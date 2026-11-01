/**
 * Pure storage planning. No IO, no clock (callers pass `now`), fully deterministic.
 * Rules are specified in docs/storage-management.md.
 */
import { priorityRank, type Priority, type RetentionPolicy } from "@nocon/shared";

export const MiB = 1024 * 1024;
export const PROCESSING_OVERHEAD_BYTES = 64 * MiB;
export const ESTIMATE_MARGIN = 1.1;
const DAY_MS = 86_400_000;

// ---------- Retention ----------

export interface RetentionItem {
  mediaId: string;
  publishedAt: Date | null;
  downloadedAt: Date | null;
  sizeBytes: number;
  watched: boolean;
}

/** Newest first; publish date, falling back to download date; media id as tie-breaker. */
function newestFirst(items: RetentionItem[]): RetentionItem[] {
  const t = (i: RetentionItem) => (i.publishedAt ?? i.downloadedAt)?.getTime() ?? 0;
  return [...items].sort((a, b) => t(b) - t(a) || (a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0));
}

/** The media ids one source retains under its policy. */
export function retainedBySource(policy: RetentionPolicy, items: RetentionItem[], now: Date): Set<string> {
  switch (policy.mode) {
    case "all":
      return new Set(items.map((i) => i.mediaId));
    case "none":
      return new Set();
    case "latest_n":
    case "rolling":
      return new Set(newestFirst(items).slice(0, policy.count ?? 0).map((i) => i.mediaId));
    case "last_days": {
      const cutoff = now.getTime() - (policy.days ?? 0) * DAY_MS;
      return new Set(items.filter((i) => ((i.publishedAt ?? i.downloadedAt)?.getTime() ?? 0) >= cutoff).map((i) => i.mediaId));
    }
    case "quota": {
      const kept = new Set<string>();
      let total = 0;
      for (const i of newestFirst(items)) {
        total += i.sizeBytes;
        if (total > (policy.quotaBytes ?? 0)) break;
        kept.add(i.mediaId);
      }
      return kept;
    }
    case "prefer_unwatched":
      return new Set(items.filter((i) => !i.watched).map((i) => i.mediaId));
  }
}

/** Items a `rolling` source should actively evict (everything beyond the newest N). Empty for other modes. */
export function rollingExcess(policy: RetentionPolicy, items: RetentionItem[]): string[] {
  if (policy.mode !== "rolling") return [];
  const keep = retainedBySource(policy, items, new Date());
  return newestFirst(items).filter((i) => !keep.has(i.mediaId)).map((i) => i.mediaId);
}

// ---------- Candidates ----------

export interface Candidate {
  mediaId: string;
  sizeBytes: number;
  priority: Priority;
  retentionProtected: boolean;
  pinned: boolean;
  favourite: boolean;
  lastWatchedAt: Date | null;
  watchCount: number;
  downloadedAt: Date | null;
  recommendationScore: number | null;
  streaming: boolean;
  processing: boolean;
  sourceIds: string[];
}

export function isEligible(c: Candidate, incomingPriority: Priority, autoEvict: boolean): boolean {
  if (!autoEvict) return false;
  if (c.pinned || c.priority === "P0") return false;
  if (c.retentionProtected) return false;
  if (c.streaming || c.processing) return false;
  return priorityRank(c.priority) >= priorityRank(incomingPriority);
}

const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Null sorts first (never watched / unknown age / no score). */
const cmpNullFirst = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : cmp(a, b));

/**
 * Eviction order. Retention eligibility (doc key 2) is implied: protected items never pass isEligible.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    cmp(priorityRank(b.priority), priorityRank(a.priority)) || // P3 before P2 before P1
    cmp(Number(a.favourite), Number(b.favourite)) ||
    cmpNullFirst(a.lastWatchedAt?.getTime() ?? null, b.lastWatchedAt?.getTime() ?? null) ||
    cmp(a.watchCount, b.watchCount) ||
    cmpNullFirst(a.downloadedAt?.getTime() ?? null, b.downloadedAt?.getTime() ?? null) ||
    cmpNullFirst(a.recommendationScore, b.recommendationScore) ||
    cmp(b.sizeBytes, a.sizeBytes) || // largest first
    cmpStr(a.mediaId, b.mediaId)
  );
}

// ---------- Capacity ----------

export function limitBytes(totalBytes: number, priority: Priority, softThresholdPct: number, minFreePct: number): number {
  const pct = priority === "P3" ? softThresholdPct : 100 - minFreePct;
  return Math.floor((totalBytes * pct) / 100);
}

export interface AvailabilityInput {
  totalBytes: number;
  freeBytes: number;
  reservedBytes: number;
  priority: Priority;
  softThresholdPct: number;
  minFreePct: number;
}

export function availableBytes(i: AvailabilityInput): number {
  const used = i.totalBytes - i.freeBytes;
  return limitBytes(i.totalBytes, i.priority, i.softThresholdPct, i.minFreePct) - used - i.reservedBytes;
}

export function requiredBytes(estimate: number): number {
  return Math.ceil(estimate * ESTIMATE_MARGIN) + PROCESSING_OVERHEAD_BYTES;
}

// ---------- Plans ----------

export interface Plan {
  sufficient: boolean;
  needsEviction: boolean;
  toReclaim: number;
  selected: Candidate[];
  reclaimedBytes: number;
  resultingAvailable: number;
  eligibleTotal: number;
}

export interface PlanInput {
  incomingPriority: Priority;
  autoEvict: boolean;
  requiredBytes: number;
  availableBytes: number;
  candidates: Candidate[];
}

/** Never partially destructive: if eligible items cannot cover the shortfall, nothing is selected. */
export function buildPlan(i: PlanInput): Plan {
  const eligible = i.candidates.filter((c) => isEligible(c, i.incomingPriority, i.autoEvict)).sort(compareCandidates);
  const eligibleTotal = eligible.reduce((n, c) => n + c.sizeBytes, 0);
  const toReclaim = Math.max(0, i.requiredBytes - i.availableBytes);
  if (toReclaim === 0) {
    return { sufficient: true, needsEviction: false, toReclaim, selected: [], reclaimedBytes: 0, resultingAvailable: i.availableBytes, eligibleTotal };
  }
  if (eligibleTotal < toReclaim) {
    return { sufficient: false, needsEviction: true, toReclaim, selected: [], reclaimedBytes: 0, resultingAvailable: i.availableBytes, eligibleTotal };
  }
  const selected: Candidate[] = [];
  let reclaimed = 0;
  for (const c of eligible) {
    if (reclaimed >= toReclaim) break;
    selected.push(c);
    reclaimed += c.sizeBytes;
  }
  return { sufficient: true, needsEviction: true, toReclaim, selected, reclaimedBytes: reclaimed, resultingAvailable: i.availableBytes + reclaimed, eligibleTotal };
}

export interface SoftThresholdInput {
  totalBytes: number;
  freeBytes: number;
  reservedBytes: number;
  softThresholdPct: number;
  candidates: Candidate[];
}

/** Reclaim P3 media (best effort, same ordering) until usage is back under the soft threshold. */
export function buildSoftThresholdPlan(i: SoftThresholdInput): Plan {
  const used = i.totalBytes - i.freeBytes + i.reservedBytes;
  const limit = limitBytes(i.totalBytes, "P3", i.softThresholdPct, 0);
  const toReclaim = Math.max(0, used - limit);
  const eligible = i.candidates.filter((c) => c.priority === "P3" && isEligible(c, "P3", true)).sort(compareCandidates);
  const eligibleTotal = eligible.reduce((n, c) => n + c.sizeBytes, 0);
  const selected: Candidate[] = [];
  let reclaimed = 0;
  if (toReclaim > 0) {
    for (const c of eligible) {
      if (reclaimed >= toReclaim) break;
      selected.push(c);
      reclaimed += c.sizeBytes;
    }
  }
  return {
    sufficient: reclaimed >= toReclaim,
    needsEviction: toReclaim > 0,
    toReclaim,
    selected,
    reclaimedBytes: reclaimed,
    resultingAvailable: limit - used + reclaimed,
    eligibleTotal,
  };
}
