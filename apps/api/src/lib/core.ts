import { z, type ZodType } from "zod";
import { forwardedHost } from "./clientip.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type pg from "pg";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { StorageService } from "@nocon/storage-manager";
import { getSetting, setSetting, type Database } from "@nocon/database";
import { QUEUES, discoveryBudgetSchema, DEFAULT_TRUSTED_CIDRS, type ResolvedConfig, type DiscoveryBudget } from "@nocon/shared";

// ------------------------------------------------------------------ errors

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, details?: unknown) => new HttpError(400, "bad_request", m, details);
export const notFound = (m = "Not found") => new HttpError(404, "not_found", m);
export const conflict = (m: string) => new HttpError(409, "conflict", m);

/** Validates data with zod; throws a 400 with the issues in `details`. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw badRequest(msg, r.error.issues);
  }
  return r.data;
}
export const parseBody = <T extends ZodType>(req: FastifyRequest, s: T) => parse(s, req.body);
export const parseQuery = <T extends ZodType>(req: FastifyRequest, s: T) => parse(s, req.query);
export const parseParams = <T extends ZodType>(req: FastifyRequest, s: T) => parse(s, req.params);
export const idParam = z.object({ id: z.string().uuid() });

// -------------------------------------------------------------------- deps

export interface Queues {
  sync: Queue; download: Queue; processing: Queue; discovery: Queue; maintenance: Queue;
}

export interface Deps {
  config: ResolvedConfig;
  db: Database;
  pool: pg.Pool;
  redis: Redis;
  queues: Queues;
}

export function createRuntime(config: ResolvedConfig, db: Database, pool: pg.Pool): Deps {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: (n) => Math.min(n * 500, 5000) });
  redis.on("error", () => { /* surfaced by health checks */ });
  const conn = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 500, 5000) });
  conn.on("error", () => { /* ignore */ });
  const mk = (name: string) => {
    const q = new Queue(name, { connection: conn });
    q.on("error", () => { /* ignore, tolerated */ });
    return q;
  };
  return {
    config, db, pool, redis,
    queues: { sync: mk(QUEUES.sync), download: mk(QUEUES.download), processing: mk(QUEUES.processing), discovery: mk(QUEUES.discovery), maintenance: mk(QUEUES.maintenance) },
  };
}

export async function closeRuntime(d: Deps): Promise<void> {
  const conns = new Set<unknown>();
  for (const q of Object.values(d.queues)) { await q.close().catch(() => undefined); conns.add(q); }
  d.redis.disconnect();
  // the queue connection is shared; closing a queue does not close a user-supplied connection
  const c = (d.queues.sync as unknown as { opts: { connection: Redis } }).opts?.connection;
  c?.disconnect?.();
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Enqueue helpers: never throw. Postgres is the source of truth; the worker dispatcher recovers lost jobs. */
export async function enqueue(d: Deps, log: FastifyBaseLogger, queue: keyof Queues, name: string, data: Record<string, unknown>, jobId: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await withTimeout(d.queues[queue].add(name, data, { removeOnComplete: true, removeOnFail: true, jobId, ...extra }), 2000);
    return true;
  } catch (e) {
    log.warn({ err: (e as Error).message, queue, name }, "could not enqueue job (Redis unavailable?); state is saved and the worker will pick it up");
    return false;
  }
}

// ---------------------------------------------------------------- settings

export interface AppSettings {
  profile: "lightweight" | "standard";
  defaultResolution: number;
  softThreshold: number;
  minFreePercent: number;
  enableXtream: boolean;
  enableM3u: boolean;
  enableHls: boolean;
  redownloadCooldownDays: number;
  xtreamAllowedCidrs: string[];
}

const cache = new WeakMap<Deps, { at: number; v: AppSettings }>();

export function appDefaults(c: ResolvedConfig): AppSettings {
  return {
    profile: c.DEPLOYMENT_PROFILE, defaultResolution: 1080, softThreshold: c.STORAGE_SOFT_THRESHOLD ?? 85,
    minFreePercent: c.STORAGE_MIN_FREE_PERCENT ?? 5, enableXtream: c.ENABLE_XTREAM, enableM3u: c.ENABLE_M3U,
    enableHls: c.ENABLE_HLS, redownloadCooldownDays: c.REDOWNLOAD_COOLDOWN_DAYS ?? 30, xtreamAllowedCidrs: [],
  };
}

/** Defaults from env overlaid by the stored value (cached for a few seconds). */
export async function getAppSettings(d: Deps, fresh = false): Promise<AppSettings> {
  const hit = cache.get(d);
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.v;
  const stored = await getSetting<Partial<AppSettings>>(d.db, "app", {});
  const v = { ...appDefaults(d.config), ...stored };
  cache.set(d, { at: Date.now(), v });
  return v;
}
export async function saveAppSettings(d: Deps, v: AppSettings): Promise<void> {
  await setSetting(d.db, "app", v);
  cache.delete(d);
}
export async function getDiscoveryBudget(d: Deps): Promise<DiscoveryBudget> {
  return discoveryBudgetSchema.parse(await getSetting<unknown>(d.db, "discovery", {}));
}

export function effectiveCidrs(d: Deps, s: AppSettings): string[] {
  if (s.xtreamAllowedCidrs?.length) return s.xtreamAllowedCidrs;
  if (d.config.XTREAM_ALLOWED_CIDRS.length) return d.config.XTREAM_ALLOWED_CIDRS;
  return DEFAULT_TRUSTED_CIDRS;
}

/** A StorageService using the current settings. Cheap: the service holds no state. */
export async function getStorage(d: Deps): Promise<StorageService> {
  const s = await getAppSettings(d);
  return new StorageService({
    db: d.db,
    config: { softThresholdPct: s.softThreshold, minFreePct: s.minFreePercent, statfsOverrideBytes: d.config.STORAGE_STATFS_OVERRIDE_BYTES, cooldownDays: s.redownloadCooldownDays },
  });
}

export async function isSetupComplete(d: Deps): Promise<boolean> {
  return (await getSetting<{ complete?: boolean }>(d.db, "setup", {})).complete === true;
}

// ----------------------------------------------------------------- helpers

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function hostOf(req: FastifyRequest): string {
  const h = forwardedHost(req) ?? req.headers.host ?? "localhost";
  return h.split(",")[0]!.trim();
}

export function sendJson(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).send(body);
}
