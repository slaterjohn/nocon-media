# @nocon/media-core

Download argument building, yt-dlp execution with progress parsing, ffprobe/ffmpeg helpers, on-disk layout, atomic finalisation and library reconciliation.

- `buildDownloadArgs`, `parseProgressLine`, `runDownload` (ytdlp.ts)
- `probe`, `validateMedia` (ffprobe.ts)
- `remuxToMp4`, `extractThumbnail`, `hlsRemux` (ffmpeg.ts, optional `nice`)
- `mediaDirFor`, `creatorArtworkDir`, `FILES` (layout.ts): one directory per media item.
- `inspectStaging`, `moveIntoLibrary`, `writeSidecar`, `readSidecar`, `sha256File` (finalise.ts)
- `scanLibrary` (reconcile.ts): non-destructive; reports items, missing files, orphan directories.

All processes are spawned through `runProcess` from `@nocon/source-adapters` (`shell:false`).
