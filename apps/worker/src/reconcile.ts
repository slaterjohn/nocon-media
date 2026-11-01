import fsp from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@nocon/database";
import { recomputeEffectivePriority, upsertMedia } from "@nocon/database";
import { FILES, scanLibrary, type LibraryItem } from "@nocon/media-core";
import type { WorkerContext, Volume } from "./context.js";

export interface ReconcileReport {
  dryRun: boolean;
  found: number;
  rebuilt: number;
  missingFiles: { mediaId: string; canonicalKey: string; relativePath: string }[];
  orphans: { volumeId: string; relDir: string }[];
  duplicates: { canonicalKey: string; relDirs: string[] }[];
  issues: string[];
}

const MIME: Record<string, string> = { mp4: "video/mp4", m4a: "audio/mp4", webm: "video/webm", jpg: "image/jpeg", vtt: "text/vtt" };
/**
 * Platform, external id and URL are derived from the canonical key, never from the sidecar's own
 * `originalUrl` (sidecars live on user-writable disks and could point the downloader anywhere).
 */
export function deriveFromCanonicalKey(key: string): { platform: "youtube"; externalId: string; url: string } | null {
  const m = /^youtube:([A-Za-z0-9_-]{11})$/.exec(key);
  return m ? { platform: "youtube", externalId: m[1]!, url: `https://www.youtube.com/watch?v=${m[1]}` } : null;
}
const exists = (p: string) => fsp.access(p).then(() => true, () => false);

/** Non-destructive: rebuilds catalogue rows from sidecars, reports (never deletes) everything else. */
export async function runReconcile(ctx: WorkerContext, data: { dryRun: boolean; volumeId?: string }): Promise<ReconcileReport> {
  const { db } = ctx;
  const report: ReconcileReport = { dryRun: data.dryRun, found: 0, rebuilt: 0, missingFiles: [], orphans: [], duplicates: [], issues: [] };
  const volumes = (await db.select().from(s.storageVolumes).where(eq(s.storageVolumes.isOnline, true)))
    .filter((v) => !data.volumeId || v.id === data.volumeId);
  if (data.volumeId && volumes.length === 0) report.issues.push(`Volume ${data.volumeId} is offline or unknown`);

  const seenKeys = new Map<string, string[]>();
  for (const vol of volumes) {
    const scan = await scanLibrary(vol.mountPath);
    for (const o of scan.orphanDirs) report.orphans.push({ volumeId: vol.id, relDir: o });
    for (const e of scan.errors) report.issues.push(`${vol.name}: ${e.relDir}: ${e.error}`);

    const manifest: { canonicalKey: string; relDir: string; sha256: string }[] = [];
    for (const item of scan.items) {
      report.found++;
      const key = item.sidecar.canonicalKey;
      if (!deriveFromCanonicalKey(key)) {
        report.issues.push(`${item.relDir}: skipped, unsupported or invalid canonical key "${String(key).slice(0, 80)}"`);
        continue;
      }
      const dirs = seenKeys.get(key) ?? [];
      dirs.push(`${vol.id}:${item.relDir}`);
      seenKeys.set(key, dirs);
      if (dirs.length > 1) continue; // duplicate: first one wins
      manifest.push({ canonicalKey: key, relDir: item.relDir, sha256: item.sidecar.checksums.sha256 });
      try {
        await reconcileItem(ctx, vol, item, data.dryRun, report);
      } catch (e) {
        report.issues.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await checkMissing(ctx, vol, data.dryRun, report);

    if (!data.dryRun) {
      const dir = path.join(vol.mountPath, ".noconmedia", "manifests");
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `library-${new Date().toISOString().slice(0, 10)}.json`);
      await fsp.writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), volumeId: vol.id, items: manifest }, null, 2));
    }
  }
  for (const [canonicalKey, relDirs] of seenKeys) if (relDirs.length > 1) report.duplicates.push({ canonicalKey, relDirs });
  return report;
}

async function reconcileItem(ctx: WorkerContext, vol: Volume, item: LibraryItem, dryRun: boolean, report: ReconcileReport): Promise<void> {
  const { db } = ctx;
  const sc = item.sidecar;
  const mainMissing = item.missingFiles.includes(sc.mainFile);
  const [existing] = await db.select().from(s.media).where(eq(s.media.canonicalKey, sc.canonicalKey));

  if (existing) {
    if (mainMissing) return; // reported by checkMissing / below
    const files = await db.select({ kind: s.mediaFiles.kind }).from(s.mediaFiles)
      .where(and(eq(s.mediaFiles.mediaId, existing.id), eq(s.mediaFiles.volumeId, vol.id)));
    const hasMain = files.some((f) => f.kind === "video" || f.kind === "audio");
    const wrongLocation = existing.volumeId !== vol.id || existing.mediaDir !== item.relDir;
    const needs = existing.availability !== "available" || !hasMain || wrongLocation;
    if (!needs) return;
    if (existing.availability === "available" && wrongLocation && hasMain) {
      report.issues.push(`${sc.canonicalKey}: library copy at ${item.relDir} differs from the catalogue location`);
      return;
    }
    if (dryRun) {
      report.issues.push(`Would restore ${sc.canonicalKey} from ${item.relDir}`);
      return;
    }
    await rebuildFiles(ctx, existing.id, vol, item);
    report.rebuilt++;
    return;
  }

  if (mainMissing) {
    report.issues.push(`${sc.canonicalKey}: sidecar found at ${item.relDir} but ${sc.mainFile} is missing`);
    return;
  }
  if (dryRun) {
    report.issues.push(`Would import ${sc.canonicalKey} from ${item.relDir}`);
    return;
  }
  const derived = deriveFromCanonicalKey(sc.canonicalKey);
  if (!derived) { report.issues.push(`${item.relDir}: skipped, unsupported or invalid canonical key`); return; }
  const { media } = await upsertMedia(db, {
    canonicalKey: sc.canonicalKey, platform: derived.platform, externalId: derived.externalId,
    url: derived.url, title: sc.title, description: sc.description, channelId: sc.creator.id || undefined,
    channelName: sc.creator.name || undefined, publishedAt: sc.publishedAt ? new Date(sc.publishedAt) : null,
    durationSeconds: sc.durationSeconds, categories: sc.categories, tags: sc.tags,
  });
  await db.update(s.media).set({ manualPriority: "P1", retainOverride: true }).where(eq(s.media.id, media.id));
  await rebuildFiles(ctx, media.id, vol, item);
  report.rebuilt++;
}

/** Recreates media_files rows from what is on disk and marks the media available. */
async function rebuildFiles(ctx: WorkerContext, mediaId: string, vol: Volume, item: LibraryItem): Promise<void> {
  const { db } = ctx;
  const sc = item.sidecar;
  const abs = path.join(vol.mountPath, item.relDir);
  const rows: (typeof s.mediaFiles.$inferInsert)[] = [];
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(abs, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(r); continue; }
      const size = (await fsp.stat(path.join(abs, r))).size;
      total += size;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      const base = { mediaId, volumeId: vol.id, relativePath: `${item.relDir}/${r}`, sizeBytes: size, mimeType: MIME[ext] ?? null };
      if (r === sc.mainFile) {
        const t = sc.technical;
        rows.push({
          ...base, kind: t.videoCodec || t.width ? "video" : "audio", container: ext, videoCodec: t.videoCodec ?? null, audioCodec: t.audioCodec ?? null,
          width: t.width ?? null, height: t.height ?? null, bitrate: t.bitrate ?? null, durationSeconds: sc.durationSeconds, checksumSha256: sc.checksums.sha256,
        });
      } else if (r === FILES.thumbnail) rows.push({ ...base, kind: "thumbnail" });
      else if (r === FILES.sidecar) rows.push({ ...base, kind: "sidecar" });
      else if (r === FILES.info) rows.push({ ...base, kind: "info" });
      else if (r === `${FILES.hlsDir}/${FILES.hlsPlaylist}`) rows.push({ ...base, kind: "hls", container: "hls" });
      else {
        const sub = sc.subtitles.find((x) => x.file === r);
        if (sub) rows.push({ ...base, kind: "subtitle", language: sub.language, label: sub.language });
      }
    }
  };
  await walk("");
  await db.transaction(async (tx) => {
    await tx.delete(s.mediaFiles).where(eq(s.mediaFiles.mediaId, mediaId));
    if (rows.length) await tx.insert(s.mediaFiles).values(rows);
    await tx.update(s.media).set({
      availability: "available", volumeId: vol.id, mediaDir: item.relDir, sizeBytes: total, evictedAt: null, unavailableReason: null,
      downloadedAt: sc.downloadedAt ? new Date(sc.downloadedAt) : new Date(), redownloadAfter: null, updatedAt: new Date(),
    }).where(eq(s.media.id, mediaId));
  });
  await recomputeEffectivePriority(ctx.db, mediaId);
}

/** Available media whose main file is gone from an online volume: report, and only flag `file_missing`. */
async function checkMissing(ctx: WorkerContext, vol: Volume, dryRun: boolean, report: ReconcileReport): Promise<void> {
  const { db } = ctx;
  const rows = await db.select({ m: s.media, f: s.mediaFiles }).from(s.media)
    .innerJoin(s.mediaFiles, and(eq(s.mediaFiles.mediaId, s.media.id), inArray(s.mediaFiles.kind, ["video", "audio"])))
    .where(and(eq(s.media.volumeId, vol.id), eq(s.media.availability, "available")));
  for (const { m, f } of rows) {
    const present = await exists(path.join(vol.mountPath, f.relativePath));
    if (!present) {
      report.missingFiles.push({ mediaId: m.id, canonicalKey: m.canonicalKey, relativePath: f.relativePath });
      if (!dryRun && m.unavailableReason !== "file_missing") {
        await db.update(s.media).set({ unavailableReason: "file_missing", updatedAt: new Date() }).where(eq(s.media.id, m.id));
      }
    } else if (!dryRun && m.unavailableReason === "file_missing") {
      await db.update(s.media).set({ unavailableReason: null, updatedAt: new Date() }).where(eq(s.media.id, m.id));
    }
  }
}
