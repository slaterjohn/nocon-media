import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { logActivity } from "@nocon/database";
import { conflict, idParam, notFound, parse, parseBody, type Deps } from "../lib/core.js";
import { playableSql, toSummaries } from "../lib/serialize.js";

export async function collectionRoutes(app: FastifyInstance, d: Deps) {
  const dto = async (c: typeof s.collections.$inferSelect) => {
    const [cnt] = await d.db.select({ n: sql<number>`count(*)::int` }).from(s.collectionItems)
      .innerJoin(s.media, eq(s.media.id, s.collectionItems.mediaId)).where(and(eq(s.collectionItems.collectionId, c.id), playableSql));
    const [t] = await d.db.select({ id: s.media.id }).from(s.collectionItems)
      .innerJoin(s.media, eq(s.media.id, s.collectionItems.mediaId))
      .innerJoin(s.mediaFiles, and(eq(s.mediaFiles.mediaId, s.media.id), eq(s.mediaFiles.kind, "thumbnail")))
      .where(and(eq(s.collectionItems.collectionId, c.id), playableSql)).limit(1);
    return {
      id: c.id, name: c.name, kind: c.kind, description: c.description, showInXtream: c.showInXtream,
      count: cnt?.n ?? 0, thumbnailUrl: t ? `/api/media/${t.id}/thumbnail` : null, createdAt: c.createdAt.toISOString(),
    };
  };
  const load = async (id: string) => {
    const [c] = await d.db.select().from(s.collections).where(eq(s.collections.id, id));
    if (!c) throw notFound("Collection not found");
    return c;
  };
  const detail = async (c: typeof s.collections.$inferSelect) => {
    const rows = await d.db.select({ m: s.media }).from(s.collectionItems).innerJoin(s.media, eq(s.media.id, s.collectionItems.mediaId))
      .where(eq(s.collectionItems.collectionId, c.id)).orderBy(asc(s.collectionItems.position), asc(s.collectionItems.addedAt));
    const base = await dto(c);
    return { collection: base, ...base, items: await toSummaries(d, rows.map((r) => r.m)) };
  };

  const body = z.object({
    name: z.string().trim().min(1).max(200), kind: z.enum(["collection", "playlist"]).default("collection"),
    description: z.string().max(2000).nullish(), showInXtream: z.boolean().optional(),
  });

  app.get("/api/collections", async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(["collection", "playlist"]).optional() }), req.query);
    const rows = await d.db.select().from(s.collections).where(kind ? eq(s.collections.kind, kind) : undefined).orderBy(asc(s.collections.name));
    return { items: await Promise.all(rows.map(dto)) };
  });

  app.post("/api/collections", async (req) => {
    const b = parseBody(req, body);
    const [c] = await d.db.insert(s.collections).values({ name: b.name, kind: b.kind, description: b.description ?? null, showInXtream: b.showInXtream ?? true }).returning();
    await logActivity(d.db, { type: "collection.created", message: `${b.kind === "playlist" ? "Playlist" : "Collection"} "${b.name}" created`, entityType: "collection", entityId: c!.id });
    return { collection: await dto(c!), ...(await dto(c!)) };
  });

  app.get("/api/collections/:id", async (req) => detail(await load(parse(idParam, req.params).id)));

  app.patch("/api/collections/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parseBody(req, body.partial());
    await load(id);
    await d.db.update(s.collections).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.showInXtream !== undefined ? { showInXtream: b.showInXtream } : {}), updatedAt: new Date(),
    }).where(eq(s.collections.id, id));
    return detail(await load(id));
  });

  app.delete("/api/collections/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    await load(id);
    await d.db.delete(s.collections).where(eq(s.collections.id, id));
    return { ok: true };
  });

  app.post("/api/collections/:id/items", async (req) => {
    const { id } = parse(idParam, req.params);
    const { mediaId } = parseBody(req, z.object({ mediaId: z.string().uuid() }));
    await load(id);
    const [m] = await d.db.select({ id: s.media.id }).from(s.media).where(eq(s.media.id, mediaId));
    if (!m) throw notFound("Media not found");
    const [pos] = await d.db.select({ n: sql<number>`coalesce(max(${s.collectionItems.position}), -1) + 1` }).from(s.collectionItems).where(eq(s.collectionItems.collectionId, id));
    const r = await d.db.insert(s.collectionItems).values({ collectionId: id, mediaId, position: pos?.n ?? 0 }).onConflictDoNothing().returning();
    if (!r.length) throw conflict("Already in this collection");
    return detail(await load(id));
  });

  app.delete("/api/collections/:id/items/:mediaId", async (req) => {
    const { id, mediaId } = parse(z.object({ id: z.string().uuid(), mediaId: z.string().uuid() }), req.params);
    await load(id);
    await d.db.delete(s.collectionItems).where(and(eq(s.collectionItems.collectionId, id), eq(s.collectionItems.mediaId, mediaId)));
    return { ok: true };
  });
}
