import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "./policy.js";

/** Next run after `from`. Returns null for manual / completed one-off schedules. */
export function nextRunAt(s: Schedule, from: Date, hasRunBefore: boolean): Date | null {
  const h = 3600_000;
  switch (s.kind) {
    case "manual": return null;
    case "once": return hasRunBefore ? null : from;
    case "hourly": return new Date(from.getTime() + h);
    case "daily": return new Date(from.getTime() + 24 * h);
    case "weekly": return new Date(from.getTime() + 7 * 24 * h);
    case "cron": return CronExpressionParser.parse(s.cron!, { currentDate: from }).next().toDate();
  }
}

export function isValidCron(expr: string): boolean {
  try { CronExpressionParser.parse(expr); return true; } catch { return false; }
}

/** Exponential failure backoff: 15 min * 2^(n-1), capped at 24 h. */
export function failureBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(15 * 60_000 * 2 ** (consecutiveFailures - 1), 24 * 3600_000);
}
