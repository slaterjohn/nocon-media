# Development

## Repository layout

```text
apps/
  api/        Fastify API: auth, REST, streaming, Xtream/M3U, migrations on boot
  worker/     BullMQ worker: sync, downloads, processing, discovery, reconcile, scheduler
  web/        Next.js app: setup wizard, admin interface, player
packages/
  shared/           config (zod), enums, state machine, path and URL guards, schedule helpers
  database/         Drizzle schema, SQL migrations, migrator, catalogue helpers
  storage-manager/  eviction planner and the database-backed storage service
  source-adapters/  SourceAdapter interface, YouTube adapter, Takeout parser
  media-core/       yt-dlp runner, ffprobe/ffmpeg wrappers, file layout, sidecars
  discovery/        recommendation scoring and budgets
  streaming/        range-request file streaming
  xtream/           Xtream and M3U response builders
docker/           Dockerfiles for api, worker and web
scripts/          install, backup, restore, benchmark, build and test helpers
tests/            integration, e2e, offline and fixtures (fake yt-dlp)
docs/             documentation (see docs/README.md)
compose.yml       production stack
compose.dev.yml   Postgres and Redis for development and tests
compose.offline.yml  override used by the offline test
```

The architecture is explained in [architecture.md](architecture.md).

## Prerequisites

- Node.js 22 or later (the images use Node 24).
- pnpm 10 (the repository pins `pnpm@10.32.1`; run `corepack enable` and it follows the pin).
- Docker with Compose, for Postgres and Redis and for building images.
- ffmpeg and ffprobe on the `PATH`, for the integration tests and for running the worker locally.
- For the end-to-end tests: Playwright's Chromium (`pnpm exec playwright install chromium`).

## Install

```bash
git clone https://github.com/slaterjohn/nocon-media.git
cd nocon-media
pnpm install
```

## Development infrastructure

`compose.dev.yml` starts Postgres 17 and Redis 7 bound to localhost on unusual ports so they do not clash with anything else. The data is in memory (tmpfs) and disappears when the container stops.

| Service | Address | Credentials |
|---|---|---|
| Postgres | `127.0.0.1:55432` | user `nocon`, password `nocon`, database `nocon` |
| Redis | `127.0.0.1:56379` | none |

```bash
pnpm test:infra            # docker compose -f compose.dev.yml up -d --wait postgres redis
```

## Running the apps

Run each in its own terminal from the repository root. Use a scratch folder for media and data; `MEDIA_ROOTS_ALLOWED` must include the folder you register in the setup wizard.

```bash
export DATABASE_URL=postgres://nocon:nocon@127.0.0.1:55432/nocon
export REDIS_URL=redis://127.0.0.1:56379
export MEDIA_ROOT=$HOME/nocon-dev/media MEDIA_ROOTS_ALLOWED=$HOME/nocon-dev/media
export DATA_ROOT=$HOME/nocon-dev/data
export NOCON_PROXY_SECRET=dev-secret-dev-secret-dev-secret-00
mkdir -p "$MEDIA_ROOT" "$DATA_ROOT/tmp"

pnpm --filter @nocon/api dev       # http://127.0.0.1:3001, applies migrations on start
pnpm --filter @nocon/worker dev
API_INTERNAL_URL=http://127.0.0.1:3001 pnpm --filter @nocon/web dev    # http://localhost:3000
```

`pnpm dev` starts all three in parallel with the same environment. The API and worker use `tsx watch`; the web app uses `next dev -p 3000`.

The web app forwards `/api/*` to `API_INTERNAL_URL`, so you only open port 3000. The shared `NOCON_PROXY_SECRET` lets the API trust the client address the web app sends. Open `http://localhost:3000` and complete the setup wizard, entering your `MEDIA_ROOT` path as the storage folder.

### Fake yt-dlp

To work without internet or real YouTube downloads, point the worker at the fake:

```bash
export YTDLP_PATH=$PWD/tests/fixtures/fake-yt-dlp.mjs
```

It mimics the yt-dlp options NoConMedia uses, serves a small built-in catalogue of channels, playlists and videos (channel `UCfakechannel0000000000a`, videos `fakevid0001` and so on) and creates real H.264/AAC MP4 files with ffmpeg. Set `FAKE_YTDLP_CATALOG` to a JSON file to serve your own catalogue (see `tests/e2e/global-setup.ts` for the shape). `FAKE_YTDLP_COLOURFUL=1` makes it render varied 1280x720 gradients instead of the plain test card; `scripts/screenshots.mjs` uses it to regenerate the images in `docs/images/` (run `pnpm build` and `pnpm exec playwright install chromium` first). To make the worker believe it is online without internet, point `CONNECTIVITY_CHECK_URLS` at any local HTTP server.

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | Unit tests (`packages/*/test`, `apps/*/test`) with Vitest | nothing |
| `pnpm test:integration` | Integration tests in `tests/integration` | `pnpm test:infra`, ffmpeg |
| `pnpm test:e2e` | Playwright tests in `tests/e2e` | `pnpm test:infra`, `pnpm build`, ffmpeg, Chromium |
| `scripts/offline-test.sh` | Full stack on a no-internet network | Docker |
| `pnpm typecheck` | TypeScript across the workspace | nothing |

Integration tests create a uniquely named database (`createTestDb()` in `tests/integration/helpers`) on the dev Postgres (override the server with `TEST_DATABASE_URL`) and drop it afterwards. The end-to-end global setup creates a database named `e2e`, starts the built API and worker from `apps/*/dist`, builds the web app into `apps/web/.next-e2e` on first run (set `E2E_REBUILD=1` to force a rebuild), and serves on ports 24000 (web) and 24001 (API). Build first:

```bash
pnpm build
pnpm test:e2e
```

Test strategy and the storage scenarios are in [testing-strategy.md](testing-strategy.md).

## Building images

```bash
scripts/build-images.sh                       # api, worker, web for arm64 and amd64, loaded locally
scripts/build-images.sh --platform arm64      # one platform only
scripts/build-images.sh --oci ./out           # multi-platform OCI archives
scripts/build-images.sh --push registry.example.com
```

Local builds are tagged `nocon-media/<service>:<version>-arm64` and `-amd64`. The non-native platform runs under QEMU and is slow. Options: `--no-cache`, `--version TAG`, `--services "api worker web"`. It needs Docker Buildx.

For everyday use, `docker compose up -d --build` builds the images for your own architecture.

Base images are pinned to an exact tag plus multi-arch digest (`image:tag@sha256:...`). To bump one, follow "Bumping a pinned image" in [security.md](security.md#container-images-and-supply-chain). yt-dlp is pinned separately by `YTDLP_VERSION`.

## Adding a source adapter

The contract is the `SourceAdapter` interface in `packages/source-adapters/src/types.ts` (described in [source-adapters.md](source-adapters.md)). To add a platform:

1. Implement `SourceAdapter` with honest `capabilities`, and a strict `identify()` that returns `null` for anything it does not recognise.
2. Register it in `packages/source-adapters/src/registry.ts`: add the name to `SUPPORTED_PLATFORMS`, return it from `getAdapter()`, and include its identifier in `identifySource()`.
3. Adapters never touch storage, eviction or the database. They must call external tools with argument arrays, never a shell. A generic adapter that accepts arbitrary URLs must use `assertPublicHttpUrl` from `@nocon/shared`.
4. Check places that assume YouTube. For example, library reconcile derives platform and URL from canonical keys of the form `youtube:<id>` and skips others, and the artwork downloader allows only YouTube image hosts.
5. Add unit tests beside `packages/source-adapters/test` and extend the fake yt-dlp if you reuse yt-dlp.

## Conventions

- TypeScript throughout, ES modules, strict compiler options from `tsconfig.base.json`. Packages export TypeScript source; the API and worker are bundled with tsup.
- Validate every external input with zod. Reuse schemas from `@nocon/shared`.
- Resolve media paths only with `resolveInside()`. Never join user input to a path by hand.
- Spawn child processes with argument arrays. Put user-supplied values after `--` where the tool supports it.
- Do not log credentials. Use the redaction helpers for URLs.
- User-facing text is UK English, sentence case, plain and specific. The web app uses shadcn/ui components in `apps/web/components/ui`.
- The Next.js version in `apps/web` differs from older releases in places. Check the guides under `node_modules/next/dist/docs/` (also pointed to by `apps/web/AGENTS.md`) before changing web code.
- Keep changes additive in the database ([database-migrations.md](database-migrations.md)).

## Documents that act as contracts

[api.md](api.md) and [jobs.md](jobs.md) are the agreement between the API, the worker and the web app. Anyone changing an endpoint, a response shape, a queue, a job payload, a Redis key, a setting or a state transition updates the matching document in the same change, because the code on the other side is built against it. If code and document disagree, treat that as a bug and fix one of them straight away rather than working around it.

Other documents describe intent and should be kept accurate when behaviour changes: [storage-management.md](storage-management.md), [database-schema.md](database-schema.md), [security.md](security.md), [media-streaming.md](media-streaming.md). The user guides under `docs/guides/` quote UI labels and command names, so update them when those change.
