import { Unzip, UnzipInflate, UnzipPassThrough, strFromU8 } from "fflate";

/** Maximum decompressed size of the watch-history file(s) inside a Takeout archive. */
export const MAX_TAKEOUT_DECOMPRESSED = 256 * 1024 * 1024;
/** Longest anchor (`<a ...>...</a>`) the HTML parser will consider. */
const MAX_ANCHOR_BYTES = 4096;

export class TakeoutTooLargeError extends Error {
  constructor(message = "This archive is too large to import") {
    super(message);
    this.name = "TakeoutTooLargeError";
  }
}

export interface TakeoutEntry {
  videoId: string;
  canonicalKey: string;
  watchedAt: Date;
  title?: string;
  channelName?: string;
}
export interface TakeoutResult {
  entries: TakeoutEntry[];
  skipped: number;
  format: "json" | "html";
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function extractVideoId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) return null;
    const id = host === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v");
    return id && VIDEO_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function stripWatched(t: string): string {
  return t.replace(/^(Watched|Viewed)\s+/i, "").trim();
}

function parseJson(text: string): TakeoutResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid Takeout JSON");
  }
  if (!Array.isArray(data)) throw new Error("Takeout JSON must be an array");
  const entries: TakeoutEntry[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const item of data as Record<string, any>[]) {
    const id = extractVideoId(item?.titleUrl);
    const t = typeof item?.time === "string" ? new Date(item.time) : null;
    if (!id || !t || Number.isNaN(t.getTime())) {
      skipped++;
      continue;
    }
    const key = `${id}@${t.getTime()}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const e: TakeoutEntry = { videoId: id, canonicalKey: `youtube:${id}`, watchedAt: t };
    if (typeof item.title === "string") e.title = stripWatched(item.title);
    const ch = Array.isArray(item.subtitles) ? item.subtitles[0]?.name : undefined;
    if (typeof ch === "string") e.channelName = ch;
    entries.push(e);
  }
  return { entries, skipped, format: "json" };
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TZ: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};

/** Parses "1 Nov 2026, 14:03:22 GMT" and "Nov 1, 2026, 2:03:22 PM PST". */
export function parseTakeoutDate(raw: string): Date | null {
  const s = raw.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
  const time = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?`;
  const tz = String.raw`\s*([A-Z]{1,5}|[+-]\d{2}:?\d{2})?`;
  let m = new RegExp(String.raw`^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4}),? ${time}${tz}$`, "i").exec(s);
  let day: number, mon: string, year: number, rest: RegExpExecArray;
  if (m) {
    day = +m[1]!; mon = m[2]!; year = +m[3]!; rest = m;
  } else {
    m = new RegExp(String.raw`^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4}),? ${time}${tz}$`, "i").exec(s);
    if (!m) return null;
    mon = m[1]!; day = +m[2]!; year = +m[3]!; rest = m;
  }
  const month = MONTHS[mon.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  let hh = +rest[4]!;
  const mm = +rest[5]!;
  const ss = rest[6] ? +rest[6] : 0;
  const ap = rest[7]?.toUpperCase();
  if (ap === "PM" && hh < 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  let offsetMin = 0;
  const z = rest[8];
  if (z) {
    const num = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
    if (num) offsetMin = (num[1] === "-" ? -1 : 1) * (+num[2]! * 60 + +num[3]!);
    else if (TZ[z.toUpperCase()] !== undefined) offsetMin = TZ[z.toUpperCase()]!;
    else return null;
  }
  if (hh > 23 || mm > 59 || ss > 59 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month, day, hh, mm, ss) - offsetMin * 60_000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function parseHtml(text: string): TakeoutResult {
  const entries: TakeoutEntry[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const anchors: { href: string; text: string; start: number; end: number }[] = [];
  // Linear scan: collect every "<a " and "</a>" position once, then pair each opener with the first
  // closer after it. Openers whose closer is missing or more than MAX_ANCHOR_BYTES away are ignored.
  const openers: number[] = [];
  const closers: { at: number; end: number }[] = [];
  const openRe = /<a\s/gi;
  const closeRe = /<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text))) openers.push(m.index);
  while ((m = closeRe.exec(text))) closers.push({ at: m.index, end: m.index + m[0].length });
  let ci = 0;
  let resumeAt = 0;
  for (const start of openers) {
    if (start < resumeAt) continue;
    while (ci < closers.length && closers[ci]!.at < start) ci++;
    const close = closers[ci];
    if (!close) break;
    if (close.end - start > MAX_ANCHOR_BYTES) continue;
    const raw = text.slice(start, close.end);
    const hm = /^<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*)<\/a\s*>$/i.exec(raw);
    if (!hm) continue;
    anchors.push({ href: decodeEntities(hm[1]!), text: stripTags(hm[2]!), start, end: close.end });
    resumeAt = close.end;
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const id = extractVideoId(a.href);
    if (!id) {
      if (/watch\?v=/.test(a.href)) skipped++;
      continue;
    }
    let j = i + 1;
    while (j < anchors.length && !extractVideoId(anchors[j]!.href)) j++;
    const nextStart = anchors[j]?.start ?? text.length;
    // Look at the text after this anchor up to the next video anchor; channel anchor may sit in between.
    const following = text.slice(a.end, Math.min(nextStart, a.end + 1500));
    const segments = stripTags(following.replace(/<br\s*\/?>/gi, "\n")).split(/\n/).map((x) => x.trim()).filter(Boolean);
    // Date: first segment (or tail of one) that parses.
    let date: Date | null = null;
    const flat = stripTags(following.replace(/<br\s*\/?>/gi, " | ")).split("|").map((x) => x.trim()).filter(Boolean);
    for (const seg of flat.length ? flat : segments) {
      date = parseTakeoutDate(seg);
      if (date) break;
    }
    if (!date) {
      // fall back to a regex search for any date-like fragment
      const mm = /(\d{1,2} [A-Za-z]{3,9}\.? \d{4},? \d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\s*[A-Z]{1,5})?|[A-Za-z]{3,9}\.? \d{1,2},? \d{4},? \d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\s*[A-Z]{1,5})?)/i.exec(stripTags(following));
      if (mm) date = parseTakeoutDate(mm[1]!);
    }
    if (!date) {
      skipped++;
      continue;
    }
    const key = `${id}@${date.getTime()}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const e: TakeoutEntry = { videoId: id, canonicalKey: `youtube:${id}`, watchedAt: date };
    if (a.text) e.title = a.text;
    const ch = anchors.slice(i + 1, j).find((x) => /youtube\.com\/(channel|@|user|c\/)/.test(x.href));
    if (ch?.text) e.channelName = ch.text;
    entries.push(e);
  }
  return { entries, skipped, format: "html" };
}

/**
 * Streams the archive and keeps only watch-history.json/html. The declared size is checked before an
 * entry is inflated, and the bytes actually produced are counted against the cap as they arrive, so a
 * zip bomb (or a header that lies about its size) is aborted without allocating the full output.
 */
function unzipWatchHistory(buffer: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    if (!/watch-history\.(json|html)$/i.test(file.name)) return;
    if (file.originalSize !== undefined && total + file.originalSize > MAX_TAKEOUT_DECOMPRESSED) throw new TakeoutTooLargeError();
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      total += chunk.length;
      if (total > MAX_TAKEOUT_DECOMPRESSED) {
        file.terminate();
        throw new TakeoutTooLargeError();
      }
      chunks.push(chunk);
      if (final) {
        const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        out[file.name] = merged;
      }
    };
    file.start();
  };
  try {
    unzip.push(buffer, true);
  } catch (e) {
    if (e instanceof TakeoutTooLargeError) throw e;
    throw new Error("The archive could not be read as a zip file");
  }
  return out;
}

export function parseTakeout(buffer: Uint8Array, filename: string): TakeoutResult {
  const lower = filename.toLowerCase();
  let bytes = buffer;
  let kind: "json" | "html" | null = null;
  const isZip = lower.endsWith(".zip") || (buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b);
  if (isZip) {
    const files = unzipWatchHistory(buffer);
    const jsonName = Object.keys(files).find((n) => /watch-history\.json$/i.test(n));
    const htmlName = Object.keys(files).find((n) => /watch-history\.html$/i.test(n));
    if (jsonName) { bytes = files[jsonName]!; kind = "json"; }
    else if (htmlName) { bytes = files[htmlName]!; kind = "html"; }
    else throw new Error("No watch-history.json or watch-history.html found in archive");
  } else if (lower.endsWith(".json")) kind = "json";
  else if (lower.endsWith(".html") || lower.endsWith(".htm")) kind = "html";
  else {
    const head = strFromU8(bytes.subarray(0, 64)).trimStart();
    kind = head.startsWith("[") || head.startsWith("{") ? "json" : "html";
  }
  const text = strFromU8(bytes).replace(/^﻿/, "");
  return kind === "json" ? parseJson(text) : parseHtml(text);
}
