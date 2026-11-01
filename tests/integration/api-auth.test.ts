import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startApi, Client, type Harness } from "../../apps/api/test/harness.js";

let h: Harness;
let admin: Client;
let dir: string;
const PW = "correct horse battery";

beforeAll(async () => {
  h = await startApi();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-setup-"));
});
afterAll(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await h.close();
});

describe("setup flow", () => {
  it("reports an empty system and gates other routes with setup_required", async () => {
    const c = new Client(h.app);
    const st = await c.get("/api/setup/status");
    expect(st.body).toEqual({ setupComplete: false, hasAdmin: false, steps: { admin: false, storage: false, profile: false }, defaultMediaPath: "/media" });
    const r = await c.get("/api/sources");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("setup_required");
    expect((await c.get("/healthz")).body).toEqual({ ok: true });
    expect((await c.get("/readyz")).status).toBe(200);
  });

  it("creates the admin once, validates the password, and sets a hardened cookie", async () => {
    admin = new Client(h.app);
    expect((await admin.post("/api/setup/admin", { username: "admin", password: "short" })).status).toBe(400);
    const r = await admin.post("/api/setup/admin", { username: "admin", password: PW });
    expect(r.status).toBe(200);
    expect(r.body.user.username).toBe("admin");
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/nocon_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const again = await new Client(h.app).post("/api/setup/admin", { username: "other", password: PW });
    expect(again.status).toBe(409);
  });

  it("requires a session for the remaining setup steps", async () => {
    const r = await new Client(h.app).post("/api/setup/storage/validate", { path: dir });
    expect(r.status).toBe(401);
  });

  it("rejects storage outside the allowed roots and accepts a folder inside them", async () => {
    const bad = await admin.post("/api/setup/storage/validate", { path: "/etc" });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors.join(" ")).toMatch(/allowed/);
    expect((await admin.post("/api/setup/storage", { path: "/etc", name: "nope" })).status).toBe(400);

    const missing = await admin.post("/api/setup/storage/validate", { path: path.join(dir, "nope") });
    expect(missing.body.ok).toBe(false);
    expect(missing.body.exists).toBe(false);

    const ok = await admin.post("/api/setup/storage/validate", { path: dir });
    expect(ok.body).toMatchObject({ ok: true, exists: true, writable: true, existingMarker: null });
    expect(typeof ok.body.totalBytes).toBe("number");
    expect(Array.isArray(ok.body.warnings)).toBe(true);
  });

  it("registers the volume (marker written, first is default) and completes setup", async () => {
    const r = await admin.post("/api/setup/storage", { path: dir, name: "Test drive" });
    expect(r.status).toBe(200);
    expect(r.body.volume).toMatchObject({ name: "Test drive", isDefault: true, isOnline: true, isWritable: true });
    expect(fs.existsSync(path.join(dir, ".noconmedia", "volume.json"))).toBe(true);
    // validate keeps working after registration (storage page reuses it) and flags the duplicate
    const dup = await admin.post("/api/setup/storage/validate", { path: dir });
    expect(dup.body.ok).toBe(false);
    expect(dup.body.existingMarker?.name).toBe("Test drive");

    expect((await admin.get("/api/sources")).status).toBe(409);
    const done = await admin.post("/api/setup/complete", {
      profile: "lightweight", defaultResolution: 1080, softThreshold: 85, minFreePercent: 5, enableXtream: true, enableM3u: true,
    });
    expect(done.body).toEqual({ ok: true });
    expect((await admin.get("/api/setup/status")).body.setupComplete).toBe(true);
    expect((await admin.get("/api/sources")).status).toBe(200);
    const settings = await admin.get("/api/settings");
    expect(settings.body).toMatchObject({ profile: "lightweight", softThreshold: 85, enableXtream: true });
  });
});

describe("login and sessions", () => {
  it("logs in, returns me, and rejects bad credentials", async () => {
    const c = new Client(h.app);
    expect((await c.get("/api/auth/me")).status).toBe(401);
    expect((await c.post("/api/auth/login", { username: "admin", password: "wrong password" })).status).toBe(401);
    expect((await c.post("/api/auth/login", { username: "nobody", password: PW })).status).toBe(401);
    const ok = await c.post("/api/auth/login", { username: "admin", password: PW });
    expect(ok.status).toBe(200);
    const me = await c.get("/api/auth/me");
    expect(me.body.user.username).toBe("admin");
  });

  it("stores only a hash of the session token", async () => {
    const { rows: r } = await (h.deps.pool as any).query("select id from sessions");
    const token = admin.cookie.split("=")[1]!;
    expect(r.every((x: { id: string }) => x.id !== token && x.id.length === 64)).toBe(true);
  });

  it("revokes individual sessions and all others", async () => {
    const a = new Client(h.app), b = new Client(h.app);
    await a.post("/api/auth/login", { username: "admin", password: PW });
    await b.post("/api/auth/login", { username: "admin", password: PW });
    const list = await a.get("/api/auth/sessions");
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    const other = list.body.items.find((s: { current: boolean }) => !s.current);
    expect(list.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await a.del(`/api/auth/sessions/${other.id}`)).body).toEqual({ ok: true });
    // one of the other sessions is now dead; revoke-all-others kills the rest
    await a.del("/api/auth/sessions");
    expect((await b.get("/api/auth/me")).status).toBe(401);
    expect((await a.get("/api/auth/me")).status).toBe(200);
    expect((await a.post("/api/auth/logout")).body).toEqual({ ok: true });
    expect((await a.get("/api/auth/me")).status).toBe(401);
  });

  it("changes the password and invalidates other sessions", async () => {
    const a = new Client(h.app), b = new Client(h.app);
    await a.post("/api/auth/login", { username: "admin", password: PW });
    await b.post("/api/auth/login", { username: "admin", password: PW });
    expect((await a.post("/api/auth/password", { currentPassword: "nope nope nope", newPassword: "a brand new password" })).status).toBe(400);
    expect((await a.post("/api/auth/password", { currentPassword: PW, newPassword: "a brand new password" })).body).toEqual({ ok: true });
    expect((await b.get("/api/auth/me")).status).toBe(401);
    await a.post("/api/auth/password", { currentPassword: "a brand new password", newPassword: PW });
  });
});

describe("CSRF", () => {
  it("rejects mutations without the header and with a foreign Origin", async () => {
    const c = new Client(h.app);
    await c.post("/api/auth/login", { username: "admin", password: PW });
    const noHeader = await c.call("POST", "/api/collections", { body: { name: "x" }, headers: { "x-nocon-csrf": "" } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toBe("csrf");
    const foreign = await c.call("POST", "/api/collections", { body: { name: "x" }, headers: { origin: "https://evil.example", host: "localhost:3001" } });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe("csrf");
    const same = await c.call("POST", "/api/collections", { body: { name: "c1" }, headers: { origin: "http://localhost:3001", host: "localhost:3001" } });
    expect(same.status).toBe(200);
  });

  it("ignores X-Forwarded-Host without TRUST_PROXY or the proxy secret (see api-security.test.ts for the trusted case)", async () => {
    const c = new Client(h.app);
    await c.post("/api/auth/login", { username: "admin", password: PW });
    const spoofed = await c.call("POST", "/api/collections", { body: { name: "c2" }, headers: { origin: "https://media.home", host: "api:3001", "x-forwarded-host": "media.home" } });
    expect(spoofed.status).toBe(403);
    const plain = await c.call("POST", "/api/collections", { body: { name: "c3" }, headers: { origin: "http://api:3001", host: "api:3001", "x-forwarded-host": "other.home" } });
    expect(plain.status).toBe(200);
  });

  it("does not require CSRF for the extension endpoint (bearer auth instead)", async () => {
    const r = await new Client(h.app, { csrf: false }).post("/api/ext/watch", { videoId: "dQw4w9WgXcQ" });
    expect(r.status).toBe(401);
  });
});

describe("login rate limiting", () => {
  it("blocks the sixth attempt in a minute, even with the right password", async () => {
    const ip = "10.9.9.9";
    const c = new Client(h.app);
    for (let i = 0; i < 5; i++) {
      const r = await c.call("POST", "/api/auth/login", { body: { username: "admin", password: `wrong-${i}` }, remoteAddress: ip });
      expect(r.status).toBe(401);
    }
    const blocked = await c.call("POST", "/api/auth/login", { body: { username: "admin", password: PW }, remoteAddress: ip });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
    expect(blocked.headers["retry-after"]).toBeDefined();
    // another IP is unaffected
    const fine = await c.call("POST", "/api/auth/login", { body: { username: "admin", password: PW }, remoteAddress: "10.9.9.10" });
    expect(fine.status).toBe(200);
  });
});
