#!/usr/bin/env node
// Fake yt-dlp for deterministic offline tests. Mimics the subset of the CLI NoConMedia uses.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const env = process.env;
// Tests can record every invocation (one JSON array of args per line) to assert on the flags passed.
if (env.FAKE_YTDLP_ARGS_LOG) fs.appendFileSync(env.FAKE_YTDLP_ARGS_LOG, JSON.stringify(argv) + "\n");
const FFMPEG = env.FFMPEG_PATH || "ffmpeg";

const DEFAULT_CHANNEL = "UCfakechannel0000000000a";
const mkVideo = (id, n, extra = {}) => ({
  id,
  title: `Fake video ${n}`,
  description: `Description for fake video ${n}`,
  duration: 2 + n,
  upload_date: `2026100${n}`,
  timestamp: Date.UTC(2026, 9, n, 12, 0, 0) / 1000,
  channel_id: DEFAULT_CHANNEL,
  channel: "Fake Channel",
  uploader: "Fake Channel",
  channel_url: `https://www.youtube.com/channel/${DEFAULT_CHANNEL}`,
  live_status: "not_live",
  view_count: 100 * n,
  categories: ["Education"],
  tags: ["fake", `tag${n}`],
  language: "en",
  chapters: [
    { start_time: 0, end_time: 1, title: "Intro" },
    { start_time: 1, end_time: 2 + n, title: "Main" },
  ],
  ...extra,
});
const defaultVideos = { fakevid0001: mkVideo("fakevid0001", 1), fakevid0002: mkVideo("fakevid0002", 2), fakevid0003: mkVideo("fakevid0003", 3) };
const defaultCatalog = {
  channels: { [DEFAULT_CHANNEL]: { title: "Fake Channel", entries: ["fakevid0001", "fakevid0002", "fakevid0003"] } },
  playlists: { PLfakeplaylist0001: { title: "Fake Playlist", entries: ["fakevid0001", "fakevid0002"] } },
  videos: defaultVideos,
};
let catalog = defaultCatalog;
if (env.FAKE_YTDLP_CATALOG) catalog = JSON.parse(fs.readFileSync(env.FAKE_YTDLP_CATALOG, "utf8"));
catalog.channels ??= {};
catalog.playlists ??= {};
catalog.videos ??= {};

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv.includes("--version")) {
  console.log("2026.10.26");
  process.exit(0);
}

const dd = argv.indexOf("--");
const target = dd >= 0 ? argv[dd + 1] : argv.filter((a) => /^(https?:|ytsearch)/.test(a)).pop();
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (env.FAKE_YTDLP_OFFLINE === "1") {
  fail("ERROR: [youtube] Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>");
}
if (!target) fail("ERROR: no URL provided");

function videoIdOf(u) {
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(u) || /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(u) || /\/shorts\/([A-Za-z0-9_-]{11})/.exec(u);
  return m ? m[1] : null;
}
function flatEntry(id, index) {
  const v = catalog.videos[id] ?? { id, title: id };
  const e = {
    _type: "url",
    ie_key: "Youtube",
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: v.title,
    duration: v.duration,
    channel_id: v.channel_id,
    channel: v.channel,
    uploader: v.uploader,
    view_count: v.view_count,
    live_status: v.live_status,
    description: v.description,
    thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 }],
  };
  if (v.upload_date) e.upload_date = v.upload_date;
  if (index) e.playlist_index = index;
  return e;
}
function slice(ids) {
  const start = Math.max(1, parseInt(val("--playlist-start") ?? "1", 10));
  const endRaw = val("--playlist-end");
  const end = endRaw ? parseInt(endRaw, 10) : ids.length;
  return ids.map((id, i) => ({ id, n: i + 1 })).filter((x) => x.n >= start && x.n <= end);
}
function fullInfo(id) {
  const v = catalog.videos[id];
  if (!v) fail(`ERROR: [youtube] ${id}: Video unavailable`);
  const dur = v.duration ?? 5;
  return {
    ...v,
    id,
    webpage_url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280, height: 720 }],
    subtitles: { en: [{ ext: "vtt", url: "https://example.invalid/en.vtt" }] },
    automatic_captions: {},
    is_live: false,
    live_status: v.live_status ?? "not_live",
    duration: dur,
    height: 1080,
    formats: [
      { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize: 5_000_000 },
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 500_000 },
    ],
    requested_formats: [
      { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize: 5_000_000 },
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 500_000 },
    ],
  };
}

const outTemplate = val("-o");

// Optional: FAKE_YTDLP_COLOURFUL=1 renders a 16:9 gradient per video id instead of the plain test card,
// so screenshots of the library look varied. Tests do not set it.
const colourful = env.FAKE_YTDLP_COLOURFUL === "1";
function gradientColours(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = (n) => "0x" + (n & 0xffffff).toString(16).padStart(6, "0");
  const hsl = (hue) => {
    const a = 0.45 * Math.min(0.55, 1 - 0.55);
    const f = (n) => { const k = (n + hue / 30) % 12; return Math.round(255 * (0.55 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return (f(0) << 16) | (f(8) << 8) | f(4);
  };
  return [hex(hsl(h % 360)), hex(hsl((h + 70) % 360))];
}

if (outTemplate) {
  // Download mode
  const id = videoIdOf(target);
  if (!id) fail(`ERROR: Unsupported URL: ${target}`);
  if (env.FAKE_YTDLP_FAIL === id) fail(`ERROR: [youtube] ${id}: Video unavailable`);
  const v = catalog.videos[id];
  if (!v) fail(`ERROR: [youtube] ${id}: Video unavailable`);
  const dur = v.duration ?? 2;
  const dir = path.dirname(outTemplate);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(outTemplate).replace(/\.%\(ext\)s$/, "");
  const audioOnly = argv.some((a) => a.startsWith("ba[ext=m4a]") ) || (val("-f") ?? "").startsWith("ba");
  const mainName = audioOnly ? `${base}.m4a` : `${base}.mp4`;
  const ff = audioOnly
    ? ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=duration=${dur}`, "-c:a", "aac", path.join(dir, mainName)]
    : ["-y", "-v", "error", "-f", "lavfi", "-i", colourful ? `gradients=size=1280x720:duration=${dur}:rate=25:speed=0.04:c0=${gradientColours(id)[0]}:c1=${gradientColours(id)[1]}:seed=${id.length}` : `testsrc=duration=${dur}:size=160x120:rate=25`, "-f", "lavfi", "-i", `sine=duration=${dur}`,
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, mainName)];
  const total = 1_000_000;
  const tmpl = (done) => `download:NOCON ${done} ${total} NA ${done > 0 ? 500000 : "NA"} ${done < total ? 1 : 0}`;
  process.stdout.write(`[youtube] ${id}: Downloading webpage\n`);
  for (const f of [0.1, 0.5]) process.stdout.write(tmpl(Math.floor(total * f)) + "\n");
  const r = spawnSync(FFMPEG, ff, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) fail(`ERROR: fake yt-dlp could not run ffmpeg: ${r.error?.message ?? r.stderr}`);
  process.stdout.write(tmpl(total) + "\n");
  if (flag("--write-info-json")) fs.writeFileSync(path.join(dir, `${base}.info.json`), JSON.stringify(fullInfo(id)));
  if (flag("--write-thumbnail")) {
    spawnSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", colourful ? `gradients=size=1280x720:duration=1:rate=1:c0=${gradientColours(id)[0]}:c1=${gradientColours(id)[1]}` : "color=c=blue:s=160x120", "-frames:v", "1", path.join(dir, `${base}.jpg`)]);
  }
  if (flag("--write-subs") || flag("--write-auto-subs")) {
    const langs = (val("--sub-langs") ?? "en").split(",").map((l) => l.trim()).filter((l) => l && !l.startsWith("-"));
    for (const l of langs.length ? langs : ["en"]) {
      const code = l.replace(/[^A-Za-z0-9_-]/g, "");
      if (!code || code === "all") continue;
      fs.writeFileSync(path.join(dir, `${base}.${code}.vtt`), `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello ${code}\n`);
    }
    if (!langs.length || langs.includes("all")) fs.writeFileSync(path.join(dir, `${base}.en.vtt`), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
  }
  process.stdout.write(`[download] Destination: ${path.join(dir, mainName)}\n`);
  process.exit(0);
}

// Metadata mode
const search = /^ytsearch(\d*):(.*)$/s.exec(target);
if (search) {
  const n = search[1] ? parseInt(search[1], 10) : 1;
  const ids = Object.keys(catalog.videos);
  out({ _type: "playlist", id: search[2], title: search[2], entries: ids.slice(0, n).map((id, i) => flatEntry(id, i + 1)) });
  process.exit(0);
}

const vid = videoIdOf(target);
const plist = /[?&]list=([A-Za-z0-9_-]+)/.exec(target)?.[1];
const chan = /\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(target)?.[1];
const handle = /\/(@[A-Za-z0-9._-]+)/.exec(target)?.[1];

if (flag("--no-playlist") && vid) {
  if (env.FAKE_YTDLP_FAIL === vid) fail(`ERROR: [youtube] ${vid}: Video unavailable`);
  out(fullInfo(vid));
  process.exit(0);
}
if (vid && !plist && !flag("--flat-playlist")) {
  if (env.FAKE_YTDLP_FAIL === vid) fail(`ERROR: [youtube] ${vid}: Video unavailable`);
  out(fullInfo(vid));
  process.exit(0);
}
if (plist && catalog.playlists[plist]) {
  const p = catalog.playlists[plist];
  // Shaped like live yt-dlp: playlist-level channel fields, and flat entries with no playlist_index.
  out({
    _type: "playlist", id: plist, title: p.title, playlist_count: p.entries.length,
    channel: p.channel ?? "Fake Playlist Owner", channel_id: p.channel_id ?? "UCfakeplaylistowner0000", uploader: p.channel ?? "Fake Playlist Owner",
    entries: slice(p.entries).map((x) => flatEntry(x.id)),
  });
  process.exit(0);
}
if (chan || handle) {
  let cid = chan;
  if (!cid && handle) cid = Object.keys(catalog.channels).find((k) => catalog.channels[k].handle === handle) ?? Object.keys(catalog.channels)[0];
  const c = catalog.channels[cid];
  if (!c) fail(`ERROR: [youtube:tab] ${cid}: The channel does not exist`);
  const tab = /\/(videos|shorts|streams)\/?$/.exec(target)?.[1] ?? "videos";
  const list = tab === "videos" ? c.entries : (c[tab] ?? []);
  out({
    _type: "playlist",
    id: cid,
    title: `${c.title} - ${tab[0].toUpperCase()}${tab.slice(1)}`,
    channel: c.title,
    channel_id: cid,
    uploader: c.title,
    description: c.description ?? `About ${c.title}`,
    thumbnails: [
      { id: "0", url: "https://yt3.googleusercontent.com/banner=w1060", width: 1060, height: 175 },
      { id: "banner_uncropped", url: "https://yt3.googleusercontent.com/banner-uncropped", width: 1060, height: 175 },
      { id: "avatar_uncropped", url: "https://yt3.googleusercontent.com/avatar-uncropped", width: 900, height: 900 },
    ],
    entries: slice(list).map((x) => {
      const e = flatEntry(x.id, x.n);
      if (tab === "shorts") e.url = `https://www.youtube.com/shorts/${x.id}`;
      return e;
    }),
  });
  process.exit(0);
}
fail(`ERROR: [generic] Unable to download webpage: unsupported fake target ${target}`);
