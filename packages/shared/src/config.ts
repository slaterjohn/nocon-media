import { z } from "zod";
import type { DeploymentProfile } from "./enums.js";

const bool = (d: boolean) =>
  z.preprocess((v) => (v === undefined || v === "" ? d : v === true || v === "true" || v === "1" || v === "yes"), z.boolean());
function int(d: number): z.ZodType<number>;
function int(): z.ZodType<number | undefined>;
function int(d?: number): z.ZodType<any> {
  return z.preprocess((v) => (v === undefined || v === "" ? d : Number(v)), d === undefined ? z.number().int().optional() : z.number().int());
}
const list = (d: string[]) => z.preprocess((v) => (typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : d), z.array(z.string()));

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  APP_URL: z.string().default("http://localhost:3000"),
  /** Extra browser origins accepted for mutations when the proxy secret is not configured (comma list). */
  ALLOWED_ORIGINS: list([]),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: int(3001),
  /** Host-side API port shown to Xtream clients. Defaults to API_PORT. */
  API_PORT_PUBLIC: int(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  MEDIA_ROOT: z.string().default("/media"),
  MEDIA_ROOTS_ALLOWED: list(["/media"]),
  DATA_ROOT: z.string().default("/data"),
  DEPLOYMENT_PROFILE: z.enum(["lightweight", "standard"]).default("lightweight"),
  MAX_CONCURRENT_DOWNLOADS: int(),
  MAX_CONCURRENT_PROCESSING: int(),
  MAX_CONCURRENT_METADATA: int(),
  STORAGE_SOFT_THRESHOLD: int(85),
  STORAGE_MIN_FREE_PERCENT: int(5),
  DEFAULT_SOURCE_PRIORITY: z.enum(["P0", "P1", "P2", "P3"]).default("P1"),
  DEFAULT_SOURCE_RETENTION: z.enum(["all", "none", "latest_n", "last_days", "quota", "rolling", "prefer_unwatched"]).default("all"),
  DEFAULT_SOURCE_AUTO_EVICTION: bool(true),
  ENABLE_XTREAM: bool(true),
  ENABLE_M3U: bool(true),
  ENABLE_HLS: bool(true),
  XTREAM_ALLOWED_CIDRS: list([]),
  PUBLIC_XTREAM_URL: z.string().optional(),
  TRUST_PROXY: bool(false),
  TRUSTED_PROXY_CIDRS: list([]),
  NOCON_PROXY_SECRET: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  COOKIE_SECURE: bool(false),
  YTDLP_PATH: z.string().default("yt-dlp"),
  YTDLP_EXTRA_ARGS: z.string().default(""),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  CONNECTIVITY_CHECK_URLS: list(["https://www.youtube.com/generate_204", "https://www.google.com/generate_204", "https://1.1.1.1/"]),
  CONNECTIVITY_INTERVAL_SEC: int(60),
  STORAGE_STATFS_OVERRIDE_BYTES: int(), // testing only: pretend volume capacity
  REDOWNLOAD_COOLDOWN_DAYS: int(30),
  SCHEDULER_INTERVAL_SEC: int(60),
  WORKER_DISABLE_SCHEDULER: bool(false),
});
export type Env = z.infer<typeof envSchema>;

export interface ProfileDefaults {
  downloads: number;
  processing: number;
  metadata: number;
  discoveryIntervalHours: number;
  dbPoolApi: number;
  dbPoolWorker: number;
  generateThumbnails: boolean;
  allowPreTranscode: boolean;
}

export const PROFILE_DEFAULTS: Record<DeploymentProfile, ProfileDefaults> = {
  lightweight: { downloads: 1, processing: 1, metadata: 1, discoveryIntervalHours: 12, dbPoolApi: 5, dbPoolWorker: 3, generateThumbnails: false, allowPreTranscode: false },
  standard: { downloads: 3, processing: 2, metadata: 3, discoveryIntervalHours: 3, dbPoolApi: 15, dbPoolWorker: 8, generateThumbnails: true, allowPreTranscode: true },
};

export interface ResolvedConfig extends Env {
  profile: ProfileDefaults;
  concurrency: { downloads: number; processing: number; metadata: number };
}

/** Concurrency for a profile; explicit MAX_CONCURRENT_* env values win over the profile defaults. */
export function concurrencyFor(env: Pick<Env, "MAX_CONCURRENT_DOWNLOADS" | "MAX_CONCURRENT_PROCESSING" | "MAX_CONCURRENT_METADATA">, profile: ProfileDefaults): ResolvedConfig["concurrency"] {
  return {
    downloads: env.MAX_CONCURRENT_DOWNLOADS ?? profile.downloads,
    processing: env.MAX_CONCURRENT_PROCESSING ?? profile.processing,
    metadata: env.MAX_CONCURRENT_METADATA ?? profile.metadata,
  };
}

/** Switches a resolved config to another profile in place (the stored setting overrides DEPLOYMENT_PROFILE). */
export function applyProfile(config: ResolvedConfig, name: DeploymentProfile): void {
  config.DEPLOYMENT_PROFILE = name;
  config.profile = PROFILE_DEFAULTS[name];
  config.concurrency = concurrencyFor(config, config.profile);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  const profile = PROFILE_DEFAULTS[e.DEPLOYMENT_PROFILE];
  return {
    ...e,
    profile,
    concurrency: concurrencyFor(e, profile),
  };
}
