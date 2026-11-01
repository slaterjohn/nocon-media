/**
 * Deterministic, local recommendation scoring. No AI, no network.
 *
 * Component weights (sum 1.0):
 *   topic 0.35, channel 0.20, history 0.15, recency 0.10, duration 0.10, library 0.10
 */
export const WEIGHTS = { topic: 0.35, channel: 0.2, history: 0.15, recency: 0.1, duration: 0.1, library: 0.1 } as const;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "were", "you", "your", "our", "his", "her",
  "its", "but", "not", "all", "any", "can", "has", "have", "had", "how", "what", "why", "who", "when", "into",
  "about", "than", "then", "they", "them", "their", "will", "just", "out", "new", "get", "one",
]);

export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

export interface HistoryItem {
  title: string; tags: string[]; categories: string[]; channelId?: string | null; durationSeconds?: number | null; weight: number;
}
export interface Profile {
  termWeights: Map<string, number>;
  channelAffinity: Map<string, number>;
  durationMedian: number;
  totalWeight: number;
}

export function buildProfile(items: HistoryItem[]): Profile {
  const termWeights = new Map<string, number>();
  const channelRaw = new Map<string, number>();
  const durations: number[] = [];
  let totalWeight = 0;
  for (const it of items) {
    const w = it.weight;
    if (!(w > 0)) continue;
    totalWeight += w;
    const terms = new Set([...tokenize(it.title), ...it.tags.flatMap(tokenize), ...it.categories.flatMap(tokenize)]);
    for (const t of terms) termWeights.set(t, (termWeights.get(t) ?? 0) + w);
    if (it.channelId) channelRaw.set(it.channelId, (channelRaw.get(it.channelId) ?? 0) + w);
    if (it.durationSeconds && it.durationSeconds > 0) durations.push(it.durationSeconds);
  }
  const maxChannel = Math.max(0, ...channelRaw.values());
  const channelAffinity = new Map<string, number>();
  for (const [k, v] of channelRaw) channelAffinity.set(k, maxChannel > 0 ? v / maxChannel : 0);
  durations.sort((a, b) => a - b);
  let durationMedian = 0;
  if (durations.length) {
    const m = durations.length >> 1;
    durationMedian = durations.length % 2 ? durations[m]! : (durations[m - 1]! + durations[m]!) / 2;
  }
  return { termWeights, channelAffinity, durationMedian, totalWeight };
}

export interface Candidate {
  id: string; title: string; description?: string; tags: string[]; categories: string[];
  channelId?: string; durationSeconds?: number; publishedAt?: Date;
}
export interface ScoreOptions {
  now: Date; preferredMaxDuration?: number; seed?: { title: string; tags: string[] };
}
export interface ScoreComponents { topic: number; channel: number; history: number; recency: number; duration: number; library: number }
export interface ScoreResult { score: number; components: ScoreComponents; explanation: string[] }

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function scoreCandidate(c: Candidate, profile: Profile, opts: ScoreOptions): ScoreResult {
  const maxTerm = Math.max(0, ...profile.termWeights.values());
  const norm = (t: string): number => (maxTerm > 0 ? (profile.termWeights.get(t) ?? 0) / maxTerm : 0);
  const explanation: string[] = [];

  // topic: overlap of the candidate's tags/categories with profile terms (3 strong matches saturate).
  const metaTerms = [...new Set([...c.tags.flatMap(tokenize), ...c.categories.flatMap(tokenize)])];
  const matched = metaTerms.filter((t) => norm(t) > 0).sort((a, b) => norm(b) - norm(a) || a.localeCompare(b));
  const topic = clamp01(matched.reduce((s, t) => s + norm(t), 0) / 3);
  if (matched.length) explanation.push(`Shares tags: ${matched.slice(0, 3).join(", ")}`);

  // history: cosine similarity between title/description/meta terms and the whole profile.
  const candTerms = [...new Set([...tokenize(c.title), ...tokenize(c.description ?? ""), ...metaTerms])];
  let dot = 0;
  for (const t of candTerms) dot += norm(t);
  let profNorm = 0;
  for (const v of profile.termWeights.values()) profNorm += (v / maxTerm) ** 2;
  const history = candTerms.length && profNorm > 0 ? clamp01(dot / Math.sqrt(candTerms.length * profNorm)) : 0;
  const titleHits = tokenize(c.title).filter((t) => norm(t) > 0).slice(0, 3);
  if (titleHits.length) explanation.push(`Similar to what you watched: ${titleHits.join(", ")}`);

  // channel
  const channel = c.channelId ? clamp01(profile.channelAffinity.get(c.channelId) ?? 0) : 0;
  if (channel > 0) explanation.push(`Channel you watch often: ${c.channelId}`);

  // recency: exp(-ageDays/180); unknown date is neutral.
  let recency = 0.5;
  if (c.publishedAt) {
    const ageDays = Math.max(0, (opts.now.getTime() - c.publishedAt.getTime()) / 86_400_000);
    recency = Math.exp(-ageDays / 180);
    if (recency >= 0.7) explanation.push("Recently published");
  }

  // duration
  let duration = 1;
  const d = c.durationSeconds;
  if (d === undefined || d <= 0) duration = 0.5;
  else if (opts.preferredMaxDuration !== undefined && d > opts.preferredMaxDuration) duration = 0;
  else if (profile.durationMedian > 0) {
    const lo = profile.durationMedian * 0.5, hi = profile.durationMedian * 2;
    duration = d < lo ? d / lo : d > hi ? hi / d : 1;
    if (duration === 1) explanation.push("Typical length for you");
  }

  // library: similarity to the seed item that led to this candidate.
  let library = 0;
  if (opts.seed) {
    const seedTags = new Set(opts.seed.tags.flatMap(tokenize));
    const seedAll = new Set([...tokenize(opts.seed.title), ...seedTags]);
    const candAll = new Set([...tokenize(c.title), ...metaTerms]);
    const inter = [...candAll].filter((t) => seedAll.has(t));
    const union = new Set([...candAll, ...seedAll]).size;
    library = union ? clamp01((2 * inter.length) / (union + inter.length) * 1.5) : 0;
    const shared = metaTerms.filter((t) => seedTags.has(t));
    if (shared.length) explanation.push(`Related to a video in your library: ${shared.slice(0, 3).join(", ")}`);
    else if (inter.length) explanation.push(`Related to a video in your library: ${inter.slice(0, 3).join(", ")}`);
  }

  const components: ScoreComponents = { topic, channel, history, recency, duration, library };
  const score = clamp01(
    WEIGHTS.topic * topic + WEIGHTS.channel * channel + WEIGHTS.history * history +
    WEIGHTS.recency * recency + WEIGHTS.duration * duration + WEIGHTS.library * library,
  );
  return { score, components, explanation };
}

export interface Scored<C extends Candidate = Candidate> { candidate: C; score: number }
export interface Budget { maxItems: number; maxBytes: number; minScore: number; maxDurationSec: number; maxAgeDays: number }
export type RejectReason = "below-min-score" | "too-long" | "too-old" | "max-items" | "max-bytes";

export function selectWithinBudget<C extends Candidate>(
  scored: Scored<C>[], budget: Budget, estimateBytes: (c: C) => number, now: Date = new Date(),
): { accepted: Scored<C>[]; rejected: { item: Scored<C>; reason: RejectReason }[] } {
  const sorted = [...scored].sort((a, b) => b.score - a.score || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
  const accepted: Scored<C>[] = [];
  const rejected: { item: Scored<C>; reason: RejectReason }[] = [];
  let bytes = 0;
  for (const item of sorted) {
    const c = item.candidate;
    let reason: RejectReason | null = null;
    if (item.score < budget.minScore) reason = "below-min-score";
    else if (c.durationSeconds !== undefined && c.durationSeconds > budget.maxDurationSec) reason = "too-long";
    else if (c.publishedAt && (now.getTime() - c.publishedAt.getTime()) / 86_400_000 > budget.maxAgeDays) reason = "too-old";
    else if (accepted.length >= budget.maxItems) reason = "max-items";
    else if (bytes + estimateBytes(c) > budget.maxBytes) reason = "max-bytes";
    if (reason) rejected.push({ item, reason });
    else { accepted.push(item); bytes += estimateBytes(c); }
  }
  return { accepted, rejected };
}

/** Depth of items discovered from a seed at `seedDepth`. Never exceeds maxDepth or the hard cap of 2. */
export function nextDepth(seedDepth: number, maxDepth: number): number | null {
  const next = seedDepth + 1;
  return next <= Math.min(maxDepth, 2) ? next : null;
}

export function buildSearchQueries(seed: { title: string; tags: string[] }, max = 2): string[] {
  const out: string[] = [];
  const add = (terms: string[]): void => {
    const q = terms.join(" ");
    if (q && !out.includes(q)) out.push(q);
  };
  add(tokenize(seed.title).slice(0, 4));
  add(seed.tags.flatMap(tokenize).slice(0, 3));
  const mix = [...tokenize(seed.title).slice(0, 2), ...seed.tags.flatMap(tokenize).slice(0, 2)];
  add([...new Set(mix)]);
  return out.slice(0, Math.max(0, max));
}
