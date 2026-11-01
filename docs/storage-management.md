# Storage management

Implemented in `packages/storage-manager`. The planner (`planner.ts`) is pure and takes plain data, so every rule below has a unit test. `service.ts` wires the planner to Postgres and the filesystem.

## Effective priority

The codes are stored and sent over the API as `P0` to `P3`. The app shows them as Protected (P0), Keep (P1), Optional (P2) and Spare (P3); see [Storage and eviction](guides/storage.md#priorities).

```
effectivePriority(media) = min(
  P0                     if media.pinned,
  media.manual_priority  if set,
  source.priority        for each linked source that is not deleted,
  P2                     if watched locally / imported history / approved recommendation,
  P3                     otherwise
)
```

Recomputed whenever links, pins, manual priority, history or source priority change (`recomputeEffectivePriority`). Stored on `media.effective_priority` for indexed queries.

## Retention

Retention is per source and independent of priority. Each linked source answers “do I retain this media?”.

| Mode | Retains |
|---|---|
| `all` | every downloaded media item of the source |
| `none` | nothing (default for history and discovery sources) |
| `latest_n` | the N newest by publish date |
| `last_days` | items published within N days |
| `quota` | newest items whose cumulative size ≤ quota bytes |
| `rolling` | as `latest_n`, and maintenance actively evicts the excess |
| `prefer_unwatched` | unwatched items; watched items become eligible |

A media item is **retention-protected** if any linked source retains it or `media.retain_override` is true.

## Eligibility

A media item can be reclaimed for an incoming download of priority *p* when all hold:

1. It is not Protected (P0, pinned).
2. It is not retention-protected.
3. Its effective priority is the same as or lower than *p* (Keep (P1) can reclaim unretained P1, P2 and P3; Spare (P3) can only reclaim P3).
4. It has no active stream session (`last_seen_at` within 90 s).
5. It is not being processed (no download in `processing`/`verifying` for it, no HLS job).
6. It is on the target volume and that volume is online.
7. The incoming source has `automatic_eviction = true` (otherwise nothing is eligible).

## Ordering (deterministic)

Candidates are sorted by, in order:

1. Priority, lowest first (P3 Spare before P2 Optional before P1 Keep)
2. Retention eligibility (items no source retains before items only `retain_override` protects — always eligible here)
3. User protection: non-favourites before favourites
4. Last watched, oldest/never first
5. Watch count, ascending
6. Age (`downloaded_at`), oldest first
7. Recommendation score, ascending
8. File size, largest first
9. Media id, ascending (tie-breaker)

## Capacity

```
limit_bytes(p) = total × (soft_threshold%)            for P3
               = total × (100 − min_free%)            for P0–P2
used_bytes     = total − free (statfs)
reserved       = Σ max(0, reservation.bytes − reservation.written_bytes) of active reservations
available(p)   = limit_bytes(p) − used_bytes − reserved
required       = estimate × 1.10 + 64 MiB processing overhead
```

If `available ≥ required` → reserve and go. Otherwise `to_reclaim = required − available`; walk the ordered candidates until reclaimed ≥ to_reclaim. If the eligible total is too small the plan is **insufficient** and nothing is deleted.

## Download admission sequence

Inside a transaction holding `pg_advisory_xact_lock(volume)`:

1. Confirm media is still wanted (download not cancelled; not already `ready`).
2. Compute required bytes, read statfs and active reservations.
3. Build the plan from candidates.
4. Insufficient → download `waiting_for_storage`, notification `storage:full:<volume>`, retry only when storage changes (maintenance re-checks waiting downloads every 10 min, with no tight loop).
5. Write `eviction_records` (status `planned`) and the reservation, commit.
6. Outside the transaction: delete planned files, mark records `completed`, set media `evicted`, set `redownload_after = now + cooldown`.

Metadata is never deleted by eviction.

## Reservations

Created at admission, `written_bytes` updated from download progress, released on ready, failure or cancellation. If a download grows beyond its reservation, the worker asks for an extension; if refused the download moves to `waiting_for_storage`. On boot, reservations whose download is not in an active state are released (stale-reservation recovery).

## Interrupted eviction

`planned` records found at boot: if the file is already gone → mark completed and set media evicted; if present → re-run the deletion (the plan was committed so the space was promised).

## Soft-threshold maintenance

Every 15 min, per online volume: if usage > soft threshold, reclaim P3 media (same ordering, `reason = soft_threshold`) down to the threshold. Sources in `rolling` mode have excess items evicted (`reason = retention_rolling`).

## Simulation

`POST /api/storage/simulate` with `{ bytes, priority, volumeId?, sourceId? }` or `{ policyChange: {sourceId, retention} }` runs the planner without writing and returns required, available, candidates, reclaimable total, resulting free space, affected sources and the media list.

## Missing volumes

Each volume has `.noconmedia/volume.json` containing its UUID. A volume is online only when the marker exists and matches. When it disappears: volume marked offline, downloads targeting it move to `paused` (reason `volume_offline`), writes stop, files are not treated as deleted, media show *temporarily unavailable*, Xtream hides them, notification raised. On reconnect the maintenance job marks it online and resumes paused downloads.
