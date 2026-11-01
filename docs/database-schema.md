# Database schema

PostgreSQL 17, Drizzle ORM, SQL migrations in `packages/database/drizzle/`. The authoritative definition is `packages/database/src/schema.ts`; this document explains intent.

## Entity map

| Spec entity | Table | Notes |
|---|---|---|
| Users | `users` | Local admin accounts (scrypt hashes). Multi-profile is a future enhancement. |
| Sessions | `sessions` | `id` = SHA-256 of the cookie token. Revocable. |
| Sources, schedules, policies | `sources` | Schedule, retention, filters and download options are typed `jsonb` columns validated by zod. One row per source keeps reads simple and policies atomic with the source. |
| Source sync runs | `source_runs` | |
| Media + metadata | `media` | One canonical row per `canonical_key` (`youtube:<videoId>`). Full-text `search` column (generated `tsvector`). |
| Creators (channels) | `creators` | Channel name, avatar and banner artwork. |
| Media-source relationships | `media_sources` | PK `(media_id, source_id)`, playlist position, discovery depth. |
| Media files, artwork, subtitles | `media_files` | `kind` ∈ video, audio, thumbnail, subtitle, sidecar, hls, avatar, banner. Unique `(volume_id, relative_path)`. |
| Chapters | `chapters` | |
| Collections, playlists | `collections`, `collection_items` | `kind` ∈ collection, playlist. Platform playlists are sources. |
| Downloads, attempts | `downloads`, `download_attempts`, `download_events` | `download_events` persists every state transition. |
| Storage volumes | `storage_volumes` | |
| Storage reservations | `storage_reservations` | |
| Eviction records | `eviction_records` | `plan_id` groups one plan. |
| Playback history | `playback_history`, `watch_events` | `playback_history` is per media (resume, counts). `watch_events` stores imported/extension events deduped on `(canonical_key, watched_at)`. |
| Recommendations | `recommendations` | Score and explanation. |
| Discovery relationships | `discovery_relationships` | Edge from seed to discovered media with strategy. |
| External clients | `external_clients` | Xtream/M3U and extension credentials. |
| Activity events | `activity_events` | |
| Notifications | `notifications` | Deduped by `key` while unresolved. |
| Stream sessions | `stream_sessions` | Active playback detection for eviction safety. |
| System settings | `settings` | Key/value `jsonb`. |

## Key constraints and indexes

- `media.canonical_key` unique → one record per video regardless of how many sources reference it.
- `downloads_active_media_uq`: unique index on `downloads(media_id)` where `state` not in (`ready`, `failed`, `evicted`, `unavailable`). Two jobs can never download the same media concurrently.
- `storage_reservations.download_id` unique where `released_at is null`.
- `media_files (volume_id, relative_path)` unique → no duplicate physical file rows.
- `watch_events (canonical_key, watched_at, origin)` unique → Takeout imports are idempotent.
- `external_clients.username` unique.
- `media.search` GIN index; `media (availability, effective_priority)`, `media (published_at)`, `media (created_at)` btree.
- `activity_events (at desc)`, `(type, at desc)`.
- All foreign keys `on delete cascade` from child rows of media/sources, except `eviction_records.media_id` (restrict — media rows are never deleted while history exists) and `downloads.source_id` (set null).

## Enumerations

- `priority`: `P0` `P1` `P2` `P3` (lower number = more important). Shown in the app as Protected, Keep, Optional and Spare.
- `download_state`: `discovered queued checking waiting_for_storage downloading processing verifying ready paused failed unavailable evicted`.
- `media_availability`: `discovered queued downloading available evicted unavailable failed`. *Temporarily unavailable* is derived at query time: `available` media whose primary file is on an offline volume.
- `source_type`: `channel playlist video search history discovery`.
- `source_status`: `active paused error`.

## Migrations

Generated with `drizzle-kit generate`, committed, and applied by the API on start (`migrate()` from `drizzle-orm/node-postgres/migrator`, which runs in a transaction and records applied hashes in `drizzle.__drizzle_migrations`). The API takes a Postgres advisory lock around migration so two replicas cannot race. Migrations are additive; destructive changes require a two-step migration. See `docs/database-migrations.md`.
