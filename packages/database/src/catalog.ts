import { and, eq, notInArray, sql } from "drizzle-orm";
import { assertTransition, type DownloadOptions, type DownloadState, type Priority } from "@nocon/shared";
import type { Database, DbOrTx } from "./client.js";
import { recomputeEffectivePriority } from "./repo.js";
import * as s from "./schema.js";

export type Media = typeof s.media.$inferSelect;
export type Source = typeof s.sources.$inferSelect;
export type Download = typeof s.downloads.$inferSelect;

const FINISHED_STATES: DownloadState[] = ["ready", "failed", "evicted", "unavailable"];

// ---------------------------------------------------------------- system sources

/** Idempotent: creates the built-in history / discovery / manual sources if missing. */
export async function ensureSystemSources(db: DbOrTx): Promise<{ history: Source; discovery: Source; manual: Source }> {
  await db.insert(s.sources).values([
    { name: "Watch history", type: "history", system: true, priority: "P2", retention: { mode: "none" }, schedule: { kind: "manual" }, autoDownload: false },
    { name: "Discovery", type: "discovery", system: true, priority: "P3", retention: { mode: "none" }, schedule: { kind: "manual" }, autoDownload: false },
    { name: "Manual downloads", type: "video", system: true, priority: "P1", retention: { mode: "all" }, schedule: { kind: "manual" }, autoDownload: false },
  ]).onConflictDoNothing();
  const rows = await db.select().from(s.sources).where(eq(s.sources.system, true));
  const byType = (t: string) => {
    const r = rows.find((x) => x.type === t);
    if (!r) throw new Error(`System source ${t} missing`);
    return r;
  };
  return { history: byType("history"), discovery: byType("discovery"), manual: byType("video") };
}

// ---------------------------------------------------------------- media

export interface MediaEntry {
  canonicalKey: string;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  description?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  publishedAt?: Date | null;
  durationSeconds?: number | null;
  isShort?: boolean;
  isLive?: boolean;
  thumbnailUrl?: string | null;
  viewCount?: number | null;
  categories?: string[];
  tags?: string[];
  language?: string | null;
}

/** Insert or refresh a media row by canonical key. Never touches availability or priority fields. */
export async function upsertMedia(db: DbOrTx, e: MediaEntry): Promise<{ media: Media; created: boolean }> {
  const [existing] = await db.select({ id: s.media.id }).from(s.media).where(eq(s.media.canonicalKey, e.canonicalKey));

  let creatorId: string | null = null;
  if (e.channelId) {
    const [c] = await db.insert(s.creators).values({
      platform: e.platform, externalId: e.channelId, name: e.channelName || e.channelId,
      url: e.platform === "youtube" ? `https://www.youtube.com/channel/${e.channelId}` : null,
    }).onConflictDoUpdate({
      target: [s.creators.platform, s.creators.externalId],
      set: e.channelName ? { name: e.channelName, updatedAt: new Date() } : { updatedAt: new Date() },
    }).returning({ id: s.creators.id });
    creatorId = c!.id;
  }

  const values = {
    canonicalKey: e.canonicalKey, platform: e.platform, externalId: e.externalId, url: e.url, title: e.title,
    description: e.description ?? null, creatorId, channelName: e.channelName ?? null,
    publishedAt: e.publishedAt ?? null, durationSeconds: e.durationSeconds != null ? Math.round(e.durationSeconds) : null,
    isShort: e.isShort ?? false, isLive: e.isLive ?? false, remoteThumbnailUrl: e.thumbnailUrl ?? null,
    viewCount: e.viewCount ?? null, categories: e.categories ?? [], tags: e.tags ?? [], language: e.language ?? null,
  };
  const t = s.media;
  const keep = <C extends { name: string }>(col: C) => sql.raw(`coalesce(excluded."${col.name}", "media"."${col.name}")`);
  const keepArr = <C extends { name: string }>(col: C) =>
    sql.raw(`case when cardinality(excluded."${col.name}") > 0 then excluded."${col.name}" else "media"."${col.name}" end`);
  const [row] = await db.insert(s.media).values(values).onConflictDoUpdate({
    target: t.canonicalKey,
    set: {
      url: sql`excluded.url`,
      title: sql`excluded.title`,
      description: keep(t.description),
      creatorId: keep(t.creatorId),
      channelName: keep(t.channelName),
      publishedAt: keep(t.publishedAt),
      durationSeconds: keep(t.durationSeconds),
      isShort: e.isShort === undefined ? sql`"media"."is_short"` : sql`excluded.is_short`,
      isLive: e.isLive === undefined ? sql`"media"."is_live"` : sql`excluded.is_live`,
      remoteThumbnailUrl: keep(t.remoteThumbnailUrl),
      viewCount: keep(t.viewCount),
      categories: keepArr(t.categories),
      tags: keepArr(t.tags),
      language: keep(t.language),
      updatedAt: new Date(),
    },
  }).returning();
  return { media: row!, created: !existing };
}

export async function linkMediaToSource(
  db: DbOrTx,
  l: { mediaId: string; sourceId: string; position?: number | null; depth?: number; reason?: string | null },
): Promise<void> {
  await db.insert(s.mediaSources).values({
    mediaId: l.mediaId, sourceId: l.sourceId, position: l.position ?? null, depth: l.depth ?? 0, reason: l.reason ?? null,
  }).onConflictDoUpdate({
    target: [s.mediaSources.mediaId, s.mediaSources.sourceId],
    set: l.position != null ? { position: l.position } : { sourceId: l.sourceId },
  });
  await recomputeEffectivePriority(db, l.mediaId);
}

// ---------------------------------------------------------------- downloads

export interface EnsureDownloadInput {
  mediaId: string;
  sourceId?: string | null;
  priority: Priority;
  options?: Partial<DownloadOptions>;
  requestedBy: string;
}
export type EnsureDownloadResult =
  | { download: Download; created: boolean }
  | { download: null; created: false; reason: "cooldown" | "available" };

export async function ensureDownload(db: Database, i: EnsureDownloadInput): Promise<EnsureDownloadResult> {
  const findActive = async (): Promise<Download | undefined> => {
    const [d] = await db.select().from(s.downloads)
      .where(and(eq(s.downloads.mediaId, i.mediaId), notInArray(s.downloads.state, FINISHED_STATES)));
    return d;
  };
  const active = await findActive();
  if (active) return { download: active, created: false };

  const [m] = await db.select().from(s.media).where(eq(s.media.id, i.mediaId));
  if (!m) throw new Error(`Media ${i.mediaId} not found`);
  const forced = i.requestedBy === "manual" || i.requestedBy === "restore";
  if (!forced && m.availability === "available") return { download: null, created: false, reason: "available" };
  if (!forced && m.redownloadAfter && m.redownloadAfter.getTime() > Date.now()) return { download: null, created: false, reason: "cooldown" };

  try {
    return await db.transaction(async (tx) => {
      const [d] = await tx.insert(s.downloads).values({
        mediaId: i.mediaId, sourceId: i.sourceId ?? null, state: "queued", priority: i.priority,
        options: (i.options ?? {}) as DownloadOptions, requestedBy: i.requestedBy,
      }).returning();
      await tx.insert(s.downloadEvents).values({ downloadId: d!.id, fromState: null, toState: "queued", reason: i.requestedBy });
      if (m.availability !== "available") {
        await tx.update(s.media).set({ availability: "queued", updatedAt: new Date() }).where(eq(s.media.id, i.mediaId));
      }
      return { download: d!, created: true };
    });
  } catch (err) {
    const again = await findActive(); // lost a race against the unique partial index
    if (again) return { download: again, created: false };
    throw err;
  }
}

const AVAILABILITY_FOR_STATE: Partial<Record<DownloadState, Media["availability"]>> = {
  queued: "queued", checking: "queued", waiting_for_storage: "queued", paused: "queued",
  downloading: "downloading", processing: "downloading", verifying: "downloading",
  unavailable: "unavailable",
};

export type DownloadPatch = Partial<Omit<typeof s.downloads.$inferInsert, "id" | "state" | "mediaId">>;

/** Validated state change: updates the row, writes a download_event and mirrors media availability. */
export async function transitionDownload(
  db: DbOrTx, downloadId: string, to: DownloadState, patch: DownloadPatch = {}, reason?: string,
): Promise<Download> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(s.downloads).where(eq(s.downloads.id, downloadId)).for("update");
    if (!cur) throw new Error(`Download ${downloadId} not found`);
    assertTransition(cur.state, to);
    const [row] = await tx.update(s.downloads).set({ ...patch, state: to, updatedAt: new Date() })
      .where(eq(s.downloads.id, downloadId)).returning();
    if (cur.state !== to) {
      await tx.insert(s.downloadEvents).values({ downloadId, fromState: cur.state, toState: to, reason: reason ?? null });
    }

    let avail = AVAILABILITY_FOR_STATE[to];
    if (to === "failed") {
      const [m] = await tx.select({ downloadedAt: s.media.downloadedAt }).from(s.media).where(eq(s.media.id, cur.mediaId));
      avail = m?.downloadedAt ? "evicted" : "failed";
    }
    if (avail) {
      await tx.update(s.media).set({ availability: avail, updatedAt: new Date() })
        .where(and(eq(s.media.id, cur.mediaId), notInArray(s.media.availability, ["available"])));
    }
    return row!;
  });
}
