# Benchmarks

Run `scripts/benchmark.sh` on the target hardware and paste its Markdown output below. Numbers from a laptop or an emulated platform are not Raspberry Pi results and must not be listed as such.

```
NOCON_ADMIN_PASSWORD=... scripts/benchmark.sh --requests 50 --streams 4
```

Record the board, RAM, OS image, storage device (SD, USB SSD, USB HDD), `DEPLOYMENT_PROFILE`, and the library size used.

## Status

| Hardware | Profile | Idle memory (all containers) | Idle CPU | `/api/library/search` p95 | Xtream `get_vod_streams` p95 | 4 parallel range streams | Status |
|---|---|---|---|---|---|---|---|
| Raspberry Pi 5 (8 GB), USB SSD | lightweight | not measured | not measured | not measured | not measured | not measured | **Not measured** |
| Raspberry Pi 5 (4 GB), USB SSD | lightweight | not measured | not measured | not measured | not measured | not measured | **Not measured** |
| Raspberry Pi 4 (2 GB), SD card | lightweight | about 420 MiB (summed process RSS; Docker reported no figures, see below) | under 2% per container | 42.5 ms | 21.3 ms | 4.1 to 5.6 MiB/s each, 0.20 s wall | **Measured 5 November 2026** (one-item library) |
| Raspberry Pi 5 (8 GB), USB SSD | standard | not measured | not measured | not measured | not measured | not measured | **Not measured** |

## Raspberry Pi 4 Model B (2 GB), 5 November 2026

| Item | Value |
|---|---|
| Board | Raspberry Pi 4 Model B Rev 1.5, 2 GB RAM (1.8 GiB usable), 1.8 GiB swap |
| OS | Raspberry Pi OS Lite 64-bit, Debian 13 (Trixie), kernel 6.18, aarch64, freshly flashed |
| Docker | 29.9.3, Compose v5.7.0, installed with get.docker.com |
| Storage | 58 GB SD card (library in `/srv/nocon-media` on the SD card; no USB drive) |
| Network | Wi-Fi |
| Profile | lightweight |
| Library | 1 item: a 19-second video, 738 kB, downloaded at 480p |
| Command | `NOCON_ADMIN_PASSWORD=... scripts/benchmark.sh --requests 50 --streams 4` |

Image build (`docker compose up -d --build --wait`, cold, first run): **547 s**. The images are 417 MB (web), 1.08 GB (worker) and 359 MB (api). After the build the stack was healthy with no further wait.

Idle resource use, about 30 s after the stack settled (`free -m`: 540 MiB used, 934 MiB cache, 35 MiB swap in use):

| Container | Idle CPU (`docker stats`) | Idle memory (sum of process RSS from `docker top`) |
|---|---|---|
| worker | 0.15% | 114 MiB |
| api | 0.00% | 105 MiB |
| web | 0.00% | 109 MiB |
| postgres | 1.19% | 85 MiB (RSS of its processes counts shared memory more than once) |
| redis | 1.00% | 10 MiB |

`docker stats` printed `0B / 0B` for memory because the kernel's memory cgroup controller was not enabled; Docker warned "Your kernel does not support memory limit capabilities", so the compose memory limits were not enforced either. `scripts/benchmark.sh` takes its memory column from `docker stats`, so its own table shows `0B / 0B` for this run. The memory figures above come from `docker top`. They are not cgroup figures and exclude page cache.

| Endpoint | p50 ms | p95 ms | max ms |
|---|---|---|---|
| GET /api/library/search | 28.4 | 42.5 | 55.6 |
| GET /api/library/media?limit=50 | 17.2 | 26.2 | 28.1 |
| Xtream get_vod_streams | 18.5 | 21.3 | 33.2 |
| GET /healthz | 2.5 | 3.2 | 3.5 |

Four parallel range streams (about 614 kB each, from the one small file): 5.6, 5.3, 5.5 and 4.1 MiB/s, 0.20 s wall time. With a one-item library and a file this small these say little about a large library or about sustained streaming. One run of 50 requests per endpoint; no variance was measured.

Checks: a range request on `/api/media/:id/stream` returned 206, and the Xtream `get_vod_streams` listing contained the item. `scripts/offline-test.sh` passed 23 of 23.

## Reference run (not a Pi)

An Apple Silicon Mac running Docker Desktop (native arm64 containers), `lightweight` profile, a one-item library, 50 requests per endpoint. This only shows that the script works and gives a regression baseline.

| Container | Idle CPU | Idle memory |
|---|---|---|
| worker | 0.14% | 81 MiB |
| api | 0.00% | 60 MiB |
| web | 0.03% | 43 MiB |
| postgres | 0.00% | 38 MiB |
| redis | 0.51% | 11 MiB |

| Endpoint | p50 ms | p95 ms |
|---|---|---|
| GET /api/library/search | 2.9 | 4.1 |
| GET /api/library/media?limit=50 | 2.7 | 3.7 |
| Xtream get_vod_streams | 1.2 | 2.6 |
| GET /healthz | 0.8 | 1.0 |

With a 1 item library and loopback networking these latencies say nothing about large libraries or Pi hardware.
