// Regression tests for the security review: client IP trust (M1), login throttle + scrypt limiter (M2),
// Takeout size limits via the API (M3), Xtream /movie rate limit (L2), headers + session lifetime (L3).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { strToU8, zipSync } from "../../packages/source-adapters/node_modules/fflate/esm/index.mjs";
import { startApi, adminClient, Client, type Harness } from "../../apps/api/test/harness.js";
import { LoginThrottle, THROTTLE_MAX_KEYS, MAX_SCRYPT, hashPassword, scryptStats, SESSION_MAX_MS } from "../../apps/api/src/lib/auth.js";
import * as s from "./helpers/deps.js";

const PW = "correct horse battery";
const SECRET = "test-proxy-secret-0123456789";

async function sessionIps(c: Client): Promise<string[]> {
  const r = await c.get("/api/auth/sessions");
  return (r.body.items as Array<{ ip: string }>).map((x) => x.ip);
}

describe("M1: client IP behind the web proxy", () => {
  let h: Harness;
  beforeAll(async () => { h = await startApi({ NOCON_PROXY_SECRET: SECRET }); await adminClient(h); });
  afterAll(async () => { await h.close(); });

  const proxyHeaders = (ip: string, secret = SECRET) => ({ "x-nocon-proxy-secret": secret, "x-nocon-client-ip": ip });
  const login = (c: Client, headers: Record<string, string>, password = PW) =>
    c.call("POST", "/api/auth/login", { body: { username: "admin", password }, headers, remoteAddress: "172.18.0.5" });

  it("uses x-nocon-client-ip only when the proxy secret matches", async () => {
    const good = new Client(h.app);
    expect((await login(good, proxyHeaders("203.0.113.7"))).status).toBe(200);
    expect(await sessionIps(good)).toContain("203.0.113.7");

    const wrong = new Client(h.app);
    expect((await login(wrong, proxyHeaders("203.0.113.8", "nope"))).status).toBe(200);
    expect(await sessionIps(wrong)).toContain("172.18.0.5");
    expect(await sessionIps(wrong)).not.toContain("203.0.113.8");

    const garbage = new Client(h.app);
    expect((await login(garbage, proxyHeaders("not-an-ip"))).status).toBe(200);
    expect(await sessionIps(garbage)).toContain("172.18.0.5");
  });

  it("never trusts a client-supplied x-forwarded-for when TRUST_PROXY is off", async () => {
    const c = new Client(h.app);
    expect((await login(c, { "x-forwarded-for": "198.51.100.99" })).status).toBe(200);
    expect(await sessionIps(c)).not.toContain("198.51.100.99");
  });

  it("gives each real client its own login-throttle bucket (no global lockout of the web container)", async () => {
    const attacker = new Client(h.app);
    for (let i = 0; i < 5; i++) expect((await login(attacker, proxyHeaders("203.0.113.50"), "wrong password!")).status).toBe(401);
    expect((await login(attacker, proxyHeaders("203.0.113.50"), "wrong password!")).status).toBe(429);
    // a different LAN user, arriving through the very same web container, is unaffected
    expect((await login(new Client(h.app), proxyHeaders("203.0.113.51"))).status).toBe(200);
  });

  it("honours x-forwarded-host (CSRF origin check) with the secret, ignores it without", async () => {
    const c = new Client(h.app);
    await login(c, proxyHeaders("203.0.113.60"));
    const hdr = { origin: "https://media.home", host: "api:3001", "x-forwarded-host": "media.home" };
    expect((await c.call("POST", "/api/collections", { body: { name: "fh1" }, headers: { ...hdr, ...proxyHeaders("203.0.113.60") } })).status).toBe(200);
    expect((await c.call("POST", "/api/collections", { body: { name: "fh2" }, headers: hdr })).status).toBe(403);
  });
});

describe("CSRF origin without NOCON_PROXY_SECRET", () => {
  let h: Harness;
  let c: Client;
  beforeAll(async () => { h = await startApi(); c = await adminClient(h); });
  afterAll(async () => { await h.close(); });

  it("accepts the APP_URL origin with a non-matching Host, still rejects foreign origins", async () => {
    const host = { host: "api:3001" };
    expect((await c.call("POST", "/api/collections", { body: { name: "ao1" }, headers: { ...host, origin: "http://localhost:3000" } })).status).toBe(200);
    expect((await c.call("POST", "/api/collections", { body: { name: "ao2" }, headers: { ...host, origin: "https://evil.example" } })).status).toBe(403);
  });
});

describe("M1: TRUST_PROXY with TRUSTED_PROXY_CIDRS", () => {
  let h: Harness;
  beforeAll(async () => { h = await startApi({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "10.0.0.0/8" }); await adminClient(h); });
  afterAll(async () => { await h.close(); });

  it("only believes x-forwarded-for from the listed proxies", async () => {
    const viaProxy = new Client(h.app);
    await viaProxy.call("POST", "/api/auth/login", { body: { username: "admin", password: PW }, headers: { "x-forwarded-for": "198.51.100.1" }, remoteAddress: "10.1.2.3" });
    expect(await sessionIps(viaProxy)).toContain("198.51.100.1");

    const direct = new Client(h.app);
    await direct.call("POST", "/api/auth/login", { body: { username: "admin", password: PW }, headers: { "x-forwarded-for": "198.51.100.2" }, remoteAddress: "192.168.9.9" });
    const ips = await sessionIps(direct);
    expect(ips).toContain("192.168.9.9");
    expect(ips).not.toContain("198.51.100.2");
  });
});

describe("M2: login throttle and scrypt limiter", () => {
  let h: Harness;
  beforeAll(async () => { h = await startApi(); await adminClient(h); });
  afterAll(async () => { await h.close(); });

  it("records attempts before hashing, so a concurrent burst cannot exceed the limit", async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, () =>
      new Client(h.app).call("POST", "/api/auth/login", { body: { username: "admin", password: "definitely wrong" }, remoteAddress: "192.0.2.77" })));
    const codes = attempts.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBe(5);
    expect(codes.filter((c) => c === 429).length).toBe(15);
  });

  it("a successful login clears the attempts recorded for that IP", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i++) expect(t.check("1.1.1.1", "bob")).toBe(0);
    t.clear("1.1.1.1", "bob");
    for (let i = 0; i < 5; i++) expect(t.check("1.1.1.1", "bob")).toBe(0);
    expect(t.check("1.1.1.1", "bob")).toBeGreaterThan(0);
  });

  it("caps tracked keys at ~10k", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < THROTTLE_MAX_KEYS * 2; i++) t.check(`ip-${i}`, `user-${i}`);
    const size = t.size();
    expect(size.ips).toBeLessThanOrEqual(THROTTLE_MAX_KEYS);
    expect(size.users).toBeLessThanOrEqual(THROTTLE_MAX_KEYS);
  });

  it("runs at most 2 scrypt operations at a time", async () => {
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, scryptStats().active); }, 1);
    const before = scryptStats().started;
    await Promise.all(Array.from({ length: 6 }, (_, i) => hashPassword(`password-number-${i}`)));
    clearInterval(timer);
    expect(MAX_SCRYPT).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    expect(scryptStats().started - before).toBe(6);
    expect(scryptStats().active).toBe(0);
  });

  it("setup/admin checks for an existing admin before hashing", async () => {
    const before = scryptStats().started;
    const r = await new Client(h.app).post("/api/setup/admin", { username: "second", password: PW });
    expect(r.status).toBe(409);
    expect(scryptStats().started).toBe(before);
  });
});

describe("M3: Takeout import via the API", () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => { h = await startApi(); admin = await adminClient(h); });
  afterAll(async () => { await h.close(); });

  function upload(filename: string, data: Uint8Array) {
    const boundary = "----nocon" + Math.random().toString(16).slice(2);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { payload: Buffer.concat([head, Buffer.from(data), tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  it("answers 400 'too large' for a zip bomb instead of inflating it", async () => {
    const bomb = zipSync({ "Takeout/YouTube and YouTube Music/history/watch-history.json": new Uint8Array(257 * 1024 * 1024) }, { level: 9 });
    const r = await admin.call("POST", "/api/history/import", upload("takeout.zip", bomb));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("This archive is too large to import");
  });

  it("still imports a small archive", async () => {
    const hist = [{ title: "Watched X", titleUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", time: "2026-11-01T14:03:22.000Z" }];
    const zip = zipSync({ "Takeout/YouTube/history/watch-history.json": strToU8(JSON.stringify(hist)) });
    const r = await admin.call("POST", "/api/history/import", upload("takeout.zip", zip));
    expect(r.status).toBe(200);
  });
});

describe("L2/L3: Xtream /movie rate limit, headers, absolute session lifetime", () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => { h = await startApi(); admin = await adminClient(h); });
  afterAll(async () => { await h.close(); });

  it("rate-limits /movie with its own much higher limit", async () => {
    const hit = (url: string, ip: string) => h.app.inject({ method: "GET", url, remoteAddress: ip });
    // player_api.php: 300/min
    let last = 0;
    for (let i = 0; i < 301; i++) last = (await hit("/player_api.php?username=a&password=b", "192.0.2.10")).statusCode;
    expect(last).toBe(429);
    // /movie: still allowed well past 300 …
    for (let i = 0; i < 400; i++) expect((await hit("/movie/a/b/1.mp4", "192.0.2.11")).statusCode).not.toBe(429);
    // … but not unlimited
    let limited = 0;
    for (let i = 400; i < 3010; i++) if ((await hit("/movie/a/b/1.mp4", "192.0.2.11")).statusCode === 429) { limited = i; break; }
    expect(limited).toBeGreaterThan(2900);
  }, 60_000);

  it("adds nosniff / referrer-policy to JSON and X-Frame-Options to /api", async () => {
    const r = await admin.get("/api/auth/me");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    const hz = await admin.get("/healthz");
    expect(hz.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("ends a session 90 days after creation even though expiry slides", async () => {
    const c = new Client(h.app);
    expect((await c.post("/api/auth/login", { username: "admin", password: PW })).status).toBe(200);
    expect((await c.get("/api/auth/me")).status).toBe(200);
    const old = new Date(Date.now() - SESSION_MAX_MS - 3600_000);
    await h.tdb.db.update(s.sessions).set({ createdAt: old, expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await c.get("/api/auth/me")).status).toBe(401);
  });
});
