import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as s from "./helpers/deps.js";
import { eq, and, StorageService, inArray, isNull, notInArray, recomputeEffectivePriority, type Priority } from "./helpers/deps.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import {
  createVolume, createSource, createMedia, createDownload, createPendingMedia, getMedia, removeVolume, type TestVolume,
} from "./helpers/factories.js";
import { initVolume, requiredBytes } from "../../packages/storage-manager/src/index.js";

const MiB = 1024 * 1024;
const DISK = 300 * MiB; // simulated disk: P1 limit 285 MiB, P3 limit 255 MiB
const exists = (p: string) => fsp.access(p).then(() => true, () => false);

let t: TestDb;
let svc: StorageService;
const volumes: TestVolume[] = [];

beforeAll(async () => {
  t = await createTestDb();
  svc = new StorageService({
    db: t.db,
    config: { softThresholdPct: 85, minFreePct: 5, statfsOverrideBytes: DISK, cooldownDays: 30 },
  });
});

afterAll(async () => {
  await Promise.all(volumes.map(removeVolume));
  await t.drop();
});

async function vol(o: Parameters<typeof createVolume>[1] = {}) {
  const v = await createVolume(t.db, o);
  volumes.push(v);
  return v;
}

/** An incoming download in `checking` state, as the worker would present it. */
async function incoming(priority: Priority = "P1", estimatedMiB = 100) {
  const mediaId = await createPendingMedia(t.db, { priority });
  const downloadId = await createDownload(t.db, { mediaId, priority, state: "checking", estimatedBytes: estimatedMiB * MiB });
  return { mediaId, downloadId, estimatedBytes: estimatedMiB * MiB, priority };
}

const admit = (i: Awaited<ReturnType<typeof incoming>>, volumeId: string, autoEvict = true) =>
  svc.admitDownload({ downloadId: i.downloadId, mediaId: i.mediaId, priority: i.priority, autoEvict, estimatedBytes: i.estimatedBytes, volumeId });

/** n files of sizeMiB each, oldest download first so ordering is predictable. */
async function fill(v: TestVolume, n: number, o: { sizeMiB?: number; priority?: Priority; sourceIds?: string[]; pinned?: boolean } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(await createMedia(t.db, {
      volume: v, sizeBytes: (o.sizeMiB ?? 60) * MiB, priority: o.priority ?? "P3", sourceIds: o.sourceIds, pinned: o.pinned,
      downloadedAt: new Date(Date.now() - (n - k) * 86_400_000),
    }));
  }
  return out;
}

const records = (mediaId: string) => t.db.select().from(s.evictionRecords).where(eq(s.evictionRecords.mediaId, mediaId));

describe("storage scenarios", () => {
  it("1. sufficient space: admits with a reservation and no eviction", async () => {
    const v = await vol();
    const i = await incoming("P1", 50);
    const r = await admit(i, v.id);
    expect(r.status).toBe("admitted");
    if (r.status !== "admitted") return;
    expect(r.evictions).toEqual([]);
    const [res] = await t.db.select().from(s.storageReservations).where(eq(s.storageReservations.id, r.reservationId));
    expect(res!.bytes).toBe(requiredBytes(50 * MiB));
    const [dl] = await t.db.select().from(s.downloads).where(eq(s.downloads.id, i.downloadId));
    expect(dl!.volumeId).toBe(v.id);
  });

  it("2. P3 media is evicted (oldest first) to make room for a P1 download", async () => {
    const v = await vol();
    const files = await fill(v, 3); // 180 MiB used; P1 needs 174 and has 105 -> must reclaim 69 -> two files
    const i = await incoming("P1", 100);
    const r = await admit(i, v.id);
    expect(r.status).toBe("admitted");
    if (r.status !== "admitted") return;
    expect(r.evictions.map((e) => e.mediaId)).toEqual([files[0]!.id, files[1]!.id]);
    expect(await exists(files[0]!.dir)).toBe(false);
    expect(await exists(files[1]!.dir)).toBe(false);
    expect(await exists(files[2]!.file)).toBe(true);
    const m = await getMedia(t.db, files[0]!.id);
    expect(m.availability).toBe("evicted");
    expect(m.title).toBeTruthy(); // metadata survives
    const [rec] = await records(files[0]!.id);
    expect(rec).toMatchObject({ status: "completed", reason: "storage_pressure", previousPriority: "P3", triggerDownloadId: i.downloadId });
    expect(await t.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, files[0]!.id))).toHaveLength(0);
  });

  it("2b. a manual re-download never evicts the media being re-downloaded", async () => {
    const v = await vol();
    const files = await fill(v, 3);
    const target = files[0]!; // oldest, so first in eviction order
    const downloadId = await createDownload(t.db, { mediaId: target.id, priority: "P1", state: "checking", estimatedBytes: 100 * MiB });
    await t.db.update(s.downloads).set({ requestedBy: "manual" }).where(eq(s.downloads.id, downloadId));
    const r = await svc.admitDownload({ downloadId, mediaId: target.id, priority: "P1", autoEvict: true, estimatedBytes: 100 * MiB, volumeId: v.id });
    expect(r.status).toBe("admitted");
    if (r.status !== "admitted") return;
    expect(r.evictions.map((e) => e.mediaId)).not.toContain(target.id);
    expect(await exists(target.file)).toBe(true);
  });

  it("3. P2 media is evicted for a P1 download, but never for a P3 download", async () => {
    const v = await vol();
    const files = await fill(v, 3, { priority: "P2" });
    const low = await incoming("P3", 100);
    const lowResult = await admit(low, v.id);
    expect(lowResult.status).toBe("insufficient");
    expect(await exists(files[0]!.file)).toBe(true);

    const high = await incoming("P1", 100);
    const r = await admit(high, v.id);
    expect(r.status).toBe("admitted");
    expect((await getMedia(t.db, files[0]!.id)).availability).toBe("evicted");
  });

  it("4. retention 'all' protects media; changing the policy releases it", async () => {
    const v = await vol();
    const src = await createSource(t.db, { priority: "P3", retention: { mode: "all" } });
    const files = await fill(v, 3, { sourceIds: [src.id] });
    const i = await incoming("P1", 100);
    const r = await admit(i, v.id);
    expect(r.status).toBe("insufficient");
    expect(await exists(files[0]!.file)).toBe(true);
    expect(await records(files[0]!.id)).toHaveLength(0);

    const sim = await svc.simulatePolicyChange({ sourceId: src.id, retention: { mode: "none" } });
    expect(sim.losingProtection).toHaveLength(3);
    await t.db.update(s.sources).set({ retention: { mode: "none" } }).where(eq(s.sources.id, src.id));
    const r2 = await admit(i, v.id);
    expect(r2.status).toBe("admitted");
  });

  it("5. P0 (pinned) media is never evicted", async () => {
    const v = await vol();
    const files = await fill(v, 3, { priority: "P0", pinned: true });
    const i = await incoming("P0", 100);
    const r = await admit(i, v.id);
    expect(r.status).toBe("insufficient");
    for (const f of files) expect(await exists(f.file)).toBe(true);
  });

  it("6. multi-source priority inheritance: the highest linked priority wins", async () => {
    const v = await vol();
    const low = await createSource(t.db, { priority: "P3", retention: { mode: "none" } });
    const high = await createSource(t.db, { priority: "P1", retention: { mode: "none" } });
    const files = [];
    for (let k = 0; k < 3; k++) files.push(await createMedia(t.db, { volume: v, sizeBytes: 60 * MiB, priority: "P3", sourceIds: [low.id, high.id] }));
    for (const f of files) expect(await recomputeEffectivePriority(t.db, f.id)).toBe("P1");

    // A P2 download may not reclaim P1 media.
    const p2 = await incoming("P2", 100);
    expect((await admit(p2, v.id)).status).toBe("insufficient");
    // A P1 download may reclaim unretained P1 media.
    const p1 = await incoming("P1", 100);
    expect((await admit(p1, v.id)).status).toBe("admitted");
  });

  it("7. insufficient after all eligible eviction: nothing deleted, download waits, notification raised", async () => {
    const v = await vol();
    const protectedSrc = await createSource(t.db, { priority: "P1", retention: { mode: "all" } });
    const keep = await fill(v, 2, { sourceIds: [protectedSrc.id] }); // 120 MiB protected
    const evictable = await fill(v, 1, { sizeMiB: 30 }); // only 30 MiB reclaimable
    const i = await incoming("P1", 150); // required 229 MiB; available 285-150 = 135 -> short by 94
    const r = await admit(i, v.id);
    expect(r.status).toBe("insufficient");
    if (r.status !== "insufficient") return;
    expect(r.eligibleBytes).toBe(30 * MiB);
    expect(r.shortfallBytes).toBeGreaterThan(0);
    expect(await exists(evictable[0]!.file)).toBe(true);
    for (const f of keep) expect(await exists(f.file)).toBe(true);
    expect(await records(evictable[0]!.id)).toHaveLength(0);
    const [dl] = await t.db.select().from(s.downloads).where(eq(s.downloads.id, i.downloadId));
    expect(dl!.state).toBe("waiting_for_storage");
    const notes = await t.db.select().from(s.notifications).where(and(eq(s.notifications.key, `storage:full:${v.id}`), isNull(s.notifications.resolvedAt)));
    expect(notes).toHaveLength(1);
  });

  it("8. missing drive: volume goes offline, downloads pause, notification raised, files untouched", async () => {
    const v = await vol();
    const files = await fill(v, 1);
    const queued = await incoming("P1", 10);
    await t.db.update(s.downloads).set({ volumeId: v.id, state: "downloading" }).where(eq(s.downloads.id, queued.downloadId));

    await fsp.rm(path.join(v.path, ".noconmedia", "volume.json"));
    const tr = await svc.refreshVolume(v.id);
    expect(tr).toMatchObject({ transition: "went_offline", online: false });
    expect(tr.pausedDownloadIds).toEqual([queued.downloadId]);

    const [vrow] = await t.db.select().from(s.storageVolumes).where(eq(s.storageVolumes.id, v.id));
    expect(vrow!.isOnline).toBe(false);
    const [dl] = await t.db.select().from(s.downloads).where(eq(s.downloads.id, queued.downloadId));
    expect(dl).toMatchObject({ state: "paused", waitingReason: "volume_offline" });
    const events = await t.db.select().from(s.downloadEvents).where(eq(s.downloadEvents.downloadId, queued.downloadId));
    expect(events.at(-1)).toMatchObject({ fromState: "downloading", toState: "paused" });
    const notes = await t.db.select().from(s.notifications).where(and(eq(s.notifications.key, `volume:offline:${v.id}`), isNull(s.notifications.resolvedAt)));
    expect(notes).toHaveLength(1);
    expect(await exists(files[0]!.file)).toBe(true);
    expect((await getMedia(t.db, files[0]!.id)).availability).toBe("available"); // not treated as deleted

    // Admission refuses an offline volume.
    const other = await incoming("P1", 10);
    const r = await admit(other, v.id);
    expect(r).toMatchObject({ status: "insufficient", reason: "no_volume" });

    // A second refresh while still offline is not a new transition.
    expect((await svc.refreshVolume(v.id)).transition).toBeNull();
  });

  it("9. reconnection: volume comes back, notification resolves, paused downloads are queued again", async () => {
    const v = await vol();
    const d = await incoming("P1", 10);
    await t.db.update(s.downloads).set({ volumeId: v.id, state: "downloading" }).where(eq(s.downloads.id, d.downloadId));
    const marker = await fsp.readFile(path.join(v.path, ".noconmedia", "volume.json"), "utf8");
    await fsp.rm(path.join(v.path, ".noconmedia", "volume.json"));
    await svc.refreshVolume(v.id);

    // A different drive mounted at the same path (wrong id) is not this volume.
    await initVolume(v.path, randomUUID(), "impostor");
    expect((await svc.refreshVolume(v.id)).online).toBe(false);

    await fsp.writeFile(path.join(v.path, ".noconmedia", "volume.json"), marker);
    const tr = await svc.refreshVolume(v.id);
    expect(tr).toMatchObject({ transition: "came_online", online: true, writable: true });
    expect(tr.resumedDownloadIds).toEqual([d.downloadId]);
    const [dl] = await t.db.select().from(s.downloads).where(eq(s.downloads.id, d.downloadId));
    expect(dl).toMatchObject({ state: "queued", waitingReason: null });
    const open = await t.db.select().from(s.notifications).where(and(eq(s.notifications.key, `volume:offline:${v.id}`), isNull(s.notifications.resolvedAt)));
    expect(open).toHaveLength(0);
  });

  it("10. interrupted eviction: planned records are completed on recovery (file present or already gone)", async () => {
    const v = await vol();
    const [present, gone] = await fill(v, 2);
    await fsp.rm(gone!.dir, { recursive: true });
    const planId = randomUUID();
    for (const f of [present!, gone!]) {
      await t.db.insert(s.evictionRecords).values({ planId, mediaId: f.id, volumeId: v.id, previousPriority: "P3", reclaimedBytes: 60 * MiB, reason: "storage_pressure", status: "planned" });
    }
    const r = await svc.recoverInterruptedEvictions();
    expect(r.completed).toBeGreaterThanOrEqual(2);
    expect(await exists(present!.dir)).toBe(false);
    for (const f of [present!, gone!]) {
      expect((await getMedia(t.db, f.id)).availability).toBe("evicted");
      expect((await records(f.id))[0]!.status).toBe("completed");
    }
    // Idempotent
    expect((await svc.recoverInterruptedEvictions()).completed).toBe(0);
  });

  it("11. interrupted download: stale reservations are released, live ones kept", async () => {
    const v = await vol();
    const crashed = await incoming("P1", 10);
    const live = await incoming("P1", 10);
    await t.db.update(s.downloads).set({ state: "downloading" }).where(eq(s.downloads.id, live.downloadId));
    expect((await admit(crashed, v.id)).status).toBe("admitted");
    expect((await admit(live, v.id)).status).toBe("admitted");
    // Process died: the crashed download is reset to queued by recovery, its reservation is orphaned.
    await t.db.update(s.downloads).set({ state: "queued" }).where(eq(s.downloads.id, crashed.downloadId));

    const released = await svc.releaseStaleReservations();
    expect(released).toContain(crashed.downloadId);
    expect(released).not.toContain(live.downloadId);
    const active = await t.db.select().from(s.storageReservations)
      .where(and(eq(s.storageReservations.volumeId, v.id), isNull(s.storageReservations.releasedAt)));
    expect(active.map((a) => a.downloadId)).toEqual([live.downloadId]);
  });

  it("12. duplicate discovery: canonical_key uniqueness gives one media row and one file", async () => {
    const v = await vol();
    const key = `youtube:dup-${randomUUID()}`;
    const first = await createMedia(t.db, { volume: v, sizeBytes: MiB, canonicalKey: key });
    await expect(createMedia(t.db, { volume: v, sizeBytes: MiB, canonicalKey: key })).rejects.toThrow();
    // Discovery's upsert path leaves the original untouched.
    const ins = await t.db.insert(s.media).values({
      canonicalKey: key, platform: "youtube", externalId: "dup", url: "https://example.test/dup", title: "Dup",
    }).onConflictDoNothing({ target: s.media.canonicalKey }).returning({ id: s.media.id });
    expect(ins).toHaveLength(0);
    expect(await t.db.select().from(s.media).where(eq(s.media.canonicalKey, key))).toHaveLength(1);
    expect(await t.db.select().from(s.mediaFiles).where(eq(s.mediaFiles.mediaId, first.id))).toHaveLength(1);
    expect((await fsp.readdir(path.join(v.path, "media", first.id)))).toEqual(["video.mp4"]);
  });

  it("13. evicted media gets a re-download cooldown", async () => {
    const v = await vol();
    const [f] = await fill(v, 1);
    const before = Date.now();
    const rec = await svc.manualEvict(f!.id);
    expect(rec?.status).toBe("completed");
    const m = await getMedia(t.db, f!.id);
    expect(m.availability).toBe("evicted");
    expect(m.evictedAt).not.toBeNull();
    const days = (m.redownloadAfter!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
  });

  it("14. concurrent admissions compete for space: exactly one wins", async () => {
    const v = await vol();
    const [a, b] = await Promise.all([incoming("P1", 100), incoming("P1", 100)]);
    const [ra, rb] = await Promise.all([admit(a!, v.id), admit(b!, v.id)]);
    expect([ra.status, rb.status].sort()).toEqual(["admitted", "insufficient"]);
    const active = await t.db.select().from(s.storageReservations)
      .where(and(eq(s.storageReservations.volumeId, v.id), isNull(s.storageReservations.releasedAt)));
    expect(active).toHaveLength(1);
  });

  it("14b. concurrent admissions that both need eviction never double-evict or over-commit", async () => {
    const v = await vol();
    const files = await fill(v, 4); // 240 MiB used
    const [a, b] = await Promise.all([incoming("P1", 100), incoming("P1", 100)]);
    const results = await Promise.all([admit(a!, v.id), admit(b!, v.id)]);
    expect(results.filter((r) => r.status === "admitted")).toHaveLength(1);
    const recs = await t.db.select().from(s.evictionRecords).where(inArray(s.evictionRecords.mediaId, files.map((f) => f.id)));
    expect(new Set(recs.map((r) => r.mediaId)).size).toBe(recs.length);
    expect(recs.every((r) => r.status === "completed")).toBe(true);
  });

  it("15. media being streamed is never reclaimed", async () => {
    const v = await vol();
    const files = await fill(v, 3); // oldest first would be files[0]
    await t.db.insert(s.streamSessions).values({ id: randomUUID(), mediaId: files[0]!.id, clientType: "web", lastSeenAt: new Date() });
    // files[1]: stale session (5 minutes ago) does not protect
    await t.db.insert(s.streamSessions).values({ id: randomUUID(), mediaId: files[1]!.id, clientType: "web", lastSeenAt: new Date(Date.now() - 300_000) });
    const i = await incoming("P1", 100);
    const r = await admit(i, v.id);
    expect(r.status).toBe("admitted");
    expect(await exists(files[0]!.file)).toBe(true);
    expect((await getMedia(t.db, files[0]!.id)).availability).toBe("available");
    expect((await getMedia(t.db, files[1]!.id)).availability).toBe("evicted");
  });
});

describe("storage service extras", () => {
  it("autoEvict=false never evicts", async () => {
    const v = await vol();
    const files = await fill(v, 3);
    const i = await incoming("P1", 100);
    expect((await admit(i, v.id, false)).status).toBe("insufficient");
    expect(await exists(files[0]!.file)).toBe(true);
  });

  it("picks the volume that needs no eviction when several are online", async () => {
    const full = await vol();
    const empty = await vol();
    await fill(full, 3);
    await t.db.update(s.storageVolumes).set({ acceptsNew: false }).where(notInArray(s.storageVolumes.id, [full.id, empty.id]));
    const i = await incoming("P1", 100);
    const r = await svc.admitDownload({ downloadId: i.downloadId, mediaId: i.mediaId, priority: "P1", autoEvict: true, estimatedBytes: i.estimatedBytes });
    expect(r.status === "admitted" && r.volumeId).toBe(empty.id);
  });

  it("simulate reports the plan without deleting anything", async () => {
    const v = await vol();
    const src = await createSource(t.db, { name: "Sim source", priority: "P3", retention: { mode: "none" } });
    const files = await fill(v, 3, { sourceIds: [src.id] });
    const sim = await svc.simulate({ bytes: 100 * MiB, priority: "P1", volumeId: v.id });
    expect(sim).toMatchObject({ volumeId: v.id, sufficient: true, requiredBytes: requiredBytes(100 * MiB) });
    expect(sim.candidates.map((c) => c.mediaId)).toEqual([files[0]!.id, files[1]!.id]);
    expect(sim.affectedSources).toEqual([{ id: src.id, name: "Sim source" }]);
    expect(await exists(files[0]!.file)).toBe(true);
    const tooBig = await svc.simulate({ bytes: 500 * MiB, priority: "P1", volumeId: v.id });
    expect(tooBig.sufficient).toBe(false);
  });

  it("extendReservation succeeds with room and fails without evicting", async () => {
    const v = await vol();
    const files = await fill(v, 1, { sizeMiB: 100 });
    const i = await incoming("P1", 50);
    await admit(i, v.id);
    expect(await svc.extendReservation(i.downloadId, requiredBytes(80 * MiB))).toBe(true);
    expect(await svc.extendReservation(i.downloadId, requiredBytes(400 * MiB))).toBe(false);
    expect(await exists(files[0]!.file)).toBe(true);
    await svc.updateReservationProgress(i.downloadId, 10 * MiB);
    await svc.releaseReservation(i.downloadId, "ready");
    const [res] = await t.db.select().from(s.storageReservations).where(eq(s.storageReservations.downloadId, i.downloadId));
    expect(res).toMatchObject({ writtenBytes: 10 * MiB, releaseReason: "ready" });
  });

  it("manualEvict can delete P0 media (explicit admin action)", async () => {
    const v = await vol();
    const [f] = await fill(v, 1, { priority: "P0", pinned: true });
    expect((await svc.manualEvict(f!.id))?.status).toBe("completed");
    expect(await exists(f!.dir)).toBe(false);
    expect(await svc.manualEvict(f!.id)).toBeNull();
  });

  it("softThresholdCleanup reclaims P3 down to the threshold and leaves P2", async () => {
    const v = await vol();
    const p2 = await fill(v, 1, { priority: "P2", sizeMiB: 100 });
    const p3 = await fill(v, 3, { sizeMiB: 60 }); // used 280 MiB > 255 MiB (85%) -> reclaim 25 -> one file
    const r = await svc.softThresholdCleanup(v.id);
    expect(r.evicted).toBe(1);
    expect((await records(p3[0]!.id))[0]).toMatchObject({ reason: "soft_threshold", status: "completed" });
    expect(await exists(p2[0]!.file)).toBe(true);
    expect((await svc.softThresholdCleanup(v.id)).evicted).toBe(0);
  });

  it("rollingRetentionCleanup evicts items beyond the newest N", async () => {
    const v = await vol();
    const src = await createSource(t.db, { priority: "P2", retention: { mode: "rolling", count: 2 } });
    const files = [];
    for (let k = 0; k < 4; k++) {
      files.push(await createMedia(t.db, { volume: v, sizeBytes: MiB, priority: "P2", sourceIds: [src.id], publishedAt: new Date(Date.now() - (4 - k) * 86_400_000) }));
    }
    const r = await svc.rollingRetentionCleanup();
    expect(r.evicted).toBe(2);
    expect((await getMedia(t.db, files[0]!.id)).availability).toBe("evicted");
    expect((await getMedia(t.db, files[1]!.id)).availability).toBe("evicted");
    expect((await getMedia(t.db, files[3]!.id)).availability).toBe("available");
    expect((await records(files[0]!.id))[0]!.reason).toBe("retention_rolling");
  });

  it("usageByPriority sums available bytes per priority", async () => {
    const v = await vol();
    await fill(v, 2, { priority: "P1", sizeMiB: 5 });
    await fill(v, 1, { priority: "P3", sizeMiB: 7 });
    expect(await svc.usageByPriority(v.id)).toEqual({ P0: 0, P1: 10 * MiB, P2: 0, P3: 7 * MiB });
  });

  it("recomputeEffectivePriority accounts for pins, manual priority, history and approval", async () => {
    const v = await vol();
    const src = await createSource(t.db, { priority: "P3" });
    const m = await createMedia(t.db, { volume: v, sizeBytes: MiB, sourceIds: [src.id] });
    expect(await recomputeEffectivePriority(t.db, m.id)).toBe("P3");
    await t.db.insert(s.playbackHistory).values({ mediaId: m.id, watchCount: 1 });
    expect(await recomputeEffectivePriority(t.db, m.id)).toBe("P2");
    await t.db.update(s.media).set({ manualPriority: "P1" }).where(eq(s.media.id, m.id));
    expect(await recomputeEffectivePriority(t.db, m.id)).toBe("P1");
    await t.db.update(s.media).set({ pinned: true }).where(eq(s.media.id, m.id));
    expect(await recomputeEffectivePriority(t.db, m.id)).toBe("P0");
    expect((await getMedia(t.db, m.id)).effectivePriority).toBe("P0");
  });
});
