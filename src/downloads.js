import { constants } from "node:fs";
import { mkdir, realpath, lstat, open, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { filePath, segment } from "./client.js";

export function safeFilename(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name) || name.includes(".."))
    throw new Error(
      "save_as must be a simple filename (letters, numbers, dots, underscores, hyphens; no paths or ..).",
    );
  return name;
}

export async function saveDownload(
  outputDir,
  name,
  producer,
  maxBytes = 512 * 1024 * 1024,
) {
  safeFilename(name);
  const requested = resolve(outputDir);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const root = await realpath(requested);
  if ((await lstat(requested)).isSymbolicLink())
    throw new Error("Output directory must not be a symbolic link.");
  const destination = join(root, name);
  const temporary = join(root, `.partial-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const extra = await producer(async (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes)
        throw new Error(
          `Download exceeds ${maxBytes} bytes. Choose a smaller export or raise max_bytes explicitly.`,
        );
      hash.update(buffer);
      let written = 0;
      while (written < buffer.length)
        written += (await handle.write(buffer, written)).bytesWritten;
    });
    await handle.sync();
    await handle.close();
    const sha256 = hash.digest("hex");
    if (extra?.expected_sha256 && extra.expected_sha256 !== sha256)
      throw new Error(
        "File SHA-256 differs from server metadata; download discarded.",
      );
    // link fails on EEXIST (including symlinks); never replace a user's file.
    await link(temporary, destination);
    return { ...extra, path: destination, bytes, sha256 };
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Destination already exists. Choose another save_as; files are never overwritten.",
      );
    throw error;
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function downloadFile(client, uid, file, options = {}) {
  const { save_as, max_bytes = 512 * 1024 * 1024, signal } = options;
  const name =
    save_as ||
    `file-${randomUUID()}-${file.name
      .split("/")
      .at(-1)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(-80)
      .replace(/\.\./g, "_")}`;
  if (file.size > max_bytes)
    throw new Error(
      "File exceeds max_bytes. Increase it explicitly if intended.",
    );
  const path = filePath(uid, file.path || file.name);
  return saveDownload(
    client.outputDir,
    name,
    async (write) => {
      const response = await client.response(
        path,
        {},
        { signal, timeout: 10 * 60 * 1000 },
      );
      if (Number(response.headers.get("content-length")) > max_bytes) {
        await response.body.cancel();
        throw new Error("File exceeds max_bytes.");
      }
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        await write(chunk);
      }
      return {
        run_uid: uid,
        name: file.name,
        expected_sha256: /^[a-f0-9]{64}$/.test(file.digest || "")
          ? file.digest
          : undefined,
      };
    },
    max_bytes,
  );
}

export function csvCell(value) {
  let text =
    value === undefined || value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function downloadHistory(
  client,
  uid,
  {
    format = "jsonl",
    keys,
    offset = 0,
    max_rows = 100000,
    save_as,
    max_bytes = 512 * 1024 * 1024,
    signal,
  } = {},
) {
  const before = await client.run(uid, { signal });
  const fields = keys
    ? [...new Set(["_step", "_timestamp", "_runtime", ...keys])]
    : undefined;
  if (format === "csv" && !fields)
    throw new Error(
      "CSV export requires explicit keys to avoid silently losing nested or late-appearing columns. JSONL preserves full rows.",
    );
  return saveDownload(
    client.outputDir,
    save_as || `history-${segment(uid)}-${randomUUID()}.${format}`,
    async (write) => {
      let cursor = offset,
        total,
        rows = 0;
      if (format === "csv") await write(`${fields.map(csvCell).join(",")}\n`);
      while (rows < max_rows) {
        signal?.throwIfAborted();
        const page = await client.json(
          `/api/runs/${segment(uid)}/history`,
          { offset: cursor, limit: Math.min(1000, max_rows - rows) },
          { signal },
        );
        total ??= page.total;
        const batch = page.rows.slice(0, Math.max(0, total - cursor));
        if (!batch.length) break;
        for (const row of batch) {
          const value = fields
            ? Object.fromEntries(
                fields
                  .filter((key) => Object.hasOwn(row, key))
                  .map((key) => [key, row[key]]),
              )
            : row;
          await write(
            format === "csv"
              ? `${fields.map((key) => csvCell(row[key])).join(",")}\n`
              : `${JSON.stringify(value)}\n`,
          );
        }
        rows += batch.length;
        cursor += batch.length;
        if (cursor >= total) break;
      }
      const after = await client.run(uid, { signal });
      return {
        run_uid: uid,
        format,
        offset,
        rows,
        total_at_start: total,
        complete: offset === 0 && cursor >= total,
        range_complete: cursor >= total,
        next_offset: cursor < total ? cursor : null,
        snapshot_changed: before.updated !== after.updated,
        consistency:
          "Best-effort live export, not an atomic snapshot. SDK history preserves duplicate steps; TensorBoard-imported history is reconstructed by step.",
        fields: fields || "all",
      };
    },
    max_bytes,
  );
}
