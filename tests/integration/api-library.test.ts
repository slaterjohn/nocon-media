import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startApi, adminClient, type Client, type Harness } from "../../apps/api/test/harness.js";
import { createVolume, createSource, createMedia, createPendingMedia, createDownload, getMedia, removeVolume, type TestVolume } from "./helpers/factories.js";
import * as s from "./helpers/deps.js";

const MiB = 1024 * 1024;
let h: Harness;
let c: Client;
let vol: TestVolume;
const db = () => h.tdb.db;
const CHANNEL = "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv";

beforeAll(async () => {
  h = await startApi({ STORAGE_STATFS_OVERRIDE_BYTES: String(300 * MiB) });
  c = await adminClient(h);
  vol = await createVolume(db(), { isDefault: true });
});
afterAll(async () => {
  await removeVolume(vol);
  await h.close();
});

function multipart(parts: Array<{ name: string; value: string; filename?: string }>) {
  const boundary = "----nocontest" + Math.random().toString(16).slice(2);
  const chunks: string[] = [];
  for (const p of parts) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n${p.filename ? "Content-Type: application/json\r\n" : ""}\r\n${p.value}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return { payload: Buffer.from(chunks.join("")), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("sources", () => {
  let id: string;

  it("identifies URLs and rejects unsupported ones with a clear message", async () => {
    const ok = await c.post("/api/sources/identify", { input: CHANNEL });
    expect(ok.body).toMatchObject({ ok: true, platform: "youtube", type: "channel" });
    const bad = await c.post("/api/sources", { input: "https://example.com/not-youtube" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/YouTube/);
    expect((await c.post("/api/sources/identify", { input: "nonsense" })).status).toBe(400);
  });

  it("creates a source with defaults, rejects duplicates and invalid settings", async () => {
    const r = await c.post("/api/sources", { input: CHANNEL, name: "Test channel" });
    expect(r.status).toBe(200);
    const src = r.body.source;
    id = src.id;
    expect(src).toMatchObject({ name: "Test channel", type: "channel", priority: "P1", status: "active", retention: { mode: "all" }, schedule: { kind: "daily" }, mediaCount: 0, system: false });
    expect(src.nextRunAt).toBeTruthy();
    expect(src.downloadOptions.resolution).toBe(1080);
    expect(src.downloadOptions.subtitles).toEqual({ enabled: true, languages: ["en"], auto: false });
    expect((await c.post("/api/sources", { input: CHANNEL })).status).toBe(409);
    const badRet = await c.post("/api/sources", { input: "https://www.youtube.com/playlist?list=PLabcdefghijklmnop", retention: { mode: "latest_n" } });
    expect(badRet.status).toBe(400);
    expect(badRet.body.error).toBe("bad_request");
    expect(badRet.body.details.length).toBeGreaterThan(0);
    const badCron = await c.post("/api/sources", { input: "https://www.youtube.com/playlist?list=PLabcdefghijklmnop", schedule: { kind: "cron", cron: "not a cron" } });
    expect(badCron.status).toBe(400);
    expect((await c.post("/api/sources", { type: "search" })).status).toBe(400);
    const search = await c.post("/api/sources", { type: "search", query: "lofi beats", schedule: { kind: "manual" } });
    expect(search.body.source).toMatchObject({ type: "search", query: "lofi beats" });
  });

  it("lists, reads and patches; priority change recomputes media and logs activity", async () => {
    const list = await c.get("/api/sources?type=channel");
    expect(list.body.items.some((x: { id: string }) => x.id === id)).toBe(true);
    const m = await createMedia(db(), { volume: vol, sizeBytes: 1024, priority: "P1", sourceIds: [id] });
    expect((await c.get(`/api/sources/${id}`)).body.recentRuns).toEqual([]);
    const bad = await c.patch(`/api/sources/${id}`, { priority: "P9" });
    expect(bad.status).toBe(400);
    const p = await c.patch(`/api/sources/${id}`, { priority: "P0", retention: { mode: "latest_n", count: 5 }, name: "Renamed" });
    expect(p.body.source).toMatchObject({ priority: "P0", name: "Renamed", retention: { mode: "latest_n", count: 5 }, mediaCount: 1 });
    expect((await getMedia(db(), m.id)).effectivePriority).toBe("P0");
    const act = await c.get("/api/activity?type=source.priority_changed,source.retention_changed");
    expect(act.body.items.map((e: { type: string }) => e.type).sort()).toEqual(["source.priority_changed", "source.retention_changed"]);
    expect((await c.get(`/api/sources/${id}/media`)).body.items).toHaveLength(1);
    const paused = await c.post(`/api/sources/${id}/pause`);
    expect(paused.body.source.status).toBe("paused");
    expect((await c.post(`/api/sources/${id}/resume`)).body.source.status).toBe("active");
    expect((await c.post(`/api/sources/${id}/sync`)).body).toEqual({ ok: true });
    const dup = await c.post(`/api/sources/${id}/duplicate`);
    expect(dup.body.source.name).toBe("Renamed (copy)");
  });

  it("requires ?media= on delete and honours keep / delete", async () => {
    const a = await createSource(db(), { priority: "P2" });
    const other = await createSource(db(), { priority: "P3" });
    const only = await createMedia(db(), { volume: vol, sizeBytes: 2048, priority: "P2", sourceIds: [a.id] });
    const shared = await createMedia(db(), { volume: vol, sizeBytes: 2048, priority: "P2", sourceIds: [a.id, other.id] });
    expect((await c.del(`/api/sources/${a.id}`)).status).toBe(400);
    const r = await c.del(`/api/sources/${a.id}?media=delete`);
    expect(r.body).toEqual({ ok: true, retainedMedia: 1, deletedMedia: 1 });
    expect((await getMedia(db(), only.id)).availability).toBe("evicted");
    const sharedRow = await getMedia(db(), shared.id);
    expect(sharedRow.availability).toBe("available");
    expect(sharedRow.effectivePriority).toBe("P3");

    const k = await createSource(db(), { priority: "P1" });
    const kept = await createMedia(db(), { volume: vol, sizeBytes: 2048, priority: "P1", sourceIds: [k.id] });
    const r2 = await c.del(`/api/sources/${k.id}?media=keep`);
    expect(r2.body).toMatchObject({ ok: true, retainedMedia: 1, deletedMedia: 0 });
    const keptRow = await getMedia(db(), kept.id);
    expect(keptRow).toMatchObject({ availability: "available", manualPriority: "P1", retainOverride: true, effectivePriority: "P1" });
    expect((await c.get(`/api/sources/${k.id}`)).status).toBe(404);
  });
});

describe("library, media and progress", () => {
  let a: string, b: string, cc: string;

  beforeAll(async () => {
    const ma = await createMedia(db(), { volume: vol, sizeBytes: 1024, title: "Sourdough baking masterclass", priority: "P3" });
    const mb = await createMedia(db(), { volume: vol, sizeBytes: 1024, title: "Quantum computing explained", priority: "P3" });
    const mc = await createMedia(db(), { volume: vol, sizeBytes: 1024, title: "Gardening in winter", priority: "P3" });
    a = ma.id; b = mb.id; cc = mc.id;
    await db().update(s.media).set({ tags: ["bread", "kitchen"], channelName: "Bakery Channel" }).where(eq(s.media.id, a));
    await db().update(s.media).set({ tags: ["physics"], channelName: "Science Hub", durationSeconds: 600 }).where(eq(s.media.id, b));
    await db().update(s.media).set({ channelName: "Green Thumbs" }).where(eq(s.media.id, cc));
  });

  it("lists playable media with MediaSummary fields", async () => {
    const r = await c.get("/api/library/media?limit=100");
    expect(r.body.total).toBeGreaterThanOrEqual(3);
    const item = r.body.items.find((x: { id: string }) => x.id === a);
    expect(item).toMatchObject({ playable: true, temporarilyUnavailable: false, availability: "available", channelName: "Bakery Channel", progress: null, thumbnailUrl: null });
    expect(typeof item.streamId).toBe("number");
    const p0 = await c.get("/api/library/media?priority=P3,P2");
    expect(p0.body.items.every((x: { effectivePriority: string }) => ["P3", "P2"].includes(x.effectivePriority))).toBe(true);
  });

  it("searches by title, tag, channel and prefix", async () => {
    const ids = async (q: string) => (await c.get(`/api/library/search?q=${encodeURIComponent(q)}`)).body.media.map((m: { id: string }) => m.id);
    expect(await ids("sourdough")).toEqual([a]);
    expect(await ids("physics")).toEqual([b]);
    expect(await ids("Science Hub")).toEqual([b]);
    expect(await ids("quant comp")).toEqual([b]); // prefix on the last term
    expect(await ids("gard")).toEqual([cc]);
    expect(await ids("zz")).toEqual([]);
    const lib = await c.get("/api/library/media?q=bread");
    expect(lib.body.items.map((m: { id: string }) => m.id)).toEqual([a]);
  });

  it("returns media detail with related and next", async () => {
    const r = await c.get(`/api/media/${a}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.media).toMatchObject({ id: a, tags: ["bread", "kitchen"], streamUrl: `/api/media/${a}/stream`, hlsUrl: null, directPlay: true, recommendation: null, evictions: [] });
    expect(r.body.media.files).toHaveLength(1);
    expect(Array.isArray(r.body.related)).toBe(true);
    expect((await c.get("/api/media/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await c.get("/api/media/not-a-uuid")).status).toBe(400);
  });

  it("saves progress and lifts P3 to P2, counting watches per session", async () => {
    expect((await getMedia(db(), b)).effectivePriority).toBe("P3");
    expect((await c.post(`/api/media/${b}/progress`, { positionSeconds: 30, durationSeconds: 600 })).body).toEqual({ ok: true });
    expect((await getMedia(db(), b)).effectivePriority).toBe("P2");
    await c.post(`/api/media/${b}/progress`, { positionSeconds: 60, durationSeconds: 600 });
    const [h1] = await db().select().from(s.playbackHistory).where(eq(s.playbackHistory.mediaId, b));
    expect(h1).toMatchObject({ positionSeconds: 60, watchCount: 1, completed: false });
    const events = await db().select().from(s.watchEvents).where(eq(s.watchEvents.mediaId, b));
    expect(events).toHaveLength(1);
    expect(events[0]!.origin).toBe("local");
    await c.post(`/api/media/${b}/progress`, { positionSeconds: 600, durationSeconds: 600, completed: true });
    const [h2] = await db().select().from(s.playbackHistory).where(eq(s.playbackHistory.mediaId, b));
    expect(h2).toMatchObject({ completed: true, watchCount: 2 });
    const cw = await c.get("/api/library/continue-watching");
    expect(cw.body.items.find((m: { id: string }) => m.id === b)).toBeUndefined(); // completed
    await c.post(`/api/media/${a}/progress`, { positionSeconds: 100, durationSeconds: 600 });
    expect((await c.get("/api/library/continue-watching")).body.items.map((m: { id: string }) => m.id)).toContain(a);
    const hist = await c.get("/api/history");
    expect(hist.body.items.map((i: { media: { id: string } }) => i.media.id)).toContain(a);
    expect((await c.get("/api/library/home")).body.continueWatching.length).toBeGreaterThan(0);
  });

  it("favourites and pins", async () => {
    const f = await c.patch(`/api/media/${cc}`, { favourite: true });
    expect(f.body.media.favourite).toBe(true);
    expect((await c.get("/api/library/favourites")).body.items.map((m: { id: string }) => m.id)).toContain(cc);
    const p = await c.patch(`/api/media/${cc}`, { pinned: true });
    expect(p.body.media).toMatchObject({ pinned: true, effectivePriority: "P0" });
    const un = await c.patch(`/api/media/${cc}`, { pinned: false, manualPriority: "P1" });
    expect(un.body.media).toMatchObject({ pinned: false, effectivePriority: "P1", manualPriority: "P1" });
  });

  it("manages collections", async () => {
    const created = await c.post("/api/collections", { name: "Weekend", kind: "collection" });
    const id = created.body.collection.id;
    expect((await c.post("/api/collections", { name: "" })).status).toBe(400);
    await c.post(`/api/collections/${id}/items`, { mediaId: a });
    await c.post(`/api/collections/${id}/items`, { mediaId: b });
    expect((await c.post(`/api/collections/${id}/items`, { mediaId: b })).status).toBe(409);
    const detail = await c.get(`/api/collections/${id}`);
    expect(detail.body.items.map((m: { id: string }) => m.id)).toEqual([a, b]);
    expect((await c.get(`/api/library/media?collectionId=${id}`)).body.total).toBe(2);
    expect((await c.patch(`/api/collections/${id}`, { name: "Weekend watch" })).body.collection.name).toBe("Weekend watch");
    expect((await c.get("/api/library/search?q=weekend")).body.collections).toHaveLength(1);
    await c.del(`/api/collections/${id}/items/${a}`);
    expect((await c.get(`/api/collections/${id}`)).body.items).toHaveLength(1);
    expect((await c.del(`/api/collections/${id}`)).body).toEqual({ ok: true });
    expect((await c.get(`/api/collections/${id}`)).status).toBe(404);
  });

  it("evicts manually and keeps metadata", async () => {
    const m = await createMedia(db(), { volume: vol, sizeBytes: 1024, title: "To evict" });
    expect((await c.del(`/api/media/${m.id}`)).body.ok).toBe(true);
    const row = await getMedia(db(), m.id);
    expect(row.availability).toBe("evicted");
    const d = (await c.get(`/api/media/${m.id}`)).body.media;
    expect(d.playable).toBe(false);
    expect(d.evictions[0].reason).toBe("manual");
    expect((await c.get("/api/storage/evictions")).body.items[0].media.id).toBe(m.id);
  });
});

describe("storage and downloads", () => {
  it("simulates storage use and policy changes", async () => {
    const sim = await c.post("/api/storage/simulate", { bytes: 10 * MiB, priority: "P1" });
    expect(sim.status).toBe(200);
    expect(sim.body).toMatchObject({ sufficient: true });
    expect(sim.body.requiredBytes).toBeGreaterThan(10 * MiB);
    expect(sim.body).toHaveProperty("availableBytes");
    expect(sim.body).toHaveProperty("candidates");
    const src = await createSource(db(), {});
    const pol = await c.post("/api/storage/simulate", { sourceId: src.id, retention: { mode: "latest_n", count: 2 } });
    expect(pol.body).toHaveProperty("losingProtection");
    expect((await c.post("/api/storage/simulate", { bytes: -1, priority: "P1" })).status).toBe(400);
    const overview = await c.get("/api/storage");
    expect(overview.body.volumes.length).toBeGreaterThan(0);
    expect(overview.body.thresholds).toEqual({ soft: 85, minFree: 5 });
    expect(overview.body.byPriority).toHaveProperty("P0");
  });

  it("verifies and updates volumes", async () => {
    const v = (await c.get("/api/storage")).body.volumes[0];
    expect((await c.post(`/api/storage/volumes/${v.id}/verify`)).body.volume.isOnline).toBe(true);
    expect((await c.patch(`/api/storage/volumes/${v.id}`, { name: "Main", acceptsNew: false })).body.volume).toMatchObject({ name: "Main", acceptsNew: false });
    await c.patch(`/api/storage/volumes/${v.id}`, { acceptsNew: true });
  });

  it("changes download state via retry / pause / resume / cancel", async () => {
    const mediaId = await createPendingMedia(db(), {});
    const dl = await createDownload(db(), { mediaId, state: "queued" });
    const list = await c.get("/api/downloads?state=queued");
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(dl);
    expect(list.body.counts.queued).toBeGreaterThanOrEqual(1);
    expect((await c.post(`/api/downloads/${dl}/pause`)).body.download.state).toBe("paused");
    expect((await c.post(`/api/downloads/${dl}/pause`)).status).toBe(409);
    expect((await c.post(`/api/downloads/${dl}/resume`)).body.download.state).toBe("queued");
    expect((await c.post(`/api/downloads/${dl}/cancel`)).body.download.state).toBe("failed");
    expect((await c.post(`/api/downloads/${dl}/retry`)).body.download.state).toBe("queued");
    const detail = await c.get(`/api/downloads/${dl}`);
    expect(detail.body.events.map((e: { toState: string }) => e.toState)).toEqual(["paused", "queued", "failed", "queued"]);

    const running = await createPendingMedia(db(), {});
    const rdl = await createDownload(db(), { mediaId: running, state: "downloading" });
    await c.post(`/api/downloads/${rdl}/cancel`);
    const [row] = await db().select().from(s.downloads).where(eq(s.downloads.id, rdl));
    expect(row!.cancelRequested).toBe(true);
    expect((await c.post(`/api/downloads/${rdl}/pause`)).status).toBe(409);
  });

  it("queues a manual download for a media id and for a URL", async () => {
    const m = await createPendingMedia(db(), {});
    await db().update(s.media).set({ availability: "discovered" }).where(eq(s.media.id, m));
    const r = await c.post("/api/downloads", { mediaId: m });
    expect(r.body.download).toMatchObject({ mediaId: m, state: "queued", priority: "P1" });
    const u = await c.post("/api/downloads", { url: "https://www.youtube.com/watch?v=abcdefghijk" });
    expect(u.status).toBe(200);
    expect(u.body.download.state).toBe("queued");
    expect((await c.post("/api/downloads", { url: "https://example.com/x" })).status).toBe(400);
    expect((await c.post("/api/downloads", {})).status).toBe(400);
  });

  it("re-downloads available media with the owning source's current options", async () => {
    const src = await createSource(db(), { priority: "P1" });
    const subs = { enabled: true, languages: ["de"], auto: true };
    await db().update(s.sources).set({ downloadOptions: { resolution: 720, subtitles: subs } as never }).where(eq(s.sources.id, src.id));
    const m = await createMedia(db(), { volume: vol, sizeBytes: 1024, sourceIds: [src.id] });
    const r = await c.post(`/api/media/${m.id}/download`);
    expect(r.status).toBe(200);
    expect(r.body.download.state).toBe("queued");
    const [row] = await db().select().from(s.downloads).where(eq(s.downloads.id, r.body.download.id));
    expect(row).toMatchObject({ requestedBy: "manual", sourceId: src.id });
    expect(row!.options).toMatchObject({ resolution: 720, subtitles: subs });
    expect((await getMedia(db(), m.id)).availability).toBe("available");
  });
});

describe("history import", () => {
  const takeout = JSON.stringify([
    { title: "Watched Known video", titleUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", time: "2025-01-01T10:00:00.000Z", subtitles: [{ name: "Chan A" }] },
    { title: "Watched Unknown one", titleUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb", time: "2025-01-02T10:00:00.000Z", subtitles: [{ name: "Chan B" }] },
    { title: "Watched Unknown two", titleUrl: "https://www.youtube.com/watch?v=ccccccccccc", time: "2025-01-03T10:00:00.000Z" },
    { title: "Not a video", titleUrl: "https://example.com", time: "2025-01-03T10:00:00.000Z" },
  ]);

  it("imports once and is idempotent on re-import", async () => {
    const known = await createMedia(db(), { volume: vol, sizeBytes: 1024, canonicalKey: "youtube:aaaaaaaaaaa", priority: "P3" });
    const send = (queue: string) => c.call("POST", "/api/history/import", multipart([
      { name: "queueDownloads", value: queue }, { name: "file", value: takeout, filename: "watch-history.json" },
    ]));
    const first = await send("false");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 3, duplicates: 0, skipped: 1, matchedMedia: 1, queued: 0 });
    expect((await getMedia(db(), known.id)).effectivePriority).toBe("P2");
    const created = await db().select().from(s.media).where(eq(s.media.canonicalKey, "youtube:bbbbbbbbbbb"));
    expect(created[0]).toMatchObject({ title: "Unknown one", effectivePriority: "P2" });

    const second = await send("true");
    expect(second.body).toMatchObject({ imported: 0, duplicates: 3, matchedMedia: 3 });
    expect(second.body.queued).toBe(2);
    const dls = await db().select().from(s.downloads).where(eq(s.downloads.requestedBy, "history"));
    expect(dls).toHaveLength(2);
    expect(dls.every((d) => d.priority === "P2")).toBe(true);
    const third = await send("true");
    expect(third.body.queued).toBe(0);
  });

  it("rejects non-multipart and garbage files", async () => {
    expect((await c.post("/api/history/import", {})).status).toBe(400);
    const bad = await c.call("POST", "/api/history/import", multipart([{ name: "file", value: "not json", filename: "x.json" }]));
    expect(bad.status).toBe(400);
  });
});

describe("misc", () => {
  it("serves dashboard, health, settings, notifications and offline readiness", async () => {
    const dash = (await c.get("/api/dashboard")).body;
    expect(dash.media.available).toBeGreaterThan(0);
    expect(dash).toHaveProperty("worker.online");
    expect(dash.storage).toHaveProperty("byPriority.P3");
    const health = (await c.get("/api/system/health")).body;
    expect(health.database.ok).toBe(true);
    expect(health.cpu.cores).toBeGreaterThan(0);
    const ready = (await c.get("/api/system/offline-readiness")).body;
    expect(ready.checks.map((x: { key: string }) => x.key)).toEqual(["auth", "database", "media_files", "thumbnails", "search", "streaming", "xtream", "external_dependencies"]);
    expect(ready.checks.find((x: { key: string }) => x.key === "database").ok).toBe(true);
    const put = await c.put("/api/settings", { softThreshold: 80, xtreamAllowedCidrs: ["192.168.0.0/16"] });
    expect(put.body).toMatchObject({ softThreshold: 80, xtreamAllowedCidrs: ["192.168.0.0/16"] });
    expect((await c.put("/api/settings", { xtreamAllowedCidrs: ["nonsense"] })).status).toBe(400);
    await c.put("/api/settings", { softThreshold: 85, xtreamAllowedCidrs: [] });
    expect((await c.get("/api/notifications?open=true")).body).toHaveProperty("unread");
    expect((await c.get("/api/nope")).status).toBe(404);
    expect((await c.post("/api/system/worker", { paused: true })).body).toEqual({ ok: true });
  });
});
