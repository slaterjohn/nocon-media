import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { ensureDownload, ensureSystemSources, linkMediaToSource, logActivity, recomputeEffectivePriority, upsertMedia } from "@nocon/database";
import { parseTakeout, TakeoutTooLargeError } from "@nocon/source-adapters";
import { badRequest, enqueue, HttpError, idParam, notFound, parse, parseQuery, type Deps } from "../lib/core.js";
import { toSummaries } from "../lib/serialize.js";
import { enqueueDownload } from "../lib/downloads.js";

const MAX_UPLOAD = 200 * 1024 * 1024;

export async function discoveryRoutes(app: FastifyInstance, d: Deps) {
  app.get("/api/discovery/recommendations", async (req) => {
    const q = parseQuery(req, z.object({
      status: z.enum(["pending", "approved", "rejected", "queued", "catalogued"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }));
    const rows = await d.db.select().from(s.recommendations)
      .where(q.status ? eq(s.recommendations.status, q.status) : undefined)
      .orderBy(desc(s.recommendations.score)).limit(q.limit).offset(q.offset);
    if (!rows.length) return { items: [] };
    const mediaRows = await d.db.select().from(s.media).where(inArray(s.media.id, rows.map((r) => r.mediaId)));
    const sums = new Map((await toSummaries(d, mediaRows)).map((m) => [m.id, m]));
    const seedIds = rows.map((r) => r.seedMediaId).filter((x): x is string => !!x);
    const seeds = seedIds.length ? await d.db.select({ id: s.media.id, title: s.media.title }).from(s.media).where(inArray(s.media.id, seedIds)) : [];
    const sm = new Map(seeds.map((x) => [x.id, x]));
    return {
      items: rows.map((r) => ({
        id: r.id, media: sums.get(r.mediaId), score: r.score, explanation: r.explanation, strategy: r.strategy, depth: r.depth,
        seed: r.seedMediaId ? sm.get(r.seedMediaId) ?? null : null, status: r.status, createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/discovery/recommendations/:id/approve", async (req) => {
    const { id } = parse(idParam, req.params);
    const [rec] = await d.db.select().from(s.recommendations).where(eq(s.recommendations.id, id));
    if (!rec) throw notFound("Recommendation not found");
    await d.db.update(s.media).set({ approved: true, updatedAt: new Date() }).where(eq(s.media.id, rec.mediaId));
    await recomputeEffectivePriority(d.db, rec.mediaId);
    const r = await ensureDownload(d.db, { mediaId: rec.mediaId, priority: "P2", requestedBy: "manual" });
    await d.db.update(s.recommendations).set({ status: r.download ? "queued" : "approved", updatedAt: new Date() }).where(eq(s.recommendations.id, id));
    if (r.download) await enqueueDownload(d, req.log, r.download.id);
    await logActivity(d.db, { type: "media.approved", message: "Recommendation approved", entityType: "media", entityId: rec.mediaId });
    return { ok: true, status: r.download ? "queued" : "approved", downloadId: r.download?.id ?? null };
  });

  app.post("/api/discovery/recommendations/:id/reject", async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await d.db.update(s.recommendations).set({ status: "rejected", updatedAt: new Date() }).where(eq(s.recommendations.id, id)).returning({ id: s.recommendations.id });
    if (!res.length) throw notFound("Recommendation not found");
    return { ok: true, status: "rejected" };
  });

  app.post("/api/discovery/run", async (req) => {
    const queued = await enqueue(d, req.log, "discovery", "discovery", { trigger: "manual" }, "discovery-run");
    return { ok: true, queued };
  });

  app.get("/api/history", async (req) => {
    const q = parseQuery(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }));
    const rows = await d.db.select({ h: s.playbackHistory, m: s.media }).from(s.playbackHistory)
      .innerJoin(s.media, eq(s.media.id, s.playbackHistory.mediaId)).orderBy(desc(s.playbackHistory.lastWatchedAt)).limit(q.limit).offset(q.offset);
    const sums = new Map((await toSummaries(d, rows.map((r) => r.m))).map((m) => [m.id, m]));
    return {
      items: rows.map((r) => ({
        media: sums.get(r.m.id), positionSeconds: r.h.positionSeconds, watchCount: r.h.watchCount,
        lastWatchedAt: r.h.lastWatchedAt.toISOString(), completed: r.h.completed,
      })),
    };
  });

  // Upload route lives in its own scope so the 200 MiB multipart limit applies to it only.
  await app.register(async (up) => {
    await up.register(multipart, { limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5 } });
    up.post("/api/history/import", { bodyLimit: MAX_UPLOAD + 1024 * 1024 }, async (req) => {
      if (!req.isMultipart()) throw badRequest("Send the Takeout file as multipart/form-data (field \"file\").");
      let file: Buffer | null = null, filename = "";
      let queueDownloads = false;
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file") { await part.toBuffer().catch(() => undefined); continue; }
          filename = part.filename || "watch-history.json";
          file = await part.toBuffer();
          if (part.file.truncated) throw new HttpError(413, "bad_request", "File is larger than 200 MiB.");
        } else if (part.fieldname === "queueDownloads") {
          queueDownloads = String(part.value).toLowerCase() === "true";
        }
      }
      if (!file) throw badRequest("Missing file field.");
      let parsed;
      try { parsed = parseTakeout(file, filename); } catch (e) {
        throw badRequest(e instanceof TakeoutTooLargeError ? "This archive is too large to import" : (e as Error).message);
      }

      let imported = 0;
      for (let i = 0; i < parsed.entries.length; i += 500) {
        const chunk = parsed.entries.slice(i, i + 500);
        const ins = await d.db.insert(s.watchEvents).values(chunk.map((e) => ({
          canonicalKey: e.canonicalKey, watchedAt: e.watchedAt, origin: "takeout", title: e.title ?? null,
        }))).onConflictDoNothing().returning({ id: s.watchEvents.id });
        imported += ins.length;
      }
      const duplicates = parsed.entries.length - imported;

      const keys = [...new Set(parsed.entries.map((e) => e.canonicalKey))];
      const existing = new Map<string, string>();
      for (let i = 0; i < keys.length; i += 1000) {
        const rows = await d.db.select({ id: s.media.id, key: s.media.canonicalKey }).from(s.media).where(inArray(s.media.canonicalKey, keys.slice(i, i + 1000)));
        for (const r of rows) existing.set(r.key, r.id);
      }
      const matchedMedia = existing.size;
      const { history } = await ensureSystemSources(d.db);
      let createdMedia = 0;
      const byKey = new Map(parsed.entries.map((e) => [e.canonicalKey, e]));
      for (const key of keys) {
        if (existing.has(key)) continue;
        const e = byKey.get(key)!;
        const { media } = await upsertMedia(d.db, {
          canonicalKey: key, platform: "youtube", externalId: e.videoId, url: `https://www.youtube.com/watch?v=${e.videoId}`,
          title: e.title || `YouTube video ${e.videoId}`, channelName: e.channelName,
        });
        await linkMediaToSource(d.db, { mediaId: media.id, sourceId: history.id, reason: "watch history" });
        existing.set(key, media.id);
        createdMedia++;
      }
      // Link events to media, then recompute priorities (watched => at least P2).
      for (const [key, mediaId] of existing) {
        await d.db.update(s.watchEvents).set({ mediaId }).where(and(eq(s.watchEvents.canonicalKey, key), sql`${s.watchEvents.mediaId} is null`));
        await recomputeEffectivePriority(d.db, mediaId);
      }
      let queued = 0;
      if (queueDownloads) {
        const rows = await d.db.select({ id: s.media.id, availability: s.media.availability }).from(s.media).where(inArray(s.media.id, [...existing.values()]));
        for (const m of rows) {
          if (!["discovered", "evicted", "failed"].includes(m.availability)) continue;
          const r = await ensureDownload(d.db, { mediaId: m.id, sourceId: history.id, priority: "P2", requestedBy: "history" });
          if (r.download && r.created) { queued++; await enqueueDownload(d, req.log, r.download.id); }
        }
      }
      await logActivity(d.db, { type: "history.imported", message: `Watch history imported (${imported} new events)`, data: { imported, duplicates, skipped: parsed.skipped, matchedMedia, createdMedia, queued } });
      return { imported, duplicates, skipped: parsed.skipped, matchedMedia, createdMedia, queued };
    });
  });
}
