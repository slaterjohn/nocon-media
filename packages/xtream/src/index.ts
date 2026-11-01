export interface XtreamUser { username: string; password: string; createdAt: Date; status: string }
export interface ServerCtx { host: string; port: number; protocol: "http" | "https"; timezone: string; now: Date }
export interface XtreamCategory { id: number; name: string }
export interface XtreamVod {
  streamId: number; title: string; description: string; thumbnailUrl: string; backdropUrl?: string;
  categoryIds: number[]; addedAt: Date; publishedAt?: Date; durationSeconds?: number;
  containerExtension: string; genre?: string; channelName?: string; rating?: string | number;
  video?: { codec: string; width: number; height: number }; audio?: { codec: string }; bitrate?: number;
}

const unix = (d: Date): number => Math.floor(d.getTime() / 1000);
const pad = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function timeNow(d: Date, timezone: string): string {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(d).map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return `${ymd(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
}

export function formatDuration(totalSeconds: number | undefined): string {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function authResponse(user: XtreamUser, ctx: ServerCtx) {
  const isHttps = ctx.protocol === "https";
  return {
    user_info: {
      username: user.username, password: user.password, message: "", auth: 1, status: "Active", exp_date: null,
      is_trial: "0", active_cons: "0", created_at: String(unix(user.createdAt)), max_connections: "10",
      allowed_output_formats: ["m3u8", "ts", "mp4"],
    },
    server_info: {
      url: ctx.host, port: String(ctx.port), https_port: isHttps ? String(ctx.port) : "", server_protocol: ctx.protocol,
      rtmp_port: "0", timezone: ctx.timezone, timestamp_now: unix(ctx.now), time_now: timeNow(ctx.now, ctx.timezone), process: true,
    },
  };
}

export function authFailed() { return { user_info: { auth: 0 } }; }

export function vodCategories(cats: XtreamCategory[]) {
  return cats.map((c) => ({ category_id: String(c.id), category_name: c.name, parent_id: 0 }));
}

/**
 * One row per (stream, category) membership. Clients such as IPTVnator only read `category_id`, so a stream that
 * belongs to several categories is repeated, once per category. With a filter only that category's rows are returned.
 */
export function vodStreams(vods: XtreamVod[], categoryFilter?: number | string) {
  const filter = categoryFilter === undefined || categoryFilter === "" ? undefined : Number(categoryFilter);
  const rows: Array<{ v: XtreamVod; cat: number | undefined }> = [];
  for (const v of vods) {
    if (filter !== undefined && !Number.isNaN(filter)) {
      if (v.categoryIds.includes(filter)) rows.push({ v, cat: filter });
    } else if (v.categoryIds.length === 0) rows.push({ v, cat: undefined });
    else for (const cat of v.categoryIds) rows.push({ v, cat });
  }
  return rows.map(({ v, cat }, i) => ({
    num: i + 1, name: v.title, title: v.title, stream_type: "movie", stream_id: v.streamId, stream_icon: v.thumbnailUrl,
    rating: "", rating_5based: 0, added: String(unix(v.addedAt)), is_adult: 0,
    category_id: cat === undefined ? "" : String(cat), category_ids: v.categoryIds, container_extension: v.containerExtension,
    custom_sid: null, direct_source: "", plot: v.description,
    year: v.publishedAt ? String(v.publishedAt.getUTCFullYear()) : "",
    releaseDate: v.publishedAt ? ymd(v.publishedAt) : "",
    duration_secs: v.durationSeconds ?? 0, duration: formatDuration(v.durationSeconds),
  }));
}

export function vodInfo(v: XtreamVod) {
  const release = v.publishedAt ? ymd(v.publishedAt) : "";
  return {
    info: {
      kinopoisk_url: "", tmdb_id: "", name: v.title, o_name: v.title, cover_big: v.thumbnailUrl, movie_image: v.thumbnailUrl,
      release_date: release, releasedate: release, episode_run_time: Math.round((v.durationSeconds ?? 0) / 60),
      youtube_trailer: "", director: v.channelName ?? "", actors: "", cast: v.channelName ?? "",
      description: v.description, plot: v.description, age: "", country: "", genre: v.genre ?? "",
      backdrop_path: v.backdropUrl ? [v.backdropUrl] : [], duration_secs: v.durationSeconds ?? 0,
      duration: formatDuration(v.durationSeconds),
      video: v.video ? { codec_name: v.video.codec, width: v.video.width, height: v.video.height } : {},
      audio: v.audio ? { codec_name: v.audio.codec } : {},
      bitrate: v.bitrate ?? 0, rating: "",
    },
    movie_data: {
      stream_id: v.streamId, name: v.title, title: v.title, added: String(unix(v.addedAt)),
      category_id: String(v.categoryIds[0] ?? ""), category_ids: v.categoryIds,
      container_extension: v.containerExtension, custom_sid: null, direct_source: "",
    },
  };
}

export function emptyList(): never[] { return []; }
export function shortEpg() { return { epg_listings: [] as never[] }; }
export function xmltvEmpty(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="NoConMedia"></tv>';
}

export function movieUrl(baseUrl: string, username: string, password: string, id: number | string, ext: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${encodeURIComponent(ext)}`;
}

const attr = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/"/g, "'");
const text = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

export function m3uPlaylist(o: { baseUrl: string; username: string; password: string; vods: XtreamVod[]; categories: XtreamCategory[] }): string {
  const names = new Map(o.categories.map((c) => [c.id, c.name]));
  let out = "#EXTM3U\n";
  for (const v of o.vods) {
    const group = names.get(v.categoryIds[0] ?? -1) ?? "";
    out += `#EXTINF:-1 tvg-id="" tvg-name="${attr(v.title)}" tvg-logo="${attr(v.thumbnailUrl)}" group-title="${attr(group)}",${text(v.title)}\n`;
    out += `${movieUrl(o.baseUrl, o.username, o.password, v.streamId, v.containerExtension)}\n`;
  }
  return out;
}

export function parseMoviePath(p: string): { username: string; password: string; streamId: number; ext: string } | null {
  const m = /^\/movie\/([^/]+)\/([^/]+)\/(\d+)\.([A-Za-z0-9]+)$/.exec(p.split("?")[0]!);
  if (!m) return null;
  try {
    return { username: decodeURIComponent(m[1]!), password: decodeURIComponent(m[2]!), streamId: Number(m[3]), ext: m[4]!.toLowerCase() };
  } catch { return null; }
}
