# Testing strategy

| Layer | Tool | Where | Needs |
|---|---|---|---|
| Unit | Vitest | `packages/*/test` | nothing |
| Integration | Vitest | `tests/integration` | Postgres + Redis (`pnpm test:infra` starts them in Docker), ffmpeg |
| End-to-end | Playwright | `tests/e2e` | dev Postgres/Redis (`compose.dev.yml`) plus the built API, worker and web app started by `tests/e2e/global-setup.ts` |
| Offline | shell + Vitest | `scripts/offline-test.sh` | stack on an `internal: true` network |
| Architecture | buildx | `scripts/build-images.sh` | Docker Buildx |

## Fake yt-dlp

`tests/fixtures/fake-yt-dlp.mjs` mimics the yt-dlp CLI (listing JSON, `-J`, progress lines, output templates) and generates real H.264/AAC MP4s with ffmpeg. Integration and E2E tests set `YTDLP_PATH` to it, so the full download → process → verify → ready pipeline, eviction and Xtream playback are tested deterministically and offline. A separate, opt-in `pnpm test:live` runs the real yt-dlp against one short public video.

## Unit coverage

Priority calculation, retention modes, eligibility, eviction ordering, plan sufficiency, reservation arithmetic, download state transitions, canonical identity / URL identification, recommendation scoring, availability, path validation, range parsing, redaction, SSRF guard, Takeout parsing, Xtream builders, filters.

## Storage scenarios (spec §24.4)

`tests/integration/storage-scenarios.test.ts`, one test per scenario, using a real temp directory as the volume and a configurable fake `statfs` capacity so “disk full” is reproducible:

1 sufficient space · 2 Spare (P3) eviction · 3 Optional (P2) eviction · 4 retention-all protection · 5 Protected (P0) protection · 6 multi-source priority inheritance · 7 insufficient after eligible eviction · 8 missing USB drive (marker removed) · 9 reconnection · 10 interrupted eviction (planned records, recovery) · 11 interrupted download (recovery resets state, releases reservation, cleans tmp) · 12 duplicate discovery (one media row, one file) · 13 evicted media rediscovery (cooldown) · 14 concurrent downloads competing for space (parallel admissions, advisory lock) · 15 media being streamed during reclamation.

## Integration coverage

DB operations and migrations from empty, queue processing (sync → download → ready with fake yt-dlp), adapter contract (fake yt-dlp), reconciliation (sidecars rebuild catalogue), streaming (range, HEAD, 416, disconnect), Xtream endpoints and revocation, auth (setup, login, rate limit, CSRF, session revocation), storage failure handling.

## E2E (Playwright)

Setup wizard, login, add source, edit source rules, downloads page, browse library, playback controls (play, seek, progress saved), storage settings and simulation, external client create/rotate/revoke.

## Offline

`scripts/offline-test.sh` starts the stack with `compose.offline.yml` (all services on an internal network, no egress), then runs `tests/offline` which checks login, admin endpoints, browsing, search, thumbnail fetch, range playback, Xtream auth/catalogue/playback, M3U, and the built-in offline readiness diagnostic.

## What is not automated

- UHF on Apple TV: manual checklist (`docs/clients/uhf.md`).
- Raspberry Pi hardware performance: `scripts/benchmark.sh`, results in `docs/benchmarks.md`.
