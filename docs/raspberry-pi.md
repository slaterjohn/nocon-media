# Raspberry Pi and ARM64

## Targets

- Primary: Raspberry Pi 5 (4/8 GB), Raspberry Pi OS Lite 64-bit (Bookworm or later), USB SSD/HDD.
- Secondary: Pi 4 (4/8 GB), other ARM64 Linux, AMD64 Linux.
- Not supported: 32-bit Raspberry Pi OS (armhf/armv7).

## Images

All images are `linux/arm64` + `linux/amd64`, built with `docker buildx build --platform linux/arm64,linux/amd64`.

| Image | Base | Native deps |
|---|---|---|
| api | `node:24-trixie-slim` | none (scrypt is Node core; no native addons) |
| worker | `node:24-trixie-slim` | Debian `ffmpeg`, `python3`, yt-dlp in a venv (pure Python) |
| web | `node:24-trixie-slim` | none |
| postgres | `postgres:17-alpine` | official multi-arch |
| redis | `redis:7-alpine` | official multi-arch |

No package in the dependency tree requires compiling native addons, which removes the most common ARM64 failure.

## Resource profiles

| Setting | lightweight (default) | standard |
|---|---|---|
| Downloads | 1 | 3 |
| Processing (ffmpeg) | 1 | 2 |
| Metadata/sync | 1 | 3 |
| Discovery interval | 12 h | 3 h |
| Pre-transcode non-H.264 | off | optional |
| PG pool (api / worker) | 5 / 3 | 15 / 8 |
| Thumbnail generation | from source artwork only | also ffmpeg frame grab when missing |
| Real-time transcode | never | never |

Environment variables override any value (`MAX_CONCURRENT_DOWNLOADS`, etc.). Compose sets `cpus`/`mem_limit` on the worker (`WORKER_CPUS`, `WORKER_MEMORY`), and ffmpeg/yt-dlp run with `nice 10` so the API keeps priority.

## Formats

Default selector prefers H.264 + AAC in MP4 (direct play on Apple TV, browsers, VLC) up to the configured height:

```
bv*[height<=H][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=H][ext=mp4]/bv*[height<=H]+ba/b[height<=H]/b
--merge-output-format mp4
```

Merging is a remux (stream copy). Note that YouTube serves H.264 only up to 1080p; higher resolutions arrive as VP9/AV1, which the Pi 5 cannot transcode in real time. Those files are kept as-is (MP4/WebM) and served by direct play to clients that support them.

## USB storage

See `docs/guides/storage.md`. Mount by UUID in `/etc/fstab` with `nofail`, then bind into the containers as `/media`. The volume marker file means an unmounted drive is detected as offline instead of the SD card silently filling up.

## Metrics

CPU and memory come from `/proc` inside the container (cgroup-aware where available). Temperature reads `/sys/class/thermal/thermal_zone0/temp` if readable (it is, unprivileged, on Raspberry Pi OS) and reports `null` otherwise. No privileged containers.

## Verification status

ARM64 images are built and the stack is run on an Apple Silicon host (native ARM64 containers). That proves the images, not Pi performance. Benchmarks on physical Pi 5 hardware are listed as outstanding in `docs/benchmarks.md` until someone runs `scripts/benchmark.sh` on a Pi.
