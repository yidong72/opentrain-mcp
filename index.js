#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig, OpenTrainClient } from "./src/client.js";
import { createServer } from "./src/server.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Open Train MCP — read-only training analysis, stdio transport

Usage: opentrain-mcp [--check | --help | --version]

OPENTRAIN_API_URL        Server origin (default https://opentrain.yihome.org)
OPENTRAIN_API_KEY        Your personal Open Train API key
OPENTRAIN_API_KEY_FILE   Alternative: file containing a key or WANDB_API_KEY=key
OPENTRAIN_OUTPUT_DIR     Private downloads directory (default ./opentrain-downloads)

--check verifies authentication and run access without modifying training data.
No .env file is required. Each user runs this process with their own API key.`);
} else if (args.includes("--version")) {
  console.log("0.1.1");
} else {
  let client;
  try {
    if (args.some((arg) => arg !== "--check"))
      throw new Error("Unknown argument. Use --help.");
    client = new OpenTrainClient(await loadConfig());
    if (args.includes("--check")) {
      await client.json("/healthz");
      const data = await client.json("/api/runs", { limit: 1, compact: true });
      console.log(
        JSON.stringify({
          ok: true,
          server: client.baseUrl,
          accessible_runs: data.runs.length ? "at least 1" : 0,
          read_only: true,
        }),
      );
    } else {
      const server = createServer(client);
      await server.connect(new StdioServerTransport());
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    console.error(
      client
        ? client.redact(error.message)
        : "Open Train MCP configuration error: check your API URL and key/key-file. Use --help.",
    );
    process.exitCode = 1;
  }
}
