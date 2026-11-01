import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as s from "./helpers/deps.js";
import { eq, and } from "./helpers/deps.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { createSource, getMedia } from "./helpers/factories.js";
import {
  ensureDownload, ensureSystemSources, linkMediaToSource, transitionDownload, upsertMedia,
} from "../../packages/database/src/catalog.js";
import { InvalidTransitionError } from "../../packages/shared/src/index.js";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.drop(); });

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  canonicalKey: `youtube:${id}`, platform: "youtube", externalId: id, url: `https://www.youtube.com/watch?v=${id}`, title: `Title ${id}`, ...extra,
});

describe("ensureSystemSources", () => {
  it("is idempotent and creates history, discovery and manual sources", async () => {
    const a = await ensureSystemSources(t.db);
    const b = await ensureSystemSources(t.db);
    expect(b.history.id).toBe(a.history.id);
    expect(a.history.priority).toBe("P2");
    expect(a.discovery.priority).toBe("P3");
    expect(a.manual.priority).toBe("P1");
    expect(a.manual.retention).toEqual({ mode: "all" });
    const rows = await t.db.select().from(s.sources).where(eq(s.sources.system, true));
    expect(rows).toHaveLength(3);
  });
});

describe("upsertMedia", () => {
  it("is idempotent per canonical key and keeps availability untouched", async () => {
    const first = await upsertMedia(t.db, entry("aaaaaaaaaaa", { channelId: "UCchan", channelName: "Chan", tags: ["a"], durationSeconds: 61.4 }));
    expect(first.created).toBe(true);
    await t.db.update(s.media).set({ availability: "available", manualPriority: "P1" }).where(eq(s.media.id, first.media.id));
    const second = await upsertMedia(t.db, entry("aaaaaaaaaaa", { title: "Fresher title", channelId: "UCchan" }));
    expect(second.created).toBe(false);
    expect(second.media.id).toBe(first.media.id);
    const rows = await t.db.select().from(s.media).where(eq(s.media.canonicalKey, "youtube:aaaaaaaaaaa"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Fresher title");
    expect(rows[0]!.availability).toBe("available");
    expect(rows[0]!.manualPriority).toBe("P1");
    expect(rows[0]!.tags).toEqual(["a"]); // not wiped by an update without tags
    expect(rows[0]!.durationSeconds).toBe(61);
    const creators = await t.db.select().from(s.creators).where(eq(s.creators.externalId, "UCchan"));
    expect(creators).toHaveLength(1);
    expect(rows[0]!.creatorId).toBe(creators[0]!.id);
  });
});

describe("linkMediaToSource", () => {
  it("inherits the source priority and keeps the highest one", async () => {
    const { media } = await upsertMedia(t.db, entry("bbbbbbbbbbb"));
    const low = await createSource(t.db, { priority: "P3" });
    const high = await createSource(t.db, { priority: "P1" });
    await linkMediaToSource(t.db, { mediaId: media.id, sourceId: low.id });
    expect((await getMedia(t.db, media.id)).effectivePriority).toBe("P3");
    await linkMediaToSource(t.db, { mediaId: media.id, sourceId: high.id, position: 4 });
    expect((await getMedia(t.db, media.id)).effectivePriority).toBe("P1");
    await linkMediaToSource(t.db, { mediaId: media.id, sourceId: high.id, position: 7 });
    const [link] = await t.db.select().from(s.mediaSources).where(and(eq(s.mediaSources.mediaId, media.id), eq(s.mediaSources.sourceId, high.id)));
    expect(link!.position).toBe(7);
  });
});

describe("ensureDownload", () => {
  it("dedupes active downloads and marks media queued", async () => {
    const { media } = await upsertMedia(t.db, entry("ccccccccccc"));
    const a = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "source" });
    expect(a.download && a.created).toBe(true);
    const b = await ensureDownload(t.db, { mediaId: media.id, priority: "P2", requestedBy: "manual" });
    expect(b.created).toBe(false);
    expect(b.download?.id).toBe(a.download?.id);
    expect((await getMedia(t.db, media.id)).availability).toBe("queued");
    const events = await t.db.select().from(s.downloadEvents).where(eq(s.downloadEvents.downloadId, a.download!.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.toState).toBe("queued");
  });

  it("refuses during the re-download cooldown unless manual or restore", async () => {
    const { media } = await upsertMedia(t.db, entry("ddddddddddd"));
    await t.db.update(s.media).set({ availability: "evicted", redownloadAfter: new Date(Date.now() + 86_400_000) }).where(eq(s.media.id, media.id));
    const blocked = await ensureDownload(t.db, { mediaId: media.id, priority: "P3", requestedBy: "discovery" });
    expect(blocked).toMatchObject({ download: null, created: false, reason: "cooldown" });
    const manual = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "manual" });
    expect(manual.created).toBe(true);
  });
});

describe("transitionDownload", () => {
  it("applies valid transitions with events and mirrors media availability", async () => {
    const { media } = await upsertMedia(t.db, entry("eeeeeeeeeee"));
    const { download } = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "source" });
    const d = await transitionDownload(t.db, download!.id, "checking", { attempts: 1 }, "start");
    expect(d.state).toBe("checking");
    expect(d.attempts).toBe(1);
    await transitionDownload(t.db, download!.id, "downloading");
    expect((await getMedia(t.db, media.id)).availability).toBe("downloading");
    await transitionDownload(t.db, download!.id, "failed", { error: "boom" });
    expect((await getMedia(t.db, media.id)).availability).toBe("failed");
    const events = await t.db.select().from(s.downloadEvents).where(eq(s.downloadEvents.downloadId, download!.id));
    expect(events.map((e) => e.toState)).toEqual(["queued", "checking", "downloading", "failed"]);
  });

  it("throws on an invalid transition and leaves the row unchanged", async () => {
    const { media } = await upsertMedia(t.db, entry("fffffffffff"));
    const { download } = await ensureDownload(t.db, { mediaId: media.id, priority: "P1", requestedBy: "source" });
    await expect(transitionDownload(t.db, download!.id, "ready")).rejects.toBeInstanceOf(InvalidTransitionError);
    const [row] = await t.db.select().from(s.downloads).where(eq(s.downloads.id, download!.id));
    expect(row!.state).toBe("queued");
  });
});
