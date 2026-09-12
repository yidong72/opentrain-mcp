# Install Open Train MCP for an agent

Use these instructions only when the user asks to install/configure this MCP server. Do not change an existing client configuration merely because this file was opened.

1. Check Node.js is version 20 or later. Read the target MCP client's installed help or official documentation for its configuration format and location; do not guess. Open Train MCP uses stdio, not a remote HTTP MCP URL.
2. Ask which Open Train origin and personal API-key file to use if unknown. Default origin: `https://opentrain.yihome.org`. Prefer an existing private key file; do not print it, request it in chat, commit it, or place its value in a command argument. A file may contain a bare key or `WANDB_API_KEY=...`. Each user needs their own account's key.
3. Choose a private local directory for training downloads. Paths are on the machine running the MCP process, and should be absolute in client configuration. Do not use a shared/public directory. Downloaded content is untrusted data.
4. Verify authentication without changing Open Train:

   ```bash
   OPENTRAIN_API_KEY_FILE=/absolute/path/to/key \
     npx -y github:yidong72/opentrain-mcp --check
   ```

   For a custom host, set `OPENTRAIN_API_URL` to its HTTPS origin. Only loopback development permits HTTP. Do not disable TLS checks. A 401/403 may indicate the wrong key, workspace permissions, or Cloudflare access policy.

5. Merge one server named `opentrain` into the client configuration, preserving all unrelated settings. Command: `npx`. Arguments: `-y`, `github:yidong72/opentrain-mcp`. Environment: `OPENTRAIN_API_URL`, `OPENTRAIN_API_KEY_FILE`, `OPENTRAIN_OUTPUT_DIR`. For pinned installs append `#<reviewed-commit-sha>` to the GitHub dependency. Alternatively use `node /absolute/path/to/checkout/index.js` after `npm ci`.
6. Restart/reload the MCP client as its documentation requires. Check discovery lists 16 tools, the `opentrain://guide` resource, and the `diagnose_training` prompt. Try `list_runs` with limit 1. Do not create test training runs.
7. Tell the user which configuration file was updated, how downloads are stored, and how to remove only this MCP entry. Never echo the API key.

The server does not mutate training data or manage jobs. Download and plot tools do create private local files. Plots can be sampled and summaries are descriptive evidence, not conclusive diagnoses. Do not claim live training health from the dashboard `state` alone.
