import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import * as s from "@nocon/database";
import { ensureSystemSources, getSetting, type Database } from "@nocon/database";
import { QUEUES, applyProfile, createLogger, sleep, type DeploymentProfile, type Logger, type ResolvedConfig } from "@nocon/shared";
import { StorageService, type StorageConfig } from "@nocon/storage-manager";
import { ConnectivityMonitor } from "./connectivity.js";
import { appSettings, createAdapterFactory, errMessage, type SyncTrigger, type WorkerContext } from "./context.js";
import { processDownload } from "./download.js";
import { runDiscovery } from "./discovery.js";
import { runHls } from "./hls.js";
import { runReconcile } from "./reconcile.js";
import { cleanStaleTmp, recoverOnBoot } from "./recovery.js";
import { cleanOldStreamSessions, dispatchQueued, recheckWaiting, schedulerTick } from "./scheduler.js";
import { runSync } from "./sync.js";

export const HEARTBEAT_KEY = "nocon:worker:heartbeat";
const JOB_OPTS = { removeOnComplete: true, removeOnFail: true } as const;

export interface RuntimeOptions {
  config: ResolvedConfig;
  db: Database;
  /** Must be created with `maxRetriesPerRequest: null` (BullMQ requirement). */
  redis: Redis;
  prefix?: string;
  log?: Logger;
  fetch?: typeof fetch;
  adapterFor?: WorkerContext["adapterFor"];
  /** Overrides for tests. Milliseconds. */
  intervals?: Partial<Record<"heartbeat" | "pause" | "connectivity" | "scheduler" | "dispatcher" | "waiting" | "volumes" | "softThreshold" | "rolling" | "housekeeping" | "progress" | "profile", number>>;
  dbWaitMs?: number;
}

export interface WorkerRuntime {
  ctx: WorkerContext;
  queues: Record<keyof typeof QUEUES, Queue>;
  workers: Worker[];
  connectivity: ConnectivityMonitor;
  /** Run a periodic task now (used by tests and after reconnects). */
  stop(): Promise<void>;
}

export async function waitForDatabase(db: Database, log: Logger, maxMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.select({ key: s.settings.key }).from(s.settings).limit(1);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Database not ready after ${Math.round(maxMs / 1000)} s: ${errMessage(e)}`);
      if (attempt === 1 || attempt % 5 === 0) log.info({ err: errMessage(e) }, "waiting for database (the API runs migrations)");
      await sleep(2000);
    }
  }
}

export async function startWorker(opts: RuntimeOptions): Promise<WorkerRuntime> {
  const { config, db, redis } = opts;
  const log = opts.log ?? createLogger("worker", config.LOG_LEVEL);
  const iv = { heartbeat: 15_000, pause: 10_000, connectivity: (config.CONNECTIVITY_INTERVAL_SEC ?? 60) * 1000, scheduler: (config.SCHEDULER_INTERVAL_SEC ?? 60) * 1000,
    dispatcher: 30_000, waiting: 600_000, volumes: 60_000, softThreshold: 900_000, rolling: 3_600_000, housekeeping: 3_600_000, progress: 2000, profile: 60_000, ...opts.intervals };
  const prefix = opts.prefix ?? "bull";
  const fetchFn = opts.fetch ?? fetch;

  await waitForDatabase(db, log, opts.dbWaitMs);
  await ensureSystemSources(db);

  // The profile chosen in the wizard or Settings (settings.app.profile) wins over DEPLOYMENT_PROFILE,
  // which is only the default while the setting is absent. MAX_CONCURRENT_* env values still override.
  const storedProfile = async (): Promise<DeploymentProfile | undefined> => {
    const p = (await getSetting<{ profile?: unknown }>(db, "app", {})).profile;
    return p === "lightweight" || p === "standard" ? p : undefined;
  };
  const bootProfile = await storedProfile();
  if (bootProfile) applyProfile(config, bootProfile);

  // ---- queues and enqueue helpers
  const q = (name: string) => new Queue(name, { connection: redis, prefix });
  const queues = { sync: q(QUEUES.sync), download: q(QUEUES.download), processing: q(QUEUES.processing), discovery: q(QUEUES.discovery), maintenance: q(QUEUES.maintenance) };

  // ---- shared state
  const shutdown = new AbortController();
  let paused = false;
  const active = { downloads: 0, processing: 0, sync: 0, discovery: 0 };

  const storageConfig: StorageConfig = {
    softThresholdPct: (config.STORAGE_SOFT_THRESHOLD ?? 85), minFreePct: (config.STORAGE_MIN_FREE_PERCENT ?? 5),
    cooldownDays: (config.REDOWNLOAD_COOLDOWN_DAYS ?? 30), ...(config.STORAGE_STATFS_OVERRIDE_BYTES ? { statfsOverrideBytes: config.STORAGE_STATFS_OVERRIDE_BYTES } : {}),
  };
  const storage = new StorageService({ db, config: storageConfig });
  const refreshStorageConfig = async (): Promise<void> => {
    const app = await appSettings({ db, config });
    storageConfig.softThresholdPct = app.softThreshold ?? (config.STORAGE_SOFT_THRESHOLD ?? 85);
    storageConfig.minFreePct = app.minFreePercent ?? (config.STORAGE_MIN_FREE_PERCENT ?? 5);
    storageConfig.cooldownDays = app.redownloadCooldownDays;
  };
  await refreshStorageConfig();

  const connectivity = new ConnectivityMonitor({ db, redis, log, urls: config.CONNECTIVITY_CHECK_URLS, fetch: fetchFn });

  const ctx: WorkerContext = {
    db, redis, config, storage, log,
    adapterFor: opts.adapterFor ?? createAdapterFactory(config),
    isOnline: () => connectivity.online,
    isPaused: () => paused,
    enqueueDownload: async (downloadId) => { await queues.download.add("download", { downloadId }, { ...JOB_OPTS, jobId: `download-${downloadId}` }); },
    enqueueSync: async (sourceId, trigger: SyncTrigger) => { await queues.sync.add("sync", { sourceId, trigger }, { ...JOB_OPTS, jobId: `sync-${sourceId}` }); },
    enqueueDiscovery: async (trigger) => { await queues.discovery.add("discovery", { trigger }, { ...JOB_OPTS, jobId: "discovery-run" }); },
    fetch: fetchFn,
    signal: shutdown.signal,
    progressIntervalMs: iv.progress,
  };

  // ---- boot: probe first so recovery and workers know the connectivity state, then recover
  await connectivity.check().catch((e) => log.warn({ err: errMessage(e) }, "initial connectivity probe failed"));
  await recoverOnBoot(ctx);

  // ---- workers
  const tracked = <T>(key: keyof typeof active, fn: (data: T) => Promise<unknown>) => async (job: Job<T>) => {
    active[key]++;
    try {
      return await fn(job.data);
    } catch (e) {
      log.error({ job: job.name, err: errMessage(e) }, "job crashed");
      throw e;
    } finally {
      active[key]--;
    }
  };
  const mk = (name: string, concurrency: number, fn: (job: Job) => Promise<unknown>, lockDuration = 300_000) =>
    new Worker(name, fn, { connection: redis, prefix, concurrency, lockDuration });
  const syncW = mk(QUEUES.sync, config.concurrency.metadata, tracked("sync", (d: { sourceId: string; trigger: SyncTrigger }) => runSync(ctx, d)));
  const downloadW = mk(QUEUES.download, config.concurrency.downloads, tracked("downloads", (d: { downloadId: string }) => processDownload(ctx, d)));
  const processingW = mk(QUEUES.processing, config.concurrency.processing, tracked("processing", (d: { mediaId: string }) => runHls(ctx, d)));
  const discoveryW = mk(QUEUES.discovery, 1, tracked("discovery", (d: { trigger: "schedule" | "manual" }) => runDiscovery(ctx, d)));
  const maintenanceW = mk(QUEUES.maintenance, 1, (job) => runReconcile(ctx, job.data as { dryRun: boolean; volumeId?: string }));
  const workers = [syncW, downloadW, processingW, discoveryW, maintenanceW];
  for (const w of workers) w.on("error", (e) => log.error({ err: errMessage(e), queue: w.name }, "worker error"));
  const pausable = [syncW, downloadW, processingW, discoveryW];

  // ---- periodic tasks (never overlapping, never throwing)
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, fn: () => Promise<unknown>, runNow = false): (() => Promise<void>) => {
    let running = false;
    const run = async (): Promise<void> => {
      if (running || shutdown.signal.aborted) return;
      running = true;
      try { await fn(); } catch (e) { log.warn({ task: name, err: errMessage(e) }, "periodic task failed"); } finally { running = false; }
    };
    timers.push(setInterval(() => void run(), ms));
    if (runNow) void run();
    return run;
  };

  const heartbeat = async (): Promise<void> => {
    await redis.set(HEARTBEAT_KEY, JSON.stringify({
      at: new Date().toISOString(), pid: process.pid, version: process.env.npm_package_version ?? "0.1.0", paused, active: { ...active },
    }), "EX", 60);
  };
  const checkPause = async (): Promise<void> => {
    const w = await getSetting<{ paused?: boolean }>(db, "worker", {});
    const want = w.paused === true;
    if (want === paused) return;
    paused = want;
    if (paused) { await Promise.all(pausable.map((x) => x.pause(true))); log.info("worker paused"); }
    else { pausable.forEach((x) => x.resume()); log.info("worker resumed"); void dispatch(); }
  };
  const dispatch = every("dispatcher", iv.dispatcher, () => dispatchQueued(ctx), true);
  const tick = config.WORKER_DISABLE_SCHEDULER ? async () => undefined : every("scheduler", iv.scheduler, () => schedulerTick(ctx), true);
  const volumes = async (): Promise<void> => {
    for (const t of await storage.refreshAllVolumes()) {
      if (t.transition) log.info({ volumeId: t.volumeId, transition: t.transition }, "volume transition");
      for (const id of t.resumedDownloadIds) await ctx.enqueueDownload(id);
    }
  };

  await heartbeat();
  await checkPause();
  every("heartbeat", iv.heartbeat, heartbeat);
  every("pause", iv.pause, checkPause);
  every("connectivity", iv.connectivity, async () => {
    const r = await connectivity.check();
    if (r.restored) { await dispatch(); await tick(); }
  });
  every("storage-config", 60_000, refreshStorageConfig);
  every("profile", iv.profile, async () => {
    const p = await storedProfile();
    if (!p || p === config.DEPLOYMENT_PROFILE) return;
    applyProfile(config, p);
    syncW.concurrency = config.concurrency.metadata;
    downloadW.concurrency = config.concurrency.downloads;
    processingW.concurrency = config.concurrency.processing;
    log.info({ profile: p, concurrency: config.concurrency }, "deployment profile changed, concurrency updated");
  });
  every("volumes", iv.volumes, volumes);
  every("waiting", iv.waiting, () => recheckWaiting(ctx));
  every("soft-threshold", iv.softThreshold, async () => {
    for (const v of await db.select().from(s.storageVolumes).where(eq(s.storageVolumes.isOnline, true))) await storage.softThresholdCleanup(v.id);
  });
  every("rolling-retention", iv.rolling, () => storage.rollingRetentionCleanup());
  every("housekeeping", iv.housekeeping, async () => { await cleanOldStreamSessions(ctx); await cleanStaleTmp(ctx); });

  log.info({ concurrency: config.concurrency, profile: config.DEPLOYMENT_PROFILE }, "worker started");

  return {
    ctx, queues, workers, connectivity,
    async stop() {
      log.info("worker shutting down");
      timers.forEach(clearInterval);
      shutdown.abort(); // running downloads stop and return to `queued`
      await Promise.race([Promise.all(workers.map((w) => w.close())), sleep(15_000)]);
      await Promise.all(Object.values(queues).map((x) => x.close().catch(() => undefined)));
      await redis.del(HEARTBEAT_KEY).catch(() => undefined);
    },
  };
}
