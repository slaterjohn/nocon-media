# Architecture

NoConMedia is a pnpm monorepo that ships three Node.js processes plus PostgreSQL and Redis.

```
                ┌────────────── LAN ───────────────┐
 Browser ──:3000──▶ web (Next.js standalone)       │
                │      │ /api/* proxied (streams)   │
 UHF / VLC ─:3001──▶ api (Fastify)  ◀──────────────┘
                       │  admin + viewer REST (/api)
                       │  native media server (range, HLS)
                       │  Xtream (/player_api.php, /movie/...)
                       │  M3U (/get.php)
                       ▼
               PostgreSQL ◀──── worker (BullMQ)
                   ▲              │ yt-dlp, ffmpeg, ffprobe
                   └── Redis ◀────┘ queues, heartbeats
```

## Processes

| Process | Responsibility | Can be stopped without breaking playback |
|---|---|---|
| `web` | Admin interface and web player (Next.js App Router, client components, shadcn/ui). Proxies `/api/*` to the API at runtime so cookies stay same-origin. | No (browser UI), but Xtream keeps working |
| `api` | Authentication, REST API, media streaming, HLS file serving, Xtream and M3U, migrations on boot, storage-volume verification on read paths. | — |
| `worker` | Source sync, downloads, processing, discovery, reconciliation, eviction, connectivity checks, scheduler tick, recovery after restart. | Yes. Playback, search and Xtream do not depend on it. |

The API and the media server share one Fastify process because they share auth, DB access and path validation, and one fewer container matters on a Pi. The worker is separate so heavy work can be paused (`settings.worker.paused`) or the container stopped without affecting streams.

## Packages

| Package | Contents | Depends on |
|---|---|---|
| `@nocon/shared` | Env config (zod), enums, download state machine, priority helpers, path safety, URL/SSRF guards, log redaction, logger | — |
| `@nocon/database` | Drizzle schema, client factory, SQL migrations, migrator, small repository helpers (activity, notifications, settings) | shared |
| `@nocon/storage-manager` | Pure planner (retention, eligibility, ordering, plan) + DB-backed service (volumes, statfs, reservations, eviction execution, simulation) | shared, database |
| `@nocon/source-adapters` | `SourceAdapter` interface, YouTube adapter (yt-dlp), Takeout parser, adapter registry | shared |
| `@nocon/media-core` | yt-dlp process runner and progress parser, ffprobe/ffmpeg wrappers, file layout, sidecars, checksums, HLS remux | shared |
| `@nocon/discovery` | Deterministic tokeniser and scorer, budget checks | shared |
| `@nocon/streaming` | Range-request parser and file streamer, MIME map | shared |
| `@nocon/xtream` | Xtream/M3U response builders (pure functions) | shared |

`packages/ui` from the suggested layout is not created: shadcn/ui components are generated into `apps/web/components/ui` and only the web app uses them. Adding a package for one consumer would be abstraction without benefit.

Packages export TypeScript source (`"exports": "./src/index.ts"`). `api` and `worker` are bundled with esbuild (via tsup) into a single file each, so production images contain no workspace symlinks and a small `node_modules`. The web app compiles workspace packages through `transpilePackages`.

## Request paths

- **Browser UI**: `GET :3000/...` → Next.js renders the shell; client components call `/api/...` which a Next route handler forwards to `API_INTERNAL_URL` (default `http://api:3001`). Range headers and response bodies are streamed, not buffered.
- **Browser playback**: `<video src="/api/media/:id/stream">` → proxy → API range streamer. HLS: `/api/media/:id/hls/index.m3u8` when a cached rendition exists.
- **Xtream clients**: talk to `:3001` directly. `/player_api.php`, `/movie/:user/:pass/:streamId.:ext`, `/get.php`, `/xmltv.php`.

## Job flow

```
scheduler tick (1/min) ──▶ queue:sync  ──▶ adapter.discover ──▶ upsert media + media_sources
                                                          └──▶ downloads(queued) ──▶ queue:download
queue:download ──▶ checking (metadata, size estimate)
               ──▶ storage plan (+ eviction) ──▶ reservation ──▶ downloading (yt-dlp to volume tmp)
               ──▶ processing (ffprobe, remux, artwork, subs) ──▶ verifying (probe, checksum)
               ──▶ atomic rename into library ──▶ ready ──▶ release reservation
queue:discovery ──▶ seeds ──▶ adapter search/channel ──▶ score ──▶ recommendations ──▶ (auto) download at Spare (P3)
queue:maintenance ──▶ volume checks, connectivity, stale reservation cleanup, tmp cleanup, soft-threshold cleanup, rolling retention
```

Each job type has its own queue and concurrency (see `DEPLOYMENT_PROFILE`). BullMQ job IDs are deterministic (`sync-<sourceId>`, `download-<downloadId>`) to prevent duplicates. The database, not Redis, is the source of truth: on boot the worker re-enqueues work from DB state, so a lost Redis volume costs nothing but time.

## Offline behaviour

The worker keeps a connectivity state (`online` / `offline`) from several probes. While offline it does not start external jobs: downloads stay `queued`, sync runs are skipped and recorded as `skipped_offline`. All API features use only Postgres and local files, so they keep working. When connectivity returns, overdue sources are caught up a few at a time.

## Data ownership

- Postgres: catalogue, policies, history, activity, credentials (hashed).
- Media volume: media files, sidecars, artwork, subtitles, HLS caches, `.noconmedia/volume.json` marker, `.noconmedia/manifests/`, `.noconmedia/tmp/` staging.
- Redis: queues, worker heartbeat. Rebuildable.
