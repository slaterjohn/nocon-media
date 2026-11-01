import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { ensureDownload, ensureSystemSources, getSetting, linkMediaToSource, setSetting, upsertMedia } from "@nocon/database";
import {
  buildProfile, buildSearchQueries, nextDepth, scoreCandidate, selectWithinBudget,
  type Candidate, type HistoryItem, type ScoreResult,
} from "@nocon/discovery";
import { discoveryBudgetSchema, type DiscoveryBudget } from "@nocon/shared";
import type { DiscoveredEntry, IdentifiedSource } from "@nocon/source-adapters";
import { appSettings, classifyError, errMessage, type WorkerContext } from "./context.js";

export const BYTES_PER_SECOND = 750 * 1024; // ~1080p
const DAY = 86_400_000;

export interface DiscoveryResult {
  status: "completed" | "skipped";
  seeds: number;
  candidates: number;
  accepted: number;
  queued: number;
  reason?: string;
}

interface Seed { mediaId: string; title: string; tags: string[]; creatorExternalId: string | null; platform: string; depth: number }
interface Cand extends Candidate {
  entry: DiscoveredEntry;
  seed: Seed;
  depth: number;
  strategy: "same_channel" | "search";
  result: ScoreResult;
}

export async function getDiscoveryBudget(ctx: Pick<WorkerContext, "db">): Promise<DiscoveryBudget> {
  return discoveryBudgetSchema.parse(await getSetting<unknown>(ctx.db, "discovery", {}));
}

export async function runDiscovery(ctx: WorkerContext, _data: { trigger: "schedule" | "manual" }): Promise<DiscoveryResult> {
  const { db, log } = ctx;
  const skipped = (reason: string): DiscoveryResult => ({ status: "skipped", seeds: 0, candidates: 0, accepted: 0, queued: 0, reason });
  const budget = await getDiscoveryBudget(ctx);
  if (!budget.enabled) return skipped("disabled");
  if (!ctx.isOnline()) return skipped("offline");

  const now = new Date();
  await setSetting(db, "discovery.lastRunAt", now.toISOString());
  const { discovery: discoverySource } = await ensureSystemSources(db);
  const adapter = ctx.adapterFor("youtube");
  const since = new Date(now.getTime() - 30 * DAY);

  // ---- seeds
  const seedSelect = {
    mediaId: s.media.id, title: s.media.title, tags: s.media.tags, platform: s.media.platform, creatorExternalId: s.creators.externalId,
  };
  const downloaded = await db.select(seedSelect).from(s.media).leftJoin(s.creators, eq(s.creators.id, s.media.creatorId))
    .where(and(eq(s.media.availability, "available"), eq(s.media.effectivePriority, "P1"), gte(s.media.downloadedAt, since)))
    .orderBy(desc(s.media.downloadedAt)).limit(10);
  const watched = await db.select(seedSelect).from(s.playbackHistory)
    .innerJoin(s.media, eq(s.media.id, s.playbackHistory.mediaId)).leftJoin(s.creators, eq(s.creators.id, s.media.creatorId))
    .where(gte(s.playbackHistory.lastWatchedAt, since)).orderBy(desc(s.playbackHistory.lastWatchedAt)).limit(10);
  const seeds = new Map<string, Seed>();
  for (const r of [...downloaded, ...watched]) seeds.set(r.mediaId, { ...r, depth: 0 });
  if (budget.maxDepth >= 2) {
    const recs = await db.select({ ...seedSelect, depth: s.recommendations.depth }).from(s.recommendations)
      .innerJoin(s.media, eq(s.media.id, s.recommendations.mediaId)).leftJoin(s.creators, eq(s.creators.id, s.media.creatorId))
      .where(inArray(s.recommendations.status, ["approved", "queued"])).limit(10);
    for (const r of recs) if (!seeds.has(r.mediaId)) seeds.set(r.mediaId, r);
  }

  // ---- profile: watched items count three times as much as library items
  const profileCols = { title: s.media.title, tags: s.media.tags, categories: s.media.categories, channelId: s.creators.externalId, durationSeconds: s.media.durationSeconds };
  const weighted = (rows: Omit<HistoryItem, "weight">[], weight: number): HistoryItem[] => rows.map((r) => ({ ...r, weight }));
  const watchedItems = await db.select(profileCols).from(s.playbackHistory)
    .innerJoin(s.media, eq(s.media.id, s.playbackHistory.mediaId)).leftJoin(s.creators, eq(s.creators.id, s.media.creatorId))
    .orderBy(desc(s.playbackHistory.lastWatchedAt)).limit(500);
  const libraryItems = await db.select(profileCols).from(s.media).leftJoin(s.creators, eq(s.creators.id, s.media.creatorId))
    .where(eq(s.media.availability, "available")).orderBy(desc(s.media.downloadedAt)).limit(500);
  const profile = buildProfile([...weighted(watchedItems, 3), ...weighted(libraryItems, 1)]);

  // ---- candidate gathering: at most 2 sequential yt-dlp calls per seed
  const candidates = new Map<string, Cand>();
  let stopped = false;
  for (const seed of seeds.values()) {
    if (stopped || ctx.signal.aborted) break;
    const depth = nextDepth(seed.depth, budget.maxDepth);
    if (depth === null) continue;
    const calls: { strategy: Cand["strategy"]; run: () => Promise<DiscoveredEntry[]> }[] = [];
    if (seed.creatorExternalId) {
      const src: IdentifiedSource = {
        platform: seed.platform, type: "channel", externalId: seed.creatorExternalId,
        canonicalUrl: `https://www.youtube.com/channel/${seed.creatorExternalId}`,
      };
      calls.push({ strategy: "same_channel", run: () => adapter.discover(src, { limit: 15, signal: ctx.signal }) });
    }
    const [query] = buildSearchQueries(seed, 1);
    if (query && adapter.search) calls.push({ strategy: "search", run: () => adapter.search!(query, 10, { signal: ctx.signal }) });

    for (const call of calls) {
      try {
        for (const e of await call.run()) {
          const base: Candidate = {
            id: e.canonicalKey, title: e.title, description: e.description, tags: [], categories: [], channelId: e.channelId,
            durationSeconds: e.durationSeconds, publishedAt: e.publishedAt,
          };
          const result = scoreCandidate(base, profile, { now, preferredMaxDuration: budget.maxDurationSec, seed: { title: seed.title, tags: seed.tags } });
          const prev = candidates.get(e.canonicalKey);
          if (!prev || result.score > prev.result.score) candidates.set(e.canonicalKey, { ...base, entry: e, seed, depth, strategy: call.strategy, result });
        }
      } catch (err) {
        const cls = classifyError(adapter, err);
        log.warn({ seed: seed.mediaId, strategy: call.strategy, errorClass: cls, err: errMessage(err) }, "discovery call failed");
        if (cls === "rate_limited" || cls === "network") { stopped = true; break; }
      }
    }
  }

  // ---- exclusions: already in the library or queue, already recommended (any status, incl. rejected), cooling down, or a seed itself
  const seedIds = new Set([...seeds.values()].map((x) => x.mediaId));
  const keys = [...candidates.keys()];
  const existing = keys.length
    ? await db.select({ id: s.media.id, key: s.media.canonicalKey, availability: s.media.availability, redownloadAfter: s.media.redownloadAfter, rec: s.recommendations.id })
      .from(s.media).leftJoin(s.recommendations, eq(s.recommendations.mediaId, s.media.id)).where(inArray(s.media.canonicalKey, keys))
    : [];
  for (const m of existing) {
    const blocked = ["available", "queued", "downloading"].includes(m.availability) || m.rec !== null
      || (m.redownloadAfter !== null && m.redownloadAfter > now) || seedIds.has(m.id);
    if (blocked) candidates.delete(m.key);
  }

  // ---- budget
  const [recTotal] = await db.select({ n: count() }).from(s.recommendations);
  const [usage] = await db.select({ bytes: sql<number>`coalesce(sum(${s.media.sizeBytes}), 0)::float8`, n: count() })
    .from(s.media)
    .innerJoin(s.mediaSources, and(eq(s.mediaSources.mediaId, s.media.id), eq(s.mediaSources.sourceId, discoverySource.id)))
    .where(eq(s.media.availability, "available"));
  const [activeDl] = await db.select({ n: count() }).from(s.downloads)
    .where(and(eq(s.downloads.requestedBy, "discovery"), inArray(s.downloads.state, ["queued", "checking", "waiting_for_storage", "downloading", "processing", "verifying", "paused"])));
  const remainingItems = Math.max(0, budget.maxDiscovered - (recTotal?.n ?? 0));
  const remainingDownloads = Math.max(0, budget.maxDownloaded - (usage?.n ?? 0) - (activeDl?.n ?? 0));
  const maxItems = budget.mode === "auto" ? Math.min(remainingItems, remainingDownloads) : remainingItems;
  const maxBytes = Math.max(0, budget.maxStorageBytes - Number(usage?.bytes ?? 0));
  const estimateBytes = (c: Cand): number => (c.durationSeconds ?? 600) * BYTES_PER_SECOND;

  const scored = [...candidates.values()].map((c) => ({ candidate: c, score: c.result.score }));
  const { accepted } = selectWithinBudget(scored, {
    maxItems, maxBytes, minScore: budget.minScore, maxDurationSec: budget.maxDurationSec, maxAgeDays: budget.maxAgeDays,
  }, estimateBytes, now);

  // ---- persist
  const app = await appSettings(ctx);
  let queued = 0;
  for (const { candidate: c, score } of accepted) {
    const e = c.entry;
    const { media } = await upsertMedia(db, {
      canonicalKey: e.canonicalKey, platform: c.seed.platform, externalId: e.externalId, url: e.url, title: e.title, description: e.description,
      channelId: e.channelId, channelName: e.channelName, publishedAt: e.publishedAt, durationSeconds: e.durationSeconds,
      isShort: e.isShort, isLive: e.isLive, thumbnailUrl: e.thumbnailUrl, viewCount: e.viewCount,
    });
    await linkMediaToSource(db, { mediaId: media.id, sourceId: discoverySource.id, depth: c.depth, reason: c.strategy });
    await db.update(s.media).set({ recommendationScore: score, updatedAt: new Date() }).where(eq(s.media.id, media.id));
    await db.insert(s.discoveryRelationships).values({ fromMediaId: c.seed.mediaId, toMediaId: media.id, strategy: c.strategy, weight: score })
      .onConflictDoNothing();

    let status: typeof s.recommendations.$inferInsert["status"] = budget.mode === "approval" ? "pending" : "catalogued";
    if (budget.mode === "auto") {
      const r = await ensureDownload(db, {
        mediaId: media.id, sourceId: discoverySource.id, priority: "P3", options: { resolution: app.defaultResolution as 1080 }, requestedBy: "discovery",
      });
      if (r.download) {
        status = "queued";
        queued++;
        await ctx.enqueueDownload(r.download.id);
      }
    }
    await db.insert(s.recommendations).values({
      mediaId: media.id, score, explanation: { components: c.result.components, reasons: c.result.explanation },
      depth: c.depth, seedMediaId: c.seed.mediaId, strategy: c.strategy, status,
    }).onConflictDoUpdate({
      target: s.recommendations.mediaId,
      set: { score, depth: c.depth, seedMediaId: c.seed.mediaId, strategy: c.strategy, updatedAt: new Date() },
    });
  }
  log.info({ seeds: seeds.size, candidates: scored.length, accepted: accepted.length, queued }, "discovery run finished");
  return { status: "completed", seeds: seeds.size, candidates: scored.length, accepted: accepted.length, queued };
}
