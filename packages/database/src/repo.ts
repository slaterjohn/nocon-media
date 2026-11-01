import { and, eq, isNull, sql } from "drizzle-orm";
import { computeEffectivePriority, type Priority } from "@nocon/shared";
import type { DbOrTx } from "./client.js";
import * as s from "./schema.js";

type Severity = "info" | "warning" | "error" | "critical";

export async function getSetting<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(s.settings).where(eq(s.settings.key, key)).limit(1);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(db: DbOrTx, key: string, value: unknown): Promise<void> {
  await db.insert(s.settings).values({ key, value })
    .onConflictDoUpdate({ target: s.settings.key, set: { value, updatedAt: new Date() } });
}

export interface ActivityInput {
  type: string;
  severity?: Severity;
  message: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
}

export async function logActivity(db: DbOrTx, e: ActivityInput): Promise<void> {
  await db.insert(s.activityEvents).values({
    type: e.type,
    severity: e.severity ?? "info",
    message: e.message,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    data: e.data ?? {},
  });
}

export interface NotificationInput {
  key: string;
  severity: Severity;
  title: string;
  body?: string;
  remediation?: string;
}

/** Creates the notification, or bumps count/body of the open one with the same key. */
export async function raiseNotification(db: DbOrTx, n: NotificationInput): Promise<void> {
  await db.insert(s.notifications).values({
    key: n.key, severity: n.severity, title: n.title, body: n.body ?? null, remediation: n.remediation ?? null,
  }).onConflictDoUpdate({
    target: s.notifications.key,
    targetWhere: isNull(s.notifications.resolvedAt),
    set: {
      count: sql`${s.notifications.count} + 1`,
      body: n.body ?? null,
      severity: n.severity,
      updatedAt: new Date(),
    },
  });
}

export async function resolveNotification(db: DbOrTx, key: string): Promise<void> {
  await db.update(s.notifications).set({ resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(s.notifications.key, key), isNull(s.notifications.resolvedAt)));
}

/** Recomputes and stores media.effective_priority. Returns the new value. */
export async function recomputeEffectivePriority(db: DbOrTx, mediaId: string): Promise<Priority> {
  const [m] = await db.select().from(s.media).where(eq(s.media.id, mediaId)).limit(1);
  if (!m) throw new Error(`Media ${mediaId} not found`);
  const links = await db.select({ priority: s.sources.priority }).from(s.mediaSources)
    .innerJoin(s.sources, eq(s.sources.id, s.mediaSources.sourceId))
    .where(eq(s.mediaSources.mediaId, mediaId));
  const [hist] = await db.select().from(s.playbackHistory).where(eq(s.playbackHistory.mediaId, mediaId)).limit(1);
  const [ev] = await db.select({ id: s.watchEvents.id }).from(s.watchEvents).where(eq(s.watchEvents.mediaId, mediaId)).limit(1);
  const watched = !!ev || (!!hist && (hist.watchCount > 0 || hist.completed));
  const priority = computeEffectivePriority({
    pinned: m.pinned,
    manualPriority: m.manualPriority,
    sourcePriorities: links.map((l) => l.priority),
    watched,
    approved: m.approved,
  });
  await db.update(s.media).set({ effectivePriority: priority, updatedAt: new Date() }).where(eq(s.media.id, mediaId));
  return priority;
}
