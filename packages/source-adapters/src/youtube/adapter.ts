import type { ErrorClass } from "@nocon/shared";
import { runProcess } from "../process.js";
import {
  AdapterError,
  type DiscoveredEntry,
  type DiscoverOptions,
  type IdentifiedSource,
  type MediaInfo,
  type SourceAdapter,
  type SourceInfo,
  type SourceKind,
} from "../types.js";
import { identifyYouTube } from "./identify.js";

export interface YouTubeAdapterOptions {
  ytDlpPath: string;
  extraArgs?: string[];
  cookiesFile?: string;
  timeoutMs?: number;
}

type Json = Record<string, any>;

const HEIGHT_BPS: [number, number][] = [
  [2160, 20_000_000],
  [1440, 10_000_000],
  [1080, 6_000_000],
  [720, 3_000_000],
  [480, 1_500_000],
  [360, 1_000_000],
];
const AUDIO_BPS = 200_000;
const FALLBACK_BYTES = 2 * 1024 * 1024 * 1024;

export function estimateBytes(info: Json): number {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const req: Json[] | undefined = Array.isArray(info.requested_formats) ? info.requested_formats : undefined;
  if (req && req.length) {
    const sum = req.reduce((a, f) => a + (num(f.filesize) || num(f.filesize_approx)), 0);
    if (sum > 0) return Math.round(sum);
  }
  if (num(info.filesize)) return Math.round(num(info.filesize));
  if (num(info.filesize_approx)) return Math.round(num(info.filesize_approx));
  const duration = num(info.duration);
  if (duration) {
    const height = num(info.height) || Math.max(0, ...((req ?? []).map((f) => num(f.height))));
    let bps = AUDIO_BPS;
    if (height) {
      bps = HEIGHT_BPS[HEIGHT_BPS.length - 1]![1];
      for (const [h, b] of HEIGHT_BPS) {
        if (height >= h) {
          bps = b;
          break;
        }
      }
    } else if (info.vcodec && info.vcodec !== "none") bps = 3_000_000;
    return Math.round((duration * bps) / 8);
  }
  return FALLBACK_BYTES;
}

function parseDate(e: Json): Date | undefined {
  const ud = e.upload_date;
  if (typeof ud === "string" && /^\d{8}$/.test(ud)) {
    return new Date(Date.UTC(+ud.slice(0, 4), +ud.slice(4, 6) - 1, +ud.slice(6, 8)));
  }
  const ts = e.timestamp ?? e.release_timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts * 1000);
  return undefined;
}

function pickThumb(e: Json): string | undefined {
  if (typeof e.thumbnail === "string") return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) {
    const withUrl = e.thumbnails.filter((t: Json) => typeof t?.url === "string");
    if (!withUrl.length) return undefined;
    const sorted = [...withUrl].sort((a: Json, b: Json) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
    return sorted[0].url;
  }
  return undefined;
}

export function mapFlatEntry(e: Json, forceShort: boolean, fallbackChannel?: { id?: string; name?: string }): DiscoveredEntry | null {
  const id = typeof e?.id === "string" ? e.id : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const url = typeof e.url === "string" && /^https?:\/\//.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${id}`;
  const liveStatus = e.live_status;
  const entry: DiscoveredEntry = {
    externalId: id,
    canonicalKey: `youtube:${id}`,
    url,
    title: typeof e.title === "string" ? e.title : id,
    isShort: forceShort || /\/shorts\//.test(url),
    isLive: liveStatus === "is_live" || liveStatus === "is_upcoming" || e.is_live === true,
  };
  if (typeof e.duration === "number") entry.durationSeconds = Math.round(e.duration);
  const d = parseDate(e);
  if (d) entry.publishedAt = d;
  const cid = e.channel_id ?? fallbackChannel?.id;
  if (typeof cid === "string") entry.channelId = cid;
  const cname = e.channel ?? e.uploader ?? fallbackChannel?.name;
  if (typeof cname === "string") entry.channelName = cname;
  if (typeof e.playlist_index === "number") entry.position = e.playlist_index;
  const th = pickThumb(e);
  if (th) entry.thumbnailUrl = th;
  if (typeof e.view_count === "number") entry.viewCount = e.view_count;
  if (typeof e.description === "string") entry.description = e.description;
  return entry;
}

export function classifyYouTubeError(stderr: string): ErrorClass {
  const s = stderr.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => s.includes(n.toLowerCase()));
  if (has("HTTP Error 429", "rate-limit", "rate limit", "confirm you’re not a bot", "confirm you're not a bot")) return "rate_limited";
  if (has("Private video", "members-only", "Sign in to confirm your age", "Join this channel")) return "private";
  if (has("Video unavailable", "has been removed", "not available", "does not exist", "account associated with this video has been terminated")) return "unavailable";
  if (has("Unable to download webpage", "getaddrinfo", "timed out", "Network is unreachable", "Connection refused", "Temporary failure in name resolution", "Connection reset")) return "network";
  return "unknown";
}

export class YouTubeAdapter implements SourceAdapter {
  readonly platform = "youtube";
  readonly capabilities = { channel: true, playlist: true, video: true, search: true, related: false };

  constructor(private readonly opts: YouTubeAdapterOptions) {}

  identify(input: string): IdentifiedSource | null {
    return identifyYouTube(input);
  }

  classifyError(stderr: string): ErrorClass {
    return classifyYouTubeError(stderr);
  }

  private baseArgs(): string[] {
    const a = ["--ignore-config", "--no-warnings"];
    if (process.env.NOCON_YTDLP_NO_JS_RUNTIME !== "1") a.push("--js-runtimes", "node");
    if (this.opts.cookiesFile) a.push("--cookies", this.opts.cookiesFile);
    a.push(...(this.opts.extraArgs ?? []));
    return a;
  }

  private async runJson(args: string[], target: string, signal?: AbortSignal): Promise<Json> {
    const full = [...this.baseArgs(), ...args, "--", target];
    const res = await runProcess(this.opts.ytDlpPath, full, {
      timeoutMs: this.opts.timeoutMs ?? 180_000,
      signal,
      maxStdoutBytes: 128 * 1024 * 1024,
    });
    if (res.exitCode !== 0) {
      const cls = res.timedOut ? "network" : this.classifyError(res.stderrTail);
      throw new AdapterError(`yt-dlp failed (exit ${res.exitCode}): ${res.stderrTail.slice(-500)}`, cls, res.stderrTail);
    }
    try {
      return JSON.parse(res.stdout) as Json;
    } catch {
      throw new AdapterError("yt-dlp returned invalid JSON", "unknown", res.stderrTail);
    }
  }

  private async listing(url: string, limit: number, offset: number, forceShort: boolean, signal?: AbortSignal, numbered = false): Promise<DiscoveredEntry[]> {
    const args = ["--flat-playlist", "-J"];
    if (offset > 0) args.push("--playlist-start", String(offset + 1));
    args.push("--playlist-end", String(offset + limit));
    const json = await this.runJson(args, url, signal);
    const entries: Json[] = Array.isArray(json.entries) ? json.entries : [];
    const fallback = typeof json.channel_id === "string" ? { id: json.channel_id, name: json.channel ?? json.uploader } : undefined;
    const out: DiscoveredEntry[] = [];
    for (const [i, e] of entries.entries()) {
      const m = mapFlatEntry(e, forceShort, fallback);
      if (!m) continue;
      // Live `--flat-playlist -J` entries carry no playlist_index, so number them from their place in the list.
      if (numbered && m.position === undefined) m.position = offset + i + 1;
      out.push(m);
    }
    return out;
  }

  async discover(src: IdentifiedSource, opts: DiscoverOptions = {}): Promise<DiscoveredEntry[]> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    if (src.type === "playlist") return this.listing(src.canonicalUrl, limit, offset, false, opts.signal, true);
    if (src.type === "video") {
      return [
        {
          externalId: src.externalId,
          canonicalKey: `youtube:${src.externalId}`,
          url: src.canonicalUrl,
          title: src.externalId,
          isShort: false,
          isLive: false,
        },
      ];
    }
    if (src.type !== "channel") throw new AdapterError("Cannot discover this source type", "invalid");
    const base = src.canonicalUrl.replace(/\/+$/, "");
    const tabs: { path: string; short: boolean }[] = [{ path: "videos", short: false }];
    if (opts.includeShorts) tabs.push({ path: "shorts", short: true });
    if (opts.includeLive) tabs.push({ path: "streams", short: false });
    const seen = new Set<string>();
    const all: DiscoveredEntry[] = [];
    for (const t of tabs) {
      let list: DiscoveredEntry[];
      try {
        list = await this.listing(`${base}/${t.path}`, limit, offset, t.short, opts.signal);
      } catch (e) {
        // Missing optional tabs (no shorts/streams) are not fatal.
        if (t.path !== "videos" && e instanceof AdapterError && (e.errorClass === "unavailable" || e.errorClass === "unknown")) continue;
        throw e;
      }
      for (const x of list) {
        if (seen.has(x.externalId)) continue;
        seen.add(x.externalId);
        all.push(x);
      }
    }
    return all;
  }

  async fetchSourceInfo(src: IdentifiedSource, opts: { signal?: AbortSignal } = {}): Promise<SourceInfo> {
    if (src.type === "video") {
      const mi = await this.fetchMediaInfo(src.canonicalUrl, opts);
      return { title: mi.title, description: mi.description, avatarUrl: null, bannerUrl: mi.thumbnailUrl, channelId: mi.channel.id, channelName: mi.channel.name };
    }
    const target = src.type === "channel" ? `${src.canonicalUrl.replace(/\/+$/, "")}/videos` : src.canonicalUrl;
    const json = await this.runJson(["--flat-playlist", "-J", "--playlist-end", "1"], target, opts.signal);
    return mapSourceInfo(json, src.type);
  }

  async fetchMediaInfo(url: string, opts: { signal?: AbortSignal } = {}): Promise<MediaInfo> {
    // Never hand an unvetted URL (e.g. one read from a sidecar) to yt-dlp: only YouTube video URLs, normalised.
    const id = this.identify(url);
    if (!id || id.type !== "video") throw new AdapterError("Refusing to fetch a URL that is not a YouTube video", "invalid");
    const json = await this.runJson(["-J", "--no-playlist"], id.canonicalUrl, opts.signal);
    return mapMediaInfo(json);
  }

  async search(query: string, limit: number, opts: { signal?: AbortSignal } = {}): Promise<DiscoveredEntry[]> {
    const q = query.replace(/[\r\n\0]/g, " ").trim();
    if (!q) return [];
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    const json = await this.runJson(["--flat-playlist", "-J"], `ytsearch${n}:${q}`, opts.signal);
    const out: DiscoveredEntry[] = [];
    for (const e of Array.isArray(json.entries) ? json.entries : []) {
      const m = mapFlatEntry(e, false);
      if (m) out.push(m);
    }
    return out;
  }
}

export function mapSourceInfo(json: Json, type?: SourceKind): SourceInfo {
  const thumbs: Json[] = Array.isArray(json.thumbnails) ? json.thumbnails.filter((t: Json) => typeof t?.url === "string") : [];
  const byId = (id: string) => thumbs.find((t) => t.id === id)?.url as string | undefined;
  const avatar =
    byId("avatar_uncropped") ?? thumbs.find((t) => typeof t.id === "string" && /avatar/.test(t.id))?.url ?? thumbs.find((t) => t.width && t.height && t.width === t.height)?.url ?? null;
  const banner =
    byId("banner_uncropped") ?? thumbs.find((t) => typeof t.id === "string" && /banner/.test(t.id))?.url ?? thumbs.find((t) => t.width && t.height && t.width > t.height * 3)?.url ?? null;
  const info: SourceInfo = {
    // A playlist is named by its own title; a channel listing by the channel name (its title is "<name> - Videos").
    title: String(type === "playlist" ? (json.title ?? json.channel ?? "") : (json.channel ?? json.title ?? json.uploader ?? "")),
    description: String(json.description ?? ""),
    avatarUrl: avatar ?? null,
    bannerUrl: banner ?? null,
  };
  if (typeof json.channel_id === "string") info.channelId = json.channel_id;
  const cn = json.channel ?? json.uploader;
  if (typeof cn === "string") info.channelName = cn;
  return info;
}

export function mapMediaInfo(json: Json): MediaInfo {
  const chapters = (Array.isArray(json.chapters) ? json.chapters : [])
    .filter((c: Json) => typeof c?.start_time === "number")
    .map((c: Json) => ({ start: c.start_time as number, end: typeof c.end_time === "number" ? c.end_time : c.start_time, title: String(c.title ?? "") }));
  const subs = new Set<string>();
  for (const k of Object.keys(json.subtitles ?? {})) subs.add(k);
  const channelId = String(json.channel_id ?? json.uploader_id ?? "");
  return {
    title: String(json.title ?? ""),
    description: String(json.description ?? ""),
    channel: {
      id: channelId,
      name: String(json.channel ?? json.uploader ?? ""),
      url: String(json.channel_url ?? (channelId ? `https://www.youtube.com/channel/${channelId}` : "")),
    },
    publishedAt: parseDate(json) ?? null,
    durationSeconds: typeof json.duration === "number" ? Math.round(json.duration) : 0,
    categories: Array.isArray(json.categories) ? json.categories.map(String) : [],
    tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
    language: typeof json.language === "string" ? json.language : null,
    chapters,
    thumbnailUrl: pickThumb(json) ?? null,
    subtitleLanguages: [...subs],
    estimatedBytes: estimateBytes(json),
    isLive: json.is_live === true || json.live_status === "is_live",
    raw: json,
  };
}
