import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { resolveInside, type Priority, type RetentionPolicy } from "@nocon/shared";
import * as s from "@nocon/database";
import {
  logActivity, raiseNotification, resolveNotification,
  type Database, type DbOrTx,
} from "@nocon/database";
import {
  buildPlan, buildSoftThresholdPlan, availableBytes, requiredBytes, retainedBySource, rollingExcess,
  type Candidate, type Plan, type RetentionItem,
} from "./planner.js";
import { statVolume, verifyVolume, mountInfo } from "./volumes.js";

type MediaRow = typeof s.media.$inferSelect;
type VolumeRow = typeof s.storageVolumes.$inferSelect;

export interface StorageConfig {
  softThresholdPct: number;
  minFreePct: number;
  statfsOverrideBytes?: number;
  cooldownDays: number;
}

export interface StorageServiceOptions {
  db: Database;
  config: StorageConfig;
  /** A stream session seen within this many seconds counts as active. Default 90. */
  activeStreamWindowSec?: number;
}

export type EvictionReason = "storage_pressure" | "soft_threshold" | "retention_rolling" | "manual" | (string & {});

export interface LoadedCandidate extends Candidate {
  title: string;
  volumeId: string | null;
  sources: Array<{ id: string; name: string }>;
  retentionSnapshot: Array<{ sourceId: string; retention: RetentionPolicy }>;
}

export interface VolumeTransition {
  volumeId: string;
  wasOnline: boolean;
  online: boolean;
  writable: boolean;
  transition: "went_offline" | "came_online" | null;
  /** Downloads moved to paused(volume_offline). */
  pausedDownloadIds: string[];
  /** Downloads moved back to queued; the worker should re-enqueue them. */
  resumedDownloadIds: string[];
}

export interface AdmitInput {
  downloadId: string;
  mediaId: string;
  priority: Priority;
  autoEvict: boolean;
  estimatedBytes: number;
  volumeId?: string;
}

export interface EvictionSummary { recordId: string; mediaId: string; title: string; sizeBytes: number; status: "planned" | "completed" | "failed" | "skipped"; error?: string }

export interface VolumeShortfall { volumeId: string; availableBytes: number; eligibleBytes: number; toReclaimBytes: number }

export type AdmitResult =
  | { status: "admitted"; volumeId: string; reservationId: string; evictionPlanId?: string; evictions: EvictionSummary[] }
  | { status: "insufficient"; requiredBytes: number; volumeId: string | null; availableBytes: number; eligibleBytes: number; shortfallBytes: number; volumes: VolumeShortfall[]; reason?: "no_volume" }
  | { status: "rejected"; reason: "cancelled" | "already_ready" | "download_not_found" };

export interface SimulateInput { bytes: number; priority: Priority; volumeId?: string; autoEvict?: boolean }
export interface SimulationResult {
  volumeId: string | null;
  requiredBytes: number;
  availableBytes: number;
  totalBytes: number;
  candidates: Array<{ mediaId: string; title: string; sizeBytes: number; priority: Priority; sources: Array<{ id: string; name: string }> }>;
  reclaimedBytes: number;
  resultingAvailable: number;
  sufficient: boolean;
  affectedSources: Array<{ id: string; name: string }>;
}

export interface ExecuteResult { completed: number; failed: number; skipped: number; results: EvictionSummary[] }
export interface CleanupResult { planId: string | null; evicted: number; reclaimedBytes: number }

const ACTIVE_RESERVATION = isNull(s.storageReservations.releasedAt);

export class StorageService {
  private readonly db: Database;
  private readonly config: StorageConfig;
  private readonly streamWindowSec: number;

  constructor(opts: StorageServiceOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.streamWindowSec = opts.activeStreamWindowSec ?? 90;
  }

  // ---------------------------------------------------------------- volumes

  async refreshAllVolumes(): Promise<VolumeTransition[]> {
    const vols = await this.db.select({ id: s.storageVolumes.id }).from(s.storageVolumes);
    const out: VolumeTransition[] = [];
    for (const v of vols) out.push(await this.refreshVolume(v.id));
    return out;
  }

  async refreshVolume(volumeId: string): Promise<VolumeTransition> {
    const [vol] = await this.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, volumeId));
    if (!vol) throw new Error(`Volume ${volumeId} not found`);
    const status = await verifyVolume(vol.mountPath, vol.id);
    let stat: { totalBytes: number; freeBytes: number } | null = null;
    let error = status.reason ?? null;
    if (status.online) {
      try { stat = await statVolume(vol.mountPath, this.config.statfsOverrideBytes); } catch (e) { error = (e as Error).message; }
    }
    const mi = status.online ? mountInfo(vol.mountPath) : null;
    await this.db.update(s.storageVolumes).set({
      isOnline: status.online,
      isWritable: status.online && status.writable,
      totalBytes: stat?.totalBytes ?? vol.totalBytes,
      freeBytes: stat?.freeBytes ?? vol.freeBytes,
      filesystem: mi?.fsType ?? vol.filesystem,
      device: mi?.source ?? vol.device,
      lastVerifiedAt: new Date(),
      lastError: error,
    }).where(eq(s.storageVolumes.id, volumeId));

    const result: VolumeTransition = {
      volumeId, wasOnline: vol.isOnline, online: status.online, writable: status.online && status.writable,
      transition: null, pausedDownloadIds: [], resumedDownloadIds: [],
    };

    if (vol.isOnline && !status.online) {
      result.transition = "went_offline";
      result.pausedDownloadIds = await this.pauseDownloadsForVolume(vol, status.reason ?? "marker missing");
    } else if (!vol.isOnline && status.online) {
      result.transition = "came_online";
      result.resumedDownloadIds = await this.resumeDownloadsForVolume(vol);
    }
    return result;
  }

  private async pauseDownloadsForVolume(vol: VolumeRow, reason: string): Promise<string[]> {
    const affected = await this.db.transaction(async (tx) => {
      const rows = await tx.select({ id: s.downloads.id, state: s.downloads.state }).from(s.downloads)
        .where(and(eq(s.downloads.volumeId, vol.id), inArray(s.downloads.state, ["queued", "checking", "downloading", "waiting_for_storage"])));
      if (rows.length) {
        await tx.update(s.downloads).set({ state: "paused", waitingReason: "volume_offline", updatedAt: new Date() })
          .where(inArray(s.downloads.id, rows.map((r) => r.id)));
        await tx.insert(s.downloadEvents).values(rows.map((r) => ({
          downloadId: r.id, fromState: r.state, toState: "paused" as const, reason: "volume_offline",
        })));
      }
      return rows.map((r) => r.id);
    });
    await raiseNotification(this.db, {
      key: `volume:offline:${vol.id}`, severity: "error", title: `Storage volume "${vol.name}" is offline`,
      body: `${reason}. ${affected.length} download(s) paused; media on this volume is temporarily unavailable.`,
      remediation: "Reconnect or remount the drive. Downloads resume automatically once it is back.",
    });
    await logActivity(this.db, {
      type: "storage.volume_offline", severity: "error", message: `Volume "${vol.name}" went offline`,
      entityType: "volume", entityId: vol.id, data: { pausedDownloads: affected.length, reason },
    });
    return affected;
  }

  private async resumeDownloadsForVolume(vol: VolumeRow): Promise<string[]> {
    const affected = await this.db.transaction(async (tx) => {
      const rows = await tx.select({ id: s.downloads.id }).from(s.downloads)
        .where(and(eq(s.downloads.volumeId, vol.id), eq(s.downloads.state, "paused"), eq(s.downloads.waitingReason, "volume_offline")));
      if (rows.length) {
        await tx.update(s.downloads).set({ state: "queued", waitingReason: null, updatedAt: new Date() })
          .where(inArray(s.downloads.id, rows.map((r) => r.id)));
        await tx.insert(s.downloadEvents).values(rows.map((r) => ({
          downloadId: r.id, fromState: "paused" as const, toState: "queued" as const, reason: "volume_online",
        })));
      }
      return rows.map((r) => r.id);
    });
    await resolveNotification(this.db, `volume:offline:${vol.id}`);
    await logActivity(this.db, {
      type: "storage.volume_online", message: `Volume "${vol.name}" is back online`,
      entityType: "volume", entityId: vol.id, data: { resumedDownloads: affected.length },
    });
    return affected;
  }

  // ------------------------------------------------------------- candidates

  /** Available media on a volume, annotated with everything the planner needs. */
  async loadCandidates(volumeId: string, db: DbOrTx = this.db): Promise<LoadedCandidate[]> {
    const rows = await db.select().from(s.media)
      .where(and(eq(s.media.availability, "available"), eq(s.media.volumeId, volumeId)));
    return this.annotate(db, rows);
  }

  private async annotate(db: DbOrTx, rows: MediaRow[], overrides?: Map<string, RetentionPolicy>): Promise<LoadedCandidate[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const links = await db.select({ mediaId: s.mediaSources.mediaId, sourceId: s.sources.id, name: s.sources.name, retention: s.sources.retention })
      .from(s.mediaSources).innerJoin(s.sources, eq(s.sources.id, s.mediaSources.sourceId))
      .where(inArray(s.mediaSources.mediaId, ids));
    const retained = await this.retainedMediaIds(db, links.map((l) => ({ id: l.sourceId, retention: l.retention })), overrides);
    const history = await db.select().from(s.playbackHistory).where(inArray(s.playbackHistory.mediaId, ids));
    const histBy = new Map(history.map((h) => [h.mediaId, h]));
    const cutoff = new Date(Date.now() - this.streamWindowSec * 1000);
    const streaming = new Set((await db.selectDistinct({ id: s.streamSessions.mediaId }).from(s.streamSessions)
      .where(and(inArray(s.streamSessions.mediaId, ids), gt(s.streamSessions.lastSeenAt, cutoff)))).map((r) => r.id));
    const processing = new Set((await db.selectDistinct({ id: s.downloads.mediaId }).from(s.downloads)
      .where(and(inArray(s.downloads.mediaId, ids), inArray(s.downloads.state, ["processing", "verifying"])))).map((r) => r.id));

    return rows.map((m) => {
      const mine = links.filter((l) => l.mediaId === m.id);
      const h = histBy.get(m.id);
      return {
        mediaId: m.id,
        title: m.title,
        volumeId: m.volumeId,
        sizeBytes: m.sizeBytes ?? 0,
        priority: m.effectivePriority,
        retentionProtected: m.retainOverride || mine.some((l) => retained.get(l.sourceId)?.has(m.id)),
        pinned: m.pinned,
        favourite: m.favourite,
        lastWatchedAt: h?.lastWatchedAt ?? null,
        watchCount: h?.watchCount ?? 0,
        downloadedAt: m.downloadedAt,
        recommendationScore: m.recommendationScore,
        streaming: streaming.has(m.id),
        processing: processing.has(m.id),
        sourceIds: mine.map((l) => l.sourceId),
        sources: mine.map((l) => ({ id: l.sourceId, name: l.name })),
        retentionSnapshot: mine.map((l) => ({ sourceId: l.sourceId, retention: overrides?.get(l.sourceId) ?? l.retention })),
      };
    });
  }

  /** For each source, the set of media ids it retains (considering all its available media). */
  private async retainedMediaIds(
    db: DbOrTx, sourcesIn: Array<{ id: string; retention: RetentionPolicy }>, overrides?: Map<string, RetentionPolicy>,
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    const uniq = new Map(sourcesIn.map((x) => [x.id, x.retention]));
    if (uniq.size === 0) return out;
    const items = await db.select({
      sourceId: s.mediaSources.sourceId, mediaId: s.media.id, publishedAt: s.media.publishedAt, downloadedAt: s.media.downloadedAt,
      sizeBytes: s.media.sizeBytes, watchCount: s.playbackHistory.watchCount, completed: s.playbackHistory.completed,
    }).from(s.mediaSources)
      .innerJoin(s.media, eq(s.media.id, s.mediaSources.mediaId))
      .leftJoin(s.playbackHistory, eq(s.playbackHistory.mediaId, s.media.id))
      .where(and(inArray(s.mediaSources.sourceId, [...uniq.keys()]), eq(s.media.availability, "available")));
    const now = new Date();
    for (const [sourceId, retention] of uniq) {
      const mine: RetentionItem[] = items.filter((i) => i.sourceId === sourceId).map((i) => ({
        mediaId: i.mediaId, publishedAt: i.publishedAt, downloadedAt: i.downloadedAt, sizeBytes: i.sizeBytes ?? 0,
        watched: (i.watchCount ?? 0) > 0 || !!i.completed,
      }));
      out.set(sourceId, retainedBySource(overrides?.get(sourceId) ?? retention, mine, now));
    }
    return out;
  }

  // ---------------------------------------------------------------- capacity

  private async reservedBytes(db: DbOrTx, volumeId: string): Promise<number> {
    const [r] = await db.select({
      v: sql<number>`coalesce(sum(greatest(${s.storageReservations.bytes} - ${s.storageReservations.writtenBytes}, 0)), 0)::double precision`,
    }).from(s.storageReservations).where(and(eq(s.storageReservations.volumeId, volumeId), ACTIVE_RESERVATION));
    return Number(r?.v ?? 0);
  }

  private async evaluateVolume(db: DbOrTx, vol: VolumeRow, priority: Priority, required: number, autoEvict: boolean, excludeMediaId?: string) {
    const stat = await statVolume(vol.mountPath, this.config.statfsOverrideBytes);
    const reserved = await this.reservedBytes(db, vol.id);
    const available = availableBytes({
      totalBytes: stat.totalBytes, freeBytes: stat.freeBytes, reservedBytes: reserved, priority,
      softThresholdPct: this.config.softThresholdPct, minFreePct: this.config.minFreePct,
    });
    const candidates = (await this.loadCandidates(vol.id, db)).filter((c) => c.mediaId !== excludeMediaId);
    const plan = buildPlan({ incomingPriority: priority, autoEvict, requiredBytes: required, availableBytes: available, candidates });
    return { vol, stat, available, candidates, plan };
  }

  private async lockVolumes(tx: DbOrTx, ids: string[]): Promise<void> {
    for (const id of [...ids].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}::text))`);
  }

  private async candidateVolumes(db: DbOrTx, volumeId?: string): Promise<VolumeRow[]> {
    const rows = await db.select().from(s.storageVolumes)
      .where(volumeId ? eq(s.storageVolumes.id, volumeId) : and(eq(s.storageVolumes.acceptsNew, true)));
    return rows.filter((v) => v.isOnline && v.isWritable);
  }

  private static choose<T extends { plan: Plan; vol: VolumeRow }>(evals: T[]): T | null {
    const ok = evals.filter((e) => e.plan.sufficient);
    const noEvict = ok.filter((e) => !e.plan.needsEviction).sort((a, b) => b.plan.resultingAvailable - a.plan.resultingAvailable || (a.vol.id < b.vol.id ? -1 : 1));
    if (noEvict[0]) return noEvict[0];
    const evict = ok.sort((a, b) => a.plan.reclaimedBytes - b.plan.reclaimedBytes || (a.vol.id < b.vol.id ? -1 : 1));
    return evict[0] ?? null;
  }

  // --------------------------------------------------------------- admission

  async admitDownload(input: AdmitInput): Promise<AdmitResult> {
    const required = requiredBytes(input.estimatedBytes);
    let evictionPlanId: string | undefined;

    const outcome = await this.db.transaction(async (tx): Promise<AdmitResult | { status: "admitted"; volumeId: string; reservationId: string }> => {
      const vols = await this.candidateVolumes(tx, input.volumeId);
      await this.lockVolumes(tx, vols.map((v) => v.id));

      const [dl] = await tx.select().from(s.downloads).where(eq(s.downloads.id, input.downloadId));
      if (!dl) return { status: "rejected", reason: "download_not_found" };
      if (dl.cancelRequested) return { status: "rejected", reason: "cancelled" };
      if (dl.state === "ready") return { status: "rejected", reason: "already_ready" };
      const [media] = await tx.select({ availability: s.media.availability }).from(s.media).where(eq(s.media.id, input.mediaId));
      // A manual download of already-available media is an explicit re-download: let it replace the files.
      if (media?.availability === "available" && dl.requestedBy !== "manual") return { status: "rejected", reason: "already_ready" };

      const [existing] = await tx.select().from(s.storageReservations)
        .where(and(eq(s.storageReservations.downloadId, input.downloadId), ACTIVE_RESERVATION));
      if (existing) return { status: "admitted", volumeId: existing.volumeId, reservationId: existing.id };

      if (vols.length === 0) {
        return { status: "insufficient", requiredBytes: required, volumeId: null, availableBytes: 0, eligibleBytes: 0, shortfallBytes: required, volumes: [], reason: "no_volume" };
      }

      const evals = [];
      for (const v of vols) evals.push(await this.evaluateVolume(tx, v, input.priority, required, input.autoEvict, input.mediaId));
      const pick = StorageService.choose(evals);

      if (!pick) {
        const volumes = evals.map((e) => ({ volumeId: e.vol.id, availableBytes: e.available, eligibleBytes: e.plan.eligibleTotal, toReclaimBytes: e.plan.toReclaim }));
        const best = [...evals].sort((a, b) => (b.available + b.plan.eligibleTotal) - (a.available + a.plan.eligibleTotal))[0]!;
        await this.markWaitingForStorage(tx, dl.id, dl.state, best.vol);
        return {
          status: "insufficient", requiredBytes: required, volumeId: best.vol.id, availableBytes: best.available,
          eligibleBytes: best.plan.eligibleTotal, shortfallBytes: Math.max(0, required - best.available - best.plan.eligibleTotal), volumes,
        };
      }

      if (pick.plan.selected.length > 0) {
        const selected = pick.candidates.filter((c) => pick.plan.selected.some((p) => p.mediaId === c.mediaId));
        // keep planner order
        const ordered = pick.plan.selected.map((p) => selected.find((c) => c.mediaId === p.mediaId)!);
        evictionPlanId = randomUUID();
        await this.insertEvictionRecords(tx, evictionPlanId, ordered, "storage_pressure", input.downloadId);
      }
      const [res] = await tx.insert(s.storageReservations).values({ volumeId: pick.vol.id, downloadId: input.downloadId, bytes: required }).returning();
      await tx.update(s.downloads).set({ volumeId: pick.vol.id, updatedAt: new Date() }).where(eq(s.downloads.id, input.downloadId));
      return { status: "admitted", volumeId: pick.vol.id, reservationId: res!.id };
    });

    if (outcome.status !== "admitted") return outcome;
    await resolveNotification(this.db, `storage:full:${outcome.volumeId}`);
    let evictions: EvictionSummary[] = [];
    if (evictionPlanId) evictions = (await this.executeEvictions(evictionPlanId)).results;
    return { status: "admitted", volumeId: outcome.volumeId, reservationId: outcome.reservationId, evictionPlanId, evictions };
  }

  private async markWaitingForStorage(tx: DbOrTx, downloadId: string, from: string, vol: VolumeRow): Promise<void> {
    if (from !== "waiting_for_storage") {
      await tx.update(s.downloads).set({ state: "waiting_for_storage", waitingReason: "insufficient_storage", updatedAt: new Date() })
        .where(eq(s.downloads.id, downloadId));
      await tx.insert(s.downloadEvents).values({
        downloadId, fromState: from as "queued", toState: "waiting_for_storage", reason: "insufficient_storage",
      });
    }
    await raiseNotification(tx, {
      key: `storage:full:${vol.id}`, severity: "warning", title: `Storage volume "${vol.name}" is full`,
      body: "A download is waiting because no eligible media can be evicted to make room.",
      remediation: "Free up space, add a volume, raise source priorities for protected media, or enable automatic eviction.",
    });
  }

  private async insertEvictionRecords(
    tx: DbOrTx, planId: string, items: LoadedCandidate[], reason: EvictionReason, triggerDownloadId: string | null,
  ): Promise<string[]> {
    if (items.length === 0) return [];
    const rows = await tx.insert(s.evictionRecords).values(items.map((c) => ({
      planId, mediaId: c.mediaId, volumeId: c.volumeId, triggerDownloadId, previousPriority: c.priority,
      retentionSnapshot: c.retentionSnapshot, reclaimedBytes: c.sizeBytes, reason, status: "planned" as const,
    }))).returning({ id: s.evictionRecords.id });
    return rows.map((r) => r.id);
  }

  // ---------------------------------------------------------------- eviction

  async executeEvictions(planId: string): Promise<ExecuteResult> {
    const records = await this.db.select().from(s.evictionRecords)
      .where(and(eq(s.evictionRecords.planId, planId), eq(s.evictionRecords.status, "planned")));
    const results: EvictionSummary[] = [];
    for (const rec of records) {
      const [m] = await this.db.select().from(s.media).where(eq(s.media.id, rec.mediaId));
      const summary: EvictionSummary = { recordId: rec.id, mediaId: rec.mediaId, title: m?.title ?? "", sizeBytes: rec.reclaimedBytes, status: "planned" };
      results.push(summary);
      try {
        const [vol] = rec.volumeId ? await this.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, rec.volumeId)) : [];
        if (vol && !vol.isOnline) { summary.status = "skipped"; summary.error = "volume offline"; continue; }
        if (m && vol) {
          // Defence in depth: a library item always lives at <platform>/<...>/<id>. Anything shallower
          // (empty, ".", a single top-level folder) must never be recursively deleted.
          const segments = (m.mediaDir ?? "").split(/[\\/]+/).filter((x) => x && x !== ".");
          if (segments.length < 2) {
            const msg = `refusing to delete suspicious media directory "${m.mediaDir ?? ""}"`;
            await this.db.update(s.evictionRecords).set({ status: "failed", error: msg }).where(eq(s.evictionRecords.id, rec.id));
            await logActivity(this.db, { type: "storage.evict_failed", severity: "error", message: `Eviction failed: ${msg}`, entityType: "media", entityId: rec.mediaId, data: { planId } });
            summary.status = "failed";
            summary.error = msg;
            continue;
          }
          // resolveInside guarantees we never delete outside (or the root of) the volume mount.
          await fsp.rm(resolveInside(vol.mountPath, m.mediaDir!), { recursive: true, force: true });
        }
        const now = new Date();
        await this.db.transaction(async (tx) => {
          if (m) {
            if (rec.volumeId) await tx.delete(s.mediaFiles).where(and(eq(s.mediaFiles.mediaId, m.id), eq(s.mediaFiles.volumeId, rec.volumeId)));
            await tx.update(s.media).set({
              availability: "evicted", evictedAt: now, updatedAt: now,
              redownloadAfter: new Date(now.getTime() + this.config.cooldownDays * 86_400_000),
            }).where(eq(s.media.id, m.id));
          }
          await tx.update(s.evictionRecords).set({ status: "completed", completedAt: now, error: null }).where(eq(s.evictionRecords.id, rec.id));
        });
        await logActivity(this.db, {
          type: "storage.evicted", message: `Evicted "${m?.title ?? rec.mediaId}" (${rec.reason})`,
          entityType: "media", entityId: rec.mediaId,
          data: { planId, reason: rec.reason, reclaimedBytes: rec.reclaimedBytes, previousPriority: rec.previousPriority, triggerDownloadId: rec.triggerDownloadId },
        });
        summary.status = "completed";
      } catch (e) {
        const msg = (e as Error).message;
        await this.db.update(s.evictionRecords).set({ status: "failed", error: msg }).where(eq(s.evictionRecords.id, rec.id));
        await logActivity(this.db, { type: "storage.evict_failed", severity: "error", message: `Eviction failed: ${msg}`, entityType: "media", entityId: rec.mediaId, data: { planId } });
        summary.status = "failed";
        summary.error = msg;
      }
    }
    return {
      completed: results.filter((r) => r.status === "completed").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    };
  }

  /** Boot-time recovery: finish plans whose deletion was interrupted. Idempotent. */
  async recoverInterruptedEvictions(): Promise<{ plans: number; completed: number; failed: number }> {
    const plans = await this.db.selectDistinct({ planId: s.evictionRecords.planId }).from(s.evictionRecords)
      .where(eq(s.evictionRecords.status, "planned"));
    let completed = 0, failed = 0;
    for (const p of plans) {
      const r = await this.executeEvictions(p.planId);
      completed += r.completed;
      failed += r.failed;
    }
    return { plans: plans.length, completed, failed };
  }

  /** Explicit admin deletion of downloaded media. Allowed for any priority, including P0. */
  async manualEvict(mediaId: string, reason: EvictionReason = "manual"): Promise<EvictionSummary | null> {
    const planId = randomUUID();
    const created = await this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(s.media).where(and(eq(s.media.id, mediaId), eq(s.media.availability, "available")));
      if (!m) return false;
      const [c] = await this.annotate(tx, [m]);
      await this.insertEvictionRecords(tx, planId, [c!], reason, null);
      return true;
    });
    if (!created) return null;
    return (await this.executeEvictions(planId)).results[0] ?? null;
  }

  // ------------------------------------------------------------ reservations

  async updateReservationProgress(downloadId: string, writtenBytes: number): Promise<void> {
    await this.db.update(s.storageReservations).set({ writtenBytes })
      .where(and(eq(s.storageReservations.downloadId, downloadId), ACTIVE_RESERVATION));
  }

  /** `newBytes` is the new TOTAL to reserve (pass requiredBytes(newEstimate)). Never evicts. */
  async extendReservation(downloadId: string, newBytes: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [res] = await tx.select().from(s.storageReservations).where(and(eq(s.storageReservations.downloadId, downloadId), ACTIVE_RESERVATION));
      if (!res) return false;
      const [vol] = await tx.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, res.volumeId));
      const [dl] = await tx.select({ priority: s.downloads.priority }).from(s.downloads).where(eq(s.downloads.id, downloadId));
      if (!vol || !dl) return false;
      await this.lockVolumes(tx, [vol.id]);
      const extra = newBytes - res.bytes;
      if (extra <= 0) return true;
      const stat = await statVolume(vol.mountPath, this.config.statfsOverrideBytes);
      const available = availableBytes({
        totalBytes: stat.totalBytes, freeBytes: stat.freeBytes, reservedBytes: await this.reservedBytes(tx, vol.id),
        priority: dl.priority, softThresholdPct: this.config.softThresholdPct, minFreePct: this.config.minFreePct,
      });
      if (available < extra) return false;
      await tx.update(s.storageReservations).set({ bytes: newBytes }).where(eq(s.storageReservations.id, res.id));
      return true;
    });
  }

  async releaseReservation(downloadId: string, reason: string): Promise<void> {
    await this.db.update(s.storageReservations).set({ releasedAt: new Date(), releaseReason: reason })
      .where(and(eq(s.storageReservations.downloadId, downloadId), ACTIVE_RESERVATION));
  }

  /** Releases active reservations whose download is no longer checking/downloading/processing/verifying. */
  async releaseStaleReservations(): Promise<string[]> {
    const live = this.db.select({ id: s.downloads.id }).from(s.downloads)
      .where(inArray(s.downloads.state, ["checking", "downloading", "processing", "verifying"]));
    const rows = await this.db.update(s.storageReservations).set({ releasedAt: new Date(), releaseReason: "stale" })
      .where(and(ACTIVE_RESERVATION, notInArray(s.storageReservations.downloadId, live)))
      .returning({ downloadId: s.storageReservations.downloadId });
    return rows.map((r) => r.downloadId);
  }

  // -------------------------------------------------------------- simulation

  async simulate(input: SimulateInput): Promise<SimulationResult> {
    const required = requiredBytes(input.bytes);
    const vols = await this.candidateVolumes(this.db, input.volumeId);
    const evals = [];
    for (const v of vols) evals.push(await this.evaluateVolume(this.db, v, input.priority, required, input.autoEvict ?? true));
    const pick = StorageService.choose(evals)
      ?? [...evals].sort((a, b) => (b.available + b.plan.eligibleTotal) - (a.available + a.plan.eligibleTotal))[0];
    if (!pick) {
      return { volumeId: null, requiredBytes: required, availableBytes: 0, totalBytes: 0, candidates: [], reclaimedBytes: 0, resultingAvailable: 0, sufficient: false, affectedSources: [] };
    }
    const selected = pick.plan.selected.map((p) => pick.candidates.find((c) => c.mediaId === p.mediaId)!);
    const affected = new Map<string, string>();
    for (const c of selected) for (const src of c.sources) affected.set(src.id, src.name);
    return {
      volumeId: pick.vol.id, requiredBytes: required, availableBytes: pick.available, totalBytes: pick.stat.totalBytes,
      candidates: selected.map((c) => ({ mediaId: c.mediaId, title: c.title, sizeBytes: c.sizeBytes, priority: c.priority, sources: c.sources })),
      reclaimedBytes: pick.plan.reclaimedBytes, resultingAvailable: pick.plan.resultingAvailable, sufficient: pick.plan.sufficient,
      affectedSources: [...affected].map(([id, name]) => ({ id, name })),
    };
  }

  /** Which downloaded media of a source would stop being retention-protected under a new policy. */
  async simulatePolicyChange(input: { sourceId: string; retention: RetentionPolicy }): Promise<{
    losingProtection: Array<{ mediaId: string; title: string; sizeBytes: number; priority: Priority }>; totalBytes: number;
  }> {
    const rows = await this.db.select({ m: s.media }).from(s.mediaSources)
      .innerJoin(s.media, eq(s.media.id, s.mediaSources.mediaId))
      .where(and(eq(s.mediaSources.sourceId, input.sourceId), eq(s.media.availability, "available")));
    const media = rows.map((r) => r.m);
    const before = await this.annotate(this.db, media);
    const after = await this.annotate(this.db, media, new Map([[input.sourceId, input.retention]]));
    const afterBy = new Map(after.map((c) => [c.mediaId, c]));
    const losing = before.filter((b) => b.retentionProtected && !afterBy.get(b.mediaId)!.retentionProtected);
    return {
      losingProtection: losing.map((c) => ({ mediaId: c.mediaId, title: c.title, sizeBytes: c.sizeBytes, priority: c.priority })),
      totalBytes: losing.reduce((n, c) => n + c.sizeBytes, 0),
    };
  }

  // ------------------------------------------------------------- maintenance

  /** Reclaim P3 media down to the soft threshold on one volume. */
  async softThresholdCleanup(volumeId: string): Promise<CleanupResult> {
    let planId: string | null = null;
    await this.db.transaction(async (tx) => {
      await this.lockVolumes(tx, [volumeId]);
      const [vol] = await tx.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, volumeId));
      if (!vol || !vol.isOnline) return;
      const stat = await statVolume(vol.mountPath, this.config.statfsOverrideBytes);
      const candidates = await this.loadCandidates(volumeId, tx);
      const plan = buildSoftThresholdPlan({
        totalBytes: stat.totalBytes, freeBytes: stat.freeBytes, reservedBytes: await this.reservedBytes(tx, volumeId),
        softThresholdPct: this.config.softThresholdPct, candidates,
      });
      if (plan.selected.length === 0) return;
      planId = randomUUID();
      const ordered = plan.selected.map((p) => candidates.find((c) => c.mediaId === p.mediaId)!);
      await this.insertEvictionRecords(tx, planId, ordered, "soft_threshold", null);
    });
    if (!planId) return { planId: null, evicted: 0, reclaimedBytes: 0 };
    const r = await this.executeEvictions(planId);
    return { planId, evicted: r.completed, reclaimedBytes: r.results.filter((x) => x.status === "completed").reduce((n, x) => n + x.sizeBytes, 0) };
  }

  /** Evict items beyond the newest N for every source in `rolling` mode. */
  async rollingRetentionCleanup(): Promise<CleanupResult> {
    const rolling = await this.db.select().from(s.sources).where(sql`${s.sources.retention}->>'mode' = 'rolling'`);
    let evicted = 0, reclaimed = 0;
    let lastPlan: string | null = null;
    for (const src of rolling) {
      const rows = await this.db.select({ m: s.media }).from(s.mediaSources)
        .innerJoin(s.media, eq(s.media.id, s.mediaSources.mediaId))
        .where(and(eq(s.mediaSources.sourceId, src.id), eq(s.media.availability, "available")));
      const items: RetentionItem[] = [];
      for (const { m } of rows) {
        const [h] = await this.db.select().from(s.playbackHistory).where(eq(s.playbackHistory.mediaId, m.id));
        items.push({ mediaId: m.id, publishedAt: m.publishedAt, downloadedAt: m.downloadedAt, sizeBytes: m.sizeBytes ?? 0, watched: (h?.watchCount ?? 0) > 0 || !!h?.completed });
      }
      const excess = new Set(rollingExcess(src.retention, items));
      if (excess.size === 0) continue;
      const loaded = await this.annotate(this.db, rows.map((r) => r.m).filter((m) => excess.has(m.id)));
      // Other sources / overrides / pins / streams may still protect an excess item.
      const doomed = loaded.filter((c) => !c.retentionProtected && !c.pinned && !c.streaming && !c.processing);
      if (doomed.length === 0) continue;
      const planId = randomUUID();
      await this.insertEvictionRecords(this.db, planId, doomed, "retention_rolling", null);
      const r = await this.executeEvictions(planId);
      evicted += r.completed;
      reclaimed += r.results.filter((x) => x.status === "completed").reduce((n, x) => n + x.sizeBytes, 0);
      lastPlan = planId;
    }
    return { planId: lastPlan, evicted, reclaimedBytes: reclaimed };
  }

  async usageByPriority(volumeId?: string): Promise<Record<Priority, number>> {
    const rows = await this.db.select({
      p: s.media.effectivePriority, bytes: sql<number>`coalesce(sum(${s.media.sizeBytes}), 0)::double precision`,
    }).from(s.media)
      .where(and(eq(s.media.availability, "available"), volumeId ? eq(s.media.volumeId, volumeId) : undefined))
      .groupBy(s.media.effectivePriority);
    const out: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const r of rows) out[r.p] = Number(r.bytes);
    return out;
  }
}
