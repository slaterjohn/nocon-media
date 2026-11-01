import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { clientIp } from "../lib/clientip.js";
import { z } from "zod";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { ensureDownload, logActivity, recomputeEffectivePriority } from "@nocon/database";
import { downloadOptionsSchema, prioritySchema, resolveInside } from "@nocon/shared";
import { HttpError, enqueue, getAppSettings, getStorage, idParam, notFound, parse, parseBody, parseQuery, type Deps } from "../lib/core.js";
import { summaryFor, toDetail, toSummaries } from "../lib/serialize.js";
import { mediaList, mediaOrder } from "../lib/query.js";
import { recordStream, resolveMediaFile, sendFile } from "../lib/serve.js";
import { enqueueDownload } from "../lib/downloads.js";
import { playableSql } from "../lib/serialize.js";

async function loadMedia(d: Deps, id: string) {
  const [m] = await d.db.select().from(s.media).where(eq(s.media.id, id));
  if (!m) throw notFound("Media not found");
  return m;
}

const unavailable = (reply: { code(n: number): { send(b: unknown): unknown } }) =>
  reply.code(404).send({ error: "unavailable", message: "This item is not available right now (its drive may be disconnected, or the file was removed)." });

export async function mediaRoutes(app: FastifyInstance, d: Deps) {
  app.get("/api/media/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const m = await loadMedia(d, id);
    const detail = await toDetail(d, m);
    const catArray = sql`ARRAY[${sql.join(m.categories.map((c) => sql`${c}`), sql`, `)}]::text[]`;
    const sameCats = m.categories.length ? sql`${s.media.categories} && ${catArray}` : sql`false`;
    const relatedClause = m.creatorId ? sql`(${s.media.creatorId} = ${m.creatorId} or ${sameCats})` : sameCats;
    // related: same creator first, then shared categories
    const related = await mediaList(d, {
      where: [playableSql, ne(s.media.id, id), relatedClause],
      limit: 12,
    });
    let next = null;
    const [link] = await d.db.select({ sourceId: s.mediaSources.sourceId, position: s.mediaSources.position }).from(s.mediaSources)
      .innerJoin(s.sources, eq(s.sources.id, s.mediaSources.sourceId))
      .where(and(eq(s.mediaSources.mediaId, id), eq(s.sources.type, "playlist"))).limit(1);
    if (link?.position != null) {
      const [n] = await d.db.select({ m: s.media }).from(s.mediaSources).innerJoin(s.media, eq(s.media.id, s.mediaSources.mediaId))
        .where(and(eq(s.mediaSources.sourceId, link.sourceId), gt(s.mediaSources.position, link.position), eq(s.media.availability, "available")))
        .orderBy(asc(s.mediaSources.position)).limit(1);
      if (n) next = (await toSummaries(d, [n.m]))[0]!;
    } else if (m.creatorId && m.publishedAt) {
      const [n] = await d.db.select().from(s.media)
        .where(and(eq(s.media.creatorId, m.creatorId), eq(s.media.availability, "available"), gt(s.media.publishedAt, m.publishedAt)))
        .orderBy(asc(s.media.publishedAt)).limit(1);
      if (n) next = (await toSummaries(d, [n]))[0]!;
    }
    return { media: detail, related: related.items, next };
  });

  app.patch("/api/media/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parseBody(req, z.object({
      favourite: z.boolean().optional(), pinned: z.boolean().optional(),
      manualPriority: prioritySchema.nullable().optional(), retainOverride: z.boolean().optional(),
    }));
    await loadMedia(d, id);
    const set: Partial<typeof s.media.$inferInsert> = { updatedAt: new Date() };
    if (body.favourite !== undefined) set.favourite = body.favourite;
    if (body.pinned !== undefined) set.pinned = body.pinned;
    if (body.manualPriority !== undefined) set.manualPriority = body.manualPriority;
    if (body.retainOverride !== undefined) set.retainOverride = body.retainOverride;
    await d.db.update(s.media).set(set).where(eq(s.media.id, id));
    await recomputeEffectivePriority(d.db, id);
    return { media: await toDetail(d, await loadMedia(d, id)) };
  });

  app.post("/api/media/:id/progress", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parseBody(req, z.object({
      positionSeconds: z.number().min(0), durationSeconds: z.number().min(0).nullish(), completed: z.boolean().optional(),
    }));
    const m = await loadMedia(d, id);
    const now = new Date();
    const duration = body.durationSeconds ?? m.durationSeconds ?? null;
    const completed = body.completed ?? (!!duration && body.positionSeconds >= duration * 0.95);
    await d.db.transaction(async (tx) => {
      const [h] = await tx.select().from(s.playbackHistory).where(eq(s.playbackHistory.mediaId, id)).for("update");
      const newSession = !h || now.getTime() - h.lastWatchedAt.getTime() > 30 * 60_000;
      const inc = newSession || (completed && !h?.completed) ? 1 : 0;
      if (!h) {
        await tx.insert(s.playbackHistory).values({
          mediaId: id, positionSeconds: body.positionSeconds, durationSeconds: duration, completed, watchCount: inc,
          firstWatchedAt: now, lastWatchedAt: now,
        });
      } else {
        await tx.update(s.playbackHistory).set({
          positionSeconds: body.positionSeconds, durationSeconds: duration, completed, watchCount: h.watchCount + inc, lastWatchedAt: now,
        }).where(eq(s.playbackHistory.mediaId, id));
      }
      const since = new Date(now.getTime() - 24 * 3600_000);
      const [ev] = await tx.select({ id: s.watchEvents.id }).from(s.watchEvents)
        .where(and(eq(s.watchEvents.mediaId, id), eq(s.watchEvents.origin, "local"), gt(s.watchEvents.watchedAt, since))).limit(1);
      if (!ev) {
        await tx.insert(s.watchEvents).values({ canonicalKey: m.canonicalKey, mediaId: id, watchedAt: now, origin: "local", title: m.title, progressSeconds: body.positionSeconds })
          .onConflictDoNothing();
      }
    });
    await recomputeEffectivePriority(d.db, id);
    return { ok: true };
  });

  app.post("/api/media/:id/download", async (req) => {
    const { id } = parse(idParam, req.params);
    await loadMedia(d, id);
    // Use the owning source's current download options (highest-priority linked, non-system source), else app defaults.
    const links = await d.db.select({ sourceId: s.sources.id, priority: s.sources.priority, downloadOptions: s.sources.downloadOptions })
      .from(s.mediaSources).innerJoin(s.sources, eq(s.sources.id, s.mediaSources.sourceId))
      .where(and(eq(s.mediaSources.mediaId, id), eq(s.sources.system, false)));
    const owner = links.sort((a, b) => a.priority.localeCompare(b.priority))[0];
    const options = owner?.downloadOptions ?? downloadOptionsSchema.parse({ resolution: (await getAppSettings(d)).defaultResolution });
    const r = await ensureDownload(d.db, { mediaId: id, sourceId: owner?.sourceId ?? null, priority: "P1", options, requestedBy: "manual" });
    if (!r.download) throw new HttpError(409, "conflict", "Nothing to download.");
    await enqueueDownload(d, req.log, r.download.id);
    const { downloadById } = await import("../lib/serialize.js");
    return { download: await downloadById(d, r.download.id) };
  });

  app.delete("/api/media/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const { purge } = parseQuery(req, z.object({ purge: z.enum(["true", "false"]).optional() }));
    const m = await loadMedia(d, id);
    const storage = await getStorage(d);
    const ev = await storage.manualEvict(id, "manual");
    let purged = false;
    if (purge === "true") {
      const cnt = async (t: string) => {
        const r = await d.pool.query(`select count(*)::int n from ${t} where media_id = $1`, [id]);
        return r.rows[0].n as number;
      };
      const refs = (await cnt("playback_history")) + (await cnt("eviction_records")) + (await cnt("watch_events"));
      if (refs === 0 && m.availability !== "available") {
        await d.db.delete(s.media).where(eq(s.media.id, id));
        purged = true;
      }
    }
    if (ev) await logActivity(d.db, { type: "media.evicted", message: `"${m.title}" removed manually`, entityType: "media", entityId: id });
    return { ok: true, purged };
  });

  // ---- file serving (hijacked responses; see lib/serve.ts)
  app.get("/api/media/:id/stream", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const m = await loadMedia(d, id);
    const f = await resolveMediaFile(d, id, ["video", "audio"]);
    if (!f) return unavailable(reply);
    if (req.method === "GET") await recordStream(d, { clientType: "web", clientId: req.auth!.userId, mediaId: m.id, ip: clientIp(req) });
    await sendFile(req, reply, f.abs, f.mime);
  });

  app.get("/api/media/:id/thumbnail", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = await resolveMediaFile(d, id, ["thumbnail"]);
    if (!f) return reply.code(404).send({ error: "not_found", message: "No thumbnail" });
    await sendFile(req, reply, f.abs, f.mime, "private, max-age=86400");
  });

  app.get("/api/media/:id/subtitles/:file", async (req, reply) => {
    const { id, file } = parse(z.object({ id: z.string().uuid(), file: z.string().regex(/^[0-9a-f-]{36}\.vtt$/i) }), req.params);
    const f = await resolveMediaFile(d, id, ["subtitle"], file.slice(0, 36));
    if (!f) return reply.code(404).send({ error: "not_found", message: "Subtitle not found" });
    await sendFile(req, reply, f.abs, "text/vtt; charset=utf-8", "private, max-age=3600");
  });

  app.get("/api/media/:id/hls/:file", async (req, reply) => {
    const { id, file } = parse(z.object({ id: z.string().uuid(), file: z.string().regex(/^[A-Za-z0-9_.-]+$/).refine((f) => !f.startsWith("."), "invalid") }), req.params);
    const m = await loadMedia(d, id);
    const [vol] = m.volumeId ? await d.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, m.volumeId)) : [];
    if (m.availability !== "available" || !vol?.isOnline || !m.mediaDir) return unavailable(reply);
    let abs: string;
    try { abs = resolveInside(vol.mountPath, `${m.mediaDir}/hls/${file}`); } catch { return reply.code(404).send({ error: "not_found", message: "Not found" }); }
    if (fs.existsSync(abs) && fs.existsSync(resolveInside(vol.mountPath, `${m.mediaDir}/hls/index.m3u8`))) return sendFile(req, reply, abs);
    if (file === "index.m3u8") {
      const st = await getAppSettings(d);
      if (d.config.ENABLE_HLS && st.enableHls) {
        await enqueue(d, req.log, "processing", "hls", { mediaId: id }, `hls-${id}`);
        return reply.code(202).send({ status: "preparing" });
      }
    }
    return reply.code(404).send({ error: "not_found", message: "Not found" });
  });

  for (const kind of ["avatar", "banner"] as const) {
    app.get(`/api/creators/:id/${kind}`, async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const [c] = await d.db.select().from(s.creators).where(eq(s.creators.id, id));
      const rel = kind === "avatar" ? c?.avatarPath : c?.bannerPath;
      if (!c || !rel || !c.artworkVolumeId) return reply.code(404).send({ error: "not_found", message: "No artwork" });
      const [vol] = await d.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, c.artworkVolumeId));
      if (!vol?.isOnline) return reply.code(404).send({ error: "unavailable", message: "Artwork drive is offline" });
      let abs: string;
      try { abs = resolveInside(vol.mountPath, rel); } catch { return reply.code(404).send({ error: "not_found", message: "No artwork" }); }
      if (!fs.existsSync(abs)) return reply.code(404).send({ error: "not_found", message: "No artwork" });
      await sendFile(req, reply, abs, undefined, "private, max-age=86400");
    });
  }

  void mediaOrder; void summaryFor;
}
