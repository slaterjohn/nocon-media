# Source adapters

`packages/source-adapters` defines the contract every provider implements.

```ts
interface SourceAdapter {
  platform: string;                                    // "youtube"
  capabilities: { channel: boolean; playlist: boolean; video: boolean;
                  search: boolean; related: boolean };
  identify(input: string): IdentifiedSource | null;     // validate URL/handle → type + externalId + canonical URL
  fetchSourceInfo(src): Promise<SourceInfo>;           // title, description, avatar/banner URLs
  discover(src, opts): Promise<DiscoveredEntry[]>;     // listing, newest first (limit/offset in opts)
  fetchMediaInfo(url): Promise<MediaInfo>;             // full metadata + formats + size estimate
  search?(query, limit): Promise<DiscoveredEntry[]>;
  classifyError(stderr: string): ErrorClass;           // unavailable | private | rate_limited | network | auth | unknown
}
```

Adapters never touch storage, eviction or the database. The worker owns persistence.

## YouTube adapter

Backed by yt-dlp (invoked with `execFile`-style argument arrays, never a shell).

| Capability | yt-dlp call |
|---|---|
| Channel | `--flat-playlist -J --playlist-end N https://www.youtube.com/channel/<id>/videos` (also `/shorts`, `/streams` when enabled) |
| Playlist | `--flat-playlist -J <playlist url>` — keeps `playlist_index` for ordering |
| Video | `-J --no-playlist <url>` |
| Search | `-J --flat-playlist "ytsearchN:<query>"` |
| Related | **not reliable** — yt-dlp does not expose YouTube related videos. Discovery uses channel and search strategies instead. |

Accepted inputs: `youtube.com/@handle`, `/channel/UC…`, `/c/…`, `/user/…`, `/playlist?list=…`, `/watch?v=…`, `youtu.be/…`, `/shorts/…`, bare `@handle`, bare `UC…` IDs. Host allowlist: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`. Anything else is rejected before yt-dlp sees it.

Rate limiting: one yt-dlp metadata process at a time in the lightweight profile, `--sleep-requests 1` for listings, and backoff on `rate_limited` errors (source next run pushed out exponentially, capped at 24 h).

Current yt-dlp needs a JavaScript runtime for YouTube. The worker image ships Node.js already and passes `--js-runtimes node`; `yt-dlp[default]` includes the `yt-dlp-ejs` solver scripts, so no network fetch is needed for them.

Authentication: the adapter and downloader accept a `cookiesFile` (passed to yt-dlp as `--cookies`) read from a source's `metadata.cookiesFile`. `PUT /api/sources/:id/cookies` sets that field (see `docs/guides/sources.md#cookies`). Only for content the user is entitled to; no DRM circumvention.

## Filters (applied by the worker before queueing)

`maxAgeDays`, `minDurationSec`, `maxDurationSec`, `maxHistorical`, `maxNewPerRun`, `includeShorts`, `includeLive`, `requiredKeywords[]`, `excludedKeywords[]`, `preferredLanguage`. Download options: `resolution` (`2160|1440|1080|720|480|360`), `audioOnly`, `subtitles {enabled, languages[], auto}`. Discovery options: `depth` 0–2, `maxRecommendations`.

## Takeout import

`parseTakeout(buffer, filename)` accepts `watch-history.json`, `watch-history.html`, or the Takeout `.zip` (searched for those files). Returns `{videoId, watchedAt, title, channel}` entries; non-video entries (ads, removed videos without IDs) are counted as skipped.

## Future adapters

RSS/podcasts, direct URLs and other yt-dlp sites slot in by implementing the same interface with honest `capabilities`. A generic adapter must call `assertPublicHttpUrl` (DNS-resolving SSRF guard) because it cannot use a host allowlist.
