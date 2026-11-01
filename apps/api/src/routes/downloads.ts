import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, inArray, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { ensureDownload, ensureSystemSources, linkMediaToSource, logActivity, transitionDownload, upsertMedia } from "@nocon/database";
import { DOWNLOAD_STATES, RUNNING_DOWNLOAD_STATES, type DownloadState } from "@nocon/shared";
import { identifySource } from "@nocon/source-adapters";
import { badRequest, HttpError, idParam, notFound, parse, parseBody, parseQuery, type Deps } from "../lib/core.js";
import { downloadById, toDownloads } from "../lib/serialize.js";
import { cancelDownload, enqueueDownload, getDownload } from "../lib/downloads.js";

export async function downloadRoutes(app: FastifyInstance, d: Deps) {
  app.get("/api/downloads", async (req) => {
    const q = parseQuery(req, z.object({ state: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }));
    const states = q.state ? q.state.split(",").filter((x) => (DOWNLOAD_STATES as readonly string[]).includes(x)) : [];
    const where = states.length ? inArray(s.downloads.state, states as DownloadState[]) : undefined;
    const items = await toDownloads(d, where, q.limit);
    const counts = await d.db.select({ state: s.downloads.state, n: sql<number>`count(*)::int` }).from(s.downloads).groupBy(s.downloads.state);
    return { items, counts: Object.fromEntries(counts.map((c) => [c.state, c.n])) };
  });

  app.post("/api/downloads", async (req) => {
    const body = parseBody(req, z.object({ mediaId: z.string().uuid().optional(), url: z.string().max(2000).optional() }));
    let mediaId = body.mediaId;
    let sourceId: string | null = null;
    if (!mediaId) {
      if (!body.url) throw badRequest("Provide mediaId or url.");
      const id = identifySource(body.url);
      if (!id || id.type !== "video") throw badRequest("That is not a supported YouTube video URL.");
      const { manual } = await ensureSystemSources(d.db);
      const { media } = await upsertMedia(d.db, {
        canonicalKey: `${id.platform}:${id.externalId}`, platform: id.platform, externalId: id.externalId,
        url: id.canonicalUrl, title: `YouTube video ${id.externalId}`,
      });
      await linkMediaToSource(d.db, { mediaId: media.id, sourceId: manual.id, reason: "manual download" });
      mediaId = media.id; sourceId = manual.id;
    } else {
      const [m] = await d.db.select({ id: s.media.id }).from(s.media).where(eq(s.media.id, mediaId));
      if (!m) throw notFound("Media not found");
    }
    const r = await ensureDownload(d.db, { mediaId, sourceId, priority: "P1", requestedBy: "manual" });
    if (!r.download) throw new HttpError(409, "conflict", "This item cannot be downloaded right now.");
    await logActivity(d.db, { type: "download.requested", message: "Download requested", entityType: "download", entityId: r.download.id, data: { mediaId } });
    await enqueueDownload(d, req.log, r.download.id);
    return { download: await downloadById(d, r.download.id) };
  });

  app.get("/api/downloads/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const dl = await downloadById(d, id);
    if (!dl) throw notFound("Download not found");
    const attempts = await d.db.select().from(s.downloadAttempts).where(eq(s.downloadAttempts.downloadId, id)).orderBy(asc(s.downloadAttempts.startedAt));
    const events = await d.db.select().from(s.downloadEvents).where(eq(s.downloadEvents.downloadId, id)).orderBy(asc(s.downloadEvents.at), asc(s.downloadEvents.id));
    return {
      download: dl,
      attempts: attempts.map((a) => ({ id: a.id, startedAt: a.startedAt.toISOString(), finishedAt: a.finishedAt?.toISOString() ?? null, outcome: a.outcome, error: a.error, logTail: a.logTail })),
      events: events.map((e) => ({ fromState: e.fromState, toState: e.toState, reason: e.reason, at: e.at.toISOString() })),
    };
  });

  const requeue = (allowed: DownloadState[], reason: string) => async (req: { params: unknown; log: FastifyInstance["log"] }) => {
    const { id } = parse(idParam, req.params);
    const dl = await getDownload(d, id);
    if (!allowed.includes(dl.state)) throw new HttpError(409, "conflict", `A ${dl.state} download cannot be ${reason}.`);
    await transitionDownload(d.db, id, "queued", {
      error: null, errorClass: null, waitingReason: null, nextAttemptAt: null, cancelRequested: false,
      ...(reason === "retried" ? { attempts: 0 } : {}),
    }, reason);
    await enqueueDownload(d, req.log, id);
    return { download: await downloadById(d, id) };
  };
  app.post("/api/downloads/:id/retry", requeue(["failed", "unavailable", "evicted"], "retried"));
  app.post("/api/downloads/:id/resume", requeue(["paused"], "resumed"));

  app.post("/api/downloads/:id/cancel", async (req) => {
    const { id } = parse(idParam, req.params);
    await cancelDownload(d, id);
    return { download: await downloadById(d, id) };
  });

  app.post("/api/downloads/:id/pause", async (req) => {
    const { id } = parse(idParam, req.params);
    const dl = await getDownload(d, id);
    if (RUNNING_DOWNLOAD_STATES.includes(dl.state)) throw new HttpError(409, "conflict", "A running download cannot be paused. Cancel it instead.");
    if (!["queued", "discovered", "waiting_for_storage"].includes(dl.state)) throw new HttpError(409, "conflict", `A ${dl.state} download cannot be paused.`);
    await transitionDownload(d.db, id, "paused", { waitingReason: "paused_by_user" }, "paused");
    return { download: await downloadById(d, id) };
  });
}
