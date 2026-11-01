import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import * as s from "@nocon/database";
import { resolveInside } from "@nocon/shared";
import { iso, type Deps } from "./core.js";

export type MediaRow = typeof s.media.$inferSelect;

export async function volumeOnlineMap(d: Deps): Promise<Map<string, boolean>> {
  const rows = await d.db.select({ id: s.storageVolumes.id, online: s.storageVolumes.isOnline }).from(s.storageVolumes);
  return new Map(rows.map((r) => [r.id, r.online]));
}

/** Media summaries for a list of rows, with batched progress / thumbnail lookups. */
export async function toSummaries(d: Deps, rows: MediaRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [online, hist, thumbs] = await Promise.all([
    volumeOnlineMap(d),
    d.db.select().from(s.playbackHistory).where(inArray(s.playbackHistory.mediaId, ids)),
    d.db.select({ mediaId: s.mediaFiles.mediaId }).from(s.mediaFiles).where(and(inArray(s.mediaFiles.mediaId, ids), eq(s.mediaFiles.kind, "thumbnail"))),
  ]);
  const hm = new Map(hist.map((h) => [h.mediaId, h]));
  const tm = new Set(thumbs.map((t) => t.mediaId));
  return rows.map((m) => summary(m, online, hm.get(m.id), tm.has(m.id)));
}

export function summary(m: MediaRow, online: Map<string, boolean>, h?: typeof s.playbackHistory.$inferSelect, hasThumb = false) {
  const volOnline = m.volumeId ? online.get(m.volumeId) === true : false;
  const available = m.availability === "available";
  return {
    id: m.id, streamId: m.streamId, title: m.title, channelName: m.channelName, creatorId: m.creatorId,
    durationSeconds: m.durationSeconds, publishedAt: iso(m.publishedAt), downloadedAt: iso(m.downloadedAt),
    availability: m.availability, playable: available && volOnline, temporarilyUnavailable: available && !volOnline,
    effectivePriority: m.effectivePriority, pinned: m.pinned, favourite: m.favourite, sizeBytes: m.sizeBytes,
    thumbnailUrl: hasThumb ? `/api/media/${m.id}/thumbnail` : null,
    progress: h ? { positionSeconds: h.positionSeconds, durationSeconds: h.durationSeconds ?? m.durationSeconds ?? 0, completed: h.completed } : null,
  };
}

export async function summaryFor(d: Deps, id: string) {
  const [m] = await d.db.select().from(s.media).where(eq(s.media.id, id));
  return m ? (await toSummaries(d, [m]))[0]! : null;
}

export const DIRECT_PLAY = ["mp4", "webm", "m4a"];

export async function toDetail(d: Deps, m: MediaRow) {
  const base = (await toSummaries(d, [m]))[0]!;
  const [files, srcs, chs, rec, evs] = await Promise.all([
    d.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, m.id)).orderBy(asc(s.mediaFiles.createdAt)),
    d.db.select({ id: s.sources.id, name: s.sources.name, type: s.sources.type, priority: s.sources.priority })
      .from(s.mediaSources).innerJoin(s.sources, eq(s.sources.id, s.mediaSources.sourceId)).where(eq(s.mediaSources.mediaId, m.id)),
    d.db.select().from(s.chapters).where(eq(s.chapters.mediaId, m.id)).orderBy(asc(s.chapters.startSeconds)),
    d.db.select().from(s.recommendations).where(eq(s.recommendations.mediaId, m.id)),
    d.db.select().from(s.evictionRecords).where(eq(s.evictionRecords.mediaId, m.id)).orderBy(desc(s.evictionRecords.createdAt)),
  ]);
  const primary = files.find((f) => f.kind === "video") ?? files.find((f) => f.kind === "audio");
  const ext = primary ? path.extname(primary.relativePath).slice(1).toLowerCase() : "";
  const tokens = (primary?.container ?? "").toLowerCase().split(/[,\s]+/);
  const directPlay = !!primary && (DIRECT_PLAY.includes(ext) || tokens.some((t) => DIRECT_PLAY.includes(t)) && ext !== "mkv");
  let hlsUrl: string | null = null;
  if (m.availability === "available" && m.volumeId && m.mediaDir) {
    const [vol] = await d.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, m.volumeId));
    if (vol?.isOnline) {
      try { if (fs.existsSync(resolveInside(vol.mountPath, `${m.mediaDir}/hls/index.m3u8`))) hlsUrl = `/api/media/${m.id}/hls/index.m3u8`; } catch { /* ignore */ }
    }
  }
  return {
    ...base,
    description: m.description, url: m.url, platform: m.platform, externalId: m.externalId,
    categories: m.categories, tags: m.tags, language: m.language, manualPriority: m.manualPriority,
    retainOverride: m.retainOverride, recommendationScore: m.recommendationScore, sources: srcs,
    files: files.filter((f) => f.kind !== "subtitle").map((f) => ({
      id: f.id, kind: f.kind, mimeType: f.mimeType, container: f.container, videoCodec: f.videoCodec, audioCodec: f.audioCodec,
      width: f.width, height: f.height, sizeBytes: f.sizeBytes, language: f.language, label: f.label,
    })),
    subtitles: files.filter((f) => f.kind === "subtitle").map((f) => ({
      id: f.id, language: f.language ?? "und", label: f.label ?? f.language ?? "Subtitles", url: `/api/media/${m.id}/subtitles/${f.id}.vtt`,
    })),
    chapters: chs.map((c) => ({ startSeconds: c.startSeconds, endSeconds: c.endSeconds ?? c.startSeconds, title: c.title })),
    streamUrl: primary && base.playable ? `/api/media/${m.id}/stream` : null,
    hlsUrl, directPlay,
    recommendation: rec[0] ? { score: rec[0].score, explanation: rec[0].explanation, strategy: rec[0].strategy, status: rec[0].status } : null,
    evictions: evs.map((e) => ({ at: iso(e.createdAt), reason: e.reason, reclaimedBytes: e.reclaimedBytes })),
  };
}

// ------------------------------------------------------------------ sources

export type SourceRow = typeof s.sources.$inferSelect;

export async function toSources(d: Deps, rows: SourceRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const stats = await d.db.select({
    sourceId: s.mediaSources.sourceId,
    mediaCount: sql<number>`count(*)::int`,
    downloadedCount: sql<number>`count(*) filter (where ${s.media.availability} = 'available')::int`,
    storageBytes: sql<number>`coalesce(sum(${s.media.sizeBytes}) filter (where ${s.media.availability} = 'available'), 0)::float8`,
  }).from(s.mediaSources).innerJoin(s.media, eq(s.media.id, s.mediaSources.mediaId))
    .where(inArray(s.mediaSources.sourceId, ids)).groupBy(s.mediaSources.sourceId);
  const sm = new Map(stats.map((x) => [x.sourceId, x]));
  const cids = rows.map((r) => r.creatorId).filter((x): x is string => !!x);
  const creators = cids.length ? await d.db.select({ id: s.creators.id, avatarPath: s.creators.avatarPath }).from(s.creators).where(inArray(s.creators.id, cids)) : [];
  const cm = new Map(creators.map((c) => [c.id, c.avatarPath]));
  return rows.map((r) => {
    const st = sm.get(r.id);
    return {
      id: r.id, name: r.name, platform: r.platform, type: r.type, url: r.url, externalId: r.externalId, query: r.query,
      system: r.system, status: r.status, priority: r.priority, retention: r.retention, automaticEviction: r.automaticEviction,
      schedule: r.schedule, filters: r.filters, downloadOptions: r.downloadOptions, discovery: r.discovery,
      autoDownload: r.autoDownload, volumeId: r.volumeId, lastCheckedAt: iso(r.lastCheckedAt), lastSuccessAt: iso(r.lastSuccessAt),
      nextRunAt: iso(r.nextRunAt), consecutiveFailures: r.consecutiveFailures, lastError: r.lastError, needsAttention: r.needsAttention,
      avatarUrl: r.creatorId && cm.get(r.creatorId) ? `/api/creators/${r.creatorId}/avatar` : null,
      mediaCount: st?.mediaCount ?? 0, downloadedCount: st?.downloadedCount ?? 0, storageBytes: st?.storageBytes ?? 0,
      hasCookies: typeof r.metadata?.cookiesFile === "string" && r.metadata.cookiesFile !== "",
      createdAt: iso(r.createdAt),
    };
  });
}

// ---------------------------------------------------------------- downloads

export async function toDownloads(d: Deps, whereSql?: ReturnType<typeof sql>, limit = 200, extra?: { states?: string[] }) {
  void extra;
  const rows = await d.db.select({ dl: s.downloads, title: s.media.title, sourceName: s.sources.name })
    .from(s.downloads).innerJoin(s.media, eq(s.media.id, s.downloads.mediaId))
    .leftJoin(s.sources, eq(s.sources.id, s.downloads.sourceId))
    .where(whereSql ?? sql`true`).orderBy(desc(s.downloads.updatedAt)).limit(limit);
  return rows.map((r) => downloadDto(r.dl, r.title, r.sourceName));
}

export function downloadDto(r: typeof s.downloads.$inferSelect, title: string, sourceName: string | null) {
  return {
    id: r.id, mediaId: r.mediaId, title, sourceId: r.sourceId, sourceName, state: r.state, priority: r.priority,
    progress: r.progress, bytesDownloaded: r.bytesDownloaded, totalBytes: r.totalBytes, estimatedBytes: r.estimatedBytes,
    speedBps: r.speedBps, etaSeconds: r.etaSeconds, attempts: r.attempts, error: r.error, errorClass: r.errorClass,
    waitingReason: r.waitingReason, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
    startedAt: iso(r.startedAt), completedAt: iso(r.completedAt),
  };
}

export async function downloadById(d: Deps, id: string) {
  const [r] = await d.db.select({ dl: s.downloads, title: s.media.title, sourceName: s.sources.name })
    .from(s.downloads).innerJoin(s.media, eq(s.media.id, s.downloads.mediaId))
    .leftJoin(s.sources, eq(s.sources.id, s.downloads.sourceId)).where(eq(s.downloads.id, id));
  return r ? downloadDto(r.dl, r.title, r.sourceName) : null;
}

// ------------------------------------------------------------------ volumes

export async function toVolumes(d: Deps, live = false) {
  const vols = await d.db.select().from(s.storageVolumes).orderBy(asc(s.storageVolumes.createdAt));
  const res = await d.db.select({
    volumeId: s.storageReservations.volumeId,
    bytes: sql<number>`coalesce(sum(greatest(0, ${s.storageReservations.bytes} - ${s.storageReservations.writtenBytes})), 0)::float8`,
  }).from(s.storageReservations).where(isNull(s.storageReservations.releasedAt)).groupBy(s.storageReservations.volumeId);
  const rm = new Map(res.map((r) => [r.volumeId, r.bytes]));
  const { statVolume } = await import("@nocon/storage-manager");
  const out = [];
  for (const v of vols) {
    let total = v.totalBytes ?? 0, free = v.freeBytes ?? 0;
    if (live && v.isOnline) {
      try { const st = await statVolume(v.mountPath, d.config.STORAGE_STATFS_OVERRIDE_BYTES); total = st.totalBytes; free = st.freeBytes; } catch { /* use stored */ }
    }
    out.push({
      id: v.id, name: v.name, mountPath: v.mountPath, filesystem: v.filesystem, totalBytes: total, freeBytes: free,
      usedBytes: Math.max(0, total - free), reservedBytes: rm.get(v.id) ?? 0, isWritable: v.isWritable, isOnline: v.isOnline,
      isDefault: v.isDefault, acceptsNew: v.acceptsNew, lastVerifiedAt: iso(v.lastVerifiedAt), lastError: v.lastError,
    });
  }
  return out;
}

// ------------------------------------------------------------------ creators

export async function toCreators(d: Deps, rows: Array<typeof s.creators.$inferSelect>) {
  if (!rows.length) return [];
  const online = await volumeOnlineMap(d);
  void online;
  const ids = rows.map((r) => r.id);
  const counts = await d.db.select({
    creatorId: s.media.creatorId,
    mediaCount: sql<number>`count(*)::int`,
    playableCount: sql<number>`count(*) filter (where ${s.media.availability} = 'available' and exists (select 1 from storage_volumes v where v.id = "media"."volume_id" and v.is_online))::int`,
  }).from(s.media).where(inArray(s.media.creatorId, ids)).groupBy(s.media.creatorId);
  const cm = new Map(counts.map((c) => [c.creatorId, c]));
  return rows.map((c) => ({
    id: c.id, name: c.name, avatarUrl: c.avatarPath ? `/api/creators/${c.id}/avatar` : null,
    bannerUrl: c.bannerPath ? `/api/creators/${c.id}/banner` : null, description: c.description,
    mediaCount: cm.get(c.id)?.mediaCount ?? 0, playableCount: cm.get(c.id)?.playableCount ?? 0,
  }));
}

export const playableSql = sql`(${s.media.availability} = 'available' and exists (select 1 from storage_volumes v where v.id = "media"."volume_id" and v.is_online))`;
