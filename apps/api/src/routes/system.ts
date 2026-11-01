import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { getSetting, logActivity, setSetting } from "@nocon/database";
import { RESOLUTIONS, discoveryBudgetSchema } from "@nocon/shared";
import {
  effectiveCidrs, getAppSettings, getDiscoveryBudget, getStorage, iso, parseBody, saveAppSettings, withTimeout, type Deps,
} from "../lib/core.js";
import { playableSql, toSummaries, toVolumes } from "../lib/serialize.js";
import { searchClause } from "../lib/query.js";
import { buildCatalog } from "../lib/xtream.js";
import { readHeartbeat } from "./auth.js";
import { activityDto } from "./activity.js";
import { resolveMediaFile } from "../lib/serve.js";
import { publicBase } from "./xtream.js";

export async function readConnectivity(d: Deps): Promise<{ online: boolean; checkedAt: string | null }> {
  try {
    const raw = await withTimeout(d.redis.get("nocon:connectivity"), 1500);
    if (raw) { const v = JSON.parse(raw); return { online: !!v.online, checkedAt: v.checkedAt ?? null }; }
  } catch { /* unknown */ }
  return { online: false, checkedAt: null };
}

async function workerState(d: Deps) {
  const hb = await readHeartbeat(d);
  const paused = (await getSetting<{ paused?: boolean }>(d.db, "worker", {})).paused ?? false;
  return { online: !!hb, paused: hb?.paused ?? paused, lastHeartbeat: hb?.at ?? null };
}

async function cpuPercent(): Promise<number> {
  const snap = () => os.cpus().reduce((a, c) => {
    const t = c.times; return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq };
  }, { idle: 0, total: 0 });
  const a = snap();
  await new Promise((r) => setTimeout(r, 200));
  const b = snap();
  const total = b.total - a.total;
  return total <= 0 ? 0 : Math.round((1 - (b.idle - a.idle) / total) * 1000) / 10;
}

function readNum(p: string): number | null {
  try { const v = Number(fs.readFileSync(p, "utf8").trim()); return Number.isFinite(v) ? v : null; } catch { return null; }
}

function memory() {
  let total = os.totalmem(), used = total - os.freemem();
  const cur = readNum("/sys/fs/cgroup/memory.current");
  const max = readNum("/sys/fs/cgroup/memory.max"); // NaN when "max"
  if (cur !== null) { used = cur; if (max !== null && max < total) total = max; }
  return { totalBytes: total, usedBytes: used, processRss: process.memoryUsage().rss };
}

const ACTIVE = ["checking", "downloading", "processing", "verifying"] as const;

export async function systemRoutes(app: FastifyInstance, d: Deps) {
  const activeStreams = async () => {
    const [r] = await d.db.select({ n: sql<number>`count(*)::int` }).from(s.streamSessions).where(gt(s.streamSessions.lastSeenAt, new Date(Date.now() - 90_000)));
    return r?.n ?? 0;
  };
  const countDownloads = async () => {
    const rows = await d.db.select({ state: s.downloads.state, n: sql<number>`count(*)::int` }).from(s.downloads).groupBy(s.downloads.state);
    const m = Object.fromEntries(rows.map((r) => [r.state, r.n])) as Record<string, number>;
    return { active: ACTIVE.reduce((a, k) => a + (m[k] ?? 0), 0), pending: (m.queued ?? 0) + (m.discovered ?? 0), failed: m.failed ?? 0, waitingForStorage: m.waiting_for_storage ?? 0 };
  };

  app.get("/api/dashboard", async () => {
    const mc = await d.db.select({ a: s.media.availability, n: sql<number>`count(*)::int` }).from(s.media).groupBy(s.media.availability);
    const m = Object.fromEntries(mc.map((r) => [r.a, r.n])) as Record<string, number>;
    const vols = await toVolumes(d);
    const sc = await d.db.select({ status: s.sources.status, attention: s.sources.needsAttention, n: sql<number>`count(*)::int` }).from(s.sources)
      .where(eq(s.sources.system, false)).groupBy(s.sources.status, s.sources.needsAttention);
    const [ls] = await d.db.select({ at: sql<Date | null>`max(${s.sources.lastSuccessAt})` }).from(s.sources);
    const [un] = await d.db.select({ n: sql<number>`count(*)::int` }).from(s.notifications).where(and(isNull(s.notifications.resolvedAt), isNull(s.notifications.readAt)));
    const sum = (st?: string) => sc.filter((r) => !st || r.status === st).reduce((a, r) => a + r.n, 0);
    return {
      media: { total: Object.values(m).reduce((a, b) => a + b, 0), available: m.available ?? 0, evicted: m.evicted ?? 0, discovered: m.discovered ?? 0 },
      storage: {
        totalBytes: vols.reduce((a, v) => a + v.totalBytes, 0), freeBytes: vols.reduce((a, v) => a + v.freeBytes, 0),
        usedBytes: vols.reduce((a, v) => a + v.usedBytes, 0), byPriority: await (await getStorage(d)).usageByPriority(),
      },
      downloads: await countDownloads(),
      sources: { total: sum(), active: sum("active"), paused: sum("paused"), error: sum("error"), needsAttention: sc.filter((r) => r.attention).reduce((a, r) => a + r.n, 0), lastSyncAt: iso(ls?.at ? new Date(ls.at) : null) },
      streams: { active: await activeStreams() },
      connectivity: await readConnectivity(d),
      worker: await workerState(d),
      notifications: { unread: un?.n ?? 0 },
    };
  });

  app.get("/api/system/health", async () => {
    const t0 = Date.now();
    let dbOk = true;
    try { await d.pool.query("select 1"); } catch { dbOk = false; }
    const dbMs = Date.now() - t0;
    const t1 = Date.now();
    let redisOk = true;
    try { await withTimeout(d.redis.ping(), 1500); } catch { redisOk = false; }
    const redisMs = Date.now() - t1;
    const queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }> = {};
    if (redisOk) {
      for (const [name, q] of Object.entries(d.queues)) {
        try {
          const c = (await withTimeout(q.getJobCounts("waiting", "active", "delayed", "failed"), 2000)) as Record<string, number>;
          queues[name] = { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
        } catch { queues[name] = { waiting: 0, active: 0, delayed: 0, failed: 0 }; }
      }
    }
    let temp: number | null = null;
    const raw = readNum("/sys/class/thermal/thermal_zone0/temp");
    if (raw !== null) temp = Math.round(raw / 100) / 10;
    const volumes = await toVolumes(d, true);
    const worker = await workerState(d);
    const errors = dbOk ? await d.db.select().from(s.activityEvents).where(inArray(s.activityEvents.severity, ["error", "critical"])).orderBy(desc(s.activityEvents.id)).limit(10) : [];
    const remediation: Array<{ key: string; message: string }> = [];
    if (!worker.online) remediation.push({ key: "worker_offline", message: "The worker is not running. Downloads and syncs are paused. Restart the worker container." });
    if (!redisOk) remediation.push({ key: "redis_down", message: "Redis is not reachable. Queued work will resume when it is back." });
    for (const v of volumes) if (!v.isOnline) remediation.push({ key: `volume_offline:${v.id}`, message: `Storage "${v.name}" is offline. Check the drive is plugged in and mounted, then press Verify.` });
    if (!dbOk) remediation.push({ key: "database_down", message: "The database is not reachable." });
    return {
      cpu: { percent: await cpuPercent(), cores: os.cpus().length, load: os.loadavg() },
      memory: memory(), temperatureC: temp, volumes,
      worker: { ...worker, queues },
      database: { ok: dbOk, latencyMs: dbMs }, redis: { ok: redisOk, latencyMs: redisMs },
      downloads: { active: dbOk ? (await countDownloads()).active : 0 }, streams: { active: dbOk ? await activeStreams() : 0 },
      connectivity: await readConnectivity(d), recentErrors: errors.map(activityDto), remediation,
    };
  });

  app.get("/api/system/offline-readiness", async (req) => {
    const checks: Array<{ key: string; ok: boolean; message: string }> = [];
    const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
      try { checks.push({ key, ...(await fn()) }); } catch (e) { checks.push({ key, ok: false, message: (e as Error).message }); }
    };
    const playableRows = async (n: number) => d.db.select().from(s.media).where(playableSql).orderBy(desc(s.media.downloadedAt)).limit(n);

    await run("auth", async () => {
      await d.db.select({ id: s.sessions.id }).from(s.sessions).limit(1);
      return { ok: true, message: "Sign-in uses the local database; no internet needed." };
    });
    await run("database", async () => { await d.pool.query("select 1"); return { ok: true, message: "Database reachable." }; });
    await run("media_files", async () => {
      const rows = await playableRows(5);
      if (!rows.length) return { ok: false, message: "No playable media yet." };
      let readable = 0;
      for (const m of rows) if (await resolveMediaFile(d, m.id, ["video", "audio"])) readable++;
      return readable === rows.length ? { ok: true, message: `${rows.length} sampled file(s) present on disk.` } : { ok: false, message: `${rows.length - readable} of ${rows.length} sampled files are missing on disk.` };
    });
    await run("thumbnails", async () => {
      const [r] = await d.db.select({
        total: sql<number>`count(*)::int`,
        missing: sql<number>`count(*) filter (where not exists (select 1 from media_files f where f.media_id = "media"."id" and f.kind = 'thumbnail'))::int`,
      }).from(s.media).where(playableSql);
      return r!.missing === 0 ? { ok: true, message: `All ${r!.total} playable item(s) have a local thumbnail.` } : { ok: false, message: `${r!.missing} of ${r!.total} playable item(s) have no local thumbnail.` };
    });
    await run("search", async () => {
      const sc = searchClause("readiness check");
      await d.db.select({ id: s.media.id }).from(s.media).where(sc.cond).orderBy(sql`${sc.rank} desc`).limit(1);
      return { ok: true, message: "Full-text search runs in the local database." };
    });
    await run("streaming", async () => {
      const [m] = await playableRows(1);
      if (!m) return { ok: false, message: "No playable media to test streaming with." };
      const f = await resolveMediaFile(d, m.id, ["video", "audio"]);
      if (!f) return { ok: false, message: "The sample file is missing." };
      const fh = await fs.promises.open(f.abs, "r");
      try { const b = Buffer.alloc(16); const { bytesRead } = await fh.read(b, 0, 16, 0); return bytesRead > 0 ? { ok: true, message: "Sample file opens and reads." } : { ok: false, message: "The sample file is empty." }; }
      finally { await fh.close(); }
    });
    let vodThumbs: string[] = [];
    await run("xtream", async () => {
      const base = publicBase(d, req as FastifyRequest);
      const cat = await buildCatalog(d, { baseUrl: base, username: "readiness", password: "readiness" });
      vodThumbs = cat.vods.map((v) => v.thumbnailUrl);
      return { ok: cat.categories.length > 0, message: `Built ${cat.categories.length} categories and ${cat.vods.length} streams in-process.` };
    });
    await run("external_dependencies", async () => {
      const rows = await playableRows(200);
      const urls = [...(await toSummaries(d, rows)).map((m) => m.thumbnailUrl).filter((u): u is string => !!u), ...vodThumbs];
      const own = new URL(publicBase(d, req as FastifyRequest)).host;
      const external = urls.filter((u) => /^https?:\/\//i.test(u) && new URL(u).host !== own);
      return external.length === 0 ? { ok: true, message: "All artwork URLs are served locally." } : { ok: false, message: `${external.length} artwork URL(s) point to other hosts.` };
    });
    return { ok: checks.every((c) => c.ok), checks };
  });

  app.post("/api/system/worker", async (req) => {
    const { paused } = parseBody(req, z.object({ paused: z.boolean() }));
    await setSetting(d.db, "worker", { paused });
    await logActivity(d.db, { type: paused ? "worker.paused" : "worker.resumed", message: paused ? "Worker paused" : "Worker resumed" });
    return { ok: true };
  });

  const cidr = z.string().refine((v) => {
    const [ip, bits] = v.split("/");
    const fam = net.isIP(ip ?? "");
    if (!fam) return false;
    if (bits === undefined) return true;
    return /^\d+$/.test(bits) && Number(bits) <= (fam === 4 ? 32 : 128);
  }, "Invalid CIDR");
  const settingsSchema = z.object({
    profile: z.enum(["lightweight", "standard"]), defaultResolution: z.number().int().refine((n) => (RESOLUTIONS as readonly number[]).includes(n), "Unsupported resolution"),
    softThreshold: z.number().int().min(50).max(99), minFreePercent: z.number().int().min(1).max(50),
    enableXtream: z.boolean(), enableM3u: z.boolean(), enableHls: z.boolean(),
    discovery: discoveryBudgetSchema.partial(), redownloadCooldownDays: z.number().int().min(0).max(3650),
    xtreamAllowedCidrs: z.array(cidr).max(50),
  }).partial();

  const settingsOut = async () => {
    const st = await getAppSettings(d, true);
    return { ...st, xtreamAllowedCidrs: effectiveCidrs(d, st), discovery: await getDiscoveryBudget(d) };
  };
  app.get("/api/settings", settingsOut);
  app.put("/api/settings", async (req) => {
    const { discovery, ...app_ } = parseBody(req, settingsSchema);
    const cur = await getAppSettings(d, true);
    await saveAppSettings(d, { ...cur, ...app_ });
    if (discovery) await setSetting(d.db, "discovery", discoveryBudgetSchema.parse({ ...(await getDiscoveryBudget(d)), ...discovery }));
    await logActivity(d.db, { type: "settings.updated", message: "Settings updated", data: { fields: Object.keys({ ...app_, ...(discovery ? { discovery } : {}) }) } });
    return settingsOut();
  });
}
