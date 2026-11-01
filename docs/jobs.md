# Jobs, settings and shared runtime contract

This is the contract between `apps/api` and `apps/worker`. Postgres is the source of truth; BullMQ jobs are triggers that can be lost and re-created.

## Queues and jobs

Queue names come from `QUEUES` in `@nocon/shared`. Every job is added with `{ removeOnComplete: true, removeOnFail: true }` (history lives in Postgres) and a deterministic `jobId` (no `:` allowed by BullMQ, so `-` is used).

| Queue | Job name | Data | jobId | Added by |
|---|---|---|---|---|
| `sync` | `sync` | `{ sourceId, trigger: "schedule"\|"manual"\|"create"\|"catchup" }` | `sync-<sourceId>` | API (create, sync now), worker scheduler |
| `download` | `download` | `{ downloadId }` | `download-<downloadId>` | API (manual download, approve, restore, retry/resume), worker (sync, dispatcher) |
| `processing` | `hls` | `{ mediaId }` | `hls-<mediaId>` | API on first HLS request |
| `discovery` | `discovery` | `{ trigger: "schedule"\|"manual" }` | `discovery-run` | API (run now), worker scheduler |
| `maintenance` | `reconcile` | `{ dryRun: boolean, volumeId?: string }` | `reconcile-<uuid>` chosen by API | API |

For `reconcile` the job's return value is the report; the reconcile job is added with `{ removeOnComplete: { age: 3600 } }` so the API can read it with `Queue.getJob(id)` (`GET /api/storage/reconcile/:jobId` → `{state, result}`).

The worker additionally runs internal repeatable work on timers (no external triggers needed): scheduler tick, download dispatcher, volume checks, connectivity probes, waiting-for-storage re-checks, stale tmp cleanup, soft-threshold and rolling-retention cleanup, discovery schedule.

**Download dispatcher (worker, every 30 s):** every download in `queued` state whose `next_attempt_at` is null or past gets `download-<id>` added (duplicates are ignored by BullMQ). So the API may enqueue for low latency, but correctness never depends on it.

**Progress:** yt-dlp downloads the video and audio streams one after the other and reports each from zero. The worker adds the finished streams together, so `bytesDownloaded` never exceeds `totalBytes` and `progress` stays below 1 until the download is processed. On `ready`, `totalBytes` is set to the final size on disk.

**Cancellation:** API sets `downloads.cancel_requested = true` (and state change if not running). The worker polls the flag during a running download (every progress tick / 5 s) and aborts yt-dlp.

## Shared catalogue helpers — `packages/database/src/catalog.ts`

Both apps import these from `@nocon/database`:

```ts
ensureSystemSources(db): Promise<{ history: Source; discovery: Source; manual: Source }>
  // idempotent; creates system sources if missing:
  //  history   type=history   priority P2 (Optional) retention none  schedule manual
  //  discovery type=discovery priority P3 (Spare) retention none  schedule manual
  //  manual    type=video     priority P1 (Keep) retention all   schedule manual, name "Manual downloads"

upsertMedia(db, entry: {canonicalKey, platform, externalId, url, title, description?, channelId?, channelName?,
  publishedAt?, durationSeconds?, isShort?, isLive?, thumbnailUrl?, viewCount?, categories?, tags?, language?}):
  Promise<{ media: Media; created: boolean }>
  // insert ... on conflict (canonical_key) do update set only non-null fresher metadata; never touches availability/priority fields.
  // also upserts creators when channelId present and links media.creator_id.

linkMediaToSource(db, {mediaId, sourceId, position?, depth?, reason?}): Promise<void>  // on conflict update position; then recomputeEffectivePriority

ensureDownload(db, {mediaId, sourceId?, priority, options?, requestedBy}): Promise<{ download: Download; created: boolean }>
  // returns the existing active download (unique partial index) or inserts state=queued and media.availability='queued';
  // writes a download_events row. Refuses (returns created:false, download:null, reason:"cooldown") when
  // media.redownload_after > now() unless requestedBy is "manual"|"restore".

transitionDownload(db, downloadId, to: DownloadState, patch?: Partial<Download>, reason?): Promise<Download>
  // asserts the transition with assertTransition(), updates row + download_events in one transaction.
```

## Settings (table `settings`)

| Key | Value | Default source |
|---|---|---|
| `setup` | `{ complete: boolean, completedAt?: string }` | `{complete:false}` |
| `app` | `{ profile, defaultResolution, softThreshold, minFreePercent, enableXtream, enableM3u, enableHls, redownloadCooldownDays, xtreamAllowedCidrs: string[] }` | env (`DEPLOYMENT_PROFILE`, `STORAGE_SOFT_THRESHOLD`, …) |
| `discovery` | `DiscoveryBudget` (`@nocon/shared`) | schema defaults |
| `worker` | `{ paused: boolean }` | `{paused:false}` |

Effective values = defaults from env, overlaid by the stored value. Use `getSetting` from `@nocon/database`.

## Redis keys

| Key | Writer | Value |
|---|---|---|
| `nocon:worker:heartbeat` | worker every 15 s, `EX 60` | `{ at, pid, version, paused, active: { downloads, processing, sync, discovery } }` |
| `nocon:connectivity` | worker every `CONNECTIVITY_INTERVAL_SEC` | `{ online: boolean, checkedAt, probes: [{url, ok, ms, error?}] }` |

Worker online ⇔ heartbeat key exists.

## Connectivity rules

Online when at least one probe in `CONNECTIVITY_CHECK_URLS` responds (any HTTP status) within 5 s. While offline the worker does not start `sync`, `download` (jobs return early and leave the download `queued`), or `discovery`; sync runs are recorded with status `skipped_offline`. When the state flips to online: activity `connectivity.restored`, overdue sources caught up at most 3 per scheduler tick, queued downloads dispatched normally (concurrency limits apply).

## Files on a volume

```
<mount>/.noconmedia/volume.json        marker
<mount>/.noconmedia/tmp/<downloadId>/  yt-dlp staging (same filesystem → atomic rename)
<mount>/.noconmedia/manifests/         library manifests written by backup script / reconcile
<mount>/<mediaDirFor(...)>/            media.<ext>, metadata.json, media.jpg, media.info.json, media.<lang>.vtt, hls/  (names from FILES in @nocon/media-core)
<mount>/youtube/channels/<id>/_channel avatar.jpg, banner.jpg
```
