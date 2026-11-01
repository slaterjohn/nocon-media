# @nocon/storage-manager

Implements `docs/storage-management.md`. `planner.ts` is pure; `volumes.ts` is filesystem helpers; `service.ts` wires both to Postgres.

```ts
import { StorageService, requiredBytes, initVolume } from "@nocon/storage-manager";
const storage = new StorageService({ db, config: { softThresholdPct, minFreePct, statfsOverrideBytes?, cooldownDays }, activeStreamWindowSec: 90 });
```

## StorageService

| Method | Notes |
|---|---|
| `refreshVolume(id): Promise<VolumeTransition>` / `refreshAllVolumes()` | Verifies marker + statfs, updates `storage_volumes`. `transition` is `"went_offline"`, `"came_online"` or `null`. Offline: pauses queued/checking/downloading/waiting_for_storage downloads (`paused`, `waitingReason: "volume_offline"`), raises `volume:offline:<id>`. Online: resolves it, moves those downloads to `queued`. `resumedDownloadIds` is what the worker must re-enqueue. |
| `loadCandidates(volumeId)` | Available media on the volume with retention/stream/processing flags. |
| `admitDownload({downloadId, mediaId, priority, autoEvict, estimatedBytes, volumeId?})` | Call while the download is `checking`. Returns `{status:"admitted", volumeId, reservationId, evictionPlanId?, evictions[]}` (evictions already executed), `{status:"insufficient", requiredBytes, volumeId, availableBytes, eligibleBytes, shortfallBytes, volumes[], reason?:"no_volume"}` or `{status:"rejected", reason}`. On insufficient it sets the download to `waiting_for_storage` (+ download_event) and raises `storage:full:<volume>`. Idempotent: an existing active reservation is returned. Sets `downloads.volume_id`. Safe under concurrency (advisory lock per volume). |
| `executeEvictions(planId)` | Deletes dirs, `media_files`, sets media `evicted` + `redownload_after`. Offline volume leaves the record `planned` (`skipped`). |
| `recoverInterruptedEvictions()` | Boot: re-runs all `planned` records. Idempotent. |
| `updateReservationProgress(downloadId, writtenBytes)` | |
| `extendReservation(downloadId, newTotalBytes): Promise<boolean>` | Pass `requiredBytes(newEstimate)`. Never evicts. `false` means move the download to `waiting_for_storage`. |
| `releaseReservation(downloadId, reason)` | Call on ready / failed / cancelled. |
| `releaseStaleReservations(): Promise<string[]>` | Releases reservations whose download is not checking/downloading/processing/verifying. Call on boot and from maintenance. |
| `simulate({bytes, priority, volumeId?, autoEvict?})` | No writes. `{volumeId, requiredBytes, availableBytes, totalBytes, candidates[{mediaId,title,sizeBytes,priority,sources}], reclaimedBytes, resultingAvailable, sufficient, affectedSources[]}`. |
| `simulatePolicyChange({sourceId, retention})` | `{losingProtection[], totalBytes}`. |
| `softThresholdCleanup(volumeId)` / `rollingRetentionCleanup()` | `{planId, evicted, reclaimedBytes}`; reasons `soft_threshold` / `retention_rolling`. |
| `usageByPriority(volumeId?)` | `{P0,P1,P2,P3}` bytes of available media. |
| `manualEvict(mediaId, reason = "manual")` | Explicit deletion, allowed for Protected (P0) and in-use media. Returns summary or `null` if not available. |

## Planner (pure)

`retainedBySource`, `rollingExcess`, `isEligible`, `compareCandidates`, `limitBytes`, `availableBytes`, `requiredBytes`, `buildPlan`, `buildSoftThresholdPlan`.

## Volumes

`statVolume(path, overrideTotalBytes?)`, `initVolume(root, id, name)`, `verifyVolume(root, expectedId)`, `readMarker`, `mountInfo(path)`, `onRootFilesystem(path)`.

With an override, free space = override minus bytes stored under the path (sparse files count by apparent size), which simulates a small disk in tests.
