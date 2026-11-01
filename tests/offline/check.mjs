// Offline acceptance checks. Runs inside the internal Docker network (no internet).
// Env: API_URL, WEB_URL, OFFLINE_ADMIN_PASSWORD, OFFLINE_TITLE (seeded video title)
const API = process.env.API_URL ?? "http://api:3001";
const WEB = process.env.WEB_URL ?? "http://web:3000";
const PASSWORD = process.env.OFFLINE_ADMIN_PASSWORD ?? "offline-test-password-1";
const TITLE = process.env.OFFLINE_TITLE ?? "Offline Seed Video";
const results = [];
let cookie = "";

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e).slice(0, 200) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function req(path, { method = "GET", body, headers = {}, base = API, raw = false } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (method !== "GET" && method !== "HEAD") h["x-nocon-csrf"] = "1";
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const sc = res.headers.getSetCookie?.() ?? [];
  const sess = sc.find((c) => c.startsWith("nocon_session="));
  if (sess) cookie = sess.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = {};

// ---- bootstrap ---------------------------------------------------------------
await check("web serves /login", async () => {
  const r = await req("/login", { base: WEB });
  assert(r.status === 200, `status ${r.status}`);
});
await check("api /healthz", async () => assert((await req("/healthz")).json?.ok === true, "not ok"));
await check("web proxies /api to api", async () => {
  const r = await req("/api/setup/status", { base: WEB });
  assert(r.status === 200 && "setupComplete" in (r.json ?? {}), `status ${r.status} ${r.text.slice(0, 80)}`);
});

await check("setup: admin + storage + complete", async () => {
  const st = (await req("/api/setup/status")).json;
  if (!st.hasAdmin) {
    const a = await req("/api/setup/admin", { method: "POST", body: { username: "admin", password: PASSWORD } });
    assert(a.status === 200, `admin ${a.status} ${a.text.slice(0, 120)}`);
  }
  if (!st.steps?.storage) {
    const s = await req("/api/setup/storage", { method: "POST", body: { path: "/media", name: "Offline media" } });
    assert(s.status === 200, `storage ${s.status} ${s.text.slice(0, 120)}`);
  }
  if (!st.setupComplete) {
    const c = await req("/api/setup/complete", { method: "POST", body: { profile: "lightweight", defaultResolution: 1080, softThreshold: 85, minFreePercent: 5, enableXtream: true, enableM3u: true } });
    assert(c.status === 200, `complete ${c.status} ${c.text.slice(0, 120)}`);
  }
  return "ok";
});

await check("login", async () => {
  cookie = "";
  const r = await req("/api/auth/login", { method: "POST", body: { username: "admin", password: PASSWORD } });
  assert(r.status === 200 && cookie, `status ${r.status} ${r.text.slice(0, 120)}`);
  const me = await req("/api/auth/me");
  assert(me.json?.user?.username === "admin", "me failed");
});

await check("admin dashboard", async () => {
  const r = await req("/api/dashboard");
  assert(r.status === 200 && r.json?.media, `status ${r.status}`);
  assert(r.json.worker?.online === true, "worker offline in dashboard");
  assert(r.json.connectivity?.online === false, `connectivity.online=${r.json.connectivity?.online}, expected false (no internet)`);
});

// ---- reconcile imports the seeded sidecar ------------------------------------------------
await check("reconcile imports seeded media", async () => {
  const q = await req("/api/storage/reconcile", { method: "POST", body: { dryRun: false } });
  assert(q.status === 200 || q.status === 202, `enqueue ${q.status} ${q.text.slice(0, 120)}`);
  const id = q.json?.jobId ?? q.json?.id;
  assert(id, `no job id in ${q.text.slice(0, 120)}`);
  for (let i = 0; i < 60; i++) {
    const j = await req(`/api/storage/reconcile/${id}`);
    const s = j.json?.state;
    if (s === "completed") return JSON.stringify(j.json.result).slice(0, 120);
    if (s === "failed") throw new Error(`job failed: ${j.text.slice(0, 150)}`);
    await sleep(1000);
  }
  throw new Error("reconcile timed out");
});

await check("library listing contains seeded media", async () => {
  const r = await req("/api/library/media?availability=all");
  const item = r.json?.items?.find((m) => m.title === TITLE);
  assert(item, `title not found; total=${r.json?.total}`);
  assert(item.availability === "available" && item.playable, `availability=${item.availability} playable=${item.playable}`);
  state.media = item;
  return `id=${item.id} streamId=${item.streamId}`;
});

await check("search finds seeded title", async () => {
  const r = await req(`/api/library/search?q=${encodeURIComponent(TITLE.split(" ")[0])}`);
  assert(r.json?.media?.some((m) => m.id === state.media?.id), `not in results: ${r.text.slice(0, 120)}`);
});

await check("media detail", async () => {
  const r = await req(`/api/media/${state.media.id}`);
  assert(r.status === 200 && r.json?.media?.streamUrl, `status ${r.status}`);
});

await check("thumbnail served locally", async () => {
  const r = await req(`/api/media/${state.media.id}/thumbnail`, { raw: true });
  const buf = Buffer.from(await r.arrayBuffer());
  assert(r.status === 200 && buf.length > 100, `status ${r.status} bytes ${buf.length}`);
  assert(/image\//.test(r.headers.get("content-type") ?? ""), `content-type ${r.headers.get("content-type")}`);
});

await check("stream range request (206)", async () => {
  const r = await req(`/api/media/${state.media.id}/stream`, { headers: { range: "bytes=0-1023" }, raw: true });
  const buf = Buffer.from(await r.arrayBuffer());
  assert(r.status === 206, `status ${r.status}`);
  assert(buf.length === 1024, `bytes ${buf.length}`);
  assert(/^bytes 0-1023\//.test(r.headers.get("content-range") ?? ""), `content-range ${r.headers.get("content-range")}`);
  return r.headers.get("content-range");
});

// ---- Xtream / M3U ---------------------------------------------------------------------------
await check("create external client", async () => {
  const r = await req("/api/clients", { method: "POST", body: { name: "offline-test", kind: "xtream", allowXtream: true, allowM3u: true } });
  assert(r.status === 200 || r.status === 201, `status ${r.status} ${r.text.slice(0, 120)}`);
  state.user = r.json?.xtream?.username ?? r.json?.client?.username;
  state.pass = r.json?.xtream?.password ?? r.json?.password;
  assert(state.user && state.pass, "no credentials returned");
});
const xt = (qs) => `/player_api.php?username=${state.user}&password=${state.pass}${qs ?? ""}`;
await check("xtream player_api auth", async () => {
  const r = await req(xt(), { headers: { cookie: "" } });
  assert(r.json?.user_info?.auth === 1, r.text.slice(0, 150));
});
await check("xtream bad credentials rejected", async () => {
  const r = await req(`/player_api.php?username=${state.user}&password=wrong`);
  assert(r.json?.user_info?.auth === 0 || r.status === 401 || r.status === 403, `status ${r.status} ${r.text.slice(0, 100)}`);
});
await check("xtream vod categories", async () => {
  const r = await req(xt("&action=get_vod_categories"));
  assert(Array.isArray(r.json) && r.json.length > 0, r.text.slice(0, 120));
});
await check("xtream vod streams", async () => {
  const r = await req(xt("&action=get_vod_streams"));
  const s = Array.isArray(r.json) ? r.json.find((x) => x.name === TITLE || x.title === TITLE) : null;
  assert(s, `seeded title not listed: ${r.text.slice(0, 150)}`);
  state.vod = s;
  return `stream_id=${s.stream_id}.${s.container_extension}`;
});
await check("xtream vod info", async () => {
  const r = await req(xt(`&action=get_vod_info&vod_id=${state.vod.stream_id}`));
  assert(r.json?.movie_data?.stream_id == state.vod.stream_id, r.text.slice(0, 150));
});
await check("xtream /movie range request", async () => {
  const r = await req(`/movie/${state.user}/${state.pass}/${state.vod.stream_id}.${state.vod.container_extension}`, { headers: { range: "bytes=0-511", cookie: "" }, raw: true });
  const buf = Buffer.from(await r.arrayBuffer());
  assert(r.status === 206 && buf.length === 512, `status ${r.status} bytes ${buf.length}`);
});
await check("M3U get.php", async () => {
  const r = await req(`/get.php?username=${state.user}&password=${state.pass}&type=m3u_plus&output=mp4`);
  assert(r.status === 200 && r.text.startsWith("#EXTM3U") && r.text.includes(TITLE), r.text.slice(0, 150));
});
await check("xtream artwork served locally", async () => {
  const r = await req(`/xtream-art/${state.user}/${state.pass}/${state.media.id}.jpg`, { raw: true });
  const buf = Buffer.from(await r.arrayBuffer());
  assert(r.status === 200 && buf.length > 100, `status ${r.status}`);
});

// ---- readiness + isolation -----------------------------------------------------------------
await check("system/offline-readiness all ok", async () => {
  const r = await req("/api/system/offline-readiness");
  assert(r.status === 200, `status ${r.status}`);
  const bad = (r.json?.checks ?? []).filter((c) => !c.ok);
  assert(r.json?.ok === true && bad.length === 0, `failing: ${bad.map((c) => `${c.key}: ${c.message}`).join("; ") || r.text.slice(0, 150)}`);
  return `${r.json.checks.length} checks`;
});
await check("no internet from test container", async () => {
  try {
    await fetch("https://www.youtube.com", { signal: AbortSignal.timeout(5000) });
  } catch {
    return "request failed as expected";
  }
  throw new Error("reached https://www.youtube.com");
});

// ---- report --------------------------------------------------------------------------------
const w = Math.max(...results.map((r) => r.name.length));
console.log("\nRESULT  CHECK".padEnd(w + 10) + "DETAIL");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}    ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
