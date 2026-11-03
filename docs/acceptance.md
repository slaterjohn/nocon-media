# MVP acceptance status

Status of each item in the specification's final acceptance criteria (§30), with the evidence behind it. Recorded on 1 November 2026 on an Apple Silicon Mac running Docker Desktop (native arm64 containers, amd64 under QEMU emulation). Nothing here has been run on Raspberry Pi hardware yet.

How to re-run the evidence:

```bash
pnpm -r typecheck
pnpm test:infra && pnpm vitest run        # 393 unit + integration tests
pnpm test:e2e                             # 44 Playwright tests
scripts/offline-test.sh                   # 23 checks with no internet access
scripts/build-images.sh                   # arm64 + amd64 images
```

Legend: **Verified** = covered by an automated test or a recorded manual run. **Outstanding** = not yet verified; the reason is given. **Deferred** = needs hardware that was not available; the Human chose on 3 November 2026 to defer these, and they are listed under "Deferred to hardware" below.

## Deployment

| Criterion | Status | Evidence |
|---|---|---|
| Docker Compose deployment works | Verified | Full stack (postgres, redis, api, worker, web) starts healthy with `docker compose up -d --wait`; setup completed through the API and the web proxy. |
| ARM64 images build | Verified | `scripts/build-images.sh` (api 84 MB, worker 281 MB, web 96 MB). |
| AMD64 images build | Verified | Same script under QEMU (api 84 MB, worker 286 MB, web 96 MB); the amd64 web image was started and served `/login`. The web build stage runs on the build platform because `next build` crashes under QEMU. |
| Raspberry Pi deployment is documented | Verified | `docs/guides/install-raspberry-pi.md`, `scripts/install-pi.sh`. |
| Persistent storage is configured safely | Verified | Named volumes for Postgres/Redis, bind mounts for media and data, volume marker file, refusal to use paths outside `MEDIA_ROOTS_ALLOWED`, warning when a folder is on the container's own filesystem. |
| Application starts without cloud dependencies | Verified | `scripts/offline-test.sh` runs every service on an internal network with no egress. |

## Administration

| Criterion | Status | Evidence |
|---|---|---|
| Administrator can complete initial setup | Verified | `tests/e2e/01-setup.spec.ts` drives the wizard in a browser. |
| Sources can be added, edited, paused and deleted | Verified | `tests/e2e/03-sources.spec.ts`; `tests/integration/api-library.test.ts` (keep/delete media on delete). |
| Schedules can be configured | Verified | E2E edits the schedule; scheduler tick, backoff and catch-up in `worker-pipeline.test.ts`. |
| Download rules can be configured | Verified | Filters and download options in E2E and worker tests (`maxNewPerRun`, duration, keywords, subtitles). |
| Storage priorities can be configured | Verified | Source priority, per-media priority and protecting a video (pinning) in API and storage tests. |
| System status is visible | Verified | Dashboard and System health pages (E2E a11y pass over every page); offline readiness diagnostic. |

## Downloads

| Criterion | Status | Evidence |
|---|---|---|
| YouTube channels can be monitored | Verified | Live run against `@YouTube`: listing, filters and a 720p download. Fake-catalogue tests in CI. |
| YouTube playlists can be monitored | Verified (fake yt-dlp only) | Playlist ordering and sync with the fake catalogue; not yet run against a live playlist. |
| Individual videos can be downloaded | Verified | Live run: "Me at the zoo" reached `ready` in about 6 s (H.264/AAC MP4, thumbnail, English captions, sidecar). |
| New media can be fetched automatically | Verified | Scheduler and dispatcher tests; live channel sync queued new items. |
| Downloads recover after interruption | Verified | Boot recovery test (state reset, reservation released, staging cleaned); `docker compose kill -s KILL worker` recovery. |
| Metadata and artwork are cached locally | Verified | Sidecar, thumbnail, subtitles and channel artwork on disk; offline test serves thumbnails and Xtream artwork with no internet. |

## Storage

| Criterion | Status | Evidence |
|---|---|---|
| Protected (P0) media is never removed | Verified | Storage scenario 5. |
| Keep (P1) sources default to retention-all | Verified | `api-library.test.ts` source defaults; storage scenario 4. |
| Keep (P1) sources can reclaim Optional (P2) and Spare (P3) media | Verified | Storage scenarios 2 and 3. |
| Retention policies are enforced | Verified | Planner unit tests for every mode; rolling and soft-threshold cleanup tests. |
| Storage reservations prevent overcommitment | Verified | Scenario 14 (concurrent admissions under an advisory lock). |
| Evictions are logged | Verified | `eviction_records` assertions in the scenarios; Storage page eviction history (E2E). |
| Missing drives are handled safely | Verified | Scenarios 8 and 9 (marker removed, downloads paused, records kept, resume on reconnect). |
| Storage simulation works | Verified | `simulate` and `simulatePolicyChange` tests; E2E runs the simulation tool. |
| Duplicate media is not stored unnecessarily | Verified | Scenario 12; canonical key uniqueness; a re-download never evicts the item being re-downloaded (scenario 2b). |

## Playback

| Criterion | Status | Evidence |
|---|---|---|
| Media can be browsed locally | Verified | `tests/e2e/05-library.spec.ts`. |
| Search works offline | Verified | Offline test "search finds seeded title"; Postgres full-text search only. |
| Videos play in the browser | Verified | `tests/e2e/06-playback.spec.ts` (Chromium: play, currentTime advances). Safari and Firefox not tested. |
| Seeking works | Verified | E2E slider and keyboard seeking; HTTP 206 range tests. |
| Subtitles work where available | Verified | E2E captions control with a WebVTT track; live download included English captions. |
| Playback progress is saved | Verified | E2E reload shows "Resuming from"; API progress test. |
| Artwork remains available offline | Verified | Offline test thumbnail and Xtream artwork checks. |

## Xtream

| Criterion | Status | Evidence |
|---|---|---|
| Xtream authentication works | Verified | `api-xtream.test.ts`; offline test; live run. |
| Categories are returned | Verified | Same. |
| VOD listings are returned | Verified | Same. |
| Media metadata is returned | Verified | `get_vod_info` with codec, resolution and duration in the live run. |
| Videos stream correctly | Verified | ffprobe on the Apple Silicon host read the `/movie/...` URL over HTTP and reported H.264/AAC, 18.9 s. |
| Seeking works | Verified | Range requests return 206 with the correct bytes. |
| Client credentials can be revoked | Verified | API test and `tests/e2e/08-clients.spec.ts`. |
| Offline playback works | Verified | Offline test `/movie` range request with no internet. |
| Compatibility is validated against a real client | Verified with IPTVnator 0.24.0; **UHF deferred (needs an Apple TV)** | IPTVnator (open-source Xtream player, macOS) passed all ten §16.6 items against real downloaded content; see "Real-client validation" below. UHF on Apple TV has not been tested yet; use the checklist in `docs/clients/uhf.md`. NoConMedia does not claim UHF compatibility until that is recorded. |

### Real-client validation: IPTVnator 0.24.0

Run on 1 November 2026. The API and worker ran natively on the Apple Silicon host rather than in Docker (Docker Desktop Desktop rewrites client source addresses, which the default Xtream network allow-list rejects). Content was downloaded with the real yt-dlp: "Me at the zoo" (19 s) and a 10-minute 720p video. IPTVnator was driven through Playwright's Electron support, and each step was checked against the API logs.

| §16.6 item | Result | Evidence |
|---|---|---|
| Authentication | Pass | `get_account_info` 200; playlist loads |
| Category retrieval | Pass | `get_vod_categories` 200; all categories listed |
| Video listing | Pass | `get_vod_streams` 200; both videos listed |
| Artwork | Pass | `/xtream-art/...jpg` 200 `image/jpeg`; thumbnails shown |
| Metadata | Pass | `get_vod_info` 200; title, genre, duration 00:10:07, plot, channel shown |
| Playback | Pass | Built-in player; `/movie/.../2.mp4` 206 `Range: bytes=0-`; `currentTime` advancing |
| Seeking | Pass | Seek to 300 s issued `Range: bytes=20905984-` (206); playback continued past 307 s |
| Catalogue refresh | Pass | Refresh re-ran the full request sequence; playback progress kept |
| Offline operation | Pass | Every artwork and stream URL points at the local server |
| Credential revocation | Pass | After revoke: `auth:0`, `/movie` and artwork 401, client shows "Account inactive" |

The first run found that virtual categories (Recently added, Favourites, topic categories) were empty, because IPTVnator reads only the standard single `category_id`. `get_vod_streams` now returns one entry per category membership. A second run confirmed Recently added lists 2 items and each topic category 1, and that playback still works.

## Resilience

| Criterion | Status | Evidence |
|---|---|---|
| Internet disconnection does not prevent playback | Verified | Offline test. |
| External jobs pause appropriately | Verified | Worker tests: sync recorded as `skipped_offline`, downloads stay queued. |
| Jobs resume when connectivity returns | Verified | Connectivity transition and catch-up tests. |
| Unexpected restarts are handled safely | Verified | `docker compose restart`, SIGKILL of the worker, interrupted eviction and download recovery tests. |
| Storage disconnection does not destroy catalogue records | Verified | Scenario 8. |
| Database and application backups can be restored | Verified | `scripts/backup.sh` then `scripts/restore.sh` on the verification stack, followed by a successful login. Restoring onto a different drive path was not tested. |

## Deferred to hardware

These need devices that were not available. Everything else in the specification was built and checked as recorded above.

- **UHF on Apple TV.** Run the checklist in `docs/clients/uhf.md` and record the result in "Real-client validation". Until then NoConMedia claims compatibility with IPTVnator only.
- **Raspberry Pi deployment and performance.** Follow `docs/guides/install-raspberry-pi.md` on a Pi 5 and a Pi 4, run `scripts/benchmark.sh`, and fill in the Pi rows of `docs/benchmarks.md`. Emulation does not count as Pi verification.

## Other outstanding work

- **Egress blocking for api and web on Linux.** The `frontend` network disables IP masquerading, which Docker Desktop ignores. Check on Linux that the api and web containers cannot reach the internet.
- **Browsers other than Chromium.** The player uses standard HTML5 video and hls.js, but Safari and Firefox have not been tested.
- **Live playlist sync.** Only tested with the fake yt-dlp catalogue.
- **Security review findings.** All high and medium findings were fixed with regression tests (see `docs/security.md`). The remaining low-risk notes are floating base image tags and the deliberately admin-controlled `YTDLP_EXTRA_ARGS`.
