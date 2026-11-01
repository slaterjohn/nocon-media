import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as s from "./helpers/deps.js";
import { eq, and } from "./helpers/deps.js";
import { StorageService } from "./helpers/deps.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { createVolume, removeVolume, type TestVolume } from "./helpers/factories.js";
import { ensureDownload, setSetting, transitionDownload, upsertMedia } from "../../packages/database/src/index.js";
import { createLogger, loadConfig, type ResolvedConfig } from "../../packages/shared/src/index.js";
import { createAdapterFactory, stagingDirFor, type WorkerContext } from "../../apps/worker/src/context.js";
import { processDownload } from "../../apps/worker/src/download.js";
import { runSync } from "../../apps/worker/src/sync.js";
import { runDiscovery } from "../../apps/worker/src/discovery.js";
import { runReconcile } from "../../apps/worker/src/reconcile.js";
import { recoverOnBoot } from "../../apps/worker/src/recovery.js";
import { ConnectivityMonitor } from "../../apps/worker/src/connectivity.js";
import { schedulerTick } from "../../apps/worker/src/scheduler.js";
import { startWorker } from "../../apps/worker/src/runtime.js";
import { Redis } from "../../apps/worker/src/testing.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_YTDLP = path.resolve(HERE, "../fixtures/fake-yt-dlp.mjs");
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379";
const CHAN = "UCfakechannel0000000000a";
const CHAN_URL = `https://www.youtube.com/channel/${CHAN}`;
const GiB = 1024 ** 3;

let t: TestDb;
let volume: TestVolume;
let config: ResolvedConfig;
let ctx: WorkerContext;
let online = true;
let paused = false;
let enqueued: string[] = [];
let syncs: string[] = [];
let fetched: string[] = [];
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const extraDirs: string[] = [];

const stubFetch = (async (input: string | URL | Request) => {
  fetched.push(String(input instanceof Request ? input.url : input));
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
}) as typeof fetch;

function makeConfig(url: string, extra: Record<string, string> = {}): ResolvedConfig {
  return loadConfig({
    DATABASE_URL: url, REDIS_URL, YTDLP_PATH: FAKE_YTDLP, LOG_LEVEL: "fatal", STORAGE_STATFS_OVERRIDE_BYTES: String(2 * GiB),
    NOCON_YTDLP_NO_JS_RUNTIME: "1", ...extra,
  } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  t = await createTestDb();
  volume = await createVolume(t.db, { isDefault: true });
  config = makeConfig(t.url);
  online = true;
  paused = false;
  enqueued = [];
  syncs = [];
  fetched = [];
  const storage = new StorageService({
    db: t.db, config: { softThresholdPct: 85, minFreePct: 5, statfsOverrideBytes: 2 * GiB, cooldownDays: 30 },
  });
  ctx = {
    db: t.db, redis, config, storage, log: createLogger("test", "fatal"),
    adapterFor: createAdapterFactory(config),
    isOnline: () => online, isPaused: () => paused,
    enqueueDownload: async (id) => { enqueued.push(id); },
    enqueueSync: async (id) => { syncs.push(id); },
    enqueueDiscovery: async () => undefined,
    fetch: stubFetch, signal: new AbortController().signal, progressIntervalMs: 100,
  };
});

afterEach(async () => {
  delete process.env.FAKE_YTDLP_FAIL;
  delete process.env.FAKE_YTDLP_OFFLINE;
  delete process.env.FAKE_YTDLP_CATALOG;
  await removeVolume(volume);
  await t.drop();
});

afterAll(async () => {
  await Promise.all(extraDirs.map((d) => fsp.rm(d, { recursive: true, force: true })));
  redis.disconnect();
});

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

async function createChannelSource(over: Partial<typeof s.sources.$inferInsert> = {}) {
  const [src] = await t.db.insert(s.sources).values({ name: "Fake Channel", type: "channel", url: CHAN_URL, priority: "P1", ...over }).returning();
  return src!;
}

/** Media + queued download for one fake video, bypassing sync. */
async function queueVideo(id: string) {
  const { media } = await upsertMedia(t.db, {
    canonicalKey: `youtube:${id}`, platform: "youtube", externalId: id, url: `https://www.youtube.com/watch?v=${id}`, title: id,
  });
  const { download } = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "manual" });
  return { media, download: download! };
}

const getDownload = async (id: string) => (await t.db.select().from(s.downloads).where(eq(s.downloads.id, id)))[0]!;
const getMediaRow = async (id: string) => (await t.db.select().from(s.media).where(eq(s.media.id, id)))[0]!;

/** sync a channel, then run every queued download to completion */
async function syncAndDownloadAll() {
  const src = await createChannelSource();
  await runSync(ctx, { sourceId: src.id, trigger: "manual" });
  const dls = await t.db.select().from(s.downloads);
  for (const d of dls) expect(await processDownload(ctx, { downloadId: d.id })).toBe("ready");
  return { src, dls };
}

describe("sync + download pipeline", () => {
  it("syncs a channel, queues downloads, downloads them into the library and releases reservations", async () => {
    const src = await createChannelSource();
    const res = await runSync(ctx, { sourceId: src.id, trigger: "manual" });
    expect(res).toMatchObject({ status: "success", discovered: 3, new: 3, queued: 3 });

    const queued = await t.db.select().from(s.downloads);
    expect(queued).toHaveLength(3);
    expect(queued.every((d) => d.state === "queued" && d.priority === "P1" && d.requestedBy === "source")).toBe(true);
    expect(queued[0]!.options.resolution).toBe(1080);
    expect(enqueued).toHaveLength(3);

    const [after] = await t.db.select().from(s.sources).where(eq(s.sources.id, src.id));
    expect(after).toMatchObject({ hasRun: true, consecutiveFailures: 0, needsAttention: false });
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect((after!.metadata as { title?: string }).title).toBe("Fake Channel");
    // artwork came only from the allow-listed host and was stored on the volume
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => new URL(u).hostname.endsWith("googleusercontent.com"))).toBe(true);
    const [creator] = await t.db.select().from(s.creators).where(eq(s.creators.externalId, CHAN));
    expect(creator).toMatchObject({ avatarPath: `youtube/channels/${CHAN}/_channel/avatar.jpg`, artworkVolumeId: volume.id });
    expect(await exists(path.join(volume.path, creator!.avatarPath!))).toBe(true);

    // a second sync finds nothing new and does not duplicate downloads
    const again = await runSync(ctx, { sourceId: src.id, trigger: "schedule" });
    expect(again).toMatchObject({ status: "success", new: 0, queued: 0 });
    expect(await t.db.select().from(s.downloads)).toHaveLength(3);

    const target = queued.find((d) => d.mediaId)!;
    expect(await processDownload(ctx, { downloadId: target.id })).toBe("ready");

    const dl = await getDownload(target.id);
    expect(dl).toMatchObject({ state: "ready", progress: 1, attempts: 1 });
    const m = await getMediaRow(target.mediaId);
    expect(m.availability).toBe("available");
    expect(m.volumeId).toBe(volume.id);
    expect(m.mediaDir).toMatch(new RegExp(`^youtube/channels/${CHAN}/fakevid000\\d$`));
    expect(m.sizeBytes).toBeGreaterThan(0);
    expect(m.downloadedAt).not.toBeNull();
    expect(m.tags).toContain("fake");

    const dir = path.join(volume.path, m.mediaDir!);
    for (const f of ["media.mp4", "metadata.json", "media.jpg", "media.info.json", "media.en.vtt"]) expect(await exists(path.join(dir, f))).toBe(true);
    const sidecar = JSON.parse(await fsp.readFile(path.join(dir, "metadata.json"), "utf8"));
    expect(sidecar.canonicalKey).toBe(m.canonicalKey);
    expect(sidecar.checksums.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sidecar)).not.toMatch(/watch(ed)?(History|Count)/i);

    const files = await t.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, m.id));
    expect(files.map((f) => f.kind).sort()).toEqual(["info", "sidecar", "subtitle", "thumbnail", "video"]);
    const video = files.find((f) => f.kind === "video")!;
    expect(video).toMatchObject({ container: "mp4", videoCodec: "h264", audioCodec: "aac", volumeId: volume.id });
    expect(video.checksumSha256).toBe(sidecar.checksums.sha256);
    expect(files.find((f) => f.kind === "subtitle")!.language).toBe("en");

    expect(await t.db.select().from(s.chapters).where(eq(s.chapters.mediaId, m.id))).toHaveLength(2);
    const [res1] = await t.db.select().from(s.storageReservations).where(eq(s.storageReservations.downloadId, dl.id));
    expect(res1!.releasedAt).not.toBeNull();
    expect(await exists(stagingDirFor(volume.path, dl.id))).toBe(false);

    const events = (await t.db.select().from(s.downloadEvents).where(eq(s.downloadEvents.downloadId, dl.id))).map((e) => e.toState);
    expect(events).toEqual(["queued", "checking", "downloading", "processing", "verifying", "ready"]);
    const types = (await t.db.select().from(s.activityEvents)).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["source.sync.started", "source.sync.completed", "download.completed"]));
    const [run] = await t.db.select().from(s.sourceRuns).where(and(eq(s.sourceRuns.sourceId, src.id), eq(s.sourceRuns.trigger, "manual")));
    expect(run).toMatchObject({ status: "success", newCount: 3, queuedCount: 3 });
  });

  it("applies source filters and the maxNewPerRun cap", async () => {
    const src = await createChannelSource({ filters: { minDurationSec: 4, maxNewPerRun: 1, includeShorts: false, includeLive: false, requiredKeywords: [], excludedKeywords: [] } });
    const res = await runSync(ctx, { sourceId: src.id, trigger: "manual" });
    // fake durations are 3, 4 and 5 seconds: the first is too short, one of the remaining two is queued
    expect(res).toMatchObject({ discovered: 3, skipped: 1, queued: 1 });
    expect(await t.db.select().from(s.downloads)).toHaveLength(1);
  });

  it("marks videos unavailable when yt-dlp reports them gone", async () => {
    const { media, download } = await queueVideo("fakevid0001");
    process.env.FAKE_YTDLP_FAIL = "fakevid0001";
    expect(await processDownload(ctx, { downloadId: download.id })).toBe("unavailable");
    expect(await getDownload(download.id)).toMatchObject({ state: "unavailable", errorClass: "unavailable" });
    expect(await getMediaRow(media.id)).toMatchObject({ availability: "unavailable" });
    const res = await t.db.select().from(s.storageReservations);
    expect(res.every((r) => r.releasedAt !== null)).toBe(true);
  });

  it("backs off on network errors instead of failing", async () => {
    const { download } = await queueVideo("fakevid0002");
    process.env.FAKE_YTDLP_OFFLINE = "1";
    expect(await processDownload(ctx, { downloadId: download.id })).toBe("retry");
    const d = await getDownload(download.id);
    expect(d.state).toBe("queued");
    expect(d.errorClass).toBe("network");
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // not due yet: a second call does nothing
    expect(await processDownload(ctx, { downloadId: download.id })).toBe("deferred");
  });

  it("leaves downloads queued while offline or paused and records skipped sync runs", async () => {
    const { download } = await queueVideo("fakevid0003");
    online = false;
    expect(await processDownload(ctx, { downloadId: download.id })).toBe("deferred");
    online = true;
    paused = true;
    expect(await processDownload(ctx, { downloadId: download.id })).toBe("deferred");
    expect(await getDownload(download.id)).toMatchObject({ state: "queued", attempts: 0 });

    const src = await createChannelSource();
    online = false;
    expect(await runSync(ctx, { sourceId: src.id, trigger: "schedule" })).toMatchObject({ status: "skipped_offline" });
    const [run] = await t.db.select().from(s.sourceRuns).where(eq(s.sourceRuns.sourceId, src.id));
    expect(run!.status).toBe("skipped_offline");
    expect(await t.db.select().from(s.downloads)).toHaveLength(1);
  });

  it("fails a queued download that was cancelled before it started", async () => {
    const { download } = await queueVideo("fakevid0001");
    await t.db.update(s.downloads).set({ cancelRequested: true }).where(eq(s.downloads.id, download.id));
    expect(await processDownload(ctx, { downloadId: download.id })).toBe("cancelled");
    expect(await getDownload(download.id)).toMatchObject({ state: "failed", error: "Cancelled" });
  });

  it("raises a notification after three consecutive sync failures", async () => {
    process.env.FAKE_YTDLP_OFFLINE = "1";
    const src = await createChannelSource();
    for (let i = 0; i < 3; i++) {
      await runSync(ctx, { sourceId: src.id, trigger: "manual" });
      await t.db.update(s.sourceRuns).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }); // keep the overlap guard out of the way
    }
    const [row] = await t.db.select().from(s.sources).where(eq(s.sources.id, src.id));
    expect(row).toMatchObject({ consecutiveFailures: 3, needsAttention: true });
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const notes = await t.db.select().from(s.notifications).where(eq(s.notifications.key, `source:failing:${src.id}`));
    expect(notes).toHaveLength(1);
  });
});

describe("recovery", () => {
  it("returns interrupted downloads to queued, releases reservations and removes their staging dirs", async () => {
    const { download } = await queueVideo("fakevid0001");
    await transitionDownload(t.db, download.id, "checking");
    await transitionDownload(t.db, download.id, "downloading", { volumeId: volume.id });
    await t.db.insert(s.storageReservations).values({ volumeId: volume.id, downloadId: download.id, bytes: 1000 });
    const staging = stagingDirFor(volume.path, download.id);
    await fsp.mkdir(staging, { recursive: true });
    await fsp.writeFile(path.join(staging, "media.mp4.part"), "partial");
    // an old orphan staging dir goes too; a fresh one stays
    const oldDir = path.join(volume.path, ".noconmedia", "tmp", randomUUID());
    const freshDir = path.join(volume.path, ".noconmedia", "tmp", randomUUID());
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.mkdir(freshDir, { recursive: true });
    const old = new Date(Date.now() - 25 * 3600_000);
    await fsp.utimes(oldDir, old, old);
    // a sync run that was in flight is closed out
    const src = await createChannelSource();
    await t.db.insert(s.sourceRuns).values({ sourceId: src.id });

    const r = await recoverOnBoot(ctx);
    expect(r.recovered).toBe(1);
    expect(await getDownload(download.id)).toMatchObject({ state: "queued", tempPath: null });
    const [resv] = await t.db.select().from(s.storageReservations).where(eq(s.storageReservations.downloadId, download.id));
    expect(resv!.releasedAt).not.toBeNull();
    expect(await exists(staging)).toBe(false);
    expect(await exists(oldDir)).toBe(false);
    expect(await exists(freshDir)).toBe(true);
    const ev = await t.db.select().from(s.downloadEvents).where(and(eq(s.downloadEvents.downloadId, download.id), eq(s.downloadEvents.toState, "queued")));
    expect(ev.map((e) => e.reason)).toContain("recovered_after_restart");
    const [run] = await t.db.select().from(s.sourceRuns).where(eq(s.sourceRuns.sourceId, src.id));
    expect(run!.status).toBe("failed");
  });
});

describe("reconcile", () => {
  it("rebuilds rows from sidecars, imports unknown items and reports (never deletes) missing files", async () => {
    const { dls } = await syncAndDownloadAll();
    const [a, b, c] = await Promise.all(dls.map((d) => getMediaRow(d.mediaId)));

    await t.db.delete(s.mediaFiles).where(eq(s.mediaFiles.mediaId, a!.id)); // A: files rows lost
    await t.db.delete(s.media).where(eq(s.media.id, b!.id)); // B: whole catalogue row lost
    await fsp.rm(path.join(volume.path, c!.mediaDir!, "media.mp4")); // C: file gone from disk
    await fsp.mkdir(path.join(volume.path, "youtube", "videos", "orphan"), { recursive: true });
    await fsp.writeFile(path.join(volume.path, "youtube", "videos", "orphan", "media.mp4"), "x");

    const dry = await runReconcile(ctx, { dryRun: true });
    expect(dry.found).toBe(3);
    expect(dry.rebuilt).toBe(0);
    expect(dry.missingFiles.map((x) => x.mediaId)).toEqual([c!.id]);
    expect(dry.orphans.map((o) => o.relDir)).toEqual(["youtube/videos/orphan"]);
    expect(await t.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, a!.id))).toHaveLength(0);
    expect((await getMediaRow(c!.id)).unavailableReason).toBeNull();

    const real = await runReconcile(ctx, { dryRun: false });
    expect(real).toMatchObject({ found: 3, rebuilt: 2, duplicates: [] });
    expect(real.missingFiles).toHaveLength(1);
    expect((await t.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, a!.id))).map((f) => f.kind)).toContain("video");

    const [imported] = await t.db.select().from(s.media).where(eq(s.media.canonicalKey, b!.canonicalKey));
    expect(imported).toMatchObject({ availability: "available", manualPriority: "P1", retainOverride: true, volumeId: volume.id, mediaDir: b!.mediaDir });
    expect((await t.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, imported!.id))).map((f) => f.kind)).toContain("video");

    const missing = await getMediaRow(c!.id);
    expect(missing).toMatchObject({ availability: "available", unavailableReason: "file_missing" });
    expect(await exists(path.join(volume.path, "youtube", "videos", "orphan", "media.mp4"))).toBe(true); // orphans are only reported

    const manifests = await fsp.readdir(path.join(volume.path, ".noconmedia", "manifests"));
    expect(manifests).toHaveLength(1);
    const manifest = JSON.parse(await fsp.readFile(path.join(volume.path, ".noconmedia", "manifests", manifests[0]!), "utf8"));
    expect(manifest.items).toHaveLength(3);
    expect(manifest.items[0]).toEqual(expect.objectContaining({ canonicalKey: expect.any(String), relDir: expect.any(String), sha256: expect.any(String) }));
  });
});

describe("discovery", () => {
  const A = CHAN;
  const B = "UCfakeotherchannel000000";
  async function writeCatalog() {
    const video = (n: number, ch: string) => ({
      id: `fakevid000${n}`, title: `Fake video ${n}`, description: `About fake video ${n}`, duration: 120, upload_date: `2026102${n}`,
      channel_id: ch, channel: ch === A ? "Fake Channel" : "Other Channel", uploader: ch === A ? "Fake Channel" : "Other Channel",
      live_status: "not_live", view_count: 10 * n, categories: [], tags: [], language: "en",
    });
    const videos = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`fakevid000${n}`, video(n, n <= 4 ? A : B)]));
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nocon-catalog-"));
    extraDirs.push(dir);
    const file = path.join(dir, "catalog.json");
    await fsp.writeFile(file, JSON.stringify({ channels: { [A]: { title: "Fake Channel", entries: ["fakevid0001", "fakevid0002", "fakevid0003", "fakevid0004"] } }, playlists: {}, videos }));
    process.env.FAKE_YTDLP_CATALOG = file;
  }
  /** Two library items, downloaded just now at P1, act as seeds. */
  async function seedLibrary() {
    for (const n of [1, 2]) {
      const { media } = await upsertMedia(t.db, {
        canonicalKey: `youtube:fakevid000${n}`, platform: "youtube", externalId: `fakevid000${n}`, url: `https://www.youtube.com/watch?v=fakevid000${n}`,
        title: `Fake video ${n}`, channelId: A, channelName: "Fake Channel", durationSeconds: 120, tags: ["fake"],
      });
      await t.db.update(s.media).set({ availability: "available", effectivePriority: "P1", downloadedAt: new Date(), volumeId: volume.id }).where(eq(s.media.id, media.id));
    }
  }

  it("creates scored recommendations within the item budget (approval mode)", async () => {
    await writeCatalog();
    await seedLibrary();
    await setSetting(t.db, "discovery", { enabled: true, mode: "approval", maxDepth: 1, maxDiscovered: 2, minScore: 0 });
    const r = await runDiscovery(ctx, { trigger: "manual" });
    expect(r).toMatchObject({ status: "completed", seeds: 2, accepted: 2, queued: 0 });

    const recs = await t.db.select().from(s.recommendations);
    expect(recs).toHaveLength(2);
    for (const rec of recs) {
      expect(rec).toMatchObject({ status: "pending", depth: 1 });
      expect(["same_channel", "search"]).toContain(rec.strategy);
      expect(rec.score).toBeGreaterThan(0);
      expect((rec.explanation as { components: object }).components).toHaveProperty("topic");
      const m = await getMediaRow(rec.mediaId);
      expect(m.recommendationScore).toBeCloseTo(rec.score, 5);
      expect(m.effectivePriority).toBe("P3");
      expect(m.availability).toBe("discovered");
      expect(["fakevid0003", "fakevid0004", "fakevid0005", "fakevid0006"]).toContain(m.externalId);
    }
    expect(await t.db.select().from(s.discoveryRelationships)).toHaveLength(2);
    expect(await t.db.select().from(s.downloads)).toHaveLength(0);

    // budget is used up: another run adds nothing and re-recommends nothing
    await runDiscovery(ctx, { trigger: "manual" });
    expect(await t.db.select().from(s.recommendations)).toHaveLength(2);
    const last = await t.db.select().from(s.settings).where(eq(s.settings.key, "discovery.lastRunAt"));
    expect(last).toHaveLength(1);
  });

  it("queues P3 downloads in auto mode, capped by maxDownloaded, and skips rejected items", async () => {
    await writeCatalog();
    await seedLibrary();
    await setSetting(t.db, "discovery", { enabled: true, mode: "auto", maxDepth: 1, maxDownloaded: 1, minScore: 0 });
    const r = await runDiscovery(ctx, { trigger: "manual" });
    expect(r).toMatchObject({ accepted: 1, queued: 1 });
    const [dl] = await t.db.select().from(s.downloads);
    expect(dl).toMatchObject({ priority: "P3", requestedBy: "discovery", state: "queued" });
    expect(enqueued).toEqual([dl!.id]);
    const [rec] = await t.db.select().from(s.recommendations);
    expect(rec!.status).toBe("queued");
  });

  it("does nothing while disabled or offline", async () => {
    await writeCatalog();
    await seedLibrary();
    await setSetting(t.db, "discovery", { enabled: false });
    expect(await runDiscovery(ctx, { trigger: "manual" })).toMatchObject({ status: "skipped", reason: "disabled" });
    await setSetting(t.db, "discovery", { enabled: true });
    online = false;
    expect(await runDiscovery(ctx, { trigger: "manual" })).toMatchObject({ status: "skipped", reason: "offline" });
    expect(await t.db.select().from(s.recommendations)).toHaveLength(0);
  });
});

describe("connectivity and scheduler", () => {
  it("tracks transitions, logs activity and manages the offline notification", async () => {
    let up = false;
    const monitor = new ConnectivityMonitor({
      db: t.db, redis, log: ctx.log, urls: ["https://probe.invalid/"],
      fetch: (async () => { if (!up) throw new Error("ENOTFOUND"); return new Response(null, { status: 404 }); }) as typeof fetch,
    });
    expect(monitor.online).toBe(true); // optimistic until probed
    expect(await monitor.check()).toEqual({ online: false, restored: false });
    expect(monitor.online).toBe(false);
    const open = await t.db.select().from(s.notifications).where(eq(s.notifications.key, "connectivity:offline"));
    expect(open[0]).toMatchObject({ severity: "warning", resolvedAt: null });
    expect(JSON.parse((await redis.get("nocon:connectivity"))!).online).toBe(false);

    up = true; // any HTTP status counts as online
    expect(await monitor.check()).toEqual({ online: true, restored: true });
    const types = (await t.db.select().from(s.activityEvents)).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["connectivity.lost", "connectivity.restored"]));
    const [n] = await t.db.select().from(s.notifications).where(eq(s.notifications.key, "connectivity:offline"));
    expect(n!.resolvedAt).not.toBeNull();
  });

  it("enqueues due sources (max 3), never system or manual-schedule ones, and nothing while offline", async () => {
    const past = new Date(Date.now() - 3600_000);
    const due: { id: string }[] = [];
    for (let i = 0; i < 5; i++) due.push(await createChannelSource({ name: `due ${i}`, nextRunAt: past, hasRun: true }));
    const manual = await createChannelSource({ name: "manual", schedule: { kind: "manual" }, hasRun: false });
    const future = await createChannelSource({ name: "future", nextRunAt: new Date(Date.now() + 3600_000), hasRun: true });
    await setSetting(t.db, "discovery", { enabled: false });

    online = false;
    expect((await schedulerTick(ctx)).synced).toHaveLength(0);
    online = true;
    const r = await schedulerTick(ctx);
    expect(r.synced).toHaveLength(3);
    expect(syncs).toHaveLength(3);
    expect(r.synced.every((id) => due.some((d) => d.id === id))).toBe(true);
    expect(syncs).not.toContain(manual.id);
    expect(syncs).not.toContain(future.id);
  });
});

describe("per-source cookies", () => {
  it("passes --cookies <path> to yt-dlp for sync and download when the source has cookiesFile, and not otherwise", async () => {
    const log = path.join(os.tmpdir(), `nocon-args-${randomUUID()}.log`);
    const cookies = path.join(os.tmpdir(), `nocon-cookies-${randomUUID()}.txt`);
    await fsp.writeFile(cookies, ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tvalue\n", { mode: 0o600 });
    process.env.FAKE_YTDLP_ARGS_LOG = log;
    try {
      const readCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
      const cookieArg = (a: string[]) => a[a.indexOf("--cookies") + 1];

      const plain = await createChannelSource({ name: "plain" });
      await runSync(ctx, { sourceId: plain.id, trigger: "manual" });
      expect(readCalls().length).toBeGreaterThan(0);
      expect(readCalls().some((a) => a.includes("--cookies"))).toBe(false);

      await t.db.update(s.sources).set({ metadata: { cookiesFile: cookies } }).where(eq(s.sources.id, plain.id));
      await fsp.rm(log);
      await runSync(ctx, { sourceId: plain.id, trigger: "manual" });
      const syncCalls = readCalls();
      expect(syncCalls.length).toBeGreaterThan(0);
      for (const a of syncCalls) expect(cookieArg(a)).toBe(cookies);

      await fsp.rm(log);
      const dl = (await t.db.select().from(s.downloads).where(eq(s.downloads.sourceId, plain.id)))[0]!;
      expect(await processDownload(ctx, { downloadId: dl.id })).toBe("ready");
      const dlCalls = readCalls();
      expect(dlCalls.length).toBeGreaterThan(0);
      for (const a of dlCalls) expect(cookieArg(a)).toBe(cookies);
    } finally {
      delete process.env.FAKE_YTDLP_ARGS_LOG;
      await fsp.rm(log, { force: true });
      await fsp.rm(cookies, { force: true });
    }
  });
});

describe("worker runtime through real BullMQ queues", () => {
  it("processes sync and download jobs end to end, publishes a heartbeat and honours worker.paused", async () => {
    const prefix = `nocontest-${randomUUID().slice(0, 8)}`;
    await createChannelSource();
    const cfg = makeConfig(t.url, { WORKER_DISABLE_SCHEDULER: "true", MAX_CONCURRENT_DOWNLOADS: "2", CONNECTIVITY_CHECK_URLS: "https://probe.invalid/" });
    const rt = await startWorker({
      config: cfg, db: t.db, redis, prefix, log: ctx.log, fetch: stubFetch,
      intervals: { dispatcher: 500, pause: 300, heartbeat: 500, progress: 100, volumes: 60_000 },
    });
    try {
      const hb = JSON.parse((await redis.get("nocon:worker:heartbeat"))!);
      expect(hb).toMatchObject({ paused: false, pid: process.pid });
      expect(await redis.ttl("nocon:worker:heartbeat")).toBeGreaterThan(0);

      const [src] = await t.db.select().from(s.sources).where(eq(s.sources.type, "channel"));
      await rt.ctx.enqueueSync(src!.id, "create");
      await waitFor(async () => (await t.db.select().from(s.downloads).where(eq(s.downloads.state, "ready"))).length === 3, 90_000);
      expect(await t.db.select().from(s.media).where(eq(s.media.availability, "available"))).toHaveLength(3);

      // pausing: the next queued download is not started
      await setSetting(t.db, "worker", { paused: true });
      await waitFor(async () => JSON.parse((await redis.get("nocon:worker:heartbeat"))!).paused === true, 10_000);
      const { download } = await queueVideoFresh();
      await rt.ctx.enqueueDownload(download.id);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await getDownload(download.id)).state).toBe("queued");
      await setSetting(t.db, "worker", { paused: false });
      await waitFor(async () => (await getDownload(download.id)).state !== "queued", 30_000);
    } finally {
      await rt.stop();
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
    }
    expect(await redis.get("nocon:worker:heartbeat")).toBeNull();
  });

  it("derives concurrency from settings.app.profile, lets MAX_CONCURRENT_* override it and follows later changes", async () => {
    const prefix = `nocontest-${randomUUID().slice(0, 8)}`;
    await setSetting(t.db, "app", { profile: "standard" });
    // DEPLOYMENT_PROFILE=lightweight is only the default; the stored setting wins.
    const cfg = makeConfig(t.url, { WORKER_DISABLE_SCHEDULER: "true", MAX_CONCURRENT_PROCESSING: "4", CONNECTIVITY_CHECK_URLS: "https://probe.invalid/" });
    expect(cfg.concurrency.downloads).toBe(1);
    const rt = await startWorker({
      config: cfg, db: t.db, redis, prefix, log: ctx.log, fetch: stubFetch,
      intervals: { dispatcher: 60_000, pause: 60_000, heartbeat: 60_000, profile: 200, volumes: 60_000 },
    });
    try {
      // sync=metadata 3, download 3, processing 4 (env override), discovery and maintenance fixed at 1
      expect(rt.workers.map((w) => w.concurrency)).toEqual([3, 3, 4, 1, 1]);
      expect(cfg.DEPLOYMENT_PROFILE).toBe("standard");

      await setSetting(t.db, "app", { profile: "lightweight" });
      await waitFor(async () => rt.workers[1]!.concurrency === 1, 10_000);
      expect(rt.workers.map((w) => w.concurrency)).toEqual([1, 1, 4, 1, 1]);
    } finally {
      await rt.stop();
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
    }
  });

  it("falls back to DEPLOYMENT_PROFILE while settings.app.profile is absent", async () => {
    const prefix = `nocontest-${randomUUID().slice(0, 8)}`;
    const cfg = makeConfig(t.url, { DEPLOYMENT_PROFILE: "standard", WORKER_DISABLE_SCHEDULER: "true", CONNECTIVITY_CHECK_URLS: "https://probe.invalid/" });
    const rt = await startWorker({
      config: cfg, db: t.db, redis, prefix, log: ctx.log, fetch: stubFetch,
      intervals: { dispatcher: 60_000, pause: 60_000, heartbeat: 60_000, profile: 60_000, volumes: 60_000 },
    });
    try {
      expect(rt.workers.map((w) => w.concurrency)).toEqual([3, 3, 2, 1, 1]);
    } finally {
      await rt.stop();
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
    }
  });

  async function queueVideoFresh() {
    const { media } = await upsertMedia(t.db, {
      canonicalKey: "youtube:fakevid0003x", platform: "youtube", externalId: "fakevid0003", url: "https://www.youtube.com/watch?v=fakevid0003", title: "again",
    });
    await t.db.update(s.media).set({ availability: "evicted", redownloadAfter: null }).where(eq(s.media.id, media.id));
    const { download } = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "manual" });
    return { media, download: download! };
  }
});

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`condition not met within ${ms} ms`);
}
