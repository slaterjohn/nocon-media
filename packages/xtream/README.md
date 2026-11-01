# @nocon/xtream

Pure builders for an Xtream Codes-compatible VOD API and M3U playlists. No I/O, no framework.

Functions: `authResponse`, `authFailed`, `vodCategories`, `vodStreams(vods, categoryFilter?)`, `vodInfo`, `emptyList`, `shortEpg`, `xmltvEmpty`, `m3uPlaylist`, `movieUrl`, `parseMoviePath`, `formatDuration`.

## String vs numeric fields

Clients (UHF, TiviMate, IPTV Smarters) follow common panel output, so types are deliberate:

| Field | Type |
|---|---|
| `user_info.auth` | number (`1`/`0`) |
| `user_info.created_at`, `max_connections`, `active_cons`, `is_trial` | string |
| `user_info.exp_date` | `null` (never expires) |
| `server_info.port`, `https_port`, `rtmp_port` | string |
| `server_info.timestamp_now` | number; `time_now` string `YYYY-MM-DD HH:mm:ss` in the server timezone |
| `category_id` in categories and in stream rows | string |
| `parent_id` | number `0` |
| `stream_id`, `num`, `is_adult`, `rating_5based`, `duration_secs`, `category_ids[]` | number |
| `added` | string (unix seconds) |
| `rating`, `year`, `releaseDate` | string |
| `custom_sid` | `null`; `direct_source` is `""` |
| `episode_run_time` | number (minutes) |

`get_vod_info.info.video`/`audio` are `{}` when unknown.

## Streams repeat per category

`get_vod_streams` emits one entry per (stream, category) membership, and each entry's `category_id` is that category's id (`category_ids` still lists all of them). Single-category clients such as IPTVnator only read `category_id`, so this repetition is what fills virtual categories (Recently added, Favourites, topic categories, collections). `stream_id` is therefore not unique in the unfiltered list, and `num` is sequential. With `category_id=X` only the streams in X are returned, with `category_id` set to `X`. `get_vod_info.movie_data.category_id` stays the primary category, and the M3U playlist keeps one entry per stream with `group-title` set to the primary category.
