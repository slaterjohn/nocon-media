import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import * as s from "@nocon/database";
import { PRIORITIES } from "@nocon/shared";
import { idParam, notFound, parse, parseQuery, type Deps } from "../lib/core.js";
import { playableSql, toCreators, toSummaries } from "../lib/serialize.js";
import { escapeLike, inCollection, inSource, mediaList, mediaOrder, searchClause } from "../lib/query.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Source playlists and user playlists with counts, for home / playlists pages. */
export async function playlistSummaries(d: Deps) {
  const out: Array<{ id: string; name: string; kind: "source" | "user"; count: number; thumbnailUrl: string | null }> = [];
  const thumb = async (cond: SQL) => {
    const [r] = await d.db.select({ id: s.media.id }).from(s.media).innerJoin(s.mediaFiles, and(eq(s.mediaFiles.mediaId, s.media.id), eq(s.mediaFiles.kind, "thumbnail")))
      .where(and(cond, playableSql)).limit(1);
    return r ? `/api/media/${r.id}/thumbnail` : null;
  };
  const count = async (cond: SQL) => {
    const [r] = await d.db.select({ n: sql<number>`count(*)::int` }).from(s.media).where(and(cond, playableSql));
    return r?.n ?? 0;
  };
  const srcs = await d.db.select().from(s.sources).where(and(eq(s.sources.type, "playlist"), eq(s.sources.system, false))).orderBy(asc(s.sources.name));
  for (const src of srcs) out.push({ id: src.id, name: src.name, kind: "source", count: await count(inSource(src.id)), thumbnailUrl: await thumb(inSource(src.id)) });
  const cols = await d.db.select().from(s.collections).where(eq(s.collections.kind, "playlist")).orderBy(asc(s.collections.name));
  for (const c of cols) out.push({ id: c.id, name: c.name, kind: "user", count: await count(inCollection(c.id)), thumbnailUrl: await thumb(inCollection(c.id)) });
  return out;
}

export async function continueWatching(d: Deps, limit = 20) {
  const rows = await d.db.select({ m: s.media }).from(s.playbackHistory).innerJoin(s.media, eq(s.media.id, s.playbackHistory.mediaId))
    .where(and(eq(s.playbackHistory.completed, false), sql`${s.playbackHistory.positionSeconds} > 5`, playableSql))
    .orderBy(desc(s.playbackHistory.lastWatchedAt)).limit(limit);
  return toSummaries(d, rows.map((r) => r.m));
}

export async function libraryRoutes(app: FastifyInstance, d: Deps) {
  app.get("/api/library/home", async () => {
    const watched = sql`not exists (select 1 from playback_history ph where ph.media_id = "media"."id")`;
    const [cw, recent, subs, rec] = await Promise.all([
      continueWatching(d, 12),
      mediaList(d, { where: [playableSql], limit: 20 }),
      mediaList(d, {
        where: [playableSql, sql`exists (select 1 from media_sources ms join sources so on so.id = ms.source_id where ms.media_id = "media"."id" and so.system = false and so.type in ('channel','playlist','search'))`, watched],
        order: [...mediaOrder.published], limit: 20,
      }),
      mediaList(d, { where: [playableSql, sql`${s.media.recommendationScore} is not null`, watched], order: [sql`${s.media.recommendationScore} desc`], limit: 20 }),
    ]);
    const cr = await d.db.select({ c: s.creators }).from(s.creators)
      .innerJoin(s.media, eq(s.media.creatorId, s.creators.id)).where(playableSql)
      .groupBy(s.creators.id)
      .orderBy(sql`count(*) filter (where ${s.media.favourite}) desc`, sql`count(*) desc`).limit(10);
    return {
      continueWatching: cw, recentlyDownloaded: recent.items, newFromSubscriptions: subs.items, recommended: rec.items,
      favouriteChannels: await toCreators(d, cr.map((r) => r.c)), playlists: await playlistSummaries(d),
    };
  });

  app.get("/api/library/media", async (req) => {
    const q = parseQuery(req, listQuery.extend({
      q: z.string().trim().max(200).optional(), creatorId: z.string().uuid().optional(), sourceId: z.string().uuid().optional(),
      collectionId: z.string().uuid().optional(),
      availability: z.enum(["playable", "all", "unavailable"]).default("playable"),
      sort: z.enum(["recent", "published", "title", "duration"]).optional(),
      favourite: z.enum(["true", "false"]).optional(),
      priority: z.string().optional(),
    }));
    const where: SQL[] = [];
    if (q.availability === "playable") where.push(playableSql);
    else if (q.availability === "unavailable") where.push(sql`not ${playableSql} and ${s.media.availability} <> 'discovered'`);
    if (q.creatorId) where.push(eq(s.media.creatorId, q.creatorId));
    if (q.sourceId) where.push(inSource(q.sourceId));
    if (q.collectionId) where.push(inCollection(q.collectionId));
    if (q.favourite === "true") where.push(eq(s.media.favourite, true));
    if (q.priority) {
      const ps = q.priority.split(",").map((x) => x.trim()).filter((x) => (PRIORITIES as readonly string[]).includes(x));
      if (ps.length) where.push(inArray(s.media.effectivePriority, ps as never[]));
    }
    let order: SQL[] = [...mediaOrder[q.sort ?? "recent"]];
    if (q.q) {
      const sc = searchClause(q.q);
      where.push(sc.cond);
      if (!q.sort) order = [sql`${sc.rank} desc`, ...mediaOrder.recent];
    }
    return mediaList(d, { where, order, limit: q.limit, offset: q.offset, withTotal: true });
  });

  app.get("/api/library/search", async (req) => {
    const { q } = parseQuery(req, z.object({ q: z.string().trim().min(1).max(200) }));
    const sc = searchClause(q);
    const media = await mediaList(d, { where: [eq(s.media.availability, "available"), sc.cond], order: [sql`${sc.rank} desc`, ...mediaOrder.recent], limit: 30 });
    const like = `%${escapeLike(q)}%`;
    const creators = await d.db.select().from(s.creators).where(ilike(s.creators.name, like)).orderBy(asc(s.creators.name)).limit(10);
    const pl = (await playlistSummaries(d)).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
    const cols = await d.db.select().from(s.collections).where(and(eq(s.collections.kind, "collection"), ilike(s.collections.name, like))).limit(10);
    return {
      media: media.items, creators: await toCreators(d, creators), playlists: pl,
      collections: cols.map((c) => ({ id: c.id, name: c.name, kind: c.kind, description: c.description })),
    };
  });

  app.get("/api/library/creators", async () => {
    const rows = await d.db.select().from(s.creators).orderBy(asc(s.creators.name)).limit(500);
    const items = await toCreators(d, rows);
    return { items: items.filter((c) => c.mediaCount > 0) };
  });

  app.get("/api/library/creators/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const [c] = await d.db.select().from(s.creators).where(eq(s.creators.id, id));
    if (!c) throw notFound("Creator not found");
    const { items } = await mediaList(d, { where: [eq(s.media.creatorId, id), eq(s.media.availability, "available")], order: [...mediaOrder.published], limit: 200 });
    return { creator: (await toCreators(d, [c]))[0], media: items };
  });

  app.get("/api/library/playlists", async () => ({ items: await playlistSummaries(d) }));

  app.get("/api/library/playlists/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const [src] = await d.db.select().from(s.sources).where(eq(s.sources.id, id));
    if (src) {
      const rows = await d.db.select({ m: s.media }).from(s.mediaSources).innerJoin(s.media, eq(s.media.id, s.mediaSources.mediaId))
        .where(and(eq(s.mediaSources.sourceId, id), eq(s.media.availability, "available")))
        .orderBy(sql`${s.mediaSources.position} asc nulls last`, desc(s.media.publishedAt)).limit(500);
      return { playlist: { id, name: src.name, kind: "source" }, items: await toSummaries(d, rows.map((r) => r.m)) };
    }
    const [col] = await d.db.select().from(s.collections).where(eq(s.collections.id, id));
    if (!col) throw notFound("Playlist not found");
    const rows = await d.db.select({ m: s.media }).from(s.collectionItems).innerJoin(s.media, eq(s.media.id, s.collectionItems.mediaId))
      .where(eq(s.collectionItems.collectionId, id)).orderBy(asc(s.collectionItems.position), asc(s.collectionItems.addedAt));
    return { playlist: { id, name: col.name, kind: "user" }, items: await toSummaries(d, rows.map((r) => r.m)) };
  });

  app.get("/api/library/continue-watching", async () => ({ items: await continueWatching(d, 50) }));
  app.get("/api/library/recently-added", async () => ({ items: (await mediaList(d, { where: [playableSql], limit: 50 })).items }));
  app.get("/api/library/favourites", async () => ({
    items: (await mediaList(d, { where: [eq(s.media.favourite, true), eq(s.media.availability, "available")], limit: 200 })).items,
  }));

  app.get("/api/sources/:id/media", async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parseQuery(req, listQuery);
    return mediaList(d, { where: [inSource(id)], limit: q.limit, offset: q.offset, withTotal: true });
  });
}
