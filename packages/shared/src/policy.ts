import { z } from "zod";
import { PRIORITIES, RETENTION_MODES, DISCOVERY_MODES } from "./enums.js";

export const prioritySchema = z.enum(PRIORITIES);

export const retentionSchema = z.object({
  mode: z.enum(RETENTION_MODES).default("all"),
  count: z.number().int().positive().max(100000).optional(),
  days: z.number().int().positive().max(36500).optional(),
  quotaBytes: z.number().int().positive().optional(),
}).superRefine((r, ctx) => {
  if ((r.mode === "latest_n" || r.mode === "rolling") && !r.count) ctx.addIssue({ code: "custom", message: "count is required for this retention mode", path: ["count"] });
  if (r.mode === "last_days" && !r.days) ctx.addIssue({ code: "custom", message: "days is required for last_days", path: ["days"] });
  if (r.mode === "quota" && !r.quotaBytes) ctx.addIssue({ code: "custom", message: "quotaBytes is required for quota", path: ["quotaBytes"] });
});
export type RetentionPolicy = z.infer<typeof retentionSchema>;

export const scheduleSchema = z.object({
  kind: z.enum(["once", "hourly", "daily", "weekly", "cron", "manual"]).default("daily"),
  cron: z.string().max(100).optional(),
}).superRefine((s, ctx) => {
  if (s.kind === "cron" && !s.cron) ctx.addIssue({ code: "custom", message: "cron expression required", path: ["cron"] });
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const filtersSchema = z.object({
  maxAgeDays: z.number().int().positive().optional(),
  minDurationSec: z.number().int().nonnegative().optional(),
  maxDurationSec: z.number().int().positive().optional(),
  maxHistorical: z.number().int().nonnegative().optional(),
  maxNewPerRun: z.number().int().positive().optional(),
  includeShorts: z.boolean().default(false),
  includeLive: z.boolean().default(false),
  requiredKeywords: z.array(z.string().max(100)).max(50).default([]),
  excludedKeywords: z.array(z.string().max(100)).max(50).default([]),
  preferredLanguage: z.string().max(20).optional(),
});
export type SourceFilters = z.infer<typeof filtersSchema>;

export const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360] as const;
export const downloadOptionsSchema = z.object({
  resolution: z.union(RESOLUTIONS.map((r) => z.literal(r)) as [z.ZodLiteral<2160>, ...z.ZodLiteral<number>[]]).optional(),
  audioOnly: z.boolean().default(false),
  subtitles: z.object({
    enabled: z.boolean().default(true),
    languages: z.array(z.string().max(20)).max(10).default(["en"]),
    auto: z.boolean().default(false),
  }).default({ enabled: true, languages: ["en"], auto: false }),
});
export type DownloadOptions = z.infer<typeof downloadOptionsSchema>;

export const discoveryOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  depth: z.number().int().min(0).max(2).default(0),
  mode: z.enum(DISCOVERY_MODES).default("approval"),
  maxRecommendations: z.number().int().nonnegative().max(1000).default(20),
});
export type DiscoveryOptions = z.infer<typeof discoveryOptionsSchema>;

export const defaultSourceStoragePolicy = {
  priority: "P1" as const,
  retention: { mode: "all" as const },
  automaticEviction: true,
};

/** Global discovery budget settings (settings key "discovery"). */
export const discoveryBudgetSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(DISCOVERY_MODES).default("approval"),
  maxDepth: z.number().int().min(0).max(2).default(1),
  maxDiscovered: z.number().int().nonnegative().default(500),
  maxDownloaded: z.number().int().nonnegative().default(50),
  maxStorageBytes: z.number().int().nonnegative().default(50 * 1024 ** 3),
  maxDurationSec: z.number().int().positive().default(3600),
  maxAgeDays: z.number().int().positive().default(730),
  minScore: z.number().min(0).max(1).default(0.35),
  cooldownDays: z.number().int().nonnegative().default(30),
  intervalHours: z.number().positive().optional(),
});
export type DiscoveryBudget = z.infer<typeof discoveryBudgetSchema>;
