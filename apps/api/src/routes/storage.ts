import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import * as s from "@nocon/database";
import { ensureDownload, logActivity } from "@nocon/database";
import { prioritySchema, retentionSchema } from "@nocon/shared";
import { HttpError, enqueue, getAppSettings, getStorage, idParam, notFound, parse, parseBody, parseQuery, withTimeout, type Deps } from "../lib/core.js";
import { toVolumes } from "../lib/serialize.js";
import { registerVolume } from "../lib/volumes.js";
import { enqueueDownload } from "../lib/downloads.js";

export async function storageRoutes(app: FastifyInstance, d: Deps) {
  app.get("/api/storage", async () => {
    const storage = await getStorage(d);
    const st = await getAppSettings(d);
    const res = await d.db.select({ r: s.storageReservations, title: s.media.title }).from(s.storageReservations)
      .innerJoin(s.downloads, eq(s.downloads.id, s.storageReservations.downloadId))
      .innerJoin(s.media, eq(s.media.id, s.downloads.mediaId)).where(isNull(s.storageReservations.releasedAt));
    return {
      volumes: await toVolumes(d, true), byPriority: await storage.usageByPriority(),
      reservations: res.map((x) => ({ downloadId: x.r.downloadId, title: x.title, bytes: x.r.bytes, writtenBytes: x.r.writtenBytes })),
      thresholds: { soft: st.softThreshold, minFree: st.minFreePercent },
    };
  });

  app.post("/api/storage/volumes", async (req) => {
    const b = parseBody(req, z.object({ path: z.string().min(1).max(1024), name: z.string().trim().min(1).max(100) }));
    return { volume: await registerVolume(d, b.path, b.name) };
  });

  app.patch("/api/storage/volumes/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parseBody(req, z.object({ name: z.string().trim().min(1).max(100).optional(), isDefault: z.literal(true).optional(), acceptsNew: z.boolean().optional() }));
    const [v] = await d.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, id));
    if (!v) throw notFound("Volume not found");
    await d.db.transaction(async (tx) => {
      if (b.isDefault) await tx.update(s.storageVolumes).set({ isDefault: false }).where(ne(s.storageVolumes.id, id));
      await tx.update(s.storageVolumes).set({
        ...(b.name !== undefined ? { name: b.name } : {}), ...(b.acceptsNew !== undefined ? { acceptsNew: b.acceptsNew } : {}),
        ...(b.isDefault ? { isDefault: true } : {}),
      }).where(eq(s.storageVolumes.id, id));
    });
    return { volume: (await toVolumes(d)).find((x) => x.id === id) };
  });

  app.post("/api/storage/volumes/:id/verify", async (req) => {
    const { id } = parse(idParam, req.params);
    const [v] = await d.db.select({ id: s.storageVolumes.id }).from(s.storageVolumes).where(eq(s.storageVolumes.id, id));
    if (!v) throw notFound("Volume not found");
    const tr = await (await getStorage(d)).refreshVolume(id);
    for (const dlId of tr.resumedDownloadIds) await enqueueDownload(d, req.log, dlId);
    return { volume: (await toVolumes(d, true)).find((x) => x.id === id), transition: tr.transition };
  });

  app.post("/api/storage/simulate", async (req) => {
    const storage = await getStorage(d);
    const b = parseBody(req, z.union([
      z.object({ sourceId: z.string().uuid(), retention: retentionSchema }),
      z.object({ bytes: z.number().int().nonnegative(), priority: prioritySchema, volumeId: z.string().uuid().optional(), autoEvict: z.boolean().optional() }),
    ]));
    if ("sourceId" in b) return storage.simulatePolicyChange({ sourceId: b.sourceId, retention: b.retention });
    return storage.simulate(b);
  });

  app.get("/api/storage/evictions", async (req) => {
    const q = parseQuery(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }));
    const rows = await d.db.select({ e: s.evictionRecords, title: s.media.title }).from(s.evictionRecords)
      .innerJoin(s.media, eq(s.media.id, s.evictionRecords.mediaId)).orderBy(desc(s.evictionRecords.createdAt)).limit(q.limit).offset(q.offset);
    return {
      items: rows.map(({ e, title }) => ({
        id: e.id, planId: e.planId, media: { id: e.mediaId, title }, reason: e.reason, previousPriority: e.previousPriority,
        reclaimedBytes: e.reclaimedBytes, restorable: e.restorable, status: e.status, createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/storage/evictions/:id/restore", async (req) => {
    const { id } = parse(idParam, req.params);
    const [e] = await d.db.select().from(s.evictionRecords).where(eq(s.evictionRecords.id, id));
    if (!e) throw notFound("Eviction not found");
    if (!e.restorable) throw new HttpError(409, "conflict", "This item cannot be restored.");
    await d.db.update(s.media).set({ redownloadAfter: null, updatedAt: new Date() }).where(eq(s.media.id, e.mediaId));
    const r = await ensureDownload(d.db, { mediaId: e.mediaId, priority: e.previousPriority, requestedBy: "restore" });
    if (!r.download) throw new HttpError(409, "conflict", "Nothing to restore.");
    await logActivity(d.db, { type: "media.restore_requested", message: "Restore requested for an evicted item", entityType: "media", entityId: e.mediaId });
    await enqueueDownload(d, req.log, r.download.id);
    return { ok: true, downloadId: r.download.id };
  });

  app.post("/api/storage/reconcile", async (req, reply) => {
    const b = parseBody(req, z.object({ dryRun: z.boolean().default(true), volumeId: z.string().uuid().optional() }));
    const jobId = `reconcile-${randomUUID()}`;
    const ok = await enqueue(d, req.log, "maintenance", "reconcile", { dryRun: b.dryRun, ...(b.volumeId ? { volumeId: b.volumeId } : {}) }, jobId, { removeOnComplete: { age: 3600 } });
    if (!ok) throw new HttpError(503, "internal", "The job queue is not reachable. Is Redis running?");
    return reply.code(202).send({ jobId });
  });

  app.get("/api/storage/reconcile/:jobId", async (req) => {
    const { jobId } = parse(z.object({ jobId: z.string().regex(/^reconcile-[0-9a-f-]{36}$/) }), req.params);
    let job;
    try { job = await withTimeout(d.queues.maintenance.getJob(jobId), 2000); } catch { throw new HttpError(503, "internal", "The job queue is not reachable."); }
    if (!job) throw notFound("Job not found (finished jobs are kept for one hour).");
    return { state: await job.getState(), result: job.returnvalue ?? null };
  });

  void and;
}
