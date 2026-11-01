# Benchmarks

Run `scripts/benchmark.sh` on the target hardware and paste its Markdown output below. Numbers from a laptop or an emulated platform are not Raspberry Pi results and must not be listed as such.

```
NOCON_ADMIN_PASSWORD=... scripts/benchmark.sh --requests 50 --streams 4
```

Record the board, RAM, OS image, storage device (SD, USB SSD, USB HDD), `DEPLOYMENT_PROFILE`, and the library size used.

## Status

| Hardware | Profile | Idle memory (all containers) | Idle CPU | `/api/library/search` p95 | Xtream `get_vod_streams` p95 | 4 parallel range streams | Status |
|---|---|---|---|---|---|---|---|
| Raspberry Pi 5 (8 GB), USB SSD | lightweight | outstanding | outstanding | outstanding | outstanding | outstanding | **Outstanding** |
| Raspberry Pi 5 (4 GB), USB SSD | lightweight | outstanding | outstanding | outstanding | outstanding | outstanding | **Outstanding** |
| Raspberry Pi 4 (4 GB), USB HDD | lightweight | outstanding | outstanding | outstanding | outstanding | outstanding | **Outstanding** |
| Raspberry Pi 5 (8 GB), USB SSD | standard | outstanding | outstanding | outstanding | outstanding | outstanding | **Outstanding** |

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
