import path from "node:path";
import type { Redis } from "ioredis";
import { and, desc, eq } from "drizzle-orm";
import * as s from "@nocon/database";
import { getSetting, type Database } from "@nocon/database";
import type { Logger, ResolvedConfig } from "@nocon/shared";
import { AdapterError, getAdapter, type SourceAdapter } from "@nocon/source-adapters";
import type { ErrorClass } from "@nocon/shared";
import type { StorageService } from "@nocon/storage-manager";

export type SyncTrigger = "schedule" | "manual" | "create" | "catchup";

/** Everything a job handler needs. Handlers are plain async functions of (ctx, data) so tests can call them directly. */
export interface WorkerContext {
  db: Database;
  redis: Redis;
  config: ResolvedConfig;
  storage: StorageService;
  log: Logger;
  /** Adapter factory (swappable in tests). */
  adapterFor(platform: string, cookiesFile?: string): SourceAdapter;
  isOnline(): boolean;
  isPaused(): boolean;
  enqueueDownload(downloadId: string): Promise<void>;
  enqueueSync(sourceId: string, trigger: SyncTrigger): Promise<void>;
  enqueueDiscovery(trigger: "schedule" | "manual"): Promise<void>;
  fetch: typeof fetch;
  /** Aborted on shutdown; running downloads stop and go back to `queued`. */
  signal: AbortSignal;
  /** Download progress/cancel polling interval in ms (default 2000). */
  progressIntervalMs: number;
}

export function createAdapterFactory(config: ResolvedConfig): WorkerContext["adapterFor"] {
  const extraArgs = config.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean);
  return (platform, cookiesFile) => getAdapter(platform, { ytDlpPath: config.YTDLP_PATH, extraArgs, ...(cookiesFile ? { cookiesFile } : {}) });
}

export function adapterForSource(ctx: WorkerContext, source: { platform: string; metadata: Record<string, unknown> }): SourceAdapter {
  const cookies = source.metadata?.cookiesFile;
  return ctx.adapterFor(source.platform, typeof cookies === "string" && cookies ? cookies : undefined);
}

export function classifyError(adapter: SourceAdapter, err: unknown): ErrorClass {
  if (err instanceof AdapterError) return err.errorClass;
  const code = (err as { code?: string })?.code;
  if (code === "ENOSPC") return "storage";
  return adapter.classifyError(err instanceof Error ? err.message : String(err));
}

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

export interface AppSettings {
  defaultResolution: number;
  redownloadCooldownDays: number;
  softThreshold?: number;
  minFreePercent?: number;
}

export async function appSettings(ctx: Pick<WorkerContext, "db" | "config">): Promise<AppSettings> {
  const stored = await getSetting<Partial<AppSettings>>(ctx.db, "app", {});
  return {
    defaultResolution: stored.defaultResolution ?? 1080,
    redownloadCooldownDays: stored.redownloadCooldownDays ?? ctx.config.REDOWNLOAD_COOLDOWN_DAYS ?? 30,
    softThreshold: stored.softThreshold,
    minFreePercent: stored.minFreePercent,
  };
}

export type Volume = typeof s.storageVolumes.$inferSelect;

export async function getVolume(ctx: Pick<WorkerContext, "db">, id: string): Promise<Volume | undefined> {
  const [v] = await ctx.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, id));
  return v;
}

/** The preferred volume if online and writable, else the default online volume, else any online writable one. */
export async function pickWritableVolume(ctx: Pick<WorkerContext, "db">, preferredId?: string | null): Promise<Volume | undefined> {
  if (preferredId) {
    const v = await getVolume(ctx, preferredId);
    if (v?.isOnline && v.isWritable) return v;
  }
  const [v] = await ctx.db.select().from(s.storageVolumes)
    .where(and(eq(s.storageVolumes.isOnline, true), eq(s.storageVolumes.isWritable, true), eq(s.storageVolumes.acceptsNew, true)))
    .orderBy(desc(s.storageVolumes.isDefault), s.storageVolumes.createdAt).limit(1);
  return v;
}

export const tmpRoot = (mount: string): string => path.join(mount, ".noconmedia", "tmp");
export const stagingDirFor = (mount: string, downloadId: string): string => path.join(tmpRoot(mount), downloadId);
