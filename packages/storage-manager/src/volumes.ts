import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface VolumeStat { totalBytes: number; freeBytes: number }
export interface VolumeMarker { id: string; name: string; createdAt: string }
export interface VolumeStatus { online: boolean; writable: boolean; reason?: string }
export interface MountInfo { mountPoint: string; fsType: string; source: string }

export const MARKER_DIR = ".noconmedia";
export const markerPath = (root: string) => path.join(root, MARKER_DIR, "volume.json");

/** Total size of all regular files under dir (used to simulate a small disk in tests). */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await directoryBytes(p);
    else if (e.isFile()) {
      try { total += (await fsp.stat(p)).size; } catch { /* vanished */ }
    }
  }
  return total;
}

/** With `overrideTotalBytes` the disk is pretended to be that size, and free = override - bytes stored under path. */
export async function statVolume(dir: string, overrideTotalBytes?: number): Promise<VolumeStat> {
  if (overrideTotalBytes && overrideTotalBytes > 0) {
    const used = await directoryBytes(dir);
    return { totalBytes: overrideTotalBytes, freeBytes: Math.max(0, overrideTotalBytes - used) };
  }
  const s = await fsp.statfs(dir);
  return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
}

async function probeWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.nocon-probe-${randomUUID()}`);
  const fh = await fsp.open(probe, "w");
  try {
    await fh.write("probe");
    await fh.sync();
  } finally {
    await fh.close();
    await fsp.rm(probe, { force: true });
  }
}

export async function initVolume(root: string, id: string, name: string): Promise<VolumeMarker> {
  const st = await fsp.stat(root).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Volume path does not exist or is not a directory: ${root}`);
  try {
    await probeWritable(root);
  } catch (e) {
    throw new Error(`Volume path is not writable: ${root} (${(e as Error).message})`);
  }
  const base = path.join(root, MARKER_DIR);
  await fsp.mkdir(path.join(base, "tmp"), { recursive: true });
  await fsp.mkdir(path.join(base, "manifests"), { recursive: true });
  const marker: VolumeMarker = { id, name, createdAt: new Date().toISOString() };
  await fsp.writeFile(markerPath(root), JSON.stringify(marker, null, 2));
  return marker;
}

export async function readMarker(root: string): Promise<VolumeMarker | null> {
  try {
    const m = JSON.parse(await fsp.readFile(markerPath(root), "utf8")) as VolumeMarker;
    return typeof m.id === "string" ? m : null;
  } catch {
    return null;
  }
}

/** Online only if the marker exists and carries the expected id. */
export async function verifyVolume(root: string, expectedId: string): Promise<VolumeStatus> {
  const marker = await readMarker(root);
  if (!marker) return { online: false, writable: false, reason: "volume marker missing or unreadable" };
  if (marker.id !== expectedId) return { online: false, writable: false, reason: "volume marker id mismatch" };
  try {
    await probeWritable(root);
    return { online: true, writable: true };
  } catch (e) {
    return { online: true, writable: false, reason: `not writable: ${(e as Error).message}` };
  }
}

/** Best-effort parse of /proc/self/mountinfo. Null where unavailable (macOS) or no match. */
export function mountInfo(target: string, mountinfoText?: string): MountInfo | null {
  let text = mountinfoText;
  if (text === undefined) {
    try { text = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return null; }
  }
  let real = path.resolve(target);
  try { real = fs.realpathSync(real); } catch { /* use lexical path */ }
  let best: MountInfo | null = null;
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    const dash = parts.indexOf("-");
    if (dash < 0 || parts.length < dash + 3) continue;
    const mountPoint = (parts[4] ?? "").replace(/\\040/g, " ");
    if (real !== mountPoint && !real.startsWith(mountPoint === "/" ? "/" : mountPoint + "/")) continue;
    if (!best || mountPoint.length >= best.mountPoint.length) {
      best = { mountPoint, fsType: parts[dash + 1]!, source: parts[dash + 2]! };
    }
  }
  return best;
}

/** True when `target` is on the same filesystem as "/" (a likely sign the USB drive is not mounted). */
export function onRootFilesystem(target: string): boolean {
  try { return fs.statSync(target).dev === fs.statSync("/").dev; } catch { return false; }
}
