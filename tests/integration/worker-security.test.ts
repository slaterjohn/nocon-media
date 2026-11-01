// Regression tests for the security review: artwork fetch (M4), sidecar-derived URLs (M5), root deletion (M6).
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as s from "./helpers/deps.js";
import { eq, StorageService } from "./helpers/deps.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { createVolume, createMedia, removeVolume, type TestVolume } from "./helpers/factories.js";
import { ensureDownload, upsertMedia } from "../../packages/database/src/index.js";
import { createLogger, loadConfig, type ResolvedConfig } from "../../packages/shared/src/index.js";
import { createAdapterFactory, type WorkerContext } from "../../apps/worker/src/context.js";
import { processDownload } from "../../apps/worker/src/download.js";
import { saveArtwork } from "../../apps/worker/src/sync.js";
import { runReconcile, deriveFromCanonicalKey } from "../../apps/worker/src/reconcile.js";
import { Redis } from "../../apps/worker/src/testing.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_YTDLP = path.resolve(HERE, "../fixtures/fake-yt-dlp.mjs");
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379";
const GiB = 1024 ** 3;

let t: TestDb;
let volume: TestVolume;
let config: ResolvedConfig;
let ctx: WorkerContext;
let storage: StorageService;
let fetchImpl: (u: URL | string, init?: RequestInit) => Promise<Response>;
let calls: string[] = [];
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

beforeEach(async () => {
  t = await createTestDb();
  volume = await createVolume(t.db, { isDefault: true });
  config = loadConfig({
    DATABASE_URL: t.url, REDIS_URL, YTDLP_PATH: FAKE_YTDLP, LOG_LEVEL: "fatal", STORAGE_STATFS_OVERRIDE_BYTES: String(2 * GiB), NOCON_YTDLP_NO_JS_RUNTIME: "1",
  } as NodeJS.ProcessEnv);
  storage = new StorageService({ db: t.db, config: { softThresholdPct: 85, minFreePct: 5, statfsOverrideBytes: 2 * GiB, cooldownDays: 30 } });
  calls = [];
  fetchImpl = async () => new Response(null, { status: 404 });
  ctx = {
    db: t.db, redis, config, storage, log: createLogger("test", "fatal"),
    adapterFor: createAdapterFactory(config),
    isOnline: () => true, isPaused: () => false,
    enqueueDownload: async () => undefined, enqueueSync: async () => undefined, enqueueDiscovery: async () => undefined,
    fetch: (async (u: URL | string, init?: RequestInit) => { calls.push(String(u)); return fetchImpl(u, init); }) as typeof fetch,
    signal: new AbortController().signal, progressIntervalMs: 100,
  };
});
afterEach(async () => { await removeVolume(volume); await t.drop(); });
afterAll(() => { redis.disconnect(); });

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const img = (extra: ResponseInit = {}) => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" }, ...extra });

describe("M4: artwork fetch", () => {
  const url = "https://yt3.ggpht.com/a.jpg";
  const save = () => saveArtwork(ctx, url, volume.path, "art/avatar.jpg");

  it("saves an image/* response", async () => {
    fetchImpl = async () => img();
    expect(await save()).toBe(true);
    expect(await exists(path.join(volume.path, "art/avatar.jpg"))).toBe(true);
  });

  it("requests redirect: manual and follows an allow-listed hop", async () => {
    let init: RequestInit | undefined;
    fetchImpl = async (u, i) => {
      init = i;
      return String(u).includes("ggpht.com") ? new Response(null, { status: 302, headers: { location: "https://lh3.googleusercontent.com/b.jpg" } }) : img();
    };
    expect(await save()).toBe(true);
    expect(init?.redirect).toBe("manual");
    expect(calls).toEqual([url, "https://lh3.googleusercontent.com/b.jpg"]);
  });

  it("refuses a redirect to a host outside the allowlist, and to http", async () => {
    fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
    expect(await save()).toBe(false);
    expect(calls).toEqual([url]);
    calls = [];
    fetchImpl = async () => new Response(null, { status: 302, headers: { location: "http://i.ytimg.com/x.jpg" } });
    expect(await save()).toBe(false);
    expect(calls).toEqual([url]);
  });

  it("gives up after 3 redirect hops", async () => {
    fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://i.ytimg.com/loop.jpg" } });
    expect(await save()).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it("requires an image content type", async () => {
    fetchImpl = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(await save()).toBe(false);
    expect(await exists(path.join(volume.path, "art/avatar.jpg"))).toBe(false);
  });

  it("aborts a body over 5 MiB without buffering it all, even with no content-length", async () => {
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { produced += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); if (produced > 200 * 1024 * 1024) c.close(); },
    });
    fetchImpl = async () => new Response(body, { status: 200, headers: { "content-type": "image/png" } });
    expect(await save()).toBe(false);
    expect(produced).toBeLessThan(20 * 1024 * 1024);
    expect(await exists(path.join(volume.path, "art/avatar.jpg"))).toBe(false);
  });
});

describe("M5: sidecar-derived URLs", () => {
  it("derives the URL from a youtube canonical key only", () => {
    expect(deriveFromCanonicalKey("youtube:aaaaaaaaaaa")).toEqual({ platform: "youtube", externalId: "aaaaaaaaaaa", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" });
    for (const bad of ["vimeo:aaaaaaaaaaa", "youtube:short", "youtube:aaaaaaaaaaa/../x", "youtube:", "x", "youtube:aaaaaaaaaaaa"]) expect(deriveFromCanonicalKey(bad)).toBeNull();
  });

  async function plant(relDir: string, canonicalKey: string, originalUrl: string) {
    const dir = path.join(volume.path, relDir);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "media.mp4"), "video");
    await fsp.writeFile(path.join(dir, "metadata.json"), JSON.stringify({
      version: 1, canonicalKey, originalUrl, title: "Planted", description: "", creator: { id: "", name: "x" }, publishedAt: null,
      durationSeconds: 5, categories: [], tags: [], downloadedAt: new Date().toISOString(), technical: {}, artwork: { thumbnail: null },
      subtitles: [], chapters: [], mainFile: "media.mp4", checksums: { sha256: "ab" },
    }));
  }

  it("reconcile ignores sidecar originalUrl and skips unknown platforms / invalid ids", async () => {
    await plant("youtube/videos/aaaaaaaaaaa", "youtube:aaaaaaaaaaa", "https://evil.example/payload");
    await plant("evil/videos/x", "vimeo:12345", "https://evil.example/other");
    await plant("youtube/videos/bad", "youtube:not-valid-id-at-all", "https://www.youtube.com/watch?v=aaaaaaaaaaa");
    const report = await runReconcile(ctx, { dryRun: false });
    const rows = await t.db.select().from(s.media);
    expect(rows.map((r) => r.canonicalKey)).toEqual(["youtube:aaaaaaaaaaa"]);
    expect(rows[0]).toMatchObject({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", platform: "youtube", externalId: "aaaaaaaaaaa" });
    expect(report.issues.filter((i) => /unsupported or invalid canonical key/.test(i))).toHaveLength(2);
  });

  it("the download path refuses a non-canonical / non-YouTube media url", async () => {
    const { media } = await upsertMedia(t.db, { canonicalKey: "youtube:aaaaaaaaaaa", platform: "youtube", externalId: "aaaaaaaaaaa", url: "https://evil.example/watch?v=aaaaaaaaaaa", title: "t" });
    const { download } = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "manual" });
    const outcome = await processDownload(ctx, { downloadId: download!.id });
    expect(outcome).not.toBe("ready");
    const [dl] = await t.db.select().from(s.downloads).where(eq(s.downloads.id, download!.id));
    expect(dl!.state).not.toBe("ready");
    expect(String(dl!.error)).toMatch(/Refusing to download/);
  });
});

describe("M6: root deletion", () => {
  it("manualEvict refuses to delete a volume root or a single top-level folder, and fails the record", async () => {
    const keep = path.join(volume.path, "precious.txt");
    await fsp.writeFile(keep, "data");
    for (const dir of [".", "", "media", "./"]) {
      const m = await createMedia(t.db, { volume, sizeBytes: 10 });
      await t.db.update(s.media).set({ mediaDir: dir }).where(eq(s.media.id, m.id));
      const r = await storage.manualEvict(m.id);
      expect(r?.status).toBe("failed");
      expect(await exists(keep)).toBe(true);
      expect(await exists(volume.path)).toBe(true);
    }
    const recs = await t.db.select().from(s.evictionRecords);
    expect(recs.every((x) => x.status === "failed")).toBe(true);
  });

  it("still evicts a normal media directory", async () => {
    const m = await createMedia(t.db, { volume, sizeBytes: 10 });
    await t.db.update(s.media).set({ mediaDir: "youtube/videos/zzzzzzzzzzz" }).where(eq(s.media.id, m.id));
    await fsp.mkdir(path.join(volume.path, "youtube/videos/zzzzzzzzzzz"), { recursive: true });
    await fsp.writeFile(path.join(volume.path, "youtube/videos/zzzzzzzzzzz/media.mp4"), "x");
    expect((await storage.manualEvict(m.id))?.status).toBe("completed");
    expect(await exists(path.join(volume.path, "youtube/videos/zzzzzzzzzzz"))).toBe(false);
    expect(await exists(volume.path)).toBe(true);
  });
});
