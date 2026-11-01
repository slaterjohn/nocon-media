import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

export type RangeResult =
  | { type: "none" }
  | { type: "range"; start: number; end: number }
  | { type: "unsatisfiable" };

/** Parse an HTTP Range header (bytes only). Multi-range uses the first range. Invalid syntax → none. */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { type: "none" };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return { type: "none" };
  const first = m[1]!.split(",")[0]!.trim();
  const r = /^(\d*)-(\d*)$/.exec(first);
  if (!r || (r[1] === "" && r[2] === "")) return { type: "none" };
  if (r[1] === "") {
    const n = Number(r[2]);
    if (n === 0 || size === 0) return { type: "unsatisfiable" };
    return { type: "range", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  let end = r[2] === "" ? size - 1 : Number(r[2]);
  if (r[2] !== "" && end < start) return { type: "none" };
  if (start >= size) return { type: "unsatisfiable" };
  if (end > size - 1) end = size - 1;
  return { type: "range", start, end };
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", m4a: "audio/mp4", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", ts: "video/mp2t", m3u8: "application/vnd.apple.mpegurl", vtt: "text/vtt",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", json: "application/json",
};

export function mimeFor(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i < 0 ? "" : path.slice(i + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export interface ServeFileOptions {
  mime?: string;
  cacheControl?: string;
  /** Called once with the byte range being sent, just before streaming starts. */
  onStart?: (info: { start: number; end: number; size: number; partial: boolean }) => void;
}

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

function plain(res: ServerResponse, code: number, msg: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(msg), ...SECURITY_HEADERS, ...headers });
  res.end(msg);
}

export async function serveFile(req: IncomingMessage, res: ServerResponse, absPath: string, opts: ServeFileOptions = {}): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return plain(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    }
    let st;
    try { st = await stat(absPath); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return plain(res, 404, "Not Found");
      return plain(res, 500, "Internal Server Error");
    }
    if (!st.isFile()) return plain(res, 404, "Not Found");

    const size = st.size;
    const etag = `W/"${size}-${Math.floor(st.mtimeMs)}"`;
    const lastModified = st.mtime.toUTCString();
    const base: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": opts.mime ?? mimeFor(absPath),
      ETag: etag,
      "Last-Modified": lastModified,
      ...SECURITY_HEADERS,
    };
    if (opts.cacheControl) base["Cache-Control"] = opts.cacheControl;

    const inm = req.headers["if-none-match"];
    if (inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) {
      res.writeHead(304, base); res.end(); return;
    }

    let range = parseRange(req.headers.range, size);
    const ifRange = req.headers["if-range"];
    if (range.type !== "none" && ifRange && ifRange !== etag && ifRange !== lastModified) range = { type: "none" };

    if (range.type === "unsatisfiable") {
      return plain(res, 416, "Range Not Satisfiable", { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
    }

    const partial = range.type === "range";
    const start = range.type === "range" ? range.start : 0;
    const end = range.type === "range" ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string | number> = { ...base, "Content-Length": length };
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === "HEAD" || length === 0) { res.end(); return; }

    opts.onStart?.({ start, end, size, partial });
    const stream = createReadStream(absPath, { start, end });
    await new Promise<void>((resolve) => {
      const onClose = () => stream.destroy();
      res.on("close", onClose);
      pipeline(stream, res, () => { res.off("close", onClose); resolve(); }); // errors (aborts) are swallowed
    });
  } catch {
    try { plain(res, 500, "Internal Server Error"); } catch { /* ignore */ }
  }
}
