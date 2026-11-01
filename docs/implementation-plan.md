# Implementation plan

Status legend: **MVP** = mandatory, **Future** = designed for, not built.

## Libraries

| Need | Choice | Why |
|---|---|---|
| Workspace | pnpm 10 | workspace-aware, strict |
| Language | TypeScript 5.9 | TS 7 (native) still lacks the compiler API that Next.js type-checking uses |
| API | Fastify 5, @fastify/cookie, @fastify/rate-limit, @fastify/multipart | fast, low memory, good streaming |
| Validation | zod 4 | shared by API and web |
| DB | PostgreSQL 17, drizzle-orm + drizzle-kit, pg | spec; SQL-first migrations |
| Queue | BullMQ + ioredis, Redis 7 | spec |
| Schedules | cron-parser | next-run computation; scheduling itself is DB-driven |
| Web | Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui, lucide-react, hls.js | spec |
| Zip | fflate | pure JS Takeout zip reading |
| Build | tsup (esbuild) | single-file api/worker bundles |
| Tests | Vitest, Playwright | spec |

## Phases, tasks and dependencies

### Phase 1 — Foundation (MVP)
1. Monorepo, tsconfig, lint/typecheck scripts.
2. `@nocon/shared`: config, enums, state machine, path & URL guards, redaction. → unit tests.
3. `@nocon/database`: schema, migration 0000, client, settings/activity/notification helpers. → migration-from-empty test.
4. API skeleton: config, DB, health, auth (setup/login/logout/sessions), CSRF, rate limits, error handling.
5. Setup wizard API: storage validation (marker, statfs, mountinfo), profile, quality, thresholds, Xtream/M3U toggles.
6. Worker skeleton: queues, heartbeat, pause flag, recovery on boot, scheduler tick, connectivity probe.
7. Web shell: layout, nav, login, setup wizard.
8. Dockerfiles + compose with health checks.
**Accept:** `docker compose up` → setup wizard → admin can log in, storage registered with marker, health page shows DB/Redis/worker.

### Phase 2 — Media acquisition (MVP) — depends on 1
1. Source adapter interface, YouTube identify/discover/info/search, error classifier. Fake yt-dlp fixture.
2. Sources CRUD API (create, edit, pause, resume, sync now, duplicate, delete with media policy).
3. Sync job: discover → filters → upsert media/media_sources → queue downloads.
4. Download job: states, yt-dlp runner with progress, cancel, retry/backoff, tmp staging, processing, verify, atomic move, sidecars, artwork, subtitles, chapters, creator artwork.
5. Downloads API + page; sources pages.
**Accept:** adding a channel/playlist/video produces `ready` media files with sidecars (fake yt-dlp in CI; real yt-dlp verified manually once).

### Phase 3 — Storage intelligence (MVP) — depends on 2
1. Planner (pure) + unit tests. 2. Volume service, reservations, admission with advisory lock. 3. Eviction execution + records + cooldown. 4. Simulation API/UI. 5. Missing volume handling. 6. Reconciliation scan. 7. Soft-threshold and rolling maintenance.
**Accept:** all 15 storage scenarios pass.

### Phase 4 — Web playback (MVP) — depends on 2
Catalogue API (home rows, library, channels, playlists, collections, search via tsvector), player (controls, subtitles, chapters, speed, PiP, keyboard, resume, autoplay next), history, favourites, collections, media actions.
**Accept:** browse/search/watch/seek/resume in the browser; Playwright playback test.

### Phase 5 — External clients (MVP) — depends on 3, 4
Range streaming hardening, stream sessions, HLS job, external client management, Xtream endpoints, M3U, artwork route, CIDR restriction, redaction.
**Accept:** Xtream integration tests; VLC/ffprobe can play the `/movie/...` URL with seeking; UHF checklist documented.

### Phase 6 — Discovery (MVP) — depends on 2, 3
Scorer, seeds, strategies (channel, search by title/tags), depth limits, budgets, modes (auto/approval/discovery-only), approval queue UI, promote, Takeout import, extension endpoint, re-download cooldown.
**Accept:** discovery run produces scored recommendations with explanations under budget; Takeout import is idempotent.

### Phase 7 — Hardening (MVP) — depends on all
Offline test harness, readiness diagnostic, recovery tests (restart, kill -9), backup/restore scripts, multi-arch builds, security review, benchmarks script, full documentation set.

## Technical uncertainties

| Risk | Mitigation |
|---|---|
| YouTube changes break yt-dlp | yt-dlp pinned but upgradable in-place (`scripts/update-yt-dlp.sh`, or rebuild worker); errors classified and surfaced as “source needs attention”. |
| yt-dlp JS runtime requirement | Node is already in the worker; `--js-runtimes node`. |
| Exact UHF behaviour | Response shapes copied from widely used panels; manual test checklist; no compatibility claim until verified. |
| Size estimates unknown before download | Conservative estimate from duration × bitrate table; reservation extension; abort to `waiting_for_storage`. |
| Detecting unmounted USB inside a container | Volume marker file; mountinfo used as an extra warning at setup. |
| Next.js proxy for video | Route handler streams `ReadableStream`s and forwards Range; measured in benchmarks. |
| Pi performance | Only measurable on hardware; reported as outstanding. |

## Future (not in MVP)

Browser extension client (API exists), RSS/podcast adapters, local imports UI, multiple profiles, semantic recommendations, transcript search (`media.transcript` column reserved via `metadata`), multi-device sync, PWA downloads, scheduled backups, other protocols (DLNA, Jellyfin API).
