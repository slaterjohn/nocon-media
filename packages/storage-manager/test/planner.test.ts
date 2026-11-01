import { describe, it, expect } from "vitest";
import {
  retainedBySource, rollingExcess, isEligible, compareCandidates, limitBytes, availableBytes, requiredBytes,
  buildPlan, buildSoftThresholdPlan, MiB, type Candidate, type RetentionItem,
} from "../src/planner.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const item = (id: string, ageDays: number, size = 10, watched = false): RetentionItem =>
  ({ mediaId: id, publishedAt: day(ageDays), downloadedAt: day(ageDays), sizeBytes: size, watched });

const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  mediaId: id, sizeBytes: 100, priority: "P3", retentionProtected: false, pinned: false, favourite: false,
  lastWatchedAt: null, watchCount: 0, downloadedAt: day(10), recommendationScore: null, streaming: false, processing: false,
  sourceIds: [], ...o,
});

describe("retainedBySource", () => {
  const items = [item("a", 1), item("b", 5), item("c", 20), item("d", 40)];
  it("all retains everything", () => expect([...retainedBySource({ mode: "all" }, items, NOW)].sort()).toEqual(["a", "b", "c", "d"]));
  it("none retains nothing", () => expect(retainedBySource({ mode: "none" }, items, NOW).size).toBe(0));
  it("latest_n keeps newest N", () => expect([...retainedBySource({ mode: "latest_n", count: 2 }, items, NOW)].sort()).toEqual(["a", "b"]));
  it("last_days keeps items within window", () => expect([...retainedBySource({ mode: "last_days", days: 30 }, items, NOW)].sort()).toEqual(["a", "b", "c"]));
  it("quota keeps newest while cumulative size fits", () => {
    const sized = [item("a", 1, 40), item("b", 2, 40), item("c", 3, 40)];
    expect([...retainedBySource({ mode: "quota", quotaBytes: 100 }, sized, NOW)].sort()).toEqual(["a", "b"]);
  });
  it("quota stops at the first item that does not fit", () => {
    const sized = [item("a", 1, 60), item("b", 2, 60), item("c", 3, 5)];
    expect([...retainedBySource({ mode: "quota", quotaBytes: 100 }, sized, NOW)]).toEqual(["a"]);
  });
  it("rolling retains like latest_n", () => expect([...retainedBySource({ mode: "rolling", count: 1 }, items, NOW)]).toEqual(["a"]));
  it("prefer_unwatched retains only unwatched", () => {
    const mixed = [item("a", 1, 10, true), item("b", 2, 10, false)];
    expect([...retainedBySource({ mode: "prefer_unwatched" }, mixed, NOW)]).toEqual(["b"]);
  });
  it("falls back to downloadedAt without publish date", () => {
    const x: RetentionItem = { mediaId: "x", publishedAt: null, downloadedAt: day(1), sizeBytes: 1, watched: false };
    expect(retainedBySource({ mode: "last_days", days: 5 }, [x], NOW).has("x")).toBe(true);
  });
});

describe("rollingExcess", () => {
  const items = [item("a", 1), item("b", 5), item("c", 20)];
  it("returns items beyond the newest N", () => expect(rollingExcess({ mode: "rolling", count: 1 }, items)).toEqual(["b", "c"]));
  it("is empty for non-rolling modes", () => expect(rollingExcess({ mode: "latest_n", count: 1 }, items)).toEqual([]));
});

describe("isEligible", () => {
  it("allows a plain P3 for P3", () => expect(isEligible(cand("a"), "P3", true)).toBe(true));
  it("never evicts P0 or pinned", () => {
    expect(isEligible(cand("a", { priority: "P0" }), "P0", true)).toBe(false);
    expect(isEligible(cand("a", { pinned: true }), "P1", true)).toBe(false);
  });
  it("never evicts retention-protected", () => expect(isEligible(cand("a", { retentionProtected: true }), "P1", true)).toBe(false));
  it("never evicts streaming or processing", () => {
    expect(isEligible(cand("a", { streaming: true }), "P1", true)).toBe(false);
    expect(isEligible(cand("a", { processing: true }), "P1", true)).toBe(false);
  });
  it("only same-or-lower priority", () => {
    expect(isEligible(cand("a", { priority: "P1" }), "P1", true)).toBe(true);
    expect(isEligible(cand("a", { priority: "P2" }), "P1", true)).toBe(true);
    expect(isEligible(cand("a", { priority: "P1" }), "P2", true)).toBe(false);
    expect(isEligible(cand("a", { priority: "P2" }), "P3", true)).toBe(false);
  });
  it("nothing eligible when autoEvict is off", () => expect(isEligible(cand("a"), "P1", false)).toBe(false));
});

describe("compareCandidates ordering", () => {
  const order = (...cs: Candidate[]) => cs.sort(compareCandidates).map((c) => c.mediaId);
  it("lower priority first", () => expect(order(cand("p1", { priority: "P1" }), cand("p3", { priority: "P3" }), cand("p2", { priority: "P2" }))).toEqual(["p3", "p2", "p1"]));
  it("non-favourites before favourites", () => expect(order(cand("fav", { favourite: true }), cand("plain"))).toEqual(["plain", "fav"]));
  it("never/oldest watched first", () => expect(order(cand("recent", { lastWatchedAt: day(1) }), cand("old", { lastWatchedAt: day(50) }), cand("never"))).toEqual(["never", "old", "recent"]));
  it("lower watch count first", () => expect(order(cand("many", { watchCount: 5 }), cand("few", { watchCount: 1 }))).toEqual(["few", "many"]));
  it("older download first", () => expect(order(cand("new", { downloadedAt: day(1) }), cand("old", { downloadedAt: day(30) }))).toEqual(["old", "new"]));
  it("lower recommendation score first", () => expect(order(cand("hi", { recommendationScore: 0.9 }), cand("lo", { recommendationScore: 0.1 }))).toEqual(["lo", "hi"]));
  it("larger files first", () => expect(order(cand("small", { sizeBytes: 1 }), cand("big", { sizeBytes: 999 }))).toEqual(["big", "small"]));
  it("media id breaks ties", () => expect(order(cand("b"), cand("a"))).toEqual(["a", "b"]));
  it("earlier keys dominate later ones", () =>
    expect(order(cand("big-watched", { sizeBytes: 999, lastWatchedAt: day(1) }), cand("small-never", { sizeBytes: 1 }))).toEqual(["small-never", "big-watched"]));
});

describe("capacity maths", () => {
  it("P3 uses the soft threshold, others use 100 - minFree", () => {
    expect(limitBytes(1000, "P3", 85, 5)).toBe(850);
    expect(limitBytes(1000, "P2", 85, 5)).toBe(950);
    expect(limitBytes(1000, "P0", 85, 5)).toBe(950);
  });
  it("available subtracts used and reserved", () =>
    expect(availableBytes({ totalBytes: 1000, freeBytes: 400, reservedBytes: 50, priority: "P1", softThresholdPct: 85, minFreePct: 5 })).toBe(950 - 600 - 50));
  it("required adds 10% and 64 MiB", () => expect(Math.abs(requiredBytes(100 * MiB) - (110 * MiB + 64 * MiB))).toBeLessThanOrEqual(1));
});

describe("buildPlan", () => {
  const base = { incomingPriority: "P1" as const, autoEvict: true };
  it("is sufficient without eviction when space is available", () => {
    const p = buildPlan({ ...base, requiredBytes: 100, availableBytes: 500, candidates: [cand("a")] });
    expect(p).toMatchObject({ sufficient: true, needsEviction: false, selected: [], toReclaim: 0 });
  });
  it("selects in order until the shortfall is covered", () => {
    const p = buildPlan({ ...base, requiredBytes: 250, availableBytes: 0, candidates: [cand("c"), cand("a"), cand("b"), cand("d")] });
    expect(p.selected.map((c) => c.mediaId)).toEqual(["a", "b", "c"]);
    expect(p).toMatchObject({ sufficient: true, needsEviction: true, toReclaim: 250, reclaimedBytes: 300, resultingAvailable: 300, eligibleTotal: 400 });
  });
  it("is insufficient and selects nothing when eligible total is too small", () => {
    const p = buildPlan({ ...base, requiredBytes: 1000, availableBytes: 0, candidates: [cand("a"), cand("b")] });
    expect(p).toMatchObject({ sufficient: false, selected: [], reclaimedBytes: 0, eligibleTotal: 200 });
  });
  it("does not count ineligible items towards sufficiency", () => {
    const p = buildPlan({ ...base, requiredBytes: 150, availableBytes: 0, candidates: [cand("a"), cand("b", { retentionProtected: true }), cand("c", { pinned: true })] });
    expect(p.sufficient).toBe(false);
    expect(p.eligibleTotal).toBe(100);
  });
  it("autoEvict false means nothing is evicted", () => {
    const p = buildPlan({ ...base, autoEvict: false, requiredBytes: 50, availableBytes: 0, candidates: [cand("a")] });
    expect(p).toMatchObject({ sufficient: false, selected: [] });
  });
  it("P3 incoming cannot reclaim P1 media, P1 incoming can reclaim P3 media", () => {
    const cs = [cand("p1", { priority: "P1" }), cand("p3", { priority: "P3" })];
    expect(buildPlan({ incomingPriority: "P3", autoEvict: true, requiredBytes: 150, availableBytes: 0, candidates: cs }).sufficient).toBe(false);
    expect(buildPlan({ incomingPriority: "P1", autoEvict: true, requiredBytes: 150, availableBytes: 0, candidates: cs }).selected.map((c) => c.mediaId)).toEqual(["p3", "p1"]);
  });
  it("P3 has less capacity than P1 for the same disk", () => {
    const common = { totalBytes: 1000, freeBytes: 200, reservedBytes: 0, softThresholdPct: 85, minFreePct: 5 };
    expect(availableBytes({ ...common, priority: "P3" })).toBe(50);
    expect(availableBytes({ ...common, priority: "P1" })).toBe(150);
  });
});

describe("buildSoftThresholdPlan", () => {
  it("reclaims P3 down to the threshold only", () => {
    const p = buildSoftThresholdPlan({
      totalBytes: 1000, freeBytes: 100, reservedBytes: 0, softThresholdPct: 85,
      candidates: [cand("a"), cand("b"), cand("c"), cand("p2", { priority: "P2" })],
    });
    // used 900, limit 850 -> reclaim 50 -> one item
    expect(p.selected.map((c) => c.mediaId)).toEqual(["a"]);
    expect(p.sufficient).toBe(true);
  });
  it("does nothing under the threshold", () => {
    const p = buildSoftThresholdPlan({ totalBytes: 1000, freeBytes: 500, reservedBytes: 0, softThresholdPct: 85, candidates: [cand("a")] });
    expect(p).toMatchObject({ needsEviction: false, selected: [] });
  });
  it("best effort when P3 cannot cover the excess", () => {
    const p = buildSoftThresholdPlan({ totalBytes: 1000, freeBytes: 0, reservedBytes: 0, softThresholdPct: 85, candidates: [cand("a")] });
    expect(p.sufficient).toBe(false);
    expect(p.selected).toHaveLength(1);
  });
});
