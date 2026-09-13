import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function loadConfig(env = process.env) {
  let key = env.OPENTRAIN_API_KEY?.trim();
  if (!key && env.OPENTRAIN_API_KEY_FILE) {
    const raw = (await readFile(env.OPENTRAIN_API_KEY_FILE, "utf8")).trim();
    key = raw
      .replace(/^(?:export\s+)?(?:OPENTRAIN_API_KEY|WANDB_API_KEY)\s*=\s*/, "")
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  if (!key || /\s/.test(key))
    throw new Error(
      "Set OPENTRAIN_API_KEY or OPENTRAIN_API_KEY_FILE to one personal Open Train API key.",
    );
  const url = new URL(env.OPENTRAIN_API_URL || "https://opentrain.yihome.org");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "OPENTRAIN_API_URL must be an origin, without credentials, query, or path.",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Use HTTPS, or HTTP on localhost for development.");
  return {
    baseUrl: url.origin,
    key,
    outputDir: env.OPENTRAIN_OUTPUT_DIR || "./opentrain-downloads",
  };
}

export function segment(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[\/\\\x00-\x1f]/.test(value) ||
    [".", ".."].includes(value)
  )
    throw new Error("Invalid identifier or file path.");
  return encodeURIComponent(value);
}

export function filePath(uid, name) {
  return `/files/${segment(uid)}/${name.split("/").map(segment).join("/")}`;
}

export class OpenTrainClient {
  constructor(
    config,
    { fetchImpl = fetch, retries = 2, retryDelay = 300, timeout = 30000 } = {},
  ) {
    Object.assign(this, config, { fetchImpl, retries, retryDelay, timeout });
  }
  redact(message) {
    return String(message).split(this.key).join("[REDACTED]");
  }
  async response(path, params = {}, { signal, timeout = this.timeout } = {}) {
    if (!/^\/(api\/|auth\/me$|healthz$|files\/)/.test(path))
      throw new Error("Unsupported API path.");
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl)
      throw new Error("Cross-origin requests are forbidden.");
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== null && value !== "")
        url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${this.key}`,
            "User-Agent": "Mozilla/5.0 (compatible; OpenTrain-MCP/0.1)",
            Accept: "application/json, */*",
          },
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
        });
      } catch {
        if (signal?.aborted) throw new Error("Request cancelled.");
        if (attempt < this.retries) {
          await delay(this.retryDelay * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new Error(
          "Open Train connection failed or timed out. Check the URL, network, TLS, and Cloudflare access. Redirects are not followed.",
        );
      }
      if (response.ok) return response;
      await response.body?.cancel();
      if (
        [408, 429, 500, 502, 503, 504].includes(response.status) &&
        attempt < this.retries
      ) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(
          Math.min(
            5000,
            Math.max(
              this.retryDelay * 2 ** attempt,
              Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
            ),
          ),
          undefined,
          { signal },
        );
        continue;
      }
      const hint =
        {
          401: "Check your personal API key.",
          403: "The account lacks access, or Cloudflare blocked the request.",
          404: "Not found or not accessible to this account.",
        }[response.status] || "Server rejected the request.";
      throw new Error(`Open Train HTTP ${response.status}. ${hint}`);
    }
  }
  async json(path, params, options) {
    const response = await this.response(path, params, options);
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 32 * 1024 * 1024)
        throw new Error(
          "API response exceeds 32 MiB. Use smaller pages or download a file.",
        );
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error(
        "Open Train returned invalid JSON. Check the API URL and proxy.",
      );
    }
  }
  run(uid, options) {
    return this.json(`/api/runs/${segment(uid)}`, {}, options);
  }
  series(
    uid,
    key,
    { axis = "auto", stream = "history", limit = 2000, signal } = {},
  ) {
    return this.json(
      `/api/runs/${segment(uid)}/series`,
      { key, x: axis, stream, limit },
      { signal },
    );
  }
}

// Generated signed URLs need not leave the API adapter. Files are fetched with
// authentication from a fixed origin, using only server-listed run/name pairs.
export function stripUrls(value) {
  if (Array.isArray(value)) return value.map(stripUrls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "url")
        .map(([key, val]) => [key, stripUrls(val)]),
    );
  return value;
}
