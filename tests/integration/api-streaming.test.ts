import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startApi, adminClient, type Client, type Harness } from "../../apps/api/test/harness.js";
import { createVolume, createMedia, removeVolume, type TestVolume } from "./helpers/factories.js";
import * as s from "./helpers/deps.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
let h: Harness;
let c: Client;
let vol: TestVolume;
let mediaId: string;
let mediaDir: string;
let bytes: Buffer;

beforeAll(async () => {
  h = await startApi();
  c = await adminClient(h);
  vol = await createVolume(h.tdb.db, { isDefault: true });
  const m = await createMedia(h.tdb.db, { volume: vol, sizeBytes: 0, title: "Real video" });
  mediaId = m.id; mediaDir = m.dir;
  const gen = spawnSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", m.file]);
  if (gen.status !== 0) throw new Error(`ffmpeg failed: ${gen.stderr}`);
  bytes = fs.readFileSync(m.file);
  const rel = `media/${m.id}`;
  await h.tdb.db.update(s.mediaFiles).set({ sizeBytes: bytes.length, container: "mov,mp4,m4a,3gp,3g2,mj2", mimeType: "video/mp4", width: 160, height: 120 }).where(eq(s.mediaFiles.mediaId, m.id));
  const thumb = path.join(m.dir, "media.jpg");
  spawnSync(FFMPEG, ["-y", "-i", m.file, "-frames:v", "1", thumb]);
  await h.tdb.db.insert(s.mediaFiles).values({ mediaId: m.id, volumeId: vol.id, kind: "thumbnail", relativePath: `${rel}/media.jpg`, sizeBytes: fs.statSync(thumb).size });
  fs.writeFileSync(path.join(m.dir, "media.en.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
  await h.tdb.db.insert(s.mediaFiles).values({ mediaId: m.id, volumeId: vol.id, kind: "subtitle", relativePath: `${rel}/media.en.vtt`, language: "en", label: "English" });
});
afterAll(async () => {
  await removeVolume(vol);
  await h.close();
});

describe("direct play", () => {
  it("requires a session", async () => {
    expect((await new (c.constructor as typeof Client)(h.app).get(`/api/media/${mediaId}/stream`)).status).toBe(401);
  });

  it("serves the whole file", async () => {
    const r = await c.get(`/api/media/${mediaId}/stream`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("video/mp4");
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(Number(r.headers["content-length"])).toBe(bytes.length);
    expect(r.raw.equals(bytes)).toBe(true);
  });

  it("serves ranges, suffix ranges, HEAD and 416", async () => {
    const r = await c.get(`/api/media/${mediaId}/stream`, { headers: { range: "bytes=10-109" } });
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes 10-109/${bytes.length}`);
    expect(r.raw.equals(bytes.subarray(10, 110))).toBe(true);
    const suffix = await c.get(`/api/media/${mediaId}/stream`, { headers: { range: "bytes=-50" } });
    expect(suffix.status).toBe(206);
    expect(suffix.raw.equals(bytes.subarray(bytes.length - 50))).toBe(true);
    const open = await c.get(`/api/media/${mediaId}/stream`, { headers: { range: `bytes=${bytes.length - 5}-` } });
    expect(open.raw.length).toBe(5);
    const head = await c.call("HEAD", `/api/media/${mediaId}/stream`);
    expect(head.status).toBe(200);
    expect(Number(head.headers["content-length"])).toBe(bytes.length);
    expect(head.raw.length).toBe(0);
    const bad = await c.get(`/api/media/${mediaId}/stream`, { headers: { range: `bytes=${bytes.length + 100}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers["content-range"]).toBe(`bytes */${bytes.length}`);
  });

  it("records a stream session (and the dashboard counts it)", async () => {
    const rows = await h.tdb.db.select().from(s.streamSessions).where(eq(s.streamSessions.mediaId, mediaId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientType: "web", id: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await c.get("/api/dashboard")).body.streams.active).toBe(1);
  });

  it("returns 404 for unknown media", async () => {
    expect((await c.get("/api/media/00000000-0000-4000-8000-000000000000/stream")).status).toBe(404);
  });
});

describe("artwork, subtitles and HLS", () => {
  it("serves thumbnails and exposes them in summaries", async () => {
    const r = await c.get(`/api/media/${mediaId}/thumbnail`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    const list = await c.get("/api/library/media");
    expect(list.body.items.find((m: { id: string }) => m.id === mediaId).thumbnailUrl).toBe(`/api/media/${mediaId}/thumbnail`);
    const none = await createMedia(h.tdb.db, { volume: vol, sizeBytes: 10 });
    expect((await c.get(`/api/media/${none.id}/thumbnail`)).status).toBe(404);
  });

  it("serves subtitles as text/vtt", async () => {
    const detail = (await c.get(`/api/media/${mediaId}`)).body.media;
    expect(detail.subtitles).toHaveLength(1);
    expect(detail.subtitles[0]).toMatchObject({ language: "en", label: "English" });
    const r = await c.get(detail.subtitles[0].url);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/vtt/);
    expect(r.text).toContain("WEBVTT");
  });

  it("queues HLS preparation, then serves a cached rendition and rejects odd file names", async () => {
    const r = await c.get(`/api/media/${mediaId}/hls/index.m3u8`);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: "preparing" });
    expect(r.headers["content-type"]).toMatch(/json/);
    fs.mkdirSync(path.join(mediaDir, "hls"), { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "hls", "index.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
    fs.writeFileSync(path.join(mediaDir, "hls", "seg0.ts"), "segment");
    const pl = await c.get(`/api/media/${mediaId}/hls/index.m3u8`);
    expect(pl.status).toBe(200);
    expect(pl.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect((await c.get(`/api/media/${mediaId}/hls/seg0.ts`)).text).toBe("segment");
    expect((await c.get(`/api/media/${mediaId}/hls/missing.ts`)).status).toBe(404);
    expect((await c.get(`/api/media/${mediaId}/hls/.hidden`)).status).toBe(400);
    expect((await c.get(`/api/media/${mediaId}/hls/a%2Fb.ts`)).status).toBe(400);
    expect((await c.get(`/api/media/${mediaId}`)).body.media.hlsUrl).toBe(`/api/media/${mediaId}/hls/index.m3u8`);
  });
});

describe("offline volumes", () => {
  it("refuses to stream while the volume marker is missing, and recovers", async () => {
    const marker = path.join(vol.path, ".noconmedia", "volume.json");
    fs.renameSync(marker, marker + ".off");
    const volId = vol.id;
    const verify = await c.post(`/api/storage/volumes/${volId}/verify`);
    expect(verify.body.volume.isOnline).toBe(false);

    const r = await c.get(`/api/media/${mediaId}/stream`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("unavailable");
    expect((await c.get(`/api/media/${mediaId}/hls/index.m3u8`)).body.error).toBe("unavailable");
    const detail = (await c.get(`/api/media/${mediaId}`)).body.media;
    expect(detail).toMatchObject({ playable: false, temporarilyUnavailable: true, streamUrl: null });
    expect((await c.get("/api/library/media")).body.items.find((m: { id: string }) => m.id === mediaId)).toBeUndefined();

    fs.renameSync(marker + ".off", marker);
    expect((await c.post(`/api/storage/volumes/${volId}/verify`)).body.volume.isOnline).toBe(true);
    expect((await c.get(`/api/media/${mediaId}/stream`, { headers: { range: "bytes=0-9" } })).status).toBe(206);
  });

  it("refuses when the file itself is missing", async () => {
    const m = await createMedia(h.tdb.db, { volume: vol, sizeBytes: 10 });
    fs.rmSync(m.file);
    const r = await c.get(`/api/media/${m.id}/stream`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("unavailable");
  });
});
