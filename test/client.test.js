import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  loadConfig,
  OpenTrainClient,
  filePath,
  stripUrls,
} from "../src/client.js";
import {
  saveDownload,
  downloadHistory,
  downloadFile,
  csvCell,
} from "../src/downloads.js";
import { summarizeSeries, smooth } from "../src/analysis.js";
import { renderPlot } from "../src/plot.js";

const temp = () => mkdtemp(join(tmpdir(), "opentrain-mcp-test-"));
const config = { key: "test-key-not-real", baseUrl: "https://example.test" };

test("configuration: key-file assignment, env precedence, safe origin", async () => {
  const dir = await temp();
  const path = join(dir, "key");
  await writeFile(path, 'WANDB_API_KEY="abc123"\n');
  assert.equal(
    (await loadConfig({ OPENTRAIN_API_KEY_FILE: path })).key,
    "abc123",
  );
  assert.equal(
    (
      await loadConfig({
        OPENTRAIN_API_KEY_FILE: path,
        OPENTRAIN_API_KEY: "override",
      })
    ).key,
    "override",
  );
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/api",
    "https://example.com/?key=secret",
  ])
    await assert.rejects(
      loadConfig({ OPENTRAIN_API_KEY: "key", OPENTRAIN_API_URL: url }),
    );
  await assert.rejects(loadConfig({}));
  assert.equal(
    (
      await loadConfig({
        OPENTRAIN_API_KEY: "key",
        OPENTRAIN_API_URL: "http://127.0.0.1:8000",
      })
    ).baseUrl,
    "http://127.0.0.1:8000",
  );
});

test("auth transport is fixed-origin, GET-only, redirect-resistant and redacts errors", async () => {
  const client = new OpenTrainClient(config, {
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, config.baseUrl);
      assert.equal(options.headers.Authorization, `Bearer ${config.key}`);
      assert.equal(options.redirect, "error");
      assert.equal(options.method, undefined);
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  assert.deepEqual(await client.json("/api/runs"), { ok: true });
  await assert.rejects(client.json("//evil.test/api/runs"));
  assert.equal(client.redact(`bad ${config.key}`), "bad [REDACTED]");
});

test("transient failures retry, auth failures do not, error bodies never leak", async () => {
  let calls = 0;
  const client = new OpenTrainClient(config, {
    retryDelay: 0,
    fetchImpl: async () =>
      ++calls < 3
        ? new Response("no", { status: 503 })
        : new Response('{"ok":true}'),
  });
  assert.equal((await client.json("/api/runs")).ok, true);
  assert.equal(calls, 3);
  for (const status of [401, 403, 404]) {
    calls = 0;
    client.fetchImpl = async () => {
      calls++;
      return new Response("SECRET HTML", { status });
    };
    await assert.rejects(
      client.json("/api/runs"),
      (error) =>
        error.message.includes(String(status)) &&
        !error.message.includes("SECRET"),
    );
    assert.equal(calls, 1);
  }
});

test("network errors bounded, cancellation honored, invalid JSON rejected", async () => {
  let calls = 0;
  const client = new OpenTrainClient(config, {
    retryDelay: 0,
    fetchImpl: async () => {
      calls++;
      throw new Error("sensitive diagnostic");
    },
  });
  await assert.rejects(client.json("/api/runs"), /connection failed/);
  assert.equal(calls, 3);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.json("/api/runs", {}, { signal: abort.signal }));
  assert.equal(calls, 3);
  client.fetchImpl = async () => new Response("<html>not json</html>");
  await assert.rejects(client.json("/api/runs"), /invalid JSON/);
});

test("file paths encode labels and reject traversal; signed URLs stripped recursively", () => {
  assert.equal(filePath("r1", "media/a b.png"), "/files/r1/media/a%20b.png");
  for (const name of ["../key", "/absolute", "a/../key", "a\\b", "a//b"])
    assert.throws(() => filePath("r1", name));
  assert.deepEqual(
    stripUrls({ files: [{ name: "x", url: "signed-secret" }] }),
    { files: [{ name: "x" }] },
  );
});

test("private download, checksum, no overwrite, no symlink overwrite", async () => {
  const dir = await temp();
  const result = await saveDownload(dir, "test.json", async (write) => {
    await write("hello");
    return { custom: true };
  });
  assert.equal(await readFile(result.path, "utf8"), "hello");
  assert.equal(
    result.sha256,
    createHash("sha256").update("hello").digest("hex"),
  );
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  await assert.rejects(
    saveDownload(dir, "test.json", (write) => write("replacement")),
    /already exists/,
  );
  await symlink(result.path, join(dir, "link.json"));
  await assert.rejects(
    saveDownload(dir, "link.json", (write) => write("replacement")),
    /already exists/,
  );
  assert.equal(await readFile(result.path, "utf8"), "hello");
});

test("download cleans partial files on limits, checksum failure, producer failure; rejects unsafe names", async () => {
  const dir = await temp();
  await assert.rejects(
    saveDownload(dir, "large", (write) => write("large"), 2),
    /exceeds/,
  );
  await assert.rejects(
    saveDownload(dir, "broken", async (write) => {
      await write("part");
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(
    saveDownload(dir, "mismatch", async (write) => {
      await write("x");
      return { expected_sha256: "wrong" };
    }),
    /SHA-256/,
  );
  for (const name of ["../key", "/tmp/key", ".env", "a/b", "a..b"])
    await assert.rejects(saveDownload(dir, name, (write) => write("x")));
  assert.deepEqual(await readdir(dir), []);
  const link = join(await temp(), "linked");
  await symlink(dir, link);
  await assert.rejects(
    saveDownload(link, "safe", (write) => write("x")),
    /symbolic link/,
  );
});

test("history export preserves repeated steps, nested rows, pagination, and live-snapshot warning", async () => {
  const rows = Array.from({ length: 1003 }, (_, i) => ({
    _step: Math.floor(i / 2),
    loss: i,
    table: { data: [["nested"]] },
  }));
  const dir = await temp();
  let reads = 0;
  const client = {
    outputDir: dir,
    run: async () => ({ updated: reads++ }),
    json: async (path, { offset, limit }) => ({
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
    }),
  };
  const result = await downloadHistory(client, "r1");
  const actual = (await readFile(result.path, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(actual, rows);
  assert.equal(result.complete, true);
  assert.equal(result.snapshot_changed, true);
  const limited = await downloadHistory(client, "r1", { max_rows: 10 });
  assert.equal(limited.complete, false);
  assert.equal(limited.next_offset, 10);
  const tail = await downloadHistory(client, "r1", { offset: 1000 });
  assert.equal(tail.complete, false);
  assert.equal(tail.range_complete, true);
  assert.equal(tail.rows, 3);
});

test("CSV requires explicit columns, preserves numeric negatives, escapes formulas and quoted cells", async () => {
  assert.equal(csvCell("=CMD()"), "'=CMD()");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  const client = {
    outputDir: await temp(),
    run: async () => ({ updated: 1 }),
    json: async () => ({
      rows: [{ _step: 1, loss: -3, note: "=CMD()" }],
      total: 1,
    }),
  };
  await assert.rejects(
    downloadHistory(client, "r1", { format: "csv" }),
    /explicit keys/,
  );
  const out = await downloadHistory(client, "r1", {
    format: "csv",
    keys: ["loss", "note"],
  });
  assert.equal(
    await readFile(out.path, "utf8"),
    "_step,_timestamp,_runtime,loss,note\n1,,,-3,'=CMD()\n",
  );
});

test("file download verifies digest and respects byte limit", async () => {
  const bytes = Buffer.from("artifact content");
  const client = {
    outputDir: await temp(),
    response: async (path) => {
      assert.equal(path, "/files/r1/media/file.txt");
      return new Response(bytes);
    },
  };
  const result = await downloadFile(client, "r1", {
    name: "media/file.txt",
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.deepEqual(await readFile(result.path), bytes);
  await assert.rejects(
    downloadFile(
      client,
      "r1",
      { name: "media/file.txt", size: 100 },
      { max_bytes: 10 },
    ),
    /max_bytes/,
  );
});

test("statistics distinguish missing, sampled, and goal direction; EMA resets across gaps", () => {
  assert.equal(
    summarizeSeries({ points: [[0, null]], total: 1 }).observed_points,
    0,
  );
  const result = summarizeSeries(
    {
      points: [
        [0, 5],
        [1, null],
        [2, 3],
        [3, 1],
      ],
      total: 20,
      sampled: true,
    },
    "minimize",
  );
  assert.equal(result.observed_points, 3);
  assert.equal(result.null_or_invalid_points, 1);
  assert.equal(result.sampled, true);
  assert.match(result.caveat, /biased/);
  assert.deepEqual(result.minimum, [3, 1]);
  assert.deepEqual(
    smooth(
      [
        [0, 2],
        [1, 4],
        [2, null],
        [3, 10],
      ],
      0.5,
    ),
    [
      [0, 2],
      [1, 3],
      [2, null],
      [3, 10],
    ],
  );
});

test("PNG rendering escapes SVG labels, supports zoom/smoothing/gaps, and validates bounds", () => {
  const series = [
    {
      label: '<script>&"test',
      points: [
        [0, 1],
        [1, null],
        [2, 3],
      ],
      total: 3,
      sampled: false,
      sessions: [{ first_step: 0 }, { first_step: 2 }],
    },
  ];
  const result = renderPlot(series, {
    key: "train/<loss>",
    smoothing: 0.7,
    x_min: 0,
    x_max: 3,
  });
  assert.equal(result.png.subarray(1, 4).toString(), "PNG");
  assert.equal(result.bounds.x_max, 3);
  assert.throws(
    () => renderPlot(series, { key: "loss", x_min: 3, x_max: 1 }),
    /minimum/,
  );
  assert.throws(
    () => renderPlot(series, { key: "loss", x_min: 10 }),
    /No finite/,
  );
});
