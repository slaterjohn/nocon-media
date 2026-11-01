# API reference

Base: the API service (`:3001`). The web app proxies `/api/*` to it. JSON everywhere unless noted.

## Conventions

- Auth: session cookie `nocon_session` (see `docs/security.md`). 401 `{error:"unauthorized"}` without one.
- A request with `Content-Type: application/json` and an empty body is treated as having no body (so `POST /api/sources/:id/sync` works with or without `{}`). A non-empty body that is not valid JSON gives 400.
- CSRF: every `POST/PUT/PATCH/DELETE` under `/api` must send header `X-NoCon-CSRF: 1`. Missing → 403 `{error:"csrf"}`.
- Errors: `{error: "<code>", message: "<human text>", details?: any}`. Codes: `bad_request` (400, zod issues in `details`), `unauthorized` (401), `forbidden`/`csrf` (403), `not_found` (404), `conflict` (409), `rate_limited` (429), `setup_required` (409 on most routes until setup is done), `internal` (500).
- Lists: `?limit=` (default 50, max 200) `&cursor=` or `&offset=`; response `{items: [...], total?: number, nextCursor?: string}`.
- Dates are ISO strings. Sizes are bytes (numbers). IDs are UUIDs except `streamId` (int).

## Priority codes

Priorities are sent and returned as codes. The app and any human-readable text (activity messages, notifications) use the labels.

| Code | Label | Meaning |
|---|---|---|
| `P0` | Protected | Never removed automatically |
| `P1` | Keep | Kept unless your retention rules say otherwise |
| `P2` | Optional | Removed when Keep videos need room |
| `P3` | Spare | Removed first when space runs low |

## Shared shapes

```ts
MediaSummary = { id, streamId, title, channelName, creatorId, durationSeconds, publishedAt, downloadedAt,
  availability: "discovered"|"queued"|"downloading"|"available"|"evicted"|"unavailable"|"failed",
  playable: boolean,              // available AND volume online
  temporarilyUnavailable: boolean, // available but volume offline
  effectivePriority: "P0"|"P1"|"P2"|"P3" (see Priority codes), pinned, favourite, sizeBytes,
  thumbnailUrl: string|null,       // local /api/media/:id/thumbnail or null
  progress: { positionSeconds, durationSeconds, completed } | null }
MediaDetail = MediaSummary & { description, url, platform, externalId, categories[], tags[], language,
  manualPriority, retainOverride, recommendationScore, sources: [{id,name,type,priority}],
  files: [{id, kind, mimeType, container, videoCodec, audioCodec, width, height, sizeBytes, language, label}],
  subtitles: [{id, language, label, url}],   // url = /api/media/:id/subtitles/:fileId.vtt
  chapters: [{startSeconds, endSeconds, title}],
  streamUrl: string|null,          // /api/media/:id/stream
  hlsUrl: string|null,             // /api/media/:id/hls/index.m3u8 if a rendition exists
  directPlay: boolean,             // container is mp4/webm/m4a
  recommendation: {score, explanation, strategy, status} | null,
  evictions: [{at, reason, reclaimedBytes}] }
Source = { id, name, platform, type, url, externalId, query, system, status, priority, retention, automaticEviction,
  schedule, filters, downloadOptions, discovery, autoDownload, volumeId, lastCheckedAt, lastSuccessAt, nextRunAt,
  consecutiveFailures, lastError, needsAttention, avatarUrl, mediaCount, downloadedCount, storageBytes, hasCookies, createdAt }
Download = { id, mediaId, title, sourceId, sourceName, state, priority, progress (0..1), bytesDownloaded, totalBytes,
  estimatedBytes, speedBps, etaSeconds, attempts, error, errorClass, waitingReason, createdAt, updatedAt, startedAt, completedAt }
Volume = { id, name, mountPath, filesystem, totalBytes, freeBytes, usedBytes, reservedBytes, isWritable, isOnline,
  isDefault, acceptsNew, lastVerifiedAt, lastError }
```

## Setup & auth

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/setup/status` | — | `{setupComplete, hasAdmin, steps: {admin, storage, profile}, defaultMediaPath}` (public). `defaultMediaPath` is `MEDIA_ROOT`; the wizard pre-fills it. |
| POST | `/api/setup/admin` | `{username, password}` (only when no admin exists) | `{user}` + session cookie |
| GET | `/api/setup/checks` | — | `{database:{ok,message}, redis:{ok}, worker:{ok, lastHeartbeat}}` |
| POST | `/api/setup/storage/validate` | `{path, name?}` | `{ok, exists, writable, onRootFs, mount:{mountPoint,fsType,source}|null, totalBytes, freeBytes, existingMarker: {id,name}|null, warnings[], errors[]}` |
| POST | `/api/setup/storage` | `{path, name}` | `{volume}` (writes marker) |
| POST | `/api/setup/complete` | `{profile, defaultResolution, softThreshold, minFreePercent, enableXtream, enableM3u}` | `{ok}` |
| POST | `/api/auth/login` | `{username, password}` | `{user}` + cookie; 401 bad creds; 429 rate limited |
| POST | `/api/auth/logout` | — | `{ok}` |
| GET | `/api/auth/me` | — | `{user:{id,username}}` |
| GET | `/api/auth/sessions` | — | `{items:[{id(short), createdAt, lastSeenAt, ip, userAgent, current}]}` |
| DELETE | `/api/auth/sessions/:id` | — | `{ok}`; `DELETE /api/auth/sessions` revokes all others |
| POST | `/api/auth/password` | `{currentPassword, newPassword}` | `{ok}` |

Setup endpoints (except status) require either no admin yet (`/admin`) or a logged-in admin. Until `setupComplete`, non-setup routes return `setup_required`.

## Dashboard & system

| GET `/api/dashboard` | `{media:{total, available, evicted, discovered}, storage:{totalBytes, freeBytes, usedBytes, byPriority:{P0,P1,P2,P3}}, downloads:{active, pending, failed, waitingForStorage}, sources:{total, active, paused, error, needsAttention, lastSyncAt}, streams:{active}, connectivity:{online, checkedAt}, worker:{online, paused, lastHeartbeat}, notifications:{unread}}` |
|---|---|
| GET `/api/system/health` | `{cpu:{percent, cores, load:[1,5,15]}, memory:{totalBytes, usedBytes, processRss}, temperatureC|null, volumes:[Volume], worker:{online, paused, lastHeartbeat, queues:{name:{waiting,active,delayed,failed}}}, database:{ok, latencyMs}, redis:{ok, latencyMs}, downloads:{active}, streams:{active}, connectivity, recentErrors:[ActivityEvent], remediation:[{key, message}]}` |
| GET `/api/system/offline-readiness` | runs checks: `{ok, checks:[{key:"auth"|"database"|"media_files"|"thumbnails"|"search"|"streaming"|"xtream"|"external_dependencies", ok, message}]}` |
| POST `/api/system/worker` | `{paused: boolean}` → `{ok}` |
| GET/PUT `/api/settings` | `{profile, defaultResolution, softThreshold, minFreePercent, enableXtream, enableM3u, enableHls, discovery: DiscoveryBudget, redownloadCooldownDays, xtreamAllowedCidrs: string[]}` |

## Sources

| GET | `/api/sources` | `?status&type&q` | `{items: Source[]}` |
|---|---|---|---|
| POST | `/api/sources/identify` | `{input}` | `{ok, platform, type, externalId, canonicalUrl}` or 400 |
| POST | `/api/sources` | `{input|url, name?, type? ('search' needs query), query?, priority?, retention?, automaticEviction?, schedule?, filters?, downloadOptions?, discovery?, autoDownload?, volumeId?}` defaults from `defaultSourceStoragePolicy` and settings | `{source}` (+ first sync enqueued unless schedule kind=manual) |
| GET | `/api/sources/:id` | — | `{source, recentRuns:[{id,trigger,status,startedAt,finishedAt,discoveredCount,newCount,queuedCount,error}]}` |
| PATCH | `/api/sources/:id` | any editable field | `{source}` (priority/retention change → recompute priorities, activity logged) |
| POST | `/api/sources/:id/pause` / `/resume` / `/sync` / `/duplicate` | — | `{source}` / `{ok}` |
| PUT | `/api/sources/:id/cookies` | multipart field `file`: Netscape cookies.txt, ≤1 MiB, first cookie lines must have 7 tab-separated fields (400 otherwise, 413 if too large, 400 for system sources) | `{source}` with `hasCookies: true`. Stored at `${DATA_ROOT}/secrets/source-<id>.txt`, mode 0600. Activity `source.cookies_updated`. |
| DELETE | `/api/sources/:id/cookies` | — | `{source}` with `hasCookies: false`; the file is removed. Activity `source.cookies_removed`. |
| DELETE | `/api/sources/:id?media=keep|delete` | `media` required | `{ok, retainedMedia, deletedMedia}`. `keep`: media keep the source's priority as `manualPriority` and `retainOverride=true`. `delete`: media only owned by this source are evicted (files removed, metadata kept). |
| GET | `/api/sources/:id/media` | list params | `{items: MediaSummary[]}` |

## Downloads

| GET `/api/downloads?state=a,b&limit` | `{items: Download[], counts: {state: n}}` |
|---|---|
| POST `/api/downloads` | `{mediaId}` or `{url}` (single video, creates/uses a Keep (P1) "Manual downloads" video source) → `{download}` |
| POST `/api/downloads/:id/retry` / `/cancel` / `/pause` / `/resume` | `{download}` |
| GET `/api/downloads/:id` | `{download, attempts:[...], events:[{fromState,toState,reason,at}]}` |

## Library (viewer)

| GET `/api/library/home` | `{continueWatching: MediaSummary[], recentlyDownloaded, newFromSubscriptions, recommended, favouriteChannels: Creator[], playlists: [{id,name,kind:'source'|'user',count,thumbnailUrl}]}` |
|---|---|
| GET `/api/library/media` | `?q&creatorId&sourceId&collectionId&availability=playable|all|unavailable&sort=recent|published|title|duration&favourite=true&limit&offset` → `{items: MediaSummary[], total}` |
| GET `/api/library/search?q=` | `{media: MediaSummary[], creators: Creator[], playlists: [...], collections: [...]}` (offline FTS) |
| GET `/api/library/creators` | `{items: Creator[]}` Creator = `{id,name,avatarUrl,bannerUrl,description,mediaCount,playableCount}` |
| GET `/api/library/creators/:id` | `{creator, media: MediaSummary[]}` |
| GET `/api/library/playlists` | source playlists + user playlists |
| GET `/api/library/playlists/:id` | `{playlist:{id,name,kind}, items: MediaSummary[]}` (ordered) |
| GET `/api/library/continue-watching`, `/recently-added`, `/favourites` | `{items: MediaSummary[]}` |

## Media

| GET | `/api/media/:id` | `{media: MediaDetail, related: MediaSummary[], next: MediaSummary|null}` |
|---|---|---|
| PATCH | `/api/media/:id` | `{favourite?, pinned?, manualPriority?: Priority|null, retainOverride?}` → `{media}` |
| POST | `/api/media/:id/progress` | `{positionSeconds, durationSeconds, completed?}` → `{ok}` (marks watched, lifts to at least Optional (P2)) |
| POST | `/api/media/:id/download` | queue (re)download → `{download}` |
| DELETE | `/api/media/:id` | manual eviction (files removed, metadata kept, reason `manual`) → `{ok}`; `?purge=true` also removes the catalogue row when no history/evictions reference it |
| GET | `/api/media/:id/stream` | range streaming of primary file |
| GET | `/api/media/:id/thumbnail` | local jpg (404 if none) |
| GET | `/api/media/:id/subtitles/:fileId.vtt` | WebVTT |
| GET | `/api/media/:id/hls/:file` | `index.m3u8` (202 `{status:"preparing"}` when queued) and segments |
| GET | `/api/creators/:id/avatar`, `/api/creators/:id/banner` | images |

## Collections

| GET/POST `/api/collections` | `{name, kind:'collection'|'playlist', description?}` |
|---|---|
| GET/PATCH/DELETE `/api/collections/:id` | detail includes `items: MediaSummary[]` |
| POST `/api/collections/:id/items` `{mediaId}`; DELETE `/api/collections/:id/items/:mediaId` | |

## Discovery

| GET `/api/discovery/recommendations?status=pending|approved|rejected|queued|catalogued` | `{items:[{id, media: MediaSummary, score, explanation:{components, reasons[]}, strategy, depth, seed: {id,title}|null, status, createdAt}]}` |
|---|---|
| POST `/api/discovery/recommendations/:id/approve` (queues download, media.approved → Optional (P2)) / `/reject` | |
| POST `/api/discovery/run` | enqueue discovery now |
| POST `/api/history/import` | multipart file (json/html/zip, ≤200 MiB), field `queueDownloads=true|false` → `{imported, duplicates, skipped, matchedMedia, queued}` |
| GET `/api/history` | `{items:[{media: MediaSummary, positionSeconds, watchCount, lastWatchedAt, completed}]}` |

## Storage

| GET `/api/storage` | `{volumes: Volume[], byPriority, reservations:[{downloadId, title, bytes, writtenBytes}], thresholds:{soft, minFree}}` |
|---|---|
| POST `/api/storage/volumes` | `{path, name}` (validate + marker) ; PATCH `/api/storage/volumes/:id` `{name?, isDefault?, acceptsNew?}`; POST `/api/storage/volumes/:id/verify` |
| POST `/api/storage/simulate` | `{bytes, priority, volumeId?}` or `{sourceId, retention}` → simulation result (see storage-management.md) |
| GET `/api/storage/evictions` | `{items:[{id, planId, media:{id,title}, reason, previousPriority, reclaimedBytes, restorable, status, createdAt}]}` |
| POST `/api/storage/evictions/:id/restore` | re-queue download (clears cooldown) |
| POST `/api/storage/reconcile` | `{dryRun?: boolean (default true), volumeId?}` → 202 `{jobId}`. Poll `GET /api/storage/reconcile/:jobId` → `{state, result}` (404 after an hour). `result` is `{dryRun, found, rebuilt, missingFiles: {mediaId, canonicalKey, relativePath}[], orphans: {volumeId, relDir}[], duplicates: {canonicalKey, relDirs[]}[], issues: string[]}`. The Storage page shows the counts and an expandable list for each. |

## External players

| GET `/api/clients` | `{items:[{id,name,kind,username,status,allowXtream,allowM3u,lastUsedAt,lastIp,createdAt,rotatedAt}], serverUrl, xtreamEnabled, m3uEnabled}`. `serverUrl` is `PUBLIC_XTREAM_URL` if set, otherwise the request host with port `API_PORT_PUBLIC` (default `API_PORT`). |
|---|---|
| POST `/api/clients` | `{name, kind?:'xtream'|'extension', allowXtream?, allowM3u?}` → `{client, password, m3uUrl, xtream:{server, username, password}}` (plaintext once) |
| POST `/api/clients/:id/rotate` | → new password (once) |
| PATCH `/api/clients/:id` | `{name?, status?: 'active'|'disabled', allowXtream?, allowM3u?}` |
| DELETE `/api/clients/:id` | revoke |

## Activity & notifications

| GET `/api/activity?type=a,b&severity&q&entityType&entityId&before&limit` | `{items:[{id, at, type, severity, message, entityType, entityId, data}], nextCursor}` |
|---|---|
| GET `/api/notifications?open=true` | `{items:[{id,key,severity,title,body,remediation,count,createdAt,updatedAt,readAt,resolvedAt}], unread}` |
| POST `/api/notifications/:id/read`, `/api/notifications/read-all`, `/api/notifications/:id/resolve` | |

## Browser extension

`POST /api/ext/watch` with header `Authorization: Bearer <username>:<password>` of an `extension` client: `{url?, videoId?, watchedAt?, progressSeconds?}` → `{ok, mediaId|null}`. Not exempt from rate limits. CSRF header not required (no cookies used).

## Media-client protocols (no `/api` prefix)

See `docs/media-streaming.md`: `/player_api.php`, `/get.php`, `/xmltv.php`, `/movie/:u/:p/:id.:ext`, `/xtream-art/:u/:p/:mediaId.jpg`, `/healthz` (liveness, unauthenticated: `{ok:true}`), `/readyz` (DB reachable).
