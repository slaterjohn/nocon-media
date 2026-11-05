# MVP acceptance status

Status of each item in the specification's final acceptance criteria (§30), with the evidence behind it. Recorded on 1 November 2026 on an Apple Silicon Mac running Docker Desktop (native arm64 containers, amd64 under QEMU emulation). The Raspberry Pi 4 Model B (2 GB) check was recorded on 5 November 2026; see "Raspberry Pi verification" below. Nothing has been run on a Pi 5.

How to re-run the evidence:

```bash
pnpm -r typecheck
pnpm test:infra && pnpm vitest run        # 393 unit + integration tests
pnpm test:e2e                             # 59 Playwright tests (Chromium)
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
| Raspberry Pi deployment is documented | Verified | `docs/guides/install-raspberry-pi.md`, `scripts/install-pi.sh`. Followed end to end on a Pi 4 (2 GB) on 5 November 2026; see "Raspberry Pi verification". |
| Persistent storage is configured safely | Verified | Named volumes for Postgres/Redis, bind mounts for media and data, volume marker file, refusal to use paths outside `MEDIA_ROOTS_ALLOWED`, warning when a folder is on the container's own filesystem. |
| Application starts without cloud dependencies | Verified | `scripts/offline-test.sh` runs every service on an internal network with no egress. CI job `stack` runs it natively on amd64 and arm64 Linux (CI run 41682970957). |
| api and web have no route to the internet on Linux | Verified | CI job `stack` starts the default stack with `docker compose up --wait` on `ubuntu-latest` and `ubuntu-24.04-arm`, and shows `api` and `web` cannot reach `https://www.youtube.com` (the `frontend` network's IP masquerade setting holds on Linux; Docker Desktop for Mac ignores it). CI run 41682970957. |

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
| YouTube playlists can be monitored | Verified | Live run on 3 November 2026 (yt-dlp 2026.10.26) against the public Blender playlist "Settlers" (`PLa1F2ddGya_8Pn07ZxzgxFRw5iQbovXZv`, 8 videos, local API and worker, throwaway Postgres and Redis): the source was added, sync catalogued all 8 in playlist order, a repeat sync added nothing, and the shortest video ("Gabby" Character creation, 826 s) was downloaded through the normal download path at 360p. It produced `media.mp4` (H.264/AAC, 640x360, 29.9 MB), `media.jpg`, `media.info.json` and a correct `metadata.json`; it appeared in the library, streamed with a 206 range response (API and Xtream `/movie/...`), and was listed by Xtream `get_vod_streams` and the M3U under both the "Settlers" and "Film & Animation" categories. Reordering, removal and later growth past 30 entries cannot be produced live without owning a playlist; they are covered by fake-yt-dlp integration tests (`tests/integration/worker-pipeline.test.ts`: "playlist sync" and "playlist sync over time"). Private playlists were not tried (see Other outstanding work). |
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
| Videos play in the browser | Verified | `tests/e2e/06-playback.spec.ts` (play, seek, pause, resume) and `tests/e2e/11-engine-media.spec.ts` (HLS path). Chromium: direct play and HLS (native). Firefox (Playwright build 1555, macOS): direct play and HLS through hls.js, 44 of 44 engine-subset tests passed. In CI on Ubuntu (run 41686333991, job `e2e`): Chromium 59 passed, Firefox 44 passed, WebKit 44 passed with no decode test skipped. Real Safari (native HLS on macOS or iOS) is deferred; see "Deferred to hardware". |
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

## Raspberry Pi verification (5 November 2026)

**Verified on a Raspberry Pi 4 Model B Rev 1.5 with 2 GB of RAM. Not verified on a Pi 5.** Raspberry Pi OS Lite 64-bit (Debian 13 Trixie, kernel 6.18), a freshly flashed 58 GB SD card, Wi-Fi only. No USB drive was attached, so the library lived in `/srv/nocon-media` on the SD card instead of a mounted drive; the "If the drive is unplugged" behaviour was not exercised.

- `docs/guides/install-raspberry-pi.md` was followed with Docker from get.docker.com and a clone from GitHub. `docker compose up -d --build --wait` built all three images on the Pi in 547 s (9 min 7 s) and every service reached healthy. The build did not run out of memory (the OS image has 1.8 GB of swap). There were no kernel out-of-memory messages.
- The setup wizard was completed through the API with the lightweight profile. A 19-second public test video was downloaded at 480p, a range request returned 206, and the Xtream `get_vod_streams` call listed the item.
- `scripts/benchmark.sh` ran; results are in `docs/benchmarks.md`.
- `scripts/offline-test.sh` passed 23 of 23 checks (42 s including image checks, images cached).
- Problems found, now in the guide: the memory cgroup controller is off by default on this image, so Docker ignores the container memory limits and `docker stats` shows no memory figures; the guide also assumed the USB drive. The kernel setting that enables the controller was not applied on this Pi, so the guide's fix has not itself been tested.
- Not covered: a Pi 5, a Pi with 4 GB or more, a USB drive, Ethernet, the standard profile, sustained downloads and HLS preparation, and playback on a real client over the network.

## Deferred to hardware

These need devices that were not available. Everything else in the specification was built and checked as recorded above. Raspberry Pi 5 verification also remains deferred: follow `docs/guides/install-raspberry-pi.md` on a Pi 5, run `scripts/benchmark.sh` and fill in the Pi 5 rows of `docs/benchmarks.md`.

- **UHF on Apple TV.** Run the checklist in `docs/clients/uhf.md` and record the result in "Real-client validation". Until then NoConMedia claims compatibility with IPTVnator only.
- **Real Safari.** Playwright's WebKit passes the media subset in CI (44 tests, none skipped, CI run 41686333991), but WebKit is not Safari and it crashes at launch on macOS 26 here. A person on a Mac plays a video in Safari, directly and through HLS, and records the result.

## Resolved notes

- **Security review findings.** All high and medium findings were fixed with regression tests (see `docs/security.md`). The low-risk note about floating base image tags is closed: every base image is pinned to an exact version tag plus its multi-arch index digest, and `docs/security.md` explains how to bump one. `YTDLP_EXTRA_ARGS` stays admin-controlled by design: only an administrator can set it, as an environment variable on the host. That is an accepted design decision, not an open item.

## Other outstanding work

- **Private and unlisted playlists, live.** Everything else about playlist sync is now checked (see the YouTube playlists row). Two cases were never run against real YouTube. A private playlist needs a signed-in account and the user's own cookies file (`PUT /api/sources/:id/cookies`; cookies are supported, so this is untested rather than out of scope); no account or cookies were used. An unlisted playlist is fetched by URL exactly like a public one, so no different behaviour is expected, but none was available to try. The fake-based tests also rely on yt-dlp listing a video made private or deleted as a "[Private video]" or "[Deleted video]" placeholder entry; that is yt-dlp's documented behaviour, but it was not observed live. The earlier live run found two defects (no `playlist_index` in live flat listings; the metadata title being the channel name), fixed in 3 November 2026 with regression tests. This round of tests found two more, also fixed: a repeat sync only looked at the first 30 playlist entries, so videos YouTube appends past entry 30 were never found (repeat syncs now look at up to 500, `PLAYLIST_RESYNC_LIMIT` in `apps/worker/src/sync.ts`), and "[Private video]" or "[Deleted video]" placeholders were catalogued as items and could overwrite the real title of a video later made private (they are now skipped; items already in the library, and their files, stay linked in their last known order). Covered by the fake tests "is reordered between syncs", "keeps a video that is removed from the playlist, and keeps the real title of one made private", "does not catalogue a private or deleted placeholder on the first sync" and "finds videos appended past entry 30 on later syncs".
