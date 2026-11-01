import { describe, it, expect } from "vitest";
import { tokenize, buildProfile, scoreCandidate, selectWithinBudget, nextDepth, buildSearchQueries, type Candidate, type Scored } from "../src/index.js";

const now = new Date("2026-06-01T00:00:00Z");
const profile = buildProfile([
  { title: "Rust compilers explained", tags: ["rust", "compilers"], categories: ["Education"], channelId: "ch1", durationSeconds: 600, weight: 3 },
  { title: "Learning Rust async", tags: ["rust", "async"], categories: ["Education"], channelId: "ch1", durationSeconds: 900, weight: 1 },
  { title: "Cooking pasta", tags: ["food"], categories: ["Food"], channelId: "ch2", durationSeconds: 300, weight: 1 },
]);
const base: Candidate = { id: "a", title: "Unrelated thing", tags: [], categories: [] };
const sc = (c: Partial<Candidate>, o = {}) => scoreCandidate({ ...base, ...c }, profile, { now, ...o });

describe("tokenize", () => {
  it("lowercases, drops stopwords/short, dedupes, unicode", () => {
    expect(tokenize("The Rust and RUST of Café 42 an")).toEqual(["rust", "café"]);
    expect(tokenize("Über-cool 日本語")).toEqual(["über", "cool", "日本語"]);
  });
});

describe("buildProfile", () => {
  it("weights, affinity, median", () => {
    expect(profile.termWeights.get("rust")).toBe(4);
    expect(profile.channelAffinity.get("ch1")).toBe(1);
    expect(profile.channelAffinity.get("ch2")).toBeCloseTo(0.25);
    expect(profile.durationMedian).toBe(600);
    expect(profile.totalWeight).toBe(5);
  });
});

describe("scoreCandidate", () => {
  it("is deterministic", () => {
    const c = { tags: ["rust"], channelId: "ch1", durationSeconds: 600, publishedAt: new Date("2026-05-01") };
    expect(sc(c)).toEqual(sc(c));
  });
  it("topic + explanation", () => {
    const r = sc({ tags: ["rust", "compilers"] });
    expect(r.components.topic).toBeGreaterThan(0.5);
    expect(r.explanation.some((e) => e.startsWith("Shares tags: rust"))).toBe(true);
    expect(sc({}).components.topic).toBe(0);
  });
  it("history", () => {
    expect(sc({ title: "Rust compilers deep dive" }).components.history).toBeGreaterThan(0);
    expect(sc({}).components.history).toBe(0);
  });
  it("channel", () => {
    expect(sc({ channelId: "ch1" }).components.channel).toBe(1);
    expect(sc({ channelId: "zzz" }).components.channel).toBe(0);
    expect(sc({ channelId: "ch1" }).explanation.join()).toContain("Channel you watch often: ch1");
  });
  it("recency", () => {
    expect(sc({ publishedAt: now }).components.recency).toBeCloseTo(1);
    expect(sc({ publishedAt: new Date(now.getTime() - 180 * 86400000) }).components.recency).toBeCloseTo(Math.exp(-1));
  });
  it("duration", () => {
    expect(sc({ durationSeconds: 600 }).components.duration).toBe(1);
    expect(sc({ durationSeconds: 300 }).components.duration).toBe(1);
    expect(sc({ durationSeconds: 150 }).components.duration).toBeCloseTo(0.5);
    expect(sc({ durationSeconds: 2400 }).components.duration).toBeCloseTo(0.5);
    expect(sc({ durationSeconds: 2400 }, { preferredMaxDuration: 1800 }).components.duration).toBe(0);
  });
  it("library via seed", () => {
    const seed = { title: "Rust compilers explained", tags: ["rust"] };
    const r = sc({ title: "More Rust internals", tags: ["rust"] }, { seed });
    expect(r.components.library).toBeGreaterThan(0);
    expect(sc({}, { seed }).components.library).toBe(0);
    expect(sc({}).components.library).toBe(0);
  });
  it("score within 0..1 and higher for better match", () => {
    const good = sc({ title: "Rust compilers", tags: ["rust", "compilers"], channelId: "ch1", durationSeconds: 600, publishedAt: now });
    expect(good.score).toBeLessThanOrEqual(1);
    expect(good.score).toBeGreaterThan(sc({}).score);
  });
});

describe("selectWithinBudget", () => {
  const mk = (id: string, score: number, extra: Partial<Candidate> = {}): Scored => ({ candidate: { ...base, id, ...extra }, score });
  const budget = { maxItems: 2, maxBytes: 100, minScore: 0.2, maxDurationSec: 1000, maxAgeDays: 100 };
  it("orders, applies limits, reports reasons", () => {
    const items = [
      mk("b", 0.5), mk("a", 0.5), mk("low", 0.1), mk("long", 0.9, { durationSeconds: 5000 }),
      mk("old", 0.9, { publishedAt: new Date("2020-01-01") }), mk("c", 0.4), mk("big", 0.45),
    ];
    const r = selectWithinBudget(items, budget, (c) => (c.id === "big" ? 500 : 40), now);
    expect(r.accepted.map((x) => x.candidate.id)).toEqual(["a", "b"]);
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.item.candidate.id, x.reason]));
    expect(reasons).toMatchObject({ low: "below-min-score", long: "too-long", old: "too-old", c: "max-items", big: "max-items" });
  });
  it("max-bytes", () => {
    const r = selectWithinBudget([mk("a", 0.9), mk("b", 0.8)], { ...budget, maxItems: 5 }, () => 60, now);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]!.reason).toBe("max-bytes");
  });
  it("deterministic regardless of input order", () => {
    const items = [mk("x", 0.5), mk("y", 0.5), mk("z", 0.6)];
    const a = selectWithinBudget(items, { ...budget, maxItems: 9 }, () => 1, now).accepted.map((i) => i.candidate.id);
    const b = selectWithinBudget([...items].reverse(), { ...budget, maxItems: 9 }, () => 1, now).accepted.map((i) => i.candidate.id);
    expect(a).toEqual(["z", "x", "y"]);
    expect(b).toEqual(a);
  });
});

describe("nextDepth", () => {
  it("caps", () => {
    expect(nextDepth(0, 1)).toBe(1);
    expect(nextDepth(1, 1)).toBeNull();
    expect(nextDepth(1, 5)).toBe(2);
    expect(nextDepth(2, 5)).toBeNull();
  });
});

describe("buildSearchQueries", () => {
  it("short queries", () => {
    const q = buildSearchQueries({ title: "Rust compilers explained in depth for beginners", tags: ["rust", "compilers", "llvm"] });
    expect(q).toHaveLength(2);
    expect(q[0]).toBe("rust compilers explained depth");
    expect(q[1]).toBe("rust compilers llvm");
    expect(buildSearchQueries({ title: "x", tags: [] })).toEqual([]);
    expect(buildSearchQueries({ title: "Rust", tags: [] }, 3)).toEqual(["rust"]);
  });
});
