import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { getSetting, transitionDownload } from "@nocon/database";
import type { WorkerContext } from "./context.js";
import { getDiscoveryBudget } from "./discovery.js";

export const MAX_SYNCS_PER_TICK = 3;
const CATCHUP_AFTER_MS = 10 * 60_000;

/** Enqueues due sources (max 3 per tick) and the discovery run when its interval has passed. */
export async function schedulerTick(ctx: WorkerContext): Promise<{ synced: string[]; discovery: boolean }> {
  const out = { synced: [] as string[], discovery: false };
  if (!ctx.isOnline() || ctx.isPaused()) return out;
  const now = new Date();

  const due = await ctx.db.select().from(s.sources).where(and(
    eq(s.sources.status, "active"),
    eq(s.sources.system, false),
    or(
      lte(s.sources.nextRunAt, now),
      and(isNull(s.sources.nextRunAt), eq(s.sources.hasRun, false), sql`${s.sources.schedule}->>'kind' <> 'manual'`),
    ),
  )).orderBy(asc(s.sources.nextRunAt)).limit(MAX_SYNCS_PER_TICK);
  for (const src of due) {
    const overdue = src.nextRunAt && now.getTime() - src.nextRunAt.getTime() > CATCHUP_AFTER_MS;
    await ctx.enqueueSync(src.id, overdue ? "catchup" : "schedule");
    out.synced.push(src.id);
  }

  const budget = await getDiscoveryBudget(ctx);
  if (budget.enabled) {
    const last = await getSetting<string | null>(ctx.db, "discovery.lastRunAt", null);
    const intervalMs = (budget.intervalHours ?? ctx.config.profile.discoveryIntervalHours) * 3600_000;
    if (!last || now.getTime() - new Date(last).getTime() >= intervalMs) {
      await ctx.enqueueDiscovery("schedule");
      out.discovery = true;
    }
  }
  return out;
}

/** Every queued download that is allowed to run now gets a job (BullMQ ignores duplicate ids). */
export async function dispatchQueued(ctx: WorkerContext): Promise<number> {
  if (!ctx.isOnline() || ctx.isPaused()) return 0;
  const rows = await ctx.db.select({ id: s.downloads.id }).from(s.downloads)
    .where(and(eq(s.downloads.state, "queued"), or(isNull(s.downloads.nextAttemptAt), lte(s.downloads.nextAttemptAt, new Date()))))
    .orderBy(asc(s.downloads.priority), asc(s.downloads.createdAt)).limit(500);
  for (const r of rows) await ctx.enqueueDownload(r.id);
  return rows.length;
}

/** Storage may have been freed: move a few waiting downloads back to queued (never a tight loop). */
export async function recheckWaiting(ctx: WorkerContext, max = 5): Promise<string[]> {
  const rows = await ctx.db.select({ id: s.downloads.id }).from(s.downloads)
    .where(and(
      eq(s.downloads.state, "waiting_for_storage"),
      or(isNull(s.downloads.waitingReason), sql`${s.downloads.waitingReason} <> 'volume_offline'`),
    )).orderBy(asc(s.downloads.priority), asc(s.downloads.updatedAt)).limit(max);
  for (const r of rows) {
    await transitionDownload(ctx.db, r.id, "queued", { waitingReason: null }, "storage_recheck");
    await ctx.enqueueDownload(r.id);
  }
  return rows.map((r) => r.id);
}

export async function cleanOldStreamSessions(ctx: WorkerContext): Promise<void> {
  await ctx.db.delete(s.streamSessions).where(lte(s.streamSessions.lastSeenAt, new Date(Date.now() - 86_400_000)));
}

