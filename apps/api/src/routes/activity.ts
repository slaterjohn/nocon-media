import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import * as s from "@nocon/database";
import { escapeLike } from "../lib/query.js";
import { idParam, iso, notFound, parse, parseQuery, type Deps } from "../lib/core.js";

export const activityDto = (e: typeof s.activityEvents.$inferSelect) => ({
  id: String(e.id), at: iso(e.at), type: e.type, severity: e.severity, message: e.message,
  entityType: e.entityType, entityId: e.entityId, data: e.data,
});

export async function activityRoutes(app: FastifyInstance, d: Deps) {
  app.get("/api/activity", async (req) => {
    const q = parseQuery(req, z.object({
      type: z.string().optional(), severity: z.string().optional(), q: z.string().max(200).optional(),
      entityType: z.string().optional(), entityId: z.string().optional(), before: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }));
    const where: SQL[] = [];
    if (q.type) where.push(inArray(s.activityEvents.type, q.type.split(",")));
    if (q.severity) where.push(inArray(s.activityEvents.severity, q.severity.split(",") as never[]));
    if (q.q) where.push(ilike(s.activityEvents.message, `%${escapeLike(q.q)}%`));
    if (q.entityType) where.push(eq(s.activityEvents.entityType, q.entityType));
    if (q.entityId) where.push(eq(s.activityEvents.entityId, q.entityId));
    if (q.before) where.push(lt(s.activityEvents.id, q.before));
    const rows = await d.db.select().from(s.activityEvents).where(where.length ? and(...where) : undefined)
      .orderBy(desc(s.activityEvents.id)).limit(q.limit);
    return { items: rows.map(activityDto), nextCursor: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null };
  });

  app.get("/api/notifications", async (req) => {
    const q = parseQuery(req, z.object({ open: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }));
    const rows = await d.db.select().from(s.notifications)
      .where(q.open === "true" ? isNull(s.notifications.resolvedAt) : undefined).orderBy(desc(s.notifications.updatedAt)).limit(q.limit);
    const [u] = await d.db.select({ n: sql<number>`count(*)::int` }).from(s.notifications).where(and(isNull(s.notifications.resolvedAt), isNull(s.notifications.readAt)));
    return {
      items: rows.map((n) => ({
        id: n.id, key: n.key, severity: n.severity, title: n.title, body: n.body, remediation: n.remediation, count: n.count,
        createdAt: iso(n.createdAt), updatedAt: iso(n.updatedAt), readAt: iso(n.readAt), resolvedAt: iso(n.resolvedAt),
      })),
      unread: u?.n ?? 0,
    };
  });

  app.post("/api/notifications/read-all", async () => {
    await d.db.update(s.notifications).set({ readAt: new Date() }).where(and(isNull(s.notifications.readAt)));
    return { ok: true };
  });
  app.post("/api/notifications/:id/read", async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await d.db.update(s.notifications).set({ readAt: new Date() }).where(eq(s.notifications.id, id)).returning({ id: s.notifications.id });
    if (!r.length) throw notFound("Notification not found");
    return { ok: true };
  });
  app.post("/api/notifications/:id/resolve", async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await d.db.update(s.notifications).set({ resolvedAt: new Date(), readAt: new Date(), updatedAt: new Date() }).where(eq(s.notifications.id, id)).returning({ id: s.notifications.id });
    if (!r.length) throw notFound("Notification not found");
    return { ok: true };
  });
}
