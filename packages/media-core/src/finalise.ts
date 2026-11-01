import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "@nocon/shared";
import { FILES } from "./layout.js";

const MEDIA_EXTS = new Set(["mp4", "mkv", "webm", "m4a", "mp3", "opus", "ogg", "mov", "flac", "wav", "aac"]);

export interface Chapter {
  start: number;
  end: number;
  title: string;
}
export interface StagingInspection {
  dir: string;
  mainFile: string | null;
  subtitles: { language: string; file: string }[];
  thumbnail: string | null;
  infoJsonFile: string | null;
  info: Record<string, any> | null;
  chapters: Chapter[];
  partialFiles: string[];
}

export async function inspectStaging(dir: string): Promise<StagingInspection> {
  const names = await fsp.readdir(dir);
  const res: StagingInspection = { dir, mainFile: null, subtitles: [], thumbnail: null, infoJsonFile: null, info: null, chapters: [], partialFiles: [] };
  for (const n of names.sort()) {
    if (!n.startsWith("media")) continue;
    if (/\.(part|ytdl|temp)$/i.test(n) || /\.part-Frag/.test(n)) {
      res.partialFiles.push(n);
      continue;
    }
    const sub = /^media\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\.vtt$/.exec(n);
    if (sub) {
      res.subtitles.push({ language: sub[1]!, file: n });
      continue;
    }
    if (n === "media.info.json") {
      res.infoJsonFile = n;
      continue;
    }
    const m = /^media\.([A-Za-z0-9]+)$/.exec(n);
    if (!m) continue;
    const ext = m[1]!.toLowerCase();
    if (ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "png") res.thumbnail = res.thumbnail ?? n;
    else if (MEDIA_EXTS.has(ext)) {
      if (!res.mainFile || ext === "mp4") res.mainFile = n;
    }
  }
  if (res.infoJsonFile) {
    try {
      res.info = JSON.parse(await fsp.readFile(path.join(dir, res.infoJsonFile), "utf8"));
      const ch = res.info?.chapters;
      if (Array.isArray(ch)) {
        res.chapters = ch
          .filter((c: any) => typeof c?.start_time === "number")
          .map((c: any) => ({ start: c.start_time, end: typeof c.end_time === "number" ? c.end_time : c.start_time, title: String(c.title ?? "") }));
      }
    } catch {
      res.info = null;
    }
  }
  return res;
}

const rand = () => crypto.randomBytes(6).toString("hex");

async function listFilesRel(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (r: string) => {
    for (const e of await fsp.readdir(resolveInside(root, r), { withFileTypes: true })) {
      const child = path.posix.join(r, e.name);
      if (e.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk(rel);
  return out.sort();
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Atomically publishes a staging dir at volumeRoot/relDir. Returns file paths relative to volumeRoot. */
export async function moveIntoLibrary(stagingDir: string, volumeRoot: string, relDir: string): Promise<{ relDir: string; files: string[] }> {
  const target = resolveInside(volumeRoot, relDir);
  const incoming = resolveInside(volumeRoot, `${relDir}${FILES.incomingMarker}${rand()}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await moveDir(stagingDir, incoming);
  let aside: string | null = null;
  try {
    if (fs.existsSync(target)) {
      aside = resolveInside(volumeRoot, `${relDir}.old-${rand()}`);
      await fsp.rename(target, aside);
    }
    await fsp.rename(incoming, target);
  } catch (e) {
    if (aside && !fs.existsSync(target)) await fsp.rename(aside, target).catch(() => {});
    await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  if (aside) await fsp.rm(aside, { recursive: true, force: true });
  return { relDir, files: await listFilesRel(volumeRoot, relDir) };
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve());
  });
  return h.digest("hex");
}

export interface Sidecar {
  version: 1;
  canonicalKey: string;
  originalUrl: string;
  title: string;
  description: string;
  creator: { id: string; name: string; url?: string };
  publishedAt: string | null;
  durationSeconds: number;
  categories: string[];
  tags: string[];
  downloadedAt: string;
  technical: { container?: string; videoCodec?: string | null; audioCodec?: string | null; width?: number | null; height?: number | null; bitrate?: number; sizeBytes?: number };
  artwork: { thumbnail: string | null };
  subtitles: { language: string; file: string }[];
  chapters: Chapter[];
  mainFile: string;
  checksums: { sha256: string };
}

export type SidecarInput = Omit<Sidecar, "version" | "downloadedAt"> & { downloadedAt?: string };

export async function writeSidecar(dir: string, metadata: SidecarInput): Promise<string> {
  const full: Sidecar = { version: 1, downloadedAt: new Date().toISOString(), ...metadata };
  validateSidecar(full);
  const final = path.join(dir, FILES.sidecar);
  const tmp = `${final}.tmp-${rand()}`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(full, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
  return final;
}

export function validateSidecar(s: any): asserts s is Sidecar {
  const bad = (m: string): never => {
    throw new Error(`Invalid sidecar: ${m}`);
  };
  if (!s || typeof s !== "object") bad("not an object");
  if (s.version !== 1) bad("unsupported version");
  if (typeof s.canonicalKey !== "string" || !s.canonicalKey.includes(":")) bad("canonicalKey");
  if (typeof s.title !== "string") bad("title");
  const plainName = (v: unknown): boolean =>
    typeof v === "string" && v.length > 0 && !v.includes("/") && !v.includes("\\") && !v.includes("..") && !v.includes("\0");
  if (!plainName(s.mainFile)) bad("mainFile");
  if (typeof s.durationSeconds !== "number") bad("durationSeconds");
  if (!s.creator || typeof s.creator.name !== "string") bad("creator");
  if (typeof s.checksums?.sha256 !== "string") bad("checksums");
  if (!Array.isArray(s.subtitles) || !Array.isArray(s.chapters) || !Array.isArray(s.tags) || !Array.isArray(s.categories)) bad("arrays");
  if (!s.artwork || typeof s.artwork !== "object") bad("artwork");
  // Every file the sidecar references must be a plain filename inside the item's own directory.
  for (const [k, v] of Object.entries(s.artwork)) if (v !== null && v !== undefined && !plainName(v)) bad(`artwork.${k}`);
  for (const sub of s.subtitles) {
    if (!sub || typeof sub !== "object" || !plainName(sub.file)) bad("subtitles[].file");
  }
  for (const k of ["thumbnail", "info", "infoFile", "thumbnailFile"]) {
    if (s[k] !== undefined && s[k] !== null && !plainName(s[k])) bad(k);
  }
}

export async function readSidecar(file: string): Promise<Sidecar> {
  const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
  validateSidecar(parsed);
  return parsed;
}
