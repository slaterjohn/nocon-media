import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import {
  computeEffectivePriority, canTransition, resolveInside, PathSafetyError, cidrContains, isPrivateAddress,
  assertPublicHttpUrl, redactUrl, retentionSchema, nextRunAt, failureBackoffMs, loadConfig, safeSegment,
} from "../src/index.js";

describe("priority", () => {
  it("pinned is always P0", () => expect(computeEffectivePriority({ pinned: true, sourcePriorities: ["P3"], watched: false, approved: false })).toBe("P0"));
  it("highest source wins", () => expect(computeEffectivePriority({ pinned: false, sourcePriorities: ["P3", "P1"], watched: false, approved: false })).toBe("P1"));
  it("watched lifts P3 to P2", () => expect(computeEffectivePriority({ pinned: false, sourcePriorities: ["P3"], watched: true, approved: false })).toBe("P2"));
  it("defaults to P3", () => expect(computeEffectivePriority({ pinned: false, sourcePriorities: [], watched: false, approved: false })).toBe("P3"));
  it("manual priority counts", () => expect(computeEffectivePriority({ pinned: false, manualPriority: "P1", sourcePriorities: ["P3"], watched: false, approved: false })).toBe("P1"));
});

describe("download state machine", () => {
  it("allows the happy path", () => {
    const path: any[] = ["queued", "checking", "downloading", "processing", "verifying", "ready", "evicted", "queued"];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });
  it("rejects skipping verification", () => expect(canTransition("downloading", "ready")).toBe(false));
  it("rejects ready -> downloading", () => expect(canTransition("ready", "downloading")).toBe(false));
});

describe("path safety", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-"));
  it("resolves inside", () => expect(resolveInside(root, "a/b.mp4")).toBe(path.join(root, "a/b.mp4")));
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "a\0b", "..", "C:/x", "..\\x"])
    it(`rejects ${JSON.stringify(bad)}`, () => expect(() => resolveInside(root, bad)).toThrow(PathSafetyError));
  it("rejects symlink escape", () => {
    fs.symlinkSync("/etc", path.join(root, "link"));
    expect(() => resolveInside(root, "link/hosts")).toThrow(PathSafetyError);
  });
  it("safeSegment strips separators", () => expect(safeSegment("../a/b")).toBe("__a_b"));
});

describe("network guards", () => {
  it("cidr v4", () => { expect(cidrContains("192.168.0.0/16", "192.168.4.2")).toBe(true); expect(cidrContains("10.0.0.0/8", "11.0.0.1")).toBe(false); });
  it("cidr v4-mapped v6", () => expect(cidrContains("127.0.0.0/8", "::ffff:127.0.0.1")).toBe(true));
  it("cidr v6", () => { expect(cidrContains("fc00::/7", "fd12::1")).toBe(true); expect(cidrContains("fc00::/7", "2001:db8::1")).toBe(false); });
  it("private detection", () => { expect(isPrivateAddress("169.254.169.254")).toBe(true); expect(isPrivateAddress("8.8.8.8")).toBe(false); });
  it("blocks internal URLs", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://localhost:5432")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://evil.test/", (async () => [{ address: "10.0.0.5", family: 4 }]) as any)).rejects.toThrow();
    await expect(assertPublicHttpUrl("https://example.org/", (async () => [{ address: "93.184.215.14", family: 4 }]) as any)).resolves.toBeInstanceOf(URL);
  });
});

describe("redaction", () => {
  it("redacts xtream paths and query creds", () => {
    expect(redactUrl("/movie/bob/s3cret/12.mp4")).toBe("/movie/***/***/12.mp4");
    expect(redactUrl("/player_api.php?username=bob&password=s3cret&action=x")).toBe("/player_api.php?username=***&password=***&action=x");
  });
});

describe("policies", () => {
  it("latest_n requires count", () => expect(retentionSchema.safeParse({ mode: "latest_n" }).success).toBe(false));
  it("all is valid", () => expect(retentionSchema.parse({ mode: "all" })).toEqual({ mode: "all" }));
});

describe("schedule", () => {
  const t = new Date("2026-01-01T00:00:00Z");
  it("daily", () => expect(nextRunAt({ kind: "daily" }, t, true)!.toISOString()).toBe("2026-01-02T00:00:00.000Z"));
  it("cron", () => expect(nextRunAt({ kind: "cron", cron: "0 3 * * *" }, t, true)!.getUTCHours()).toBeTypeOf("number"));
  it("manual", () => expect(nextRunAt({ kind: "manual" }, t, false)).toBeNull());
  it("once", () => expect(nextRunAt({ kind: "once" }, t, true)).toBeNull());
  it("backoff caps", () => { expect(failureBackoffMs(1)).toBe(900_000); expect(failureBackoffMs(20)).toBe(86_400_000); });
});

describe("config", () => {
  it("applies profile defaults", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" } as any);
    expect(c.concurrency.downloads).toBe(1);
    const s = loadConfig({ DATABASE_URL: "x", REDIS_URL: "y", DEPLOYMENT_PROFILE: "standard", MAX_CONCURRENT_DOWNLOADS: "5" } as any);
    expect(s.concurrency.downloads).toBe(5); expect(s.concurrency.processing).toBe(2);
  });
  it("fails without DATABASE_URL", () => expect(() => loadConfig({ REDIS_URL: "x" } as any)).toThrow(/DATABASE_URL/));
});

describe("path safety: root and missing targets (M6, L8)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-outside-"));
  for (const rel of [".", "./", "a/..", "a/b/../.."])
    it(`rejects resolving to the root itself: ${JSON.stringify(rel)}`, () => expect(() => resolveInside(root, rel)).toThrow(PathSafetyError));
  it("allows the root with allowRoot", () => expect(resolveInside(root, ".", { allowRoot: true })).toBe(path.resolve(root)));
  it("rejects a symlink to the root itself", () => {
    fs.symlinkSync(root, path.join(root, "self"));
    expect(() => resolveInside(root, "self")).toThrow(PathSafetyError);
  });
  it("rejects a non-existent target below a symlink that escapes the root", () => {
    fs.symlinkSync(outside, path.join(root, "esc"));
    expect(() => resolveInside(root, "esc/new/deep/file.mp4")).toThrow(PathSafetyError);
  });
  it("accepts a non-existent target below a real directory", () => {
    fs.mkdirSync(path.join(root, "real"));
    expect(resolveInside(root, "real/new/file.mp4")).toBe(path.join(root, "real/new/file.mp4"));
  });
});

describe("config: proxy settings", () => {
  const base = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };
  it("defaults to no secret and no trusted CIDRs", () => {
    const c = loadConfig(base as never);
    expect(c.NOCON_PROXY_SECRET).toBeUndefined();
    expect(c.TRUSTED_PROXY_CIDRS).toEqual([]);
  });
  it("parses NOCON_PROXY_SECRET and TRUSTED_PROXY_CIDRS", () => {
    const c = loadConfig({ ...base, NOCON_PROXY_SECRET: "abc", TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 172.16.0.0/12" } as never);
    expect(c.NOCON_PROXY_SECRET).toBe("abc");
    expect(c.TRUSTED_PROXY_CIDRS).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(loadConfig({ ...base, NOCON_PROXY_SECRET: "" } as never).NOCON_PROXY_SECRET).toBeUndefined();
  });
});
