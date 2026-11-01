import fsp from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@nocon/database";
import { transitionDownload } from "@nocon/database";
import { RUNNING_DOWNLOAD_STATES } from "@nocon/shared";
import { stagingDirFor, tmpRoot, type WorkerContext } from "./context.js";

const DAY = 24 * 3600_000;

/** Runs once at boot: undo whatever a crash left half-done. */
export async function recoverOnBoot(ctx: WorkerContext): Promise<{ recovered: number }> {
  const { db, storage, log } = ctx;

  await db.update(s.sourceRuns).set({ status: "failed", error: "interrupted by restart", finishedAt: new Date() })
    .where(eq(s.sourceRuns.status, "running"));

  const stuck = await db.select().from(s.downloads).where(inArray(s.downloads.state, RUNNING_DOWNLOAD_STATES));
  const volumes = await db.select().from(s.storageVolumes);
  for (const d of stuck) {
    await transitionDownload(db, d.id, "queued", { tempPath: null, speedBps: null, etaSeconds: null, nextAttemptAt: null }, "recovered_after_restart");
    await storage.releaseReservation(d.id, "recovered_after_restart");
    for (const v of volumes) await fsp.rm(stagingDirFor(v.mountPath, d.id), { recursive: true, force: true }).catch(() => undefined);
  }
  if (stuck.length) log.info({ count: stuck.length }, "recovered interrupted downloads");

  const stale = await storage.releaseStaleReservations();
  if (stale.length) log.info({ count: stale.length }, "released stale reservations");
  const ev = await storage.recoverInterruptedEvictions();
  if (ev.plans) log.info(ev, "recovered interrupted evictions");
  await storage.refreshAllVolumes();
  await cleanStaleTmp(ctx);
  return { recovered: stuck.length };
}

/** Removes staging dirs older than 24 h that belong to no running download. */
export async function cleanStaleTmp(ctx: WorkerContext, maxAgeMs = DAY): Promise<number> {
  const { db } = ctx;
  const volumes = await db.select().from(s.storageVolumes).where(eq(s.storageVolumes.isOnline, true));
  const running = new Set((await db.select({ id: s.downloads.id }).from(s.downloads)
    .where(and(inArray(s.downloads.state, RUNNING_DOWNLOAD_STATES)))).map((r) => r.id));
  let removed = 0;
  for (const v of volumes) {
    const root = tmpRoot(v.mountPath);
    let names: string[];
    try { names = await fsp.readdir(root); } catch { continue; }
    for (const name of names) {
      if (running.has(name)) continue;
      const p = path.join(root, name);
      try {
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs > maxAgeMs) {
          await fsp.rm(p, { recursive: true, force: true });
          removed++;
        }
      } catch { /* vanished */ }
    }
  }
  return removed;
}
