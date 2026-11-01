# @nocon/source-adapters

Provider adapters (YouTube via yt-dlp), strict source identification, Takeout import parsing, and `runProcess` (shell-free process runner reused by media-core).

- `identifySource(input)` / `identifyYouTube(input)` returns `IdentifiedSource | null`. Host allowlist and ID regexes are enforced; anything else is `null`.
- `getAdapter("youtube", { ytDlpPath, extraArgs, cookiesFile })` returns a `SourceAdapter`: `identify`, `fetchSourceInfo`, `discover` (limit/offset, optional shorts/streams), `fetchMediaInfo`, `search`, `classifyError`.
- `parseTakeout(buffer, filename)` handles `watch-history.json`, `.html` and Takeout `.zip`.
- `runProcess(cmd, args, opts)` spawns with `shell:false`, caps stdout, keeps a stderr tail, SIGTERM then SIGKILL after 5 s on timeout or abort.

Set `NOCON_YTDLP_NO_JS_RUNTIME=1` to omit `--js-runtimes node`.
