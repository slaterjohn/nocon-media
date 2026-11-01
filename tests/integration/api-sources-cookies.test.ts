// Per-source cookies (PUT/DELETE /api/sources/:id/cookies), the Xtream server URL port, setup defaults and empty JSON bodies.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startApi, adminClient, type Client, type Harness } from "../../apps/api/test/harness.js";
import * as s from "./helpers/deps.js";
import { eq } from "./helpers/deps.js";

const COOKIES = [
  "# Netscape HTTP Cookie File",
  "",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsecret-session-value-123",
  "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tHSID\tanother-secret-456",
].join("\n");

function multipart(field: string, filename: string, data: string | Buffer) {
  const boundary = "----nocon" + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, Buffer.from(data), tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("source cookies", () => {
  let h: Harness;
  let admin: Client;
  let dataRoot: string;
  let sourceId: string;
  const cookiesPath = () => path.join(dataRoot, "secrets", `source-${sourceId}.txt`);

  beforeAll(async () => {
    dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nocon-data-"));
    h = await startApi({ DATA_ROOT: dataRoot });
    admin = await adminClient(h);
    const r = await admin.post("/api/sources", { input: "https://www.youtube.com/playlist?list=PLfakeplaylist0001", schedule: { kind: "manual" } });
    expect(r.status).toBe(200);
    sourceId = r.body.source.id;
  });
  afterAll(async () => { await h.close(); await fsp.rm(dataRoot, { recursive: true, force: true }); });

  const put = (id: string, data: string | Buffer, field = "file") => admin.call("PUT", `/api/sources/${id}/cookies`, multipart(field, "cookies.txt", data));

  it("starts without cookies", async () => {
    const r = await admin.get(`/api/sources/${sourceId}`);
    expect(r.body.source.hasCookies).toBe(false);
  });

  it("rejects files that are not Netscape cookies.txt", async () => {
    for (const bad of ["", "just some text\nwith lines", "# only comments\n# nothing else", "a\tb\tc", ".x.com\tTRUE\t/\tMAYBE\tnotanumber\tn\tv", "\u0000\u0001binary"]) {
      const r = await put(sourceId, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put(sourceId, COOKIES, "other")).status).toBe(400);
    expect((await admin.call("PUT", `/api/sources/${sourceId}/cookies`, { body: {} })).status).toBe(400);
    expect(fs.existsSync(cookiesPath())).toBe(false);
    expect((await admin.get(`/api/sources/${sourceId}`)).body.source.hasCookies).toBe(false);
  });

  it("rejects files over 1 MiB", async () => {
    const big = COOKIES + "\n" + "#" + "x".repeat(1024 * 1024);
    expect((await put(sourceId, big)).status).toBe(413);
    expect(fs.existsSync(cookiesPath())).toBe(false);
  });

  it("rejects unknown sources", async () => {
    expect((await put("00000000-0000-4000-8000-000000000000", COOKIES)).status).toBe(404);
  });

  it("stores the file with mode 0600 in a 0700 directory and sets hasCookies", async () => {
    const r = await put(sourceId, COOKIES);
    expect(r.status).toBe(200);
    expect(r.body.source.hasCookies).toBe(true);
    expect(fs.readFileSync(cookiesPath(), "utf8")).toBe(COOKIES);
    expect(fs.statSync(cookiesPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(cookiesPath())).mode & 0o777).toBe(0o700);
    const [row] = await h.tdb.db.select().from(s.sources).where(eq(s.sources.id, sourceId));
    expect(row!.metadata.cookiesFile).toBe(cookiesPath());
  });

  it("never returns the path or contents in any API response, log or activity entry", async () => {
    const urls = ["/api/sources", `/api/sources/${sourceId}`, "/api/activity", "/api/dashboard", "/api/library/playlists", "/api/downloads"];
    for (const u of urls) {
      const r = await admin.get(u);
      expect(r.text, u).not.toContain(dataRoot);
      expect(r.text, u).not.toContain("secrets");
      expect(r.text, u).not.toContain("cookiesFile");
      expect(r.text, u).not.toContain("secret-session-value-123");
    }
    const dup = await admin.post(`/api/sources/${sourceId}/duplicate`);
    expect(dup.text).not.toContain(dataRoot);
    expect(dup.body.source.hasCookies).toBe(false); // cookies are not copied
    const patched = await admin.patch(`/api/sources/${sourceId}`, { name: "Renamed" });
    expect(patched.text).not.toContain(dataRoot);
    expect(patched.body.source.hasCookies).toBe(true); // other edits keep the cookies
    const rep = await put(sourceId, COOKIES);
    expect(rep.text).not.toContain(dataRoot);
    expect(h.logs.join("")).not.toContain("secret-session-value-123");
    const act = await h.tdb.db.select().from(s.activityEvents);
    expect(JSON.stringify(act)).not.toContain("secret-session-value-123");
    expect(JSON.stringify(act)).not.toContain(dataRoot);
    expect(act.map((a) => a.type)).toContain("source.cookies_updated");
  });

  it("removes the file and the flag on DELETE", async () => {
    const r = await admin.del(`/api/sources/${sourceId}/cookies`);
    expect(r.status).toBe(200);
    expect(r.body.source.hasCookies).toBe(false);
    expect(fs.existsSync(cookiesPath())).toBe(false);
    const [row] = await h.tdb.db.select().from(s.sources).where(eq(s.sources.id, sourceId));
    expect(row!.metadata.cookiesFile).toBeUndefined();
    expect((await h.tdb.db.select().from(s.activityEvents)).map((a) => a.type)).toContain("source.cookies_removed");
  });

  it("deletes the cookies file when the source is deleted", async () => {
    expect((await put(sourceId, COOKIES)).status).toBe(200);
    expect(fs.existsSync(cookiesPath())).toBe(true);
    const r = await admin.del(`/api/sources/${sourceId}?media=keep`);
    expect(r.status).toBe(200);
    expect(fs.existsSync(cookiesPath())).toBe(false);
  });

  it("requires a signed-in admin", async () => {
    const anon = new (admin.constructor as new (app: Harness["app"]) => Client)(h.app);
    expect((await anon.call("PUT", `/api/sources/${sourceId}/cookies`, multipart("file", "c.txt", COOKIES))).status).toBe(401);
  });
});

describe("empty JSON bodies", () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => { h = await startApi(); admin = await adminClient(h); });
  afterAll(async () => { await h.close(); });

  it("accepts a POST with content-type application/json and no body", async () => {
    const r = await admin.post("/api/sources", { input: "https://www.youtube.com/playlist?list=PLfakeplaylist0001", schedule: { kind: "manual" } });
    const id = r.body.source.id;
    const res = await admin.call("POST", `/api/sources/${id}/sync`, { headers: { "content-type": "application/json" }, payload: "" });
    expect(res.status).toBe(200);
    expect((await admin.call("POST", `/api/sources/${id}/pause`, { headers: { "content-type": "application/json" }, payload: "  " })).status).toBe(200);
  });

  it("still rejects malformed JSON with 400", async () => {
    const res = await admin.call("POST", "/api/sources", { headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(res.status).toBe(400);
  });
});

describe("Xtream server URL and setup defaults", () => {
  it("uses the request host with API_PORT_PUBLIC, and PUBLIC_XTREAM_URL first", async () => {
    const h = await startApi({ API_PORT: "3001", API_PORT_PUBLIC: "13001" });
    try {
      const admin = await adminClient(h);
      const r = await admin.get("/api/clients", { headers: { host: "nas.lan:13000" } });
      expect(r.body.serverUrl).toBe("http://nas.lan:13001");
      const made = await admin.post("/api/clients", { name: "Player" }, { headers: { host: "nas.lan:13000" } });
      expect(made.body.xtream.server).toBe("http://nas.lan:13001");
    } finally { await h.close(); }

    const d = await startApi({ API_PORT: "3001" });
    try {
      const admin = await adminClient(d);
      expect((await admin.get("/api/clients", { headers: { host: "nas.lan:3000" } })).body.serverUrl).toBe("http://nas.lan:3001");
    } finally { await d.close(); }

    const p = await startApi({ API_PORT_PUBLIC: "13001", PUBLIC_XTREAM_URL: "https://tv.example.com/" });
    try {
      const admin = await adminClient(p);
      expect((await admin.get("/api/clients", { headers: { host: "nas.lan:3000" } })).body.serverUrl).toBe("https://tv.example.com");
    } finally { await p.close(); }
  });

  it("exposes MEDIA_ROOT as defaultMediaPath on the setup status", async () => {
    const h = await startApi({ MEDIA_ROOT: "/mnt/usb" });
    try {
      const r = await h.app.inject({ method: "GET", url: "/api/setup/status" });
      expect(JSON.parse(r.body).defaultMediaPath).toBe("/mnt/usb");
    } finally { await h.close(); }
  });
});
