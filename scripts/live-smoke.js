// Explicit opt-in read-only production smoke test. Never run in ordinary CI.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

if (!process.env.OPENTRAIN_API_KEY && !process.env.OPENTRAIN_API_KEY_FILE)
  throw new Error(
    "Set OPENTRAIN_API_KEY_FILE or OPENTRAIN_API_KEY to run the live smoke test.",
  );
const client = new Client({ name: "opentrain-live-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../index.js", import.meta.url))],
  env: { ...process.env },
  stderr: "inherit",
});
const call = async (name, args) => {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 180000 },
  );
  assert.ok(!result.isError, JSON.stringify(result));
  return {
    result,
    data: JSON.parse(result.content.find((c) => c.type === "text").text),
  };
};
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 16);
  const { data: catalog } = await call("list_runs", {
    search: process.env.OPENTRAIN_SMOKE_SEARCH || "q38_rpga_rg",
    limit: 5,
  });
  const run = catalog.runs[0];
  assert.ok(run, "No matching live runs found; set OPENTRAIN_SMOKE_SEARCH.");
  const { data: detail } = await call("get_run", {
    uid: run.uid,
    include_config: false,
  });
  const { data: metrics } = await call("list_metrics", {
    uid: run.uid,
    search: "train/",
    limit: 100,
  });
  const key =
    metrics.metrics.find((m) => /loss|reward/.test(m.key))?.key ||
    metrics.metrics[0]?.key;
  assert.ok(key, "No train/ scalar key found.");
  const { data: series } = await call("get_metric_series", {
    uid: run.uid,
    key,
  });
  assert.ok(series.points.length);
  const { data: history } = await call("download_history", {
    uid: run.uid,
    max_rows: 2000,
  });
  const { data: plot, result } = await call("plot_metric", {
    run_uids: [run.uid],
    key,
    smoothing: 0.6,
  });
  assert.ok(result.content.some((c) => c.type === "image"));
  await call("diagnose_run", { uid: run.uid, metrics: [key] });
  await call("get_logs", { uid: run.uid, tail_lines: 5 });
  await call("list_files", { uid: run.uid, limit: 1 });
  await call("list_artifacts", { uid: run.uid, limit: 1 });
  console.log(
    JSON.stringify(
      {
        ok: true,
        uid: run.uid,
        key,
        session_count: detail.session_count,
        sampled: series.sampled,
        history: {
          path: history.path,
          rows: history.rows,
          complete: history.complete,
        },
        plot: plot.path,
        remote_writes: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
