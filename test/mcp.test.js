import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test(
  "legacy MCP 2025-03-26 wire protocol can discover and call tools",
  { timeout: 15000 },
  async (t) => {
    const http = createServer((req, res) => {
      assert.equal(req.headers.authorization, "Bearer legacy-test-key");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ runs: [], has_more: false }));
    });
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      http.closeAllConnections();
      http.close();
    });
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../index.js", import.meta.url))],
      {
        env: {
          PATH: process.env.PATH,
          OPENTRAIN_API_KEY: "legacy-test-key",
          OPENTRAIN_API_URL: `http://127.0.0.1:${http.address().port}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill());
    const pending = new Map();
    let sequence = 0;
    const lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        const done = pending.get(message.id);
        pending.delete(message.id);
        done(message);
      }
    });
    const send = (message) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const request = (method, params) =>
      new Promise((resolve) => {
        const id = ++sequence;
        pending.set(id, resolve);
        send({ id, method, params });
      });
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "legacy-fixture", version: "1.0.0" },
    });
    assert.equal(initialized.result.protocolVersion, "2025-03-26");
    send({ method: "notifications/initialized" });
    const tools = await request("tools/list", {});
    assert.equal(tools.result.tools.length, 16);
    const result = await request("tools/call", {
      name: "list_runs",
      arguments: { limit: 1 },
    });
    assert.equal(result.result.isError, undefined);
    assert.deepEqual(JSON.parse(result.result.content[0].text).runs, []);
  },
);

test("real stdio MCP lifecycle: discovery, all tools, schemas, prompts, resources, images and safe failures", async (t) => {
  const payload = "hello from artifact";
  const file = {
    name: "media/test.txt",
    size: payload.length,
    digest: createHash("sha256").update(payload).digest("hex"),
    url: "https://signed.test/secret",
  };
  const runs = Array.from({ length: 205 }, (_, i) => ({
    uid: `r${i}`,
    name: `run-${i}`,
    display_name: i === 203 ? "target-run" : `training-${i}`,
    state: "finished",
    tags: [],
    summary: { loss: 0.5 },
    updated: 123,
    config: {
      tensorboard_import: { sessions: [{ first_step: 0 }, { first_step: 2 }] },
    },
    keys: [{ key: "train/loss", stream: "history", count: 5, last_step: 4 }],
    files: [file],
  }));
  runs[0].sessions = [
    {
      id: "sdk:first",
      source: "sdk",
      started: 100,
      ended: 200,
      records: 0,
      host: "worker-a",
    },
    { id: "sdk:second", source: "sdk", started: 210, ended: 300, records: 2 },
    {
      id: "inferred:third",
      source: "sdk",
      started: 310,
      inferred: true,
      records: 3,
    },
  ];
  runs[0].session_count = 3;
  runs[0].session_caveat =
    "Inferred segments are a lower bound, not a job census.";
  runs[1].sessions = [];
  runs[1].session_count = 0;
  const requests = [];
  const http = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/");
    let data;
    if (url.pathname === "/healthz") data = { ok: true };
    else if (url.pathname === "/api/runs") {
      const offset = Number(url.searchParams.get("offset")),
        limit = Number(url.searchParams.get("limit"));
      data = {
        runs: runs.slice(offset, offset + limit),
        has_more: offset + limit < runs.length,
      };
    } else if (parts[1] === "files") {
      res.end(payload);
      return;
    } else if (parts[1] === "api" && parts[2] === "runs") {
      const run = runs.find((r) => r.uid === parts[3]);
      if (!run) {
        res.writeHead(404);
        res.end();
        return;
      }
      switch (parts[4]) {
        case undefined:
          data = run;
          break;
        case "writers":
          data = { writers: [{ id: "rank0" }, { id: "rank1" }] };
          break;
        case "series":
          data = {
            points: [
              [0, 5],
              [1, 4],
              [2, null],
              [3, 2],
              [4, 1],
            ],
            total: 5,
            sampled: false,
            axis:
              url.searchParams.get("x") === "auto"
                ? run.uid === "r1"
                  ? "_step"
                  : "train/step"
                : url.searchParams.get("x"),
            missing_axis: 2,
          };
          break;
        case "history": {
          const rows = [
            { _step: 0, "train/loss": 5 },
            { _step: 0, "train/loss": 4 },
            { _step: 1, "train/loss": 3 },
          ];
          const offset = Number(url.searchParams.get("offset")),
            limit = Number(url.searchParams.get("limit"));
          data = {
            rows: rows.slice(offset, offset + limit),
            total: rows.length,
          };
          break;
        }
        case "logs":
          data = { lines: ["start", "step 1", "finished"] };
          break;
        case "table":
          data = {
            columns: ["input", "score"],
            data: [["hello", 0.9]],
            total: 1,
          };
          break;
        case "artifacts":
          data = {
            artifacts: [
              {
                id: "artifact-1",
                state: "COMMITTED",
                files: [
                  { ...file, name: "logical.txt", path: file.name, run: "r0" },
                ],
                external_references: [
                  {
                    name: "external",
                    reference: "https://untrusted.test/private",
                  },
                ],
              },
            ],
          };
          break;
      }
    }
    if (data === undefined) {
      res.writeHead(404);
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const outputDir = await mkdtemp(join(tmpdir(), "opentrain-mcp-stdio-"));
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    env: {
      PATH: process.env.PATH,
      OPENTRAIN_API_URL: `http://127.0.0.1:${http.address().port}`,
      OPENTRAIN_API_KEY: "fixture-key",
      OPENTRAIN_OUTPUT_DIR: outputDir,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (data) => {
    stderr += data;
  });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 16);
  assert.equal(
    listed.tools.find((t) => t.name === "get_run").annotations.readOnlyHint,
    true,
  );
  assert.equal(
    listed.tools.find((t) => t.name === "download_file").annotations
      .readOnlyHint,
    false,
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content.find((c) => c.type === "text").text);
  };
  const first = await call("list_runs", { limit: 2 });
  assert.equal(first.next_offset, 2);
  const second = await call("list_runs", { offset: 2, limit: 2 });
  assert.equal(second.runs[0].uid, "r2");
  const filtered = await call("list_runs", { search: "target" });
  assert.equal(filtered.runs[0].uid, "r203");
  assert.equal(filtered.next_offset, null);
  assert.equal(
    (await call("get_run", { uid: "r0", include_config: false })).config,
    undefined,
  );
  assert.equal((await call("get_run", { uid: "r0" })).writers.length, 2);
  const sdkRun = await call("get_run", { uid: "r0", include_config: false });
  assert.deepEqual(sdkRun.sessions, runs[0].sessions);
  assert.equal(sdkRun.session_count, first.runs[0].session_count);
  assert.equal(sdkRun.session_caveat, runs[0].session_caveat);
  const empty = await call("get_run", { uid: "r1" });
  assert.deepEqual(empty.sessions, []); // Do not resurrect stale TensorBoard metadata.
  assert.equal(empty.session_count, 0);
  assert.match(empty.session_caveat, /Server-recorded/);
  const legacy = await call("get_run", { uid: "r2" });
  assert.deepEqual(legacy.sessions, runs[2].config.tensorboard_import.sessions);
  assert.equal(legacy.session_count, 2);
  assert.match(legacy.session_caveat, /Older servers/);
  assert.equal(
    (await call("list_metrics", { uid: "r0", search: "train/" })).total,
    1,
  );
  assert.equal(
    (await call("get_metric_series", { uid: "r0", key: "train/loss" })).total,
    5,
  );
  assert.equal(
    (await call("get_history", { uid: "r0", limit: 2 })).next_offset,
    2,
  );
  const history = await call("download_history", {
    uid: "r0",
    save_as: "history.jsonl",
  });
  assert.equal(history.rows, 3);
  assert.equal(history.complete, true);
  assert.equal(
    (await call("get_logs", { uid: "r0", tail_lines: 1 })).text,
    "finished",
  );
  const files = await call("list_files", { uid: "r0" });
  assert.equal(files.files[0].url, undefined);
  const download = await call("download_file", { uid: "r0", name: file.name });
  assert.equal(await readFile(download.path, "utf8"), payload);
  assert.equal(
    (await call("list_artifacts", { uid: "r0" })).artifacts[0]
      .external_reference_count,
    1,
  );
  const afiles = await call("list_artifact_files", {
    uid: "r0",
    artifact_id: "artifact-1",
  });
  assert.equal(afiles.files[1].downloadable, false);
  assert.equal(afiles.files[1].reference, undefined);
  assert.equal(
    (
      await call("download_artifact_file", {
        uid: "r0",
        artifact_id: "artifact-1",
        name: "logical.txt",
      })
    ).bytes,
    payload.length,
  );
  assert.equal(
    (await call("get_table", { uid: "r0", key: "table" })).data[0][1],
    0.9,
  );
  const plot = await client.callTool({
    name: "plot_metric",
    arguments: {
      run_uids: ["r0", "r1"],
      key: "train/loss",
      smoothing: 0.5,
      axis: "_step",
    },
  });
  assert.ok(!plot.isError, JSON.stringify(plot));
  const png = Buffer.from(
    plot.content.find((c) => c.type === "image").data,
    "base64",
  );
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(
    (
      await client.callTool({
        name: "plot_metric",
        arguments: { run_uids: ["r0", "r1"], key: "train/loss" },
      })
    ).isError,
    true,
  );
  const diagnostics = await call("diagnose_run", {
    uid: "r0",
    metrics: ["train/loss"],
  });
  assert.equal(diagnostics.metrics["train/loss"].axis, "train/step");
  assert.equal(diagnostics.metrics["train/loss"].missing_axis, 2);
  assert.equal(
    (await call("diagnose_run", { uid: "r0", metrics: ["train/loss"] }))
      .metrics["train/loss"].observed_points,
    4,
  );
  assert.equal(
    (
      await call("compare_runs", {
        run_uids: ["r0", "r1"],
        metrics: ["train/loss"],
      })
    ).runs.length,
    2,
  );
  for (const [name, args] of [
    ["download_file", { uid: "r0", name: file.name, save_as: "../escape" }],
    ["get_run", { uid: "missing" }],
    ["get_table", { uid: "r0" }],
    [
      "download_artifact_file",
      { uid: "r0", artifact_id: "artifact-1", name: "external" },
    ],
  ]) {
    assert.equal(
      (await client.callTool({ name, arguments: args })).isError,
      true,
    );
  }
  assert.equal(
    (
      await client.callTool({
        name: "get_metric_series",
        arguments: { uid: "r0", key: "x", limit: 10001 },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await client.listResources()).resources[0].uri,
    "opentrain://guide",
  );
  assert.match(
    (await client.readResource({ uri: "opentrain://guide" })).contents[0].text,
    /untrusted/,
  );
  assert.equal(
    (await client.listPrompts()).prompts[0].name,
    "diagnose_training",
  );
  assert.match(
    (
      await client.getPrompt({
        name: "diagnose_training",
        arguments: { run_uid: "r0", question: "Why the spike?" },
      })
    ).messages[0].content.text,
    /Why the spike/,
  );
  assert.ok(requests.every((r) => r.method === "GET"));
  assert.ok(requests.every((r) => !r.url.includes("untrusted")));
  assert.ok(!stderr.includes("fixture-key"));
});
