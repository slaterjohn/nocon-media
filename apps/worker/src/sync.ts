import fsp from "node:fs/promises";
import path from "node:path";
import { and, eq, gt } from "drizzle-orm";
import * as s from "@nocon/database";
import {
  ensureDownload, linkMediaToSource, logActivity, raiseNotification, resolveNotification, upsertMedia, type Source,
} from "@nocon/database";
import { creatorArtworkDir } from "@nocon/media-core";
import { failureBackoffMs, hostAllowed, nextRunAt, resolveInside, type SourceFilters } from "@nocon/shared";
import type { DiscoveredEntry, IdentifiedSource, SourceAdapter } from "@nocon/source-adapters";
import {
  adapterForSource, appSettings, classifyError, errMessage, pickWritableVolume, type SyncTrigger, type WorkerContext,
} from "./context.js";

export const ARTWORK_HOSTS = ["ytimg.com", "ggpht.com", "googleusercontent.com"];
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

export interface SyncResult {
  status: "success" | "failed" | "skipped_offline" | "skipped";
  discovered: number;
  new: number;
  queued: number;
  skipped: number;
  error?: string;
}
const empty = (status: SyncResult["status"], error?: string): SyncResult => ({ status, discovered: 0, new: 0, queued: 0, skipped: 0, ...(error ? { error } : {}) });

/** Source filters applied in documented order. Returns the skip reason or null. Unknown values pass. */
export function filterEntry(e: DiscoveredEntry, f: Partial<SourceFilters>, now = new Date()): string | null {
  if (f.maxAgeDays && e.publishedAt && now.getTime() - e.publishedAt.getTime() > f.maxAgeDays * 86_400_000) return "too-old";
  if (e.durationSeconds !== undefined) {
    if (f.minDurationSec && e.durationSeconds < f.minDurationSec) return "too-short";
    if (f.maxDurationSec && e.durationSeconds > f.maxDurationSec) return "too-long";
  }
  if (e.isShort && !f.includeShorts) return "short";
  if (e.isLive && !f.includeLive) return "live";
  const title = e.title.toLowerCase();
  if (f.requiredKeywords?.length && !f.requiredKeywords.some((k) => title.includes(k.toLowerCase()))) return "missing-keyword";
  if (f.excludedKeywords?.some((k) => title.includes(k.toLowerCase()))) return "excluded-keyword";
  return null;
}

export async function runSync(ctx: WorkerContext, data: { sourceId: string; trigger: SyncTrigger }): Promise<SyncResult> {
  const { db, log } = ctx;
  const [source] = await db.select().from(s.sources).where(eq(s.sources.id, data.sourceId));
  if (!source || source.system || source.type === "history" || source.type === "discovery") return empty("skipped");
  if (source.status === "paused" && data.trigger !== "manual") return empty("skipped");

  if (!ctx.isOnline()) {
    await db.insert(s.sourceRuns).values({ sourceId: source.id, trigger: data.trigger, status: "skipped_offline", finishedAt: new Date() });
    log.info({ sourceId: source.id }, "sync skipped, offline");
    return empty("skipped_offline");
  }

  // Overlap guard: a run younger than 1 h blocks; an older one is considered dead.
  const hourAgo = new Date(Date.now() - 3600_000);
  const [running] = await db.select({ id: s.sourceRuns.id }).from(s.sourceRuns)
    .where(and(eq(s.sourceRuns.sourceId, source.id), eq(s.sourceRuns.status, "running"), gt(s.sourceRuns.startedAt, hourAgo))).limit(1);
  if (running) return empty("skipped");
  await db.update(s.sourceRuns).set({ status: "failed", error: "stale run", finishedAt: new Date() })
    .where(and(eq(s.sourceRuns.sourceId, source.id), eq(s.sourceRuns.status, "running")));

  const [run] = await db.insert(s.sourceRuns).values({ sourceId: source.id, trigger: data.trigger }).returning();
  await logActivity(db, { type: "source.sync.started", message: `Sync started for ${source.name}`, entityType: "source", entityId: source.id, data: { trigger: data.trigger } });

  const adapter = adapterForSource(ctx, source);
  try {
    const res = await syncSource(ctx, adapter, source);
    const now = new Date();
    await db.update(s.sourceRuns).set({
      status: "success", finishedAt: now, discoveredCount: res.discovered, newCount: res.new, queuedCount: res.queued, skippedCount: res.skipped,
    }).where(eq(s.sourceRuns.id, run!.id));
    await db.update(s.sources).set({
      lastCheckedAt: now, lastSuccessAt: now, hasRun: true, consecutiveFailures: 0, lastError: null, needsAttention: false,
      nextRunAt: nextRunAt(source.schedule, now, true), updatedAt: now,
    }).where(eq(s.sources.id, source.id));
    await resolveNotification(db, `source:failing:${source.id}`);
    await logActivity(db, {
      type: "source.sync.completed", message: `Sync completed for ${source.name}: ${res.new} new, ${res.queued} queued`,
      entityType: "source", entityId: source.id, data: { discovered: res.discovered, new: res.new, queued: res.queued, skipped: res.skipped },
    });
    return { ...res, status: "success" };
  } catch (err) {
    const errorClass = classifyError(adapter, err);
    const message = errMessage(err);
    const failures = source.consecutiveFailures + 1;
    const now = new Date();
    let backoff = failureBackoffMs(failures);
    if (errorClass === "rate_limited") backoff = Math.max(backoff, 3600_000 * Math.min(failures, 6));
    await db.update(s.sourceRuns).set({ status: "failed", finishedAt: now, error: message }).where(eq(s.sourceRuns.id, run!.id));
    await db.update(s.sources).set({
      lastCheckedAt: now, consecutiveFailures: failures, lastError: message, needsAttention: failures >= 3 || source.needsAttention,
      nextRunAt: source.schedule.kind === "manual" ? null : new Date(now.getTime() + backoff), updatedAt: now,
    }).where(eq(s.sources.id, source.id));
    if (failures >= 3) {
      await raiseNotification(db, {
        key: `source:failing:${source.id}`, severity: "warning", title: `Source "${source.name}" keeps failing`,
        body: message, remediation: "Check the source URL. If the content needs a login, upload fresh cookies under \"Authentication cookies\" on the source page (Admin, Sources). Then run a manual sync.",
      });
    }
    await logActivity(db, {
      type: "source.sync.failed", severity: "warning", message: `Sync failed for ${source.name}: ${message}`,
      entityType: "source", entityId: source.id, data: { errorClass, failures },
    });
    log.warn({ sourceId: source.id, errorClass, err: message }, "sync failed");
    return empty("failed", message);
  }
}

async function listEntries(adapter: SourceAdapter, source: Source, identified: IdentifiedSource | null): Promise<DiscoveredEntry[]> {
  const f = source.filters ?? {};
  if (source.type === "search") {
    if (!source.query) throw new Error("Search source has no query");
    return adapter.search ? adapter.search(source.query, 20) : [];
  }
  if (!identified) throw new Error(`Cannot identify source URL: ${source.url ?? "(none)"}`);
  if (source.type === "video") {
    const info = await adapter.fetchMediaInfo(identified.canonicalUrl);
    return [{
      externalId: identified.externalId, canonicalKey: `${source.platform}:${identified.externalId}`, url: identified.canonicalUrl,
      title: info.title, durationSeconds: info.durationSeconds, ...(info.publishedAt ? { publishedAt: info.publishedAt } : {}),
      channelId: info.channel.id || undefined, channelName: info.channel.name || undefined, isShort: false, isLive: info.isLive,
      ...(info.thumbnailUrl ? { thumbnailUrl: info.thumbnailUrl } : {}), description: info.description,
    }];
  }
  const limit = source.hasRun ? 30 : (f.maxHistorical ?? 50);
  if (limit <= 0) return [];
  return adapter.discover(identified, { limit, includeShorts: f.includeShorts ?? false, includeLive: f.includeLive ?? false });
}

async function syncSource(ctx: WorkerContext, adapter: SourceAdapter, source: Source): Promise<Omit<SyncResult, "status">> {
  const { db } = ctx;
  const identified = source.url ? adapter.identify(source.url) : null;
  const filters = source.filters ?? {};
  const entries = await listEntries(adapter, source, identified);
  const result = { discovered: entries.length, new: 0, queued: 0, skipped: 0 };

  if (!source.hasRun && identified && (source.type === "channel" || source.type === "playlist")) {
    await refreshSourceInfo(ctx, adapter, source, identified).catch((e) => ctx.log.warn({ sourceId: source.id, err: errMessage(e) }, "source info failed"));
  }

  const app = await appSettings(ctx);
  const maxNew = filters.maxNewPerRun ?? Infinity;
  const options = { ...source.downloadOptions, resolution: source.downloadOptions?.resolution ?? app.defaultResolution } as typeof source.downloadOptions;
  let position = 0;

  for (const e of entries) {
    position++;
    // Explicitly requested single videos and searches skip the filters that describe a channel feed.
    const skip = source.type === "video" ? null : filterEntry(e, filters);
    if (skip) { result.skipped++; continue; }

    const { media, created } = await upsertMedia(db, {
      canonicalKey: e.canonicalKey, platform: source.platform, externalId: e.externalId, url: e.url, title: e.title,
      description: e.description, channelId: e.channelId, channelName: e.channelName, publishedAt: e.publishedAt,
      durationSeconds: e.durationSeconds, isShort: e.isShort, isLive: e.isLive, thumbnailUrl: e.thumbnailUrl, viewCount: e.viewCount,
    });
    if (created) result.new++;
    if (filters.preferredLanguage && media.language && !media.language.toLowerCase().startsWith(filters.preferredLanguage.toLowerCase())) {
      result.skipped++;
      continue;
    }
    await linkMediaToSource(db, { mediaId: media.id, sourceId: source.id, position: source.type === "playlist" ? (e.position ?? position) : null });

    if (!source.autoDownload || result.queued >= maxNew) continue;
    if (!["discovered", "evicted"].includes(media.availability)) continue;
    const r = await ensureDownload(db, { mediaId: media.id, sourceId: source.id, priority: source.priority, options, requestedBy: "source" });
    if (r.download) {
      if (r.created) result.queued++;
      await ctx.enqueueDownload(r.download.id);
    }
  }
  return result;
}

/** First successful run: store channel/playlist metadata, the creator row and (allow-listed) artwork. */
async function refreshSourceInfo(ctx: WorkerContext, adapter: SourceAdapter, source: Source, identified: IdentifiedSource): Promise<void> {
  const { db } = ctx;
  const info = await adapter.fetchSourceInfo(identified);
  const metadata = { ...source.metadata, title: info.title, description: info.description, avatarUrl: info.avatarUrl, bannerUrl: info.bannerUrl };
  const set: Partial<typeof s.sources.$inferInsert> = { metadata, updatedAt: new Date() };

  if (source.type === "channel") {
    const channelId = info.channelId ?? identified.externalId;
    const [creator] = await db.insert(s.creators).values({
      platform: source.platform, externalId: channelId, name: info.channelName ?? info.title ?? channelId,
      url: identified.canonicalUrl, description: info.description || null,
    }).onConflictDoUpdate({
      target: [s.creators.platform, s.creators.externalId],
      set: { name: info.channelName ?? info.title ?? channelId, url: identified.canonicalUrl, description: info.description || null, updatedAt: new Date() },
    }).returning();
    set.creatorId = creator!.id;

    const volume = await pickWritableVolume(ctx, source.volumeId);
    if (volume) {
      const dir = creatorArtworkDir(source.platform, channelId);
      const avatar = await saveArtwork(ctx, info.avatarUrl, volume.mountPath, `${dir}/avatar.jpg`);
      const banner = await saveArtwork(ctx, info.bannerUrl, volume.mountPath, `${dir}/banner.jpg`);
      if (avatar || banner) {
        await db.update(s.creators).set({
          ...(avatar ? { avatarPath: `${dir}/avatar.jpg` } : {}), ...(banner ? { bannerPath: `${dir}/banner.jpg` } : {}), artworkVolumeId: volume.id,
        }).where(eq(s.creators.id, creator!.id));
      }
    }
  }
  await db.update(s.sources).set(set).where(eq(s.sources.id, source.id));
}

const MAX_ARTWORK_REDIRECTS = 3;

/** Reads a body with a running byte cap; returns null (and cancels the stream) once the cap is exceeded. */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Downloads an image only from allow-listed hosts (https). Redirects are followed manually, at most
 * MAX_ARTWORK_REDIRECTS hops, re-checking scheme and host allowlist on every Location. The response must be
 * image/* and is streamed with a MAX_ARTWORK_BYTES cap. Returns true when saved.
 */
export async function saveArtwork(ctx: WorkerContext, url: string | null, mount: string, rel: string): Promise<boolean> {
  if (!url) return false;
  try {
    let u = new URL(url);
    const signal = AbortSignal.timeout(15_000);
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_ARTWORK_REDIRECTS; hop++) {
      if (u.protocol !== "https:" || !hostAllowed(u.hostname, ARTWORK_HOSTS)) return false;
      const r = await ctx.fetch(u, { signal, redirect: "manual" });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await r.body?.cancel().catch(() => undefined);
        if (!loc || hop === MAX_ARTWORK_REDIRECTS) return false;
        u = new URL(loc, u);
        continue;
      }
      res = r;
      break;
    }
    if (!res || !res.ok) return false;
    if (!/^image\//i.test(res.headers.get("content-type") ?? "")) { await res.body?.cancel().catch(() => undefined); return false; }
    const buf = await readCapped(res, MAX_ARTWORK_BYTES);
    if (!buf || buf.length === 0) return false;
    const target = resolveInside(mount, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buf);
    return true;
  } catch (e) {
    ctx.log.debug({ err: errMessage(e) }, "artwork download failed");
    return false;
  }
}
