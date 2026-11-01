import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { logActivity } from "@nocon/database";
import { isUnderAllowedRoots } from "@nocon/shared";
import { initVolume, readMarker, mountInfo, onRootFilesystem, statVolume } from "@nocon/storage-manager";
import { badRequest, conflict, getStorage, type Deps } from "./core.js";
import { toVolumes } from "./serialize.js";

export const ROOT_FS_WARNING = "This folder is on the container's own filesystem. If you expected a USB drive here, it may not be mounted.";

function underAllowed(p: string, roots: string[]): boolean {
  if (!isUnderAllowedRoots(p, roots)) return false;
  // Also resolve symlinks so a link inside an allowed root cannot point outside it.
  try {
    const real = fs.realpathSync(p);
    const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
    return isUnderAllowedRoots(real, [...roots, ...realRoots]);
  } catch { return true; }
}

export async function validateStoragePath(d: Deps, rawPath: string) {
  const result = {
    ok: false, exists: false, writable: false, onRootFs: false,
    mount: null as { mountPoint: string; fsType: string; source: string } | null,
    totalBytes: null as number | null, freeBytes: null as number | null,
    existingMarker: null as { id: string; name: string } | null,
    warnings: [] as string[], errors: [] as string[],
  };
  const p = path.resolve(rawPath);
  if (!underAllowed(p, d.config.MEDIA_ROOTS_ALLOWED)) {
    result.errors.push(`Folder must be inside one of the allowed media locations: ${d.config.MEDIA_ROOTS_ALLOWED.join(", ")}.`);
    return { result, path: p };
  }
  const st = await fsp.stat(p).catch(() => null);
  if (!st?.isDirectory()) {
    result.errors.push("This folder does not exist. Create it (or mount the drive) and try again.");
    return { result, path: p };
  }
  result.exists = true;
  const probe = path.join(p, `.nocon-probe-${randomUUID()}`);
  try { await fsp.writeFile(probe, "probe"); await fsp.rm(probe, { force: true }); result.writable = true; }
  catch { result.errors.push("NoConMedia cannot write to this folder. Check its permissions."); }
  result.onRootFs = onRootFilesystem(p);
  if (result.onRootFs) result.warnings.push(ROOT_FS_WARNING);
  result.mount = mountInfo(p);
  try {
    const stat = await statVolume(p, d.config.STORAGE_STATFS_OVERRIDE_BYTES);
    result.totalBytes = stat.totalBytes; result.freeBytes = stat.freeBytes;
  } catch { result.warnings.push("Could not read free space for this folder."); }
  const marker = await readMarker(p);
  if (marker) {
    result.existingMarker = { id: marker.id, name: marker.name };
    result.warnings.push(`This folder already holds a NoConMedia library ("${marker.name}"). It will be re-attached.`);
  }
  const [dup] = await d.db.select({ id: s.storageVolumes.id }).from(s.storageVolumes).where(eq(s.storageVolumes.mountPath, p));
  if (dup) result.errors.push("This folder is already registered as a storage volume.");
  result.ok = result.errors.length === 0;
  return { result, path: p };
}

export async function registerVolume(d: Deps, rawPath: string, name: string) {
  const { result, path: p } = await validateStoragePath(d, rawPath);
  if (!result.ok) throw badRequest(result.errors.join(" "), result);
  const id = result.existingMarker?.id ?? randomUUID();
  const [taken] = await d.db.select({ id: s.storageVolumes.id }).from(s.storageVolumes).where(eq(s.storageVolumes.id, id));
  if (taken) throw conflict("A volume with this identity is already registered at another path.");
  try { await initVolume(p, id, name); } catch (e) { throw badRequest((e as Error).message); }
  await d.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727002)`);
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(s.storageVolumes)) as [{ n: number }];
    await tx.insert(s.storageVolumes).values({ id, name, mountPath: p, isDefault: n === 0, isOnline: true, isWritable: true });
  });
  await (await getStorage(d)).refreshVolume(id);
  await logActivity(d.db, { type: "storage.volume_added", message: `Storage volume "${name}" added`, entityType: "volume", entityId: id });
  return (await toVolumes(d)).find((v) => v.id === id)!;
}
