import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startApi, adminClient, Client, type Harness } from "../../apps/api/test/harness.js";
import { createVolume, createMedia, createSource, removeVolume, type TestVolume } from "./helpers/factories.js";
import * as s from "./helpers/deps.js";

let h: Harness;
let admin: Client;
let vol: TestVolume;
let anon: Client;
let user: string, pass: string, clientId: string, createBody: any;
let m1: { id: string; file: string }, m2: { id: string }, evicted: { id: string };
let streamId1: number;
const content = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const q = (extra: string) => `/player_api.php?username=${user}&password=${pass}${extra}`;

beforeAll(async () => {
  h = await startApi();
  admin = await adminClient(h);
  anon = new Client(h.app, { csrf: false });
  vol = await createVolume(h.tdb.db, { isDefault: true });
  const src = await createSource(h.tdb.db, { name: "Fancy Channel" });
  m1 = await createMedia(h.tdb.db, { volume: vol, sizeBytes: 10, title: "First video", sourceIds: [src.id] });
  fs.writeFileSync(m1.file, content);
  await h.tdb.db.update(s.media).set({ categories: ["Education"], durationSeconds: 125, description: "About things", favourite: true }).where(eq(s.media.id, m1.id));
  m2 = await createMedia(h.tdb.db, { volume: vol, sizeBytes: 10, title: "Second video" });
  evicted = await createMedia(h.tdb.db, { volume: vol, sizeBytes: 10, title: "Gone video" });
  const thumb = path.join(path.dirname(m1.file), "media.jpg");
  fs.writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await h.tdb.db.insert(s.mediaFiles).values({ mediaId: m1.id, volumeId: vol.id, kind: "thumbnail", relativePath: `media/${m1.id}/media.jpg`, sizeBytes: 4 });
  streamId1 = (await h.tdb.db.select().from(s.media).where(eq(s.media.id, m1.id)))[0]!.streamId;
  await admin.del(`/api/media/${evicted.id}`);

  const r = await admin.post("/api/clients", { name: "Living room TV" });
  createBody = r.body;
  user = r.body.client.username; pass = r.body.password; clientId = r.body.client.id;
});
afterAll(async () => {
  await removeVolume(vol);
  await h.close();
});

describe("clients API", () => {
  it("returns the credentials once, in the documented shape", () => {
    expect(user).toMatch(/^nc-[a-z0-9]{6}$/);
    expect(pass).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(createBody.m3uUrl).toBe(`http://localhost:3001/get.php?username=${user}&password=${pass}&type=m3u_plus&output=mp4`);
    expect(createBody.xtream).toEqual({ server: "http://localhost:3001", username: user, password: pass });
  });

  it("never lists the password or its hash, and never logs it in activity", async () => {
    const list = await admin.get("/api/clients");
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(pass);
    expect(JSON.stringify(list.body)).not.toMatch(/secret/i);
    expect(list.body).toMatchObject({ xtreamEnabled: true, m3uEnabled: true });
    const act = await admin.get("/api/activity?type=client.created");
    expect(act.body.items).toHaveLength(1);
    expect(JSON.stringify(act.body)).not.toContain(pass);
  });
});

describe("player_api", () => {
  it("authenticates and describes the server from the Host header", async () => {
    const r = await anon.get(q(""), { headers: { host: "nas.home:3001" } });
    expect(r.status).toBe(200);
    expect(r.body.user_info).toMatchObject({ auth: 1, status: "Active", username: user });
    expect(r.body.server_info).toMatchObject({ url: "nas.home", port: "3001", server_protocol: "http" });
  });

  it("returns auth 0 (HTTP 200) for bad credentials and accepts POST form data", async () => {
    const bad = await anon.get(`/player_api.php?username=${user}&password=nope`);
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ user_info: { auth: 0 } });
    expect((await anon.get("/player_api.php")).body).toEqual({ user_info: { auth: 0 } });
    const form = await anon.call("POST", "/player_api.php", {
      payload: `username=${user}&password=${pass}&action=get_vod_categories`, headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(200);
    expect(form.body.map((c: { category_name: string }) => c.category_name)).toContain("Recently added");
  });

  it("lists categories with stable ids", async () => {
    const r = await anon.get(q("&action=get_vod_categories"));
    const names = r.body.map((c: { category_name: string }) => c.category_name);
    expect(names).toEqual(expect.arrayContaining(["Recently added", "Favourites", "Fancy Channel", "Education"]));
    expect(r.body.find((c: any) => c.category_name === "Recently added")).toEqual({ category_id: "1", category_name: "Recently added", parent_id: 0 });
    expect(r.body.find((c: any) => c.category_name === "Favourites").category_id).toBe("2");
    const again = await anon.get(q("&action=get_vod_categories"));
    expect(again.body).toEqual(r.body);
    const dynamic = r.body.filter((c: any) => Number(c.category_id) >= 1000);
    expect(dynamic.length).toBeGreaterThanOrEqual(2);
  });

  it("lists only playable streams and filters by category", async () => {
    const all = await anon.get(q("&action=get_vod_streams"));
    const ids = all.body.map((v: { stream_id: number }) => v.stream_id);
    expect(ids).toContain(streamId1);
    expect(new Set(ids).size).toBe(2); // evicted media is not listed
    // one entry per (stream, category) membership, each carrying that category's id
    const v1rows = all.body.filter((x: any) => x.stream_id === streamId1);
    expect(v1rows.length).toBe(v1rows[0].category_ids.length);
    expect(v1rows.map((x: any) => x.category_id).sort()).toEqual(v1rows[0].category_ids.map(String).sort());
    expect(all.body.map((x: any) => x.num)).toEqual(all.body.map((_: unknown, i: number) => i + 1));
    const v = v1rows[0];
    expect(v).toMatchObject({ name: "First video", stream_type: "movie", container_extension: "mp4", duration_secs: 125, plot: "About things", direct_source: "" });
    expect(v.stream_icon).toBe(`http://localhost:80/xtream-art/${user}/${pass}/${m1.id}.jpg`);
    const cats = (await anon.get(q("&action=get_vod_categories"))).body;
    const fancy = cats.find((c: any) => c.category_name === "Fancy Channel").category_id;
    const filtered = await anon.get(q(`&action=get_vod_streams&category_id=${fancy}`));
    expect(filtered.body.map((x: any) => x.stream_id)).toEqual([streamId1]);
    expect(filtered.body.map((x: any) => x.category_id)).toEqual([String(fancy)]);
    const fav = await anon.get(q("&action=get_vod_streams&category_id=2"));
    expect(fav.body.map((x: any) => x.stream_id)).toEqual([streamId1]);
    expect(fav.body.map((x: any) => x.category_id)).toEqual(["2"]);
  });

  it("returns vod info and empty live/series lists", async () => {
    const info = await anon.get(q(`&action=get_vod_info&vod_id=${streamId1}`));
    expect(info.body.movie_data).toMatchObject({ stream_id: streamId1, name: "First video", container_extension: "mp4" });
    expect(info.body.movie_data.category_id).toBe(String(info.body.movie_data.category_ids[0]));
    expect(info.body.info.plot).toBe("About things");
    for (const a of ["get_live_categories", "get_live_streams", "get_series_categories", "get_series"]) {
      expect((await anon.get(q(`&action=${a}`))).body).toEqual([]);
    }
    expect((await anon.get(q("&action=get_short_epg&stream_id=1"))).body).toEqual({ epg_listings: [] });
    const xml = await anon.get(`/xmltv.php?username=${user}&password=${pass}`);
    expect(xml.text).toContain("<tv");
  });
});

describe("movie streaming, artwork and M3U", () => {
  it("serves byte ranges with 206", async () => {
    const r = await anon.get(`/movie/${user}/${pass}/${streamId1}.mp4`, { headers: { range: "bytes=100-199" } });
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe("bytes 100-199/5000");
    expect(r.raw.equals(content.subarray(100, 200))).toBe(true);
    const whole = await anon.get(`/movie/${user}/${pass}/${streamId1}.mkv`); // any extension is accepted
    expect(whole.status).toBe(200);
    expect(whole.raw.equals(content)).toBe(true);
    const sessions = await h.tdb.db.select().from(s.streamSessions).where(eq(s.streamSessions.mediaId, m1.id));
    expect(sessions.some((x) => x.clientType === "xtream" && x.clientId === clientId)).toBe(true);
  });

  it("404s for unlisted media and 401s for wrong credentials", async () => {
    expect((await anon.get(`/movie/${user}/wrong/${streamId1}.mp4`)).status).toBe(401);
    const [ev] = await h.tdb.db.select().from(s.media).where(eq(s.media.id, evicted.id));
    expect((await anon.get(`/movie/${user}/${pass}/${ev!.streamId}.mp4`)).status).toBe(404);
    expect((await anon.get(`/movie/${user}/${pass}/abc.mp4`)).status).toBe(404);
  });

  it("serves artwork locally", async () => {
    const r = await anon.get(`/xtream-art/${user}/${pass}/${m1.id}.jpg`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect((await anon.get(`/xtream-art/${user}/${pass}/${m2.id}.jpg`)).status).toBe(404);
    expect((await anon.get(`/xtream-art/${user}/bad/${m1.id}.jpg`)).status).toBe(401);
  });

  it("builds the M3U playlist", async () => {
    const r = await anon.get(`/get.php?username=${user}&password=${pass}&type=m3u_plus&output=mp4`, { headers: { host: "nas.home:3001" } });
    expect(r.status).toBe(200);
    expect(r.text.startsWith("#EXTM3U")).toBe(true);
    expect(r.text).toContain(`group-title="Fancy Channel",First video`);
    expect(r.text).toContain(`http://nas.home:3001/movie/${user}/${pass}/${streamId1}.mp4`);
    expect(r.text).not.toContain("Gone video");
    expect((await anon.get(`/get.php?username=${user}&password=bad`)).status).toBe(401);
  });
});

describe("access control", () => {
  it("restricts by CIDR (403 outside, allowed after widening)", async () => {
    for (const url of [q(""), `/movie/${user}/${pass}/${streamId1}.mp4`, `/get.php?username=${user}&password=${pass}`]) {
      expect((await anon.get(url, { remoteAddress: "8.8.8.8" })).status).toBe(403);
    }
    expect((await anon.get(q(""), { remoteAddress: "192.168.1.50" })).body.user_info.auth).toBe(1);
    await admin.put("/api/settings", { xtreamAllowedCidrs: ["10.0.0.0/8"] });
    expect((await anon.get(q(""), { remoteAddress: "192.168.1.50" })).status).toBe(403);
    expect((await anon.get(q(""), { remoteAddress: "10.1.2.3" })).status).toBe(200);
    await admin.put("/api/settings", { xtreamAllowedCidrs: ["0.0.0.0/0"] });
    expect((await anon.get(q(""), { remoteAddress: "8.8.8.8" })).body.user_info.auth).toBe(1);
    await admin.put("/api/settings", { xtreamAllowedCidrs: [] });
  });

  it("returns 404 when Xtream is disabled in settings", async () => {
    await admin.put("/api/settings", { enableXtream: false, enableM3u: false });
    expect((await anon.get(q(""))).status).toBe(404);
    expect((await anon.get(`/movie/${user}/${pass}/${streamId1}.mp4`)).status).toBe(404);
    await admin.put("/api/settings", { enableXtream: true, enableM3u: true });
    expect((await anon.get(q(""))).status).toBe(200);
  });

  it("applies disable, rotate and revoke immediately", async () => {
    await admin.patch(`/api/clients/${clientId}`, { status: "disabled" });
    expect((await anon.get(q(""))).body).toEqual({ user_info: { auth: 0 } });
    expect((await anon.get(`/movie/${user}/${pass}/${streamId1}.mp4`)).status).toBe(401);
    await admin.patch(`/api/clients/${clientId}`, { status: "active", allowM3u: false });
    expect((await anon.get(`/get.php?username=${user}&password=${pass}`)).status).toBe(401);
    expect((await anon.get(q(""))).body.user_info.auth).toBe(1);

    const rot = await admin.post(`/api/clients/${clientId}/rotate`);
    expect(rot.body.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(rot.body.password).not.toBe(pass);
    expect(rot.body.xtream.username).toBe(user);
    expect(rot.body.m3uUrl).toContain(rot.body.password);
    expect((await anon.get(q(""))).body).toEqual({ user_info: { auth: 0 } }); // old password dead
    const oldPass = pass;
    pass = rot.body.password;
    expect((await anon.get(q(""))).body.user_info.auth).toBe(1);

    expect((await admin.del(`/api/clients/${clientId}`)).body).toEqual({ ok: true });
    expect((await anon.get(q(""))).body).toEqual({ user_info: { auth: 0 } });
    expect((await anon.get(`/movie/${user}/${pass}/${streamId1}.mp4`)).status).toBe(401);
    expect((await admin.get("/api/clients")).body.items).toHaveLength(0);
    const types = (await admin.get("/api/activity?type=client.rotated,client.revoked,client.updated")).body.items.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(["client.rotated", "client.revoked", "client.updated"]));
    expect(JSON.stringify((await admin.get("/api/activity?limit=200")).body)).not.toContain(oldPass);
    expect(JSON.stringify((await admin.get("/api/activity?limit=200")).body)).not.toContain(pass);
  });

  it("never writes credentials to the logs", () => {
    const logs = h.logs.join("");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toContain("/movie/***/***/");
    expect(logs).not.toContain(pass);
    expect(logs).not.toContain(createBody.password);
    expect(logs).not.toContain(user);
  });
});

describe("browser extension endpoint", () => {
  it("accepts a bearer extension client and rejects xtream clients", async () => {
    const ext = (await admin.post("/api/clients", { name: "Chrome", kind: "extension" })).body;
    expect(ext.m3uUrl).toBeNull();
    const bearer = { authorization: `Bearer ${ext.client.username}:${ext.password}` };
    const [media] = await h.tdb.db.select().from(s.media).where(eq(s.media.id, m2.id));
    const key = media!.canonicalKey; // youtube:<uuid>; build a url-less match through videoId on a real-looking id
    void key;
    const unknown = await anon.post("/api/ext/watch", { videoId: "zzzzzzzzzzz", progressSeconds: 12 }, { headers: bearer });
    expect(unknown.body).toEqual({ ok: true, mediaId: null });
    await h.tdb.db.update(s.media).set({ canonicalKey: "youtube:ext00000001" }).where(eq(s.media.id, m2.id));
    const known = await anon.post("/api/ext/watch", { url: "https://www.youtube.com/watch?v=ext00000001" }, { headers: bearer });
    expect(known.body).toEqual({ ok: true, mediaId: m2.id });
    const events = await h.tdb.db.select().from(s.watchEvents).where(eq(s.watchEvents.origin, "extension"));
    expect(events).toHaveLength(2);
    expect((await anon.post("/api/ext/watch", { videoId: "zzzzzzzzzzz" }, { headers: { authorization: `Bearer ${ext.client.username}:wrong` } })).status).toBe(401);
    const xt = (await admin.post("/api/clients", { name: "TV2" })).body;
    expect((await anon.post("/api/ext/watch", { videoId: "zzzzzzzzzzz" }, { headers: { authorization: `Bearer ${xt.client.username}:${xt.password}` } })).status).toBe(401);
    expect((await anon.post("/api/ext/watch", {}, { headers: bearer })).status).toBe(400);
    // extension credentials do not open Xtream
    expect((await anon.get(`/player_api.php?username=${ext.client.username}&password=${ext.password}`)).body).toEqual({ user_info: { auth: 0 } });
  });
});
