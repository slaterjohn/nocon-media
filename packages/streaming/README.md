# @nocon/streaming

Framework-agnostic HTTP file serving on Node `http` primitives (no Fastify).

- `parseRange(header, size)` -> `{type:'none'} | {type:'range', start, end} | {type:'unsatisfiable'}`. Supports `a-b`, `a-`, `-n`; multi-range uses the first; end clamped to `size-1`; invalid syntax -> `none`.
- `mimeFor(path)` -> MIME type by extension (mp4/m4v, m4a, webm, mkv, mp3, ts, m3u8, vtt, jpg/jpeg, png, webp, json), else `application/octet-stream`.
- `serveFile(req, res, absPath, opts?)` -> `Promise<void>`. GET/HEAD, `Accept-Ranges`, `Content-Length`, weak ETag `W/"size-mtimeMs"`, `Last-Modified`, `If-None-Match` -> 304, `If-Range` (mismatch -> full 200), 206 + `Content-Range`, 416 + `Content-Range: bytes */size`, 404 (no path leak), 405 for other methods. Streams with `pipeline`, destroys the file stream on client close, never throws on aborts.
  - `opts.mime`, `opts.cacheControl`, `opts.onStart({start,end,size,partial})`.

The caller is responsible for authorisation and for resolving `absPath` safely.
