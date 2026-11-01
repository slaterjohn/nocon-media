import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import * as s from "@nocon/database";
import { logActivity, recomputeEffectivePriority, ensureSystemSources, getSetting } from "@nocon/database";
import {
  prioritySchema, retentionSchema, scheduleSchema, filtersSchema, downloadOptionsSchema, discoveryOptionsSchema,
  isValidCron, nextRunAt as computeNextRun, defaultSourceStoragePolicy, SOURCE_STATUSES, PRIORITY_LABELS, type Priority,
} from "@nocon/shared";
import { identifySource } from "@nocon/source-adapters";
import { HttpError, badRequest, conflict, enqueue, getAppSettings, getStorage, idParam, notFound, parse, parseBody, parseQuery, type Deps } from "../lib/core.js";
import { MAX_COOKIES_BYTES, removeCookiesFile, validateCookiesText, writeCookiesFile } from "../lib/cookies.js";
import { toSources } from "../lib/serialize.js";
import { cancelDownload } from "../lib/downloads.js";

const schedule = scheduleSchema.refine((x) => x.kind !== "cron" || isValidCron(x.cron!), { message: "Invalid cron expression", path: ["cron"] });

const editable = {
  name: z.string().trim().min(1).max(200),
  priority: prioritySchema,
  retention: retentionSchema,
  automaticEviction: z.boolean(),
  schedule,
  filters: filtersSchema,
  downloadOptions: downloadOptionsSchema,
  discovery: discoveryOptionsSchema,
  autoDownload: z.boolean(),
  volumeId: z.string().uuid().nullable(),
};

const createSchema = z.object({
  input: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
  type: z.enum(["channel", "playlist", "video", "search"]).optional(),
  query: z.string().trim().min(1).max(300).optional(),
  name: editable.name.optional(),
  priority: editable.priority.optional(),
  retention: editable.retention.optional(),
  automaticEviction: editable.automaticEviction.optional(),
  schedule: editable.schedule.optional(),
  filters: editable.filters.optional(),
  downloadOptions: editable.downloadOptions.optional(),
  discovery: editable.discovery.optional(),
  autoDownload: editable.autoDownload.optional(),
  volumeId: editable.volumeId.optional(),
});

const patchSchema = z.object({
  ...Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof editable]: z.ZodOptional<(typeof editable)[K]> },
  status: z.enum(["active", "paused"]).optional(),
});

async function recomputeSource(d: Deps, sourceId: string) {
  const rows = await d.db.select({ id: s.mediaSources.mediaId }).from(s.mediaSources).where(eq(s.mediaSources.sourceId, sourceId));
  for (const r of rows) await recomputeEffectivePriority(d.db, r.id);
  return rows.length;
}

async function loadSource(d: Deps, id: string) {
  const [src] = await d.db.select().from(s.sources).where(eq(s.sources.id, id));
  if (!src) throw notFound("Source not found");
  return src;
}

export async function sourceRoutes(app: FastifyInstance, d: Deps) {
  const one = async (id: string) => (await toSources(d, [await loadSource(d, id)]))[0]!;

  app.get("/api/sources", async (req) => {
    const q = parseQuery(req, z.object({ status: z.enum(SOURCE_STATUSES).optional(), type: z.string().optional(), q: z.string().optional() }));
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(s.sources.status, q.status));
    if (q.type) conds.push(inArray(s.sources.type, q.type.split(",") as never[]));
    if (q.q) conds.push(ilike(s.sources.name, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`));
    const rows = await d.db.select().from(s.sources).where(conds.length ? and(...conds) : undefined).orderBy(s.sources.name);
    return { items: await toSources(d, rows) };
  });

  app.post("/api/sources/identify", async (req) => {
    const { input } = parseBody(req, z.object({ input: z.string().min(1).max(2000) }));
    const id = identifySource(input);
    if (!id) throw badRequest("That is not a supported YouTube channel, playlist or video URL.");
    return { ok: true, platform: id.platform, type: id.type, externalId: id.externalId, canonicalUrl: id.canonicalUrl };
  });

  async function createFrom(body: z.infer<typeof createSchema>, log: FastifyInstance["log"]) {
    let name: string, type: "channel" | "playlist" | "video" | "search", platform = "youtube";
    let url: string | null = null, externalId: string | null = null, query: string | null = null;
    if (body.type === "search") {
      if (!body.query) throw badRequest("A search source needs a query.");
      type = "search"; query = body.query; name = body.name ?? `Search: ${body.query}`;
    } else {
      const raw = body.input ?? body.url;
      if (!raw) throw badRequest("Provide a YouTube URL (input) or a search query.");
      const id = identifySource(raw);
      if (!id) throw badRequest("That is not a supported YouTube channel, playlist or video URL.");
      type = id.type; platform = id.platform; url = id.canonicalUrl; externalId = id.externalId;
      name = body.name ?? id.handle ?? id.externalId;
    }
    const dupWhere = type === "search"
      ? and(eq(s.sources.type, "search"), eq(s.sources.query, query!))
      : and(eq(s.sources.platform, platform), eq(s.sources.type, type), eq(s.sources.externalId, externalId!));
    const [dup] = await d.db.select({ id: s.sources.id }).from(s.sources).where(and(dupWhere, eq(s.sources.system, false)));
    if (dup) throw conflict("This source has already been added.");

    const app_ = await getAppSettings(d);
    const envRet = retentionSchema.safeParse({ mode: d.config.DEFAULT_SOURCE_RETENTION });
    const retention = body.retention ?? (envRet.success ? envRet.data : defaultSourceStoragePolicy.retention);
    const dlOpts = body.downloadOptions ?? downloadOptionsSchema.parse({ resolution: app_.defaultResolution });
    const sched = body.schedule ?? scheduleSchema.parse({});
    const [row] = await d.db.insert(s.sources).values({
      name, platform, type, url, externalId, query,
      priority: body.priority ?? d.config.DEFAULT_SOURCE_PRIORITY ?? defaultSourceStoragePolicy.priority,
      retention, automaticEviction: body.automaticEviction ?? d.config.DEFAULT_SOURCE_AUTO_EVICTION,
      schedule: sched, filters: body.filters ?? filtersSchema.parse({}), downloadOptions: dlOpts,
      discovery: body.discovery ?? discoveryOptionsSchema.parse({}), autoDownload: body.autoDownload ?? true,
      volumeId: body.volumeId ?? null, nextRunAt: new Date(),
    }).returning();
    await logActivity(d.db, { type: "source.created", message: `Source "${name}" added`, entityType: "source", entityId: row!.id });
    if (sched.kind !== "manual") await enqueue(d, log, "sync", "sync", { sourceId: row!.id, trigger: "create" }, `sync-${row!.id}`);
    return row!;
  }

  app.post("/api/sources", async (req) => {
    const body = parseBody(req, createSchema);
    const row = await createFrom(body, req.log);
    return { source: await one(row.id) };
  });

  app.get("/api/sources/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const runs = await d.db.select().from(s.sourceRuns).where(eq(s.sourceRuns.sourceId, id)).orderBy(desc(s.sourceRuns.startedAt)).limit(10);
    return {
      source: await one(id),
      recentRuns: runs.map((r) => ({
        id: r.id, trigger: r.trigger, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
        discoveredCount: r.discoveredCount, newCount: r.newCount, queuedCount: r.queuedCount, error: r.error,
      })),
    };
  });

  app.patch("/api/sources/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parseBody(req, patchSchema);
    const cur = await loadSource(d, id);
    const set: Partial<typeof s.sources.$inferInsert> = { updatedAt: new Date() };
    for (const k of ["name", "automaticEviction", "autoDownload", "volumeId", "filters", "downloadOptions", "discovery", "status"] as const) {
      if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
    }
    if (body.priority) set.priority = body.priority;
    if (body.retention) set.retention = body.retention;
    if (body.schedule) {
      set.schedule = body.schedule;
      set.nextRunAt = body.schedule.kind === "manual" ? null : computeNextRun(body.schedule, new Date(), cur.hasRun);
    }
    if (body.status === "active") { set.needsAttention = false; }
    await d.db.update(s.sources).set(set).where(eq(s.sources.id, id));
    if (body.priority && body.priority !== cur.priority) {
      const n = await recomputeSource(d, id);
      await logActivity(d.db, { type: "source.priority_changed", message: `Priority of "${cur.name}" changed from ${PRIORITY_LABELS[cur.priority as Priority]} to ${PRIORITY_LABELS[body.priority]}`, entityType: "source", entityId: id, data: { from: cur.priority, to: body.priority, mediaRecomputed: n } });
    }
    if (body.retention && JSON.stringify(body.retention) !== JSON.stringify(cur.retention)) {
      await logActivity(d.db, { type: "source.retention_changed", message: `Retention of "${cur.name}" changed`, entityType: "source", entityId: id, data: { from: cur.retention, to: body.retention } });
    }
    return { source: await one(id) };
  });

  const setStatus = (status: "active" | "paused") => async (req: { params: unknown }) => {
    const { id } = parse(idParam, req.params);
    const cur = await loadSource(d, id);
    await d.db.update(s.sources).set({
      status, updatedAt: new Date(),
      ...(status === "active" ? { needsAttention: false, consecutiveFailures: 0, lastError: null } : {}),
    }).where(eq(s.sources.id, id));
    await logActivity(d.db, { type: status === "paused" ? "source.paused" : "source.resumed", message: `Source "${cur.name}" ${status === "paused" ? "paused" : "resumed"}`, entityType: "source", entityId: id });
    return { source: await one(id) };
  };
  app.post("/api/sources/:id/pause", setStatus("paused"));
  app.post("/api/sources/:id/resume", setStatus("active"));

  app.post("/api/sources/:id/sync", async (req) => {
    const { id } = parse(idParam, req.params);
    const cur = await loadSource(d, id);
    if (cur.system) throw badRequest("System sources cannot be synced.");
    await d.db.update(s.sources).set({ nextRunAt: new Date() }).where(eq(s.sources.id, id));
    await enqueue(d, req.log, "sync", "sync", { sourceId: id, trigger: "manual" }, `sync-${id}`);
    return { ok: true };
  });

  app.post("/api/sources/:id/duplicate", async (req) => {
    const { id } = parse(idParam, req.params);
    const cur = await loadSource(d, id);
    if (cur.system) throw badRequest("System sources cannot be duplicated.");
    const [row] = await d.db.insert(s.sources).values({
      name: `${cur.name} (copy)`, platform: cur.platform, type: cur.type, url: cur.url, externalId: cur.externalId, query: cur.query,
      priority: cur.priority, retention: cur.retention, automaticEviction: cur.automaticEviction, schedule: cur.schedule,
      filters: cur.filters, downloadOptions: cur.downloadOptions, discovery: cur.discovery, autoDownload: cur.autoDownload,
      volumeId: cur.volumeId, creatorId: cur.creatorId, nextRunAt: new Date(),
    }).returning();
    await logActivity(d.db, { type: "source.created", message: `Source "${row!.name}" duplicated`, entityType: "source", entityId: row!.id });
    if (cur.schedule.kind !== "manual") await enqueue(d, req.log, "sync", "sync", { sourceId: row!.id, trigger: "create" }, `sync-${row!.id}`);
    return { source: await one(row!.id) };
  });

  app.delete("/api/sources/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const { media: mode } = parseQuery(req, z.object({ media: z.enum(["keep", "delete"], { error: "Query parameter media=keep|delete is required" }) }));
    const src = await loadSource(d, id);
    if (src.system) throw badRequest("System sources cannot be deleted.");
    const linked = await d.db.select({ id: s.mediaSources.mediaId }).from(s.mediaSources).where(eq(s.mediaSources.sourceId, id));
    const ids = linked.map((l) => l.id);
    let retained = 0, deleted = 0;
    if (mode === "keep") {
      for (const mid of ids) {
        const [m] = await d.db.select().from(s.media).where(eq(s.media.id, mid));
        if (!m) continue;
        const best = [m.manualPriority, src.priority].filter(Boolean).sort()[0] as Priority;
        await d.db.update(s.media).set({ manualPriority: best, retainOverride: true, updatedAt: new Date() }).where(eq(s.media.id, mid));
        retained++;
      }
    } else if (ids.length) {
      const others = await d.db.select({ id: s.mediaSources.mediaId }).from(s.mediaSources)
        .where(and(inArray(s.mediaSources.mediaId, ids), sql`${s.mediaSources.sourceId} <> ${id}`));
      const shared = new Set(others.map((o) => o.id));
      const storage = await getStorage(d);
      for (const mid of ids) {
        if (shared.has(mid)) { retained++; continue; }
        const active = await d.db.select({ id: s.downloads.id }).from(s.downloads)
          .where(and(eq(s.downloads.mediaId, mid), sql`${s.downloads.state} not in ('ready','failed','evicted','unavailable')`));
        for (const a of active) await cancelDownload(d, a.id).catch(() => undefined);
        const r = await storage.manualEvict(mid, "source_deleted");
        if (r) deleted++;
      }
    }
    await d.db.delete(s.sources).where(eq(s.sources.id, id));
    await removeCookiesFile(d, id).catch((e) => req.log.warn({ err: (e as Error).message, sourceId: id }, "could not remove the cookies file"));
    for (const mid of ids) await recomputeEffectivePriority(d.db, mid);
    await logActivity(d.db, { type: "source.deleted", message: `Source "${src.name}" deleted (media ${mode === "keep" ? "kept" : "removed"})`, entityType: "source", entityId: id, data: { media: mode, retainedMedia: retained, deletedMedia: deleted } });
    return { ok: true, retainedMedia: retained, deletedMedia: deleted };
  });

  // Per-source cookies (Netscape cookies.txt). The file lives under DATA_ROOT/secrets; its path and contents are never returned.
  await app.register(async (up) => {
    await up.register(multipart, { limits: { fileSize: MAX_COOKIES_BYTES, files: 1, fields: 2 } });
    up.put("/api/sources/:id/cookies", { bodyLimit: MAX_COOKIES_BYTES + 64 * 1024 }, async (req) => {
      const { id } = parse(idParam, req.params);
      const src = await loadSource(d, id);
      if (src.system) throw badRequest("System sources cannot have cookies.");
      if (!req.isMultipart()) throw badRequest("Send the cookies file as multipart/form-data (field \"file\").");
      let file: Buffer | null = null;
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        if (part.fieldname !== "file") { await part.toBuffer().catch(() => undefined); continue; }
        file = await part.toBuffer().catch(() => null);
        if (part.file.truncated) throw new HttpError(413, "bad_request", "The cookies file is larger than 1 MiB.");
      }
      if (!file) throw badRequest("Missing file field.");
      const text = validateCookiesText(file);
      const path = await writeCookiesFile(d, id, text);
      await d.db.update(s.sources).set({ metadata: { ...src.metadata, cookiesFile: path }, updatedAt: new Date() }).where(eq(s.sources.id, id));
      await logActivity(d.db, { type: "source.cookies_updated", message: `Cookies updated for "${src.name}"`, entityType: "source", entityId: id });
      return { source: await one(id) };
    });
  });

  app.delete("/api/sources/:id/cookies", async (req) => {
    const { id } = parse(idParam, req.params);
    const src = await loadSource(d, id);
    const { cookiesFile: _gone, ...rest } = src.metadata;
    void _gone;
    await removeCookiesFile(d, id);
    await d.db.update(s.sources).set({ metadata: rest, updatedAt: new Date() }).where(eq(s.sources.id, id));
    await logActivity(d.db, { type: "source.cookies_removed", message: `Cookies removed from "${src.name}"`, entityType: "source", entityId: id });
    return { source: await one(id) };
  });

  void ensureSystemSources; void getSetting;
}
