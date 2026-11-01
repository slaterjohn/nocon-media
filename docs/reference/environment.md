# Environment variables

Set variables in `.env` in the repository root (copy `.env.example`). Docker Compose reads it for substitution in `compose.yml`, and loads it into the `api` and `worker` containers. The `web` container receives only the variables listed for it in `compose.yml`.

Apply a change with `docker compose up -d`.

Two rules to know:

- **Compose sets some variables.** `compose.yml` sets `NODE_ENV`, `DATABASE_URL`, `REDIS_URL` and `DATA_ROOT` for `api` and `worker` itself, plus `API_HOST` and `API_PORT` for `api`; values for these in `.env` have no effect (`DATABASE_URL` and `REDIS_URL` are built from the `POSTGRES_*` variables). `MEDIA_ROOT`, `MEDIA_ROOTS_ALLOWED`, `DEPLOYMENT_PROFILE`, `NOCON_PROXY_SECRET`, `APP_URL` and `API_PORT_PUBLIC` are passed through from `.env` with the defaults shown below, so you can change them there. To change a fixed value, use a `compose.override.yml`.
- **Some are only first-run defaults.** The thresholds, resolution and Xtream, M3U and HLS switches are stored in the database after setup and are then edited in **Settings**. The environment value is used until a stored value exists.

Booleans accept `true`, `1` or `yes`; anything else is false. Lists are comma separated.

## Compose and host

Used by Docker Compose, not by the application code.

| Name | Default | Description | Service |
|---|---|---|---|
| `POSTGRES_USER` | `nocon` | Database user. Part of `DATABASE_URL`. | postgres, api, worker |
| `POSTGRES_PASSWORD` | none (required) | Database password. Compose refuses to start without it. Changing it after the first start does not change the stored password. | postgres, api, worker |
| `POSTGRES_DB` | `nocon` | Database name. | postgres, api, worker |
| `MEDIA_PATH` | `./media` | Host folder for the library, mounted at `/media`. Must be writable by UID 1000. | api, worker |
| `DATA_PATH` | `./data` | Host folder for app data, mounted at `/data`. Must be writable by UID 1000. | api, worker |
| `API_BIND` | `0.0.0.0` | Host address the API port is published on. Use `127.0.0.1` behind a reverse proxy. | api |
| `WEB_BIND` | `0.0.0.0` | Host address the web port is published on. | web |
| `API_PORT_PUBLIC` | `3001` | Host port for the API (Xtream, M3U). The container port stays 3001. | api |
| `WEB_PORT` | `3000` | Host port for the web app. The container port stays 3000. | web |
| `API_MEMORY` | `512m` | Memory limit for the API container. | api |
| `WEB_MEMORY` | `512m` | Memory limit for the web container. | web |
| `WORKER_CPUS` | `2.0` | CPU limit for the worker container. | worker |
| `WORKER_MEMORY` | `1g` | Memory limit for the worker container. | worker |
| `NOCON_VERSION` | `latest` | Tag for the built images (`nocon-media/<service>:<tag>`). | api, worker, web |
| `YTDLP_VERSION` | `2026.10.26` | yt-dlp version baked into the worker image at build time. `scripts/update-yt-dlp.sh` sets it. | worker (build) |

## Application

| Name | Default | Description | Service |
|---|---|---|---|
| `APP_URL` | `http://localhost:3000` | Public address of the web UI. The API accepts browser requests whose `Origin` matches it (or an entry in `ALLOWED_ORIGINS`) even when the `Host` header differs, as in some proxy set-ups. | api |
| `ALLOWED_ORIGINS` | empty | Comma-separated extra browser origins accepted by the same origin check, for example `https://media.example.com`. | api |
| `NODE_ENV` | `development` in the schema, `production` in compose | Forced to `production` by compose. | all |
| `LOG_LEVEL` | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. | api, worker |
| `API_HOST` | `0.0.0.0` | Address the API listens on. Fixed by compose. | api |
| `API_PORT` | `3001` | Port the API listens on inside the container. Fixed by compose. | api |
| `API_PORT_PUBLIC` | `API_PORT` | Port shown in generated Xtream server URLs. Compose sets it from the same `API_PORT_PUBLIC` variable that maps the host port, so the two always agree. | api |
| `DATABASE_URL` | built by compose | PostgreSQL connection string. Required outside compose. | api, worker |
| `REDIS_URL` | `redis://redis:6379` in compose | Redis connection string. Required outside compose. | api, worker |
| `TZ` | system (UTC in the images) | Time zone for cron schedules. Not in `.env.example`; works when added to `.env`. | worker, api |
| `MIGRATIONS_DIR` | auto-detected | Folder of SQL migrations. Rarely needed. | api, `pnpm db:migrate` |

## Paths inside containers

Change `MEDIA_ROOT` and `MEDIA_ROOTS_ALLOWED` in `.env` (compose passes them through). `DATA_ROOT` is fixed by compose. Changing any of them without matching mounts in a `compose.override.yml` leaves the containers pointing at folders that do not exist.

| Name | Default | Description | Service |
|---|---|---|---|
| `MEDIA_ROOT` | `/media` | Folder the setup wizard pre-fills as the library location (returned as `defaultMediaPath` by `GET /api/setup/status`). | api |
| `MEDIA_ROOTS_ALLOWED` | `/media` | Comma-separated folders under which storage volumes may be created. Set in `.env`; compose passes it to `api` and `worker`. Needed to add volumes elsewhere; see [Storage](../guides/storage.md#adding-a-volume). | api |
| `DATA_ROOT` | `/data` | App data folder (`DATA_PATH` on the host). Per-source cookies are stored in `secrets/` below it. Download staging is not here; it lives in `.noconmedia/tmp` on each volume. | api |

## Deployment and concurrency

| Name | Default | Description | Service |
|---|---|---|---|
| `DEPLOYMENT_PROFILE` | `lightweight` | `lightweight` or `standard`. The default profile, used only until the setup wizard or Settings saves one; the saved profile then wins. The worker reads it at start-up and every minute, and uses it for concurrency, the discovery interval and thumbnail generation. The database pool size is set from this variable only. | api, worker |
| `MAX_CONCURRENT_DOWNLOADS` | profile: 1 or 3 | Parallel downloads. Overrides the profile, including a profile changed in Settings. | worker |
| `MAX_CONCURRENT_PROCESSING` | profile: 1 or 2 | Parallel ffmpeg jobs (remux, HLS). | worker |
| `MAX_CONCURRENT_METADATA` | profile: 1 or 3 | Parallel source syncs. | worker |

What the profile controls, from the source:

| | lightweight | standard |
|---|---|---|
| Downloads / processing / metadata | 1 / 1 / 1 | 3 / 2 / 3 |
| Discovery interval | 12 h | 3 h |
| Database pool (API / worker) | 5 / 3 | 15 / 8 |
| ffmpeg frame-grab thumbnails | off | on |

The profile chosen in the setup wizard or **Settings** is stored but does not change these values. Only this variable and the three `MAX_CONCURRENT_*` overrides do.

## Storage and retention

| Name | Default | Description | Service |
|---|---|---|---|
| `STORAGE_SOFT_THRESHOLD` | `85` | Percent used above which Spare (P3) media is cleaned up. First-run default; later set in Settings (50 to 99). | api, worker |
| `STORAGE_MIN_FREE_PERCENT` | `5` | Percent that must stay free for Protected, Keep and Optional (P0 to P2) downloads. First-run default; later set in Settings (1 to 50). | api, worker |
| `DEFAULT_SOURCE_PRIORITY` | `P1` | Priority code for new sources when none is given: `P0` Protected, `P1` Keep, `P2` Optional or `P3` Spare. | api |
| `DEFAULT_SOURCE_RETENTION` | `all` | Retention mode for new sources when none is given: `all`, `none`, `latest_n`, `last_days`, `quota`, `rolling`, `prefer_unwatched`. | api |
| `DEFAULT_SOURCE_AUTO_EVICTION` | `true` | Automatic eviction for new sources when not given. | api |
| `REDOWNLOAD_COOLDOWN_DAYS` | `30` | How long an evicted video waits before automatic sources fetch it again. First-run default; later set in Settings. | api, worker |
| `STORAGE_STATFS_OVERRIDE_BYTES` | empty | Testing only: pretend every volume has this capacity in bytes. Leave empty. | api, worker |

## Media clients

| Name | Default | Description | Service |
|---|---|---|---|
| `ENABLE_XTREAM` | `true` | First-run default for the Xtream switch; later in Settings. | api |
| `ENABLE_M3U` | `true` | First-run default for the M3U switch; later in Settings. | api |
| `ENABLE_HLS` | `true` | HLS is used only when this and the "HLS streaming" setting are both on. | api |
| `XTREAM_ALLOWED_CIDRS` | empty (private ranges) | Networks allowed to use Xtream and M3U. Used when the Settings list is empty. See [External players](../guides/xtream-clients.md#restrict-by-network). | api |
| `PUBLIC_XTREAM_URL` | empty | Base URL given to players, for example `http://nocon.local:3001`. Empty means it is built from the request's host name (`X-Forwarded-Host` behind the bundled web proxy) and `API_PORT_PUBLIC`. | api |

## Reverse proxy and cookies

| Name | Default | Description | Service |
|---|---|---|---|
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` and `X-Forwarded-Host` from a proxy in front of the API. Unsafe if clients can reach the API port directly. | api |
| `TRUSTED_PROXY_CIDRS` | empty | Limits `TRUST_PROXY` to these proxy addresses. | api |
| `NOCON_PROXY_SECRET` | none | Shared secret (32 or more random characters) so the API believes the client address sent by the bundled web proxy. Compose passes it to `api`, `worker` and `web`. | api, web |
| `COOKIE_SECURE` | `false` | Marks the session cookie `Secure`. Set `true` when served over HTTPS. | api |
| `API_INTERNAL_URL` | `http://api:3001` (set by compose) | Where the web app forwards `/api/*`. | web |
| `HOSTNAME`, `PORT` | `0.0.0.0`, `3000` (set by compose) | Listen address and port of the web server. | web |

## Downloader tools

| Name | Default | Description | Service |
|---|---|---|---|
| `YTDLP_PATH` | `yt-dlp` | Path to yt-dlp. | worker |
| `YTDLP_EXTRA_ARGS` | empty | Extra yt-dlp arguments, split on spaces and passed through unchanged. **Options such as `--exec` run commands in the worker**, so set only values you trust. Example: `--sleep-requests 1`. | worker |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg. | worker |
| `FFPROBE_PATH` | `ffprobe` | Path to ffprobe. | worker |

## Scheduling and connectivity

| Name | Default | Description | Service |
|---|---|---|---|
| `CONNECTIVITY_CHECK_URLS` | YouTube and Google `generate_204`, `https://1.1.1.1/` | URLs probed to decide whether the server is online. | worker |
| `CONNECTIVITY_INTERVAL_SEC` | `60` | Seconds between probes. | worker |
| `SCHEDULER_INTERVAL_SEC` | `60` | Seconds between scheduler ticks that look for due sources. | worker |
| `WORKER_DISABLE_SCHEDULER` | `false` | Set `true` on all but one worker if you ever run several. | worker |

## Scripts and tests

| Name | Used by | Description |
|---|---|---|
| `NOCON_ADMIN_USER`, `NOCON_ADMIN_PASSWORD` | `scripts/benchmark.sh` | Administrator login for the benchmark (user defaults to `admin`). |
| `COMPOSE_PROJECT_NAME`, `OFFLINE_ADMIN_PASSWORD` | `scripts/offline-test.sh`, `compose.offline.yml` | Project name (default `nocon-offline`) and the throwaway admin password. |
| `FAKE_YTDLP_CATALOG` | `tests/fixtures/fake-yt-dlp.mjs` | JSON catalogue the fake yt-dlp serves in tests. |
