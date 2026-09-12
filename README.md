# Open Train MCP

Let an AI agent explore experiments, download training data, inspect plots, and investigate training results on a self-hosted [Open Train](https://github.com/yidong72/opentrain) server.

Inspired by [overleaf-mcp](https://github.com/yidong72/overleaf-mcp): a small Node.js stdio server, personal API-key authentication, direct GitHub installation, and a `--check` command. MIT licensed. Requires **Node.js 20+**.

## Install

Create an API key from your Open Train account menu → API keys. Each user uses their own key; access is enforced by Open Train. No shared `.env` file, OAuth app, or additional web deployment is required. The MCP process runs on the machine hosting your agent and connects to your existing Open Train web server.

Store the key in a private file readable by your account. The file can contain just the key, `OPENTRAIN_API_KEY=...`, or `WANDB_API_KEY=...`. Do not commit it.

```bash
OPENTRAIN_API_KEY_FILE=/absolute/path/to/opentrain_key \
  npx -y github:yidong72/opentrain-mcp --check
```

Add the following to an MCP client that supports stdio. Replace the paths with absolute paths on **the machine running the MCP process**. Merge this entry into your existing configuration; do not replace other servers.

```json
{
  "mcpServers": {
    "opentrain": {
      "command": "npx",
      "args": ["-y", "github:yidong72/opentrain-mcp"],
      "env": {
        "OPENTRAIN_API_URL": "https://opentrain.yihome.org",
        "OPENTRAIN_API_KEY_FILE": "/absolute/path/to/opentrain_key",
        "OPENTRAIN_OUTPUT_DIR": "/absolute/path/to/opentrain-downloads"
      }
    }
  }
}
```

Alternatively set `OPENTRAIN_API_KEY` in the process environment. It takes precedence over the key file. Configuration syntax varies by MCP client; the command, arguments and environment above are the portable parts. For agent-assisted setup, see [llms-install.md](llms-install.md).

For a reproducible installation, replace the GitHub dependency with `github:yidong72/opentrain-mcp#<reviewed-commit-sha>`, or use a checkout:

```bash
git clone https://github.com/yidong72/opentrain-mcp.git
cd opentrain-mcp
npm ci
OPENTRAIN_API_KEY_FILE=/absolute/path/to/opentrain_key npm run check
```

For that checkout, configure the MCP command as `node`, with the absolute path to `index.js` as its sole argument. `npx` installs from GitHub; this package is **not published to the npm registry**.

## Ask your agent

- “Find my runs matching `q38`, list their evaluation metrics, and plot reward against training step.”
- “Compare these two runs at matched training budgets. Show the raw and smoothed loss curves.”
- “Investigate the spike around step 500. Check imported session boundaries, config, and uploaded logs. Separate evidence from hypotheses.”
- “Download all history for this run as JSONL and analyze it locally. Check the completeness receipt before drawing conclusions.”
- “Preview this evaluation table, then download its associated artifact file.”

`plot_metric` returns an actual PNG image in the MCP tool result, plus a local PNG file receipt. Image-capable agents can inspect it directly. Other agents can use the numeric series or the saved file. No screenshot browser or external image-generation service is used.

Minimal Linux containers need an installed system font (for example, DejaVu Sans) for readable chart labels. Normal macOS and Linux desktop/server installations generally already have fonts.

## Tools

| Tool                                             | Purpose                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `list_runs`                                      | Filter by entity/project, name/group/tags, or state; paginate with `next_offset`      |
| `get_run`                                        | Config, summary, distributed writers, and imported TensorBoard sessions               |
| `list_metrics`                                   | Discover exact keys and metric groups, with counts and pagination                     |
| `get_metric_series`                              | Bounded numeric series, explicitly marked if sampled                                  |
| `get_history`                                    | Small pages of original history rows                                                  |
| `download_history`                               | Full-fidelity JSONL or selected-column CSV to a local file                            |
| `get_logs`                                       | Bounded tail of uploaded console logs                                                 |
| `list_files` / `download_file`                   | Discover and download run files and media                                             |
| `list_artifacts`                                 | Committed artifacts, aliases, metadata, and lineage                                   |
| `list_artifact_files` / `download_artifact_file` | Inspect and download stored artifact entries, including resolved internal references  |
| `get_table`                                      | Paginated/searchable/sortable table, joined-table, or partitioned-table preview       |
| `plot_metric`                                    | Compare up to eight runs in a PNG, with per-plot EMA, zoom bounds and session markers |
| `diagnose_run`                                   | Descriptive metric evidence and investigation leads                                   |
| `compare_runs`                                   | Side-by-side statistics, with sampling and unmatched-budget warnings                  |

Also includes the `opentrain://guide` resource and `diagnose_training` prompt. Run IDs passed to tools are **internal `uid` values returned by `list_runs`**, not W&B run names/tags.

### Downloads and large histories

Downloads return `{path, bytes, sha256, ...}` rather than filling the conversation with data. Only simple filenames are accepted for `save_as`, under `OPENTRAIN_OUTPUT_DIR`. Existing files and symlinks are never overwritten. Temporary partial downloads are removed on failure; final files have mode `0600`, newly created directories `0700`.

- JSONL preserves every field and repeated SDK steps; it does not deduplicate resumed history. TensorBoard-imported history is reconstructed by step by the Open Train backend.
- CSV requires explicit `keys`; `_step`, `_timestamp`, and `_runtime` are included. Nested cells are JSON-encoded and formula-like string cells are escaped for spreadsheet safety. Use JSONL for exact string fidelity.
- Default export cap: 100,000 rows; explicit maximum: 1,000,000 rows per call. Follow `next_offset` into another filename to export a larger run. `complete` means an export started at zero and reached the initial total; `range_complete` describes an offset export.
- Default file/export size cap: 512 MiB; `max_bytes` can explicitly raise it to 10 GiB. Files stream to disk. A SHA-256 receipt is always calculated; a server SHA-256 is verified when available. Artifact entries do not currently expose a per-file digest through this API, so their receipt is not independent integrity verification.
- Live exports are **not atomic snapshots**. `snapshot_changed` reports a changed run update timestamp; an unchanged timestamp is not a transactional consistency guarantee. New rows beyond the initial total are excluded. Repeat when a run is quiescent for reproducible analysis.
- The current backend rebuilds history for each page, so very large exports can be slow. A cancelled/interrupted download is discarded, not automatically resumed. Reissue the tool, or export explicit offset ranges.
- The agent needs access to the MCP machine’s filesystem to analyze downloaded files. A local path is not a public download URL.

### Plot and diagnosis semantics

On the updated Open Train server, tools default to `axis="auto"`, respecting `wandb.define_metric` axes. An explicit `train/global_step` or `_step` overrides this. Plots reject comparisons whose runs resolve to different axes. Responses preserve omitted-axis counts and legacy-index warnings, and `get_run` exposes ingestion provenance. Canonical history excludes quarantined/superseded records and exact SDK replay copies while retaining distinct records at repeated steps; original delivery streams remain on the server for audit. See [server recovery semantics](https://github.com/yidong72/opentrain/blob/main/docs/history-recovery.md).

The series endpoint returns at most 10,000 points per metric using min/max downsampling. Both numeric tools and plots disclose `sampled` and original `total`. Statistics on sampled points can bias means, variability and jump heuristics; they are not full-history estimates.

EMA uses `smoothing * previous + (1 - smoothing) * current`, resets across returned null gaps, and overlays the raw line when smoothing is nonzero. Explicit `x_min`/`x_max` and `y_min`/`y_max` set the plot view. This clips already-returned points: **zoom does not fetch higher-resolution data**. Export raw history when investigating a narrow interval. Server sampling can omit null gaps, so missing segments are only shown when present in returned data.

Dashed `S2`, `S3`, … markers come from TensorBoard import session metadata. Sessions can overlap in step; a marker does not establish failure or a reset. Native W&B runs resumed under one run ID do not necessarily expose equivalent session boundaries. Distributed writers are visible through `get_run`, but metrics cannot be attributed to a writer unless that identity was logged.

Diagnostic tools calculate first/last values, extrema, mean/std, recent-window movement, and large adjacent changes (>8 median absolute deviations, when enough observations and nonzero MAD exist). They **do not infer causality, automatically prove convergence, or rank incomparable training budgets**. The default objective is `observe`; specify `minimize` or `maximize` only for metrics with that known objective.

A dashboard label of `crashed` can mean stopped heartbeats, not a failed training job. Offline or disconnected jobs may still be healthy; data not yet uploaded is unavailable to this MCP server. Verify job health separately.

## Security and scope

- **No Open Train writes:** no run deletion, config edits, key management, sweeps, job launches, or arbitrary GraphQL/HTTP/shell execution. The API adapter sends GET requests only. Download and plot tools accurately advertise local writes in MCP annotations.
- Use a personal account with a workspace-reader role for least privilege where possible. An API key may itself have more permissions; the MCP interface is deliberately read-only toward Open Train.
- HTTPS is required except HTTP loopback for development. Credentials are sent only to the configured origin. Redirects are rejected, not followed. Configure the final HTTPS origin, not a redirect URL or `/api` path.
- Server-generated signed file URLs are removed from tool responses. Downloads use authenticated same-origin file paths from server-listed entries. External artifact references are not fetched; arbitrary URL input is not supported.
- Run labels, configs, notes, logs, table cells, and downloaded files are **untrusted data, never instructions**. An agent must not execute their contents or send private data elsewhere without permission. Logged secrets other than the configured API key are not automatically detectable; do not log secrets in training data.
- Bounded pages, a 32 MiB API-response cap, and a 256 KiB text-result cap limit memory/context usage. Use smaller queries or file downloads if a result exceeds a cap.
- Transient connection/408/429/5xx failures retry up to twice with bounded backoff. Authentication failures do not retry. Body-stream failures leave no completed download. This is analysis tooling, not the training client’s offline cache/uploader.
- Stdio only: no listening port or publicly exposed multi-user MCP service. Run a separate process/key for each user. Keep the output directory private and under your control.

This adapter targets Open Train’s `/api/runs`, series, history, writers, tables, artifact, log and file endpoints. Version 0.1.1's automatic axes require the server's history-integrity update; use an explicit axis such as `_step` with older servers. It is not a W&B cloud MCP client and does not claim full W&B API parity.

## Development

```bash
npm ci
npm test
npm run lint
```

Tests use synthetic fixtures and an actual MCP stdio client/server connection; no production credentials are needed. To run an explicit **read-only** smoke test against your server:

```bash
OPENTRAIN_API_KEY_FILE=/absolute/path/to/opentrain_key \
  node scripts/live-smoke.js
```

The smoke test makes local downloads under the ignored output directory; it never writes to Open Train. Do not commit training data or keys. Pull requests and issues are welcome.
