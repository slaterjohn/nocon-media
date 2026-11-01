# Media streaming

## HTTP direct play (`packages/streaming`)

`serveFile(req, reply, absPath, mime)`:

- `HEAD` and `GET`, `Accept-Ranges: bytes`, `Content-Length`, `ETag` (size-mtime), `Last-Modified`.
- Single `bytes=a-b`, `bytes=a-`, `bytes=-n` ranges → `206` with `Content-Range`. Unsatisfiable → `416` with `Content-Range: bytes */size`. Multi-range requests are served as the first range (clients we target never send them).
- `fs.createReadStream({start,end})` piped to the socket: constant memory, back-pressure, stream destroyed on client disconnect.
- Paths come only from `media_files.relative_path` joined to the volume mount through `resolveInside()`, which rejects anything resolving outside the volume (including via symlinks).
- Each request upserts a `stream_sessions` row (throttled to once per 15 s per session) so eviction can avoid media being watched.

Endpoints: `/api/media/:id/stream` (session cookie), `/movie/:user/:pass/:streamId.:ext` (Xtream credentials). M3U playlists link to the same `/movie/...` URLs.

## HLS

When `ENABLE_HLS=true`, `GET /api/media/:id/hls/index.m3u8` serves a cached rendition from `<media dir>/hls/`. If none exists, the API enqueues a `hls` job and returns `202`; the worker remuxes with `ffmpeg -c copy -f hls -hls_time 6 -hls_playlist_type vod` (no transcoding). The web player uses direct play for MP4/WebM/M4A and HLS only for containers browsers can’t play directly (MKV, etc.).

## M3U

`GET /get.php?username=U&password=P&type=m3u_plus&output=ts|mp4` returns `#EXTM3U` with one `#EXTINF:-1 tvg-id="" tvg-name="…" tvg-logo="…" group-title="<category>",Title` per playable item, pointing at `/movie/U/P/<id>.<ext>`. Uses the same external client credentials and `allow_m3u` flag.

## Xtream Codes-compatible VOD API (`packages/xtream`)

| Request | Response |
|---|---|
| `player_api.php?username&password` | `{user_info, server_info}`; invalid → `{"user_info":{"auth":0}}` |
| `action=get_vod_categories` | `[{category_id, category_name, parent_id:0}]` |
| `action=get_vod_streams[&category_id]` | `[{num, name, title, stream_type:"movie", stream_id, stream_icon, rating, rating_5based, added, category_id, category_ids, container_extension, custom_sid, direct_source:"", plot, year, duration_secs}]` |
| `action=get_vod_info&vod_id` | `{info:{…plot, duration, duration_secs, releasedate, genre, cover_big, movie_image, backdrop_path[]…}, movie_data:{stream_id, name, added, category_id, container_extension, custom_sid, direct_source}}` |
| `get_live_categories`, `get_live_streams`, `get_series_categories`, `get_series`, `get_short_epg`, `get_simple_data_table` | `[]` or `{epg_listings:[]}` so clients don’t error |
| `/xmltv.php` | empty `<tv/>` |

IDs are numbers (`media.stream_id`, a serial). Strings vs numbers follow what common panels emit (IDs as strings in categories, numbers in streams), because clients tolerate that mix and some reject the alternative.

Categories: `Recently added`, `Favourites`, one per subscribed channel/playlist source, one per collection, and one per media category tag (YouTube categories such as Music, Education, Science & Technology). A stream lists every category it belongs to in `category_ids` and its primary in `category_id`.

Unfiltered `get_vod_streams` repeats a stream once per category it belongs to, each entry carrying that category's `category_id` (and the full `category_ids`). Clients like IPTVnator only read `category_id`, so without the repeats virtual categories such as Recently added or Favourites would show no items. `category_id=X` returns just X's streams with `category_id` set to X; `get_vod_info` and the M3U playlist keep the primary category only.

Only media with availability `available` on an online volume are listed. Artwork URLs point to `/xtream-art/:user/:pass/:mediaId.jpg` on the same host, so artwork works offline.

`server_info.url`/`port` are taken from the request’s `Host` header (or `PUBLIC_XTREAM_URL`), so clients build stream URLs that reach this server.

## Client compatibility

Validated in automated tests: JSON shapes, auth failure, revocation, category filtering, range/seek on stream URLs. Validated with a real client: IPTVnator 0.24.0 (all ten checklist items, see `docs/acceptance.md`). Manual validation with UHF on Apple TV is a release checklist item in `docs/clients/uhf.md`; NoConMedia does not claim compatibility for clients that have not been tested.
