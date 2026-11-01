#!/usr/bin/env node
// Captures the screenshots in docs/images/ from a throwaway stack that uses the fake yt-dlp.
//
//   pnpm build && pnpm exec playwright install chromium   # once
//   node scripts/screenshots.mjs
//
// It starts the dev Postgres/Redis from compose.dev.yml, runs the built API and worker plus the web app on
// ports 24000-24002 against a scratch database and media folder, serves a made-up catalogue (no real
// creators), downloads it, takes the screenshots and tears everything down. Nothing touches a production stack.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/images");
const WEB_PORT = 24000;
const API_PORT = 24001;
const CONN_PORT = 24002;
const PG_ADMIN = "postgres://nocon:nocon@127.0.0.1:55432/postgres";
const DB_URL = "postgres://nocon:nocon@127.0.0.1:55432/screenshots";
const REDIS_URL = "redis://127.0.0.1:56379/6";
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const ADMIN = { username: "admin", password: "correct-horse-battery-1" };

// ---- Catalogue ---------------------------------------------------------------
const chan = (name) => `UC${name.padEnd(22, "0")}`;
const CHANNELS = [
  { id: chan("workshopweekends"), title: "Workshop Weekends", priority: "P1", videos: [
    ["Building a bird box", 25, "Cutting, gluing and fitting a small nest box from offcuts."],
    ["Sharpening chisels by hand", 20, "Stones, a strop and a simple honing guide."],
    ["A simple dovetail joint", 18, "Marking and sawing a through dovetail in pine."],
    ["Finishing oak with oil", 15, "Three coats of hard wax oil on a small oak shelf."],
  ] },
  { id: chan("slowkitchen"), title: "Slow Kitchen", priority: "P0", videos: [
    ["Sourdough basics", 24, "Feeding a starter and baking a first loaf."],
    ["A weeknight lentil soup", 16, "One pan, a handful of pantry ingredients."],
    ["Fermenting vegetables at home", 19, "Sauerkraut in a jar, with salt ratios."],
    ["Perfect roast potatoes", 14, "Par-boiling, shaking and a hot tray."],
  ] },
  { id: chan("gardennotes"), title: "Garden Notes", priority: "P2", videos: [
    ["Starting seeds on a windowsill", 21, "Trays, compost and light for early sowings."],
    ["Pruning apple trees in winter", 23, "Where to cut on a young espalier."],
    ["Building a compost bay", 17, "Pallets, wire and a lid."],
  ] },
  { id: chan("pocketscience"), title: "Pocket Science", priority: "P3", videos: [
    ["How tides work", 22, "The moon, the sun and the shape of the coast."],
    ["Why the sky is blue", 13, "Scattering explained with a glass of water."],
    ["Making a simple battery", 15, "Copper, zinc and a lemon."],
  ] },
];

function buildCatalogue() {
  const videos = {};
  const channels = {};
  let n = 0;
  for (const c of CHANNELS) {
    const entries = [];
    for (const [title, duration, description] of c.videos) {
      n += 1;
      const id = `shot${String(n).padStart(7, "0")}`; // 11 characters
      const day = 28 - n;
      videos[id] = {
        id, title, description, duration,
        upload_date: `202610${String(day).padStart(2, "0")}`,
        timestamp: Date.UTC(2026, 9, day, 12, 0, 0) / 1000,
        channel_id: c.id, channel: c.title, uploader: c.title,
        channel_url: `https://www.youtube.com/channel/${c.id}`, live_status: "not_live",
        view_count: 1200 + n * 317, categories: ["Howto & Style"], tags: ["screenshots"], language: "en",
        chapters: [{ start_time: 0, end_time: Math.floor(duration / 2), title: "Introduction" }, { start_time: Math.floor(duration / 2), end_time: duration, title: "Method" }],
      };
      entries.push(id);
    }
    channels[c.id] = { title: c.title, entries };
  }
  const ids = Object.keys(videos);
  const playlists = { PLbeginnerprojects0001: { title: "Beginner projects", entries: [ids[0], ids[4], ids[8]] } };
  return { channels, playlists, videos };
}

// ---- Helpers -----------------------------------------------------------------
async function waitFor(url, ms, label) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become healthy (${url}): ${last}`);
}

// Palette-quantises the PNG with sharp, which Next.js installs as a dependency of apps/web. Without it the
// full-colour PNGs are kept (they are larger).
async function optimise(file) {
  let sharp;
  try {
    const fromWeb = createRequire(path.join(ROOT, "apps/web/package.json"));
    sharp = createRequire(fromWeb.resolve("next/package.json"))("sharp");
  } catch {
    console.warn("sharp not found; skipping PNG optimisation");
    return;
  }
  const buf = await sharp(file).png({ palette: true, quality: 85, effort: 10, compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(file, buf);
}

// ---- Main --------------------------------------------------------------------
async function main() {
  for (const f of ["apps/api/dist/index.js", "apps/worker/dist/index.js"]) {
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing. Run "pnpm build" first.`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync("docker", ["compose", "-f", "compose.dev.yml", "up", "-d", "--wait", "postgres", "redis"], { cwd: ROOT, stdio: "inherit" });

  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS screenshots WITH (FORCE)");
  await admin.query("CREATE DATABASE screenshots");
  await admin.end();
  execFileSync("docker", ["exec", "nocon-dev-redis-1", "redis-cli", "-n", "6", "FLUSHDB"], { stdio: "ignore" });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-shots-"));
  const mediaDir = path.join(scratch, "media");
  const dataDir = path.join(scratch, "data");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

  const conn = http.createServer((_req, res) => { res.statusCode = 204; res.end(); });
  await new Promise((r) => conn.listen(CONN_PORT, "127.0.0.1", r));

  const catalogue = buildCatalogue();
  const catalogPath = path.join(scratch, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalogue));

  const env = {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    APP_URL: BASE,
    API_HOST: "127.0.0.1",
    API_PORT: String(API_PORT),
    DATABASE_URL: DB_URL,
    REDIS_URL,
    MEDIA_ROOT: mediaDir,
    MEDIA_ROOTS_ALLOWED: scratch,
    DATA_ROOT: dataDir,
    TEMP_ROOT: path.join(dataDir, "tmp"),
    NOCON_PROXY_SECRET: crypto.randomBytes(24).toString("hex"),
    FAKE_YTDLP_CATALOG: catalogPath,
    FAKE_YTDLP_COLOURFUL: "1",
    YTDLP_PATH: path.join(ROOT, "tests/fixtures/fake-yt-dlp.mjs"),
    CONNECTIVITY_CHECK_URLS: `http://127.0.0.1:${CONN_PORT}/`,
    CONNECTIVITY_INTERVAL_SEC: "5",
    SCHEDULER_INTERVAL_SEC: "5",
    // Pretend the library drive is small so the storage page shows meaningful bars.
    STORAGE_STATFS_OVERRIDE_BYTES: String(120 * 1024 * 1024),
  };

  const procs = [];
  const logDir = path.join(scratch, "logs");
  fs.mkdirSync(logDir);
  const start = (name, cmd, args, extra = {}) => {
    const out = fs.openSync(path.join(logDir, `${name}.log`), "a");
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extra }, stdio: ["ignore", out, out], detached: true });
    procs.push(p);
  };
  const teardown = async () => {
    for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch {} }
    await new Promise((r) => setTimeout(r, 1000));
    for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch {} }
    conn.close();
    try {
      const c = new pg.Client({ connectionString: PG_ADMIN });
      await c.connect();
      await c.query("DROP DATABASE IF EXISTS screenshots WITH (FORCE)");
      await c.end();
    } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  };

  let browser;
  try {
    start("api", process.execPath, ["apps/api/dist/index.js"]);
    await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, 60_000, "api");
    start("worker", process.execPath, ["apps/worker/dist/index.js"]);

    const webEnv = { ...env, NEXT_DIST_DIR: ".next-e2e" };
    if (!fs.existsSync(path.join(ROOT, "apps/web/.next-e2e/BUILD_ID"))) {
      execFileSync("pnpm", ["--filter", "@nocon/web", "build"], { cwd: ROOT, stdio: "inherit", env: webEnv });
    }
    start("web", "pnpm", ["--filter", "@nocon/web", "exec", "next", "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"], {
      NEXT_DIST_DIR: ".next-e2e", API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, NODE_ENV: "production",
    });
    await waitFor(`${BASE}/login`, 60_000, "web");

    browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      try { if (!localStorage.getItem("nocon-theme")) localStorage.setItem("nocon-theme", "dark"); } catch {}
    });
    const api = context.request;
    const H = { "X-NoCon-CSRF": "1" };
    const call = async (method, p, data) => {
      const r = await api.fetch(`${BASE}${p}`, { method, headers: H, data });
      if (!r.ok()) throw new Error(`${method} ${p} -> ${r.status()} ${await r.text()}`);
      return r.status() === 204 ? null : r.json().catch(() => null);
    };

    // Setup through the same endpoints the wizard uses.
    await call("POST", "/api/setup/admin", ADMIN);
    await call("POST", "/api/setup/storage", { path: mediaDir, name: "Library drive" });
    await call("POST", "/api/setup/complete", { profile: "lightweight", defaultResolution: 720, softThreshold: 85, minFreePercent: 5, enableXtream: true, enableM3u: true });

    // Sources: one per priority, plus a playlist.
    for (const c of CHANNELS) {
      await call("POST", "/api/sources", { input: `https://www.youtube.com/channel/${c.id}`, priority: c.priority, name: c.title });
    }
    await call("POST", "/api/sources", { input: "https://www.youtube.com/playlist?list=PLbeginnerprojects0001", priority: "P1", name: "Beginner projects" });

    // Wait for every video to download.
    const total = Object.keys(catalogue.videos).length;
    const deadline = Date.now() + 8 * 60_000;
    for (;;) {
      const j = await call("GET", "/api/library/media?availability=playable&limit=200");
      if (j.total >= total) break;
      if (Date.now() > deadline) throw new Error(`Only ${j.total}/${total} videos downloaded. Logs: ${logDir}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const lib = await call("GET", "/api/library/media?availability=playable&limit=200&sort=title");
    const byTitle = (t) => lib.items.find((i) => i.title === t);

    // Some activity: favourites, watch progress, one protected video, an external player.
    await call("PATCH", `/api/media/${byTitle("Sourdough basics").id}`, { favourite: true });
    await call("PATCH", `/api/media/${byTitle("Building a bird box").id}`, { favourite: true, pinned: true });
    await call("POST", `/api/media/${byTitle("A simple dovetail joint").id}/progress`, { positionSeconds: 9, durationSeconds: 18 });
    await call("POST", `/api/media/${byTitle("Pruning apple trees in winter").id}/progress`, { positionSeconds: 14, durationSeconds: 23 });
    await call("POST", "/api/clients", { name: "Living room TV", kind: "xtream", allowXtream: true, allowM3u: true });
    await call("POST", "/api/clients", { name: "Laptop (VLC)", kind: "xtream", allowXtream: false, allowM3u: true });
    await new Promise((r) => setTimeout(r, 3000)); // let thumbnails and counters settle

    const page = await context.newPage();
    const shots = [];
    const shoot = async (name, ready) => {
      if (ready) await ready();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(600);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      await optimise(file);
      shots.push(file);
      console.log(`${name}.png  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    };
    const heading = (name) => page.getByRole("heading", { level: 1, name }).waitFor();

    await page.goto(`${BASE}/`);
    await shoot("home", () => heading("Home"));

    const bird = byTitle("Building a bird box");
    await page.goto(`${BASE}/watch/${bird.id}`);
    await shoot("watch", async () => {
      await heading("Building a bird box");
      await page.locator("video").evaluate(async (v) => {
        await new Promise((r) => (v.readyState >= 2 ? r() : v.addEventListener("loadeddata", r, { once: true })));
        v.currentTime = 7;
        await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
      });
    });

    await page.goto(`${BASE}/library`);
    await shoot("library", () => heading("Library"));

    const creators = await call("GET", "/api/library/creators");
    const wk = (creators.items ?? creators).find((c) => c.name === "Workshop Weekends");
    await page.goto(`${BASE}/channels/${wk.id}`);
    await shoot("channel", () => page.getByRole("heading", { level: 1 }).waitFor());

    await page.goto(`${BASE}/admin/sources`);
    await shoot("sources", () => heading("Sources"));

    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a source" });
    await dialog.getByLabel("Address or handle").fill(`https://www.youtube.com/channel/${chan("bikerepairbasics")}`);
    await dialog.getByLabel(/^Name/).fill("Bike repair basics");
    await dialog.getByText(/Recognised a youtube channel/).waitFor();
    await shoot("source-form", () => dialog.getByRole("button", { name: /^Advanced settings/ }).scrollIntoViewIfNeeded());
    await page.keyboard.press("Escape");

    await page.goto(`${BASE}/admin/storage`);
    // Show the in-container path rather than the scratch folder on this machine.
    await shoot("storage", async () => {
      await heading("Storage");
      await page.getByText("Library drive").first().waitFor();
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = n.nodeValue.replace(/\/\S*nocon-shots-\w+\/media/g, "/media");
      });
    });

    await page.goto(`${BASE}/admin/settings`);
    await shoot("settings", () => heading("Settings"));

    await page.goto(`${BASE}/admin/clients`);
    await shoot("players", () => page.getByRole("heading", { level: 1 }).waitFor());

    // Light theme home.
    await page.evaluate(() => { localStorage.setItem("nocon-theme", "light"); document.documentElement.classList.remove("dark"); });
    await page.goto(`${BASE}/`);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await shoot("home-light", () => heading("Home"));

    console.log(`\n${shots.length} screenshots written to ${OUT}`);
  } finally {
    await browser?.close().catch(() => {});
    await teardown();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
