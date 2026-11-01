import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_PORT = 24000;
const API_PORT = 24001;
const CONN_PORT = 24002;
const PG_ADMIN = "postgres://nocon:nocon@127.0.0.1:55432/postgres";
const DB_URL = "postgres://nocon:nocon@127.0.0.1:55432/e2e";
const REDIS_URL = "redis://127.0.0.1:56379/5";

async function waitFor(url: string, ms: number, label: string) {
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

export default async function globalSetup() {
  execFileSync("docker", ["compose", "-f", "compose.dev.yml", "up", "-d", "--wait", "postgres", "redis"], { cwd: ROOT, stdio: "inherit" });

  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS e2e WITH (FORCE)");
  await admin.query("CREATE DATABASE e2e");
  await admin.end();

  // Dedicated Redis DB index (5): flush only this one.
  execFileSync("docker", ["exec", "nocon-dev-redis-1", "redis-cli", "-n", "5", "FLUSHDB"], { stdio: "ignore" });

  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-e2e-"));
  const mediaDir = path.join(mediaRoot, "media");
  const dataDir = path.join(mediaRoot, "data");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
  process.env.E2E_MEDIA_DIR = mediaDir;

  const conn = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((r) => conn.listen(CONN_PORT, "127.0.0.1", r));

  // Fake catalogue = the built-in one plus a 30 s video, so seek/resume tests have room to work.
  const DEFAULT_CHANNEL = "UCfakechannel0000000000a";
  const mk = (id: string, n: number, title: string, duration: number) => ({
    id, title, description: `Description for ${title}`, duration,
    upload_date: `2026100${n}`, timestamp: Date.UTC(2026, 9, n, 12, 0, 0) / 1000,
    channel_id: DEFAULT_CHANNEL, channel: "Fake Channel", uploader: "Fake Channel",
    channel_url: `https://www.youtube.com/channel/${DEFAULT_CHANNEL}`, live_status: "not_live",
    view_count: 100 * n, categories: ["Education"], tags: ["fake", `tag${n}`], language: "en",
    chapters: [{ start_time: 0, end_time: 10, title: "Intro" }, { start_time: 10, end_time: duration, title: "Main" }],
  });
  const videos = {
    fakevid0001: mk("fakevid0001", 1, "Fake video 1", 3),
    fakevid0002: mk("fakevid0002", 2, "Fake video 2", 4),
    fakevid0003: mk("fakevid0003", 3, "Fake video 3", 5),
    fakelong004: mk("fakelong004", 4, "Fake long video 4", 30),
  };
  const catalogPath = path.join(mediaRoot, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    channels: { [DEFAULT_CHANNEL]: { title: "Fake Channel", entries: Object.keys(videos) } },
    playlists: { PLfakeplaylist0001: { title: "Fake Playlist", entries: ["fakevid0001", "fakevid0002"] } },
    videos,
  }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    APP_URL: `http://127.0.0.1:${WEB_PORT}`,
    API_HOST: "127.0.0.1",
    API_PORT: String(API_PORT),
    DATABASE_URL: DB_URL,
    REDIS_URL,
    MEDIA_ROOT: mediaDir,
    MEDIA_ROOTS_ALLOWED: mediaRoot,
    DATA_ROOT: dataDir,
    TEMP_ROOT: path.join(dataDir, "tmp"),
    // Shared by api and web so the API honours the proxy's X-Forwarded-Host (CSRF origin check) and client IP.
    NOCON_PROXY_SECRET: crypto.randomBytes(24).toString("hex"),
    FAKE_YTDLP_CATALOG: catalogPath,
    YTDLP_PATH: path.join(ROOT, "tests/fixtures/fake-yt-dlp.mjs"),
    CONNECTIVITY_CHECK_URLS: `http://127.0.0.1:${CONN_PORT}/`,
    CONNECTIVITY_INTERVAL_SEC: "5",
    SCHEDULER_INTERVAL_SEC: "5",
  };

  const procs: ChildProcess[] = [];
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-e2e-logs-"));
  process.env.E2E_LOG_DIR = logDir;
  const start = (name: string, cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const out = fs.openSync(path.join(logDir, `${name}.log`), "a");
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extra }, stdio: ["ignore", out, out], detached: true });
    procs.push(p);
    return p;
  };

  const teardown = async () => {
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {}
    }
    conn.close();
    try {
      const c = new pg.Client({ connectionString: PG_ADMIN });
      await c.connect();
      await c.query("DROP DATABASE IF EXISTS e2e WITH (FORCE)");
      await c.end();
    } catch {}
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  };

  try {
    start("api", process.execPath, ["apps/api/dist/index.js"]);
    await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, 60_000, "api");
    start("worker", process.execPath, ["apps/worker/dist/index.js"]);

    // Private build directory so concurrent builds of apps/web elsewhere cannot corrupt the served bundle.
    const webEnv = { ...env, NEXT_DIST_DIR: ".next-e2e" };
    if (process.env.E2E_REBUILD || !fs.existsSync(path.join(ROOT, "apps/web/.next-e2e/BUILD_ID"))) {
      execFileSync("pnpm", ["--filter", "@nocon/web", "build"], { cwd: ROOT, stdio: "inherit", env: webEnv });
    }
    start("web", "pnpm", ["--filter", "@nocon/web", "exec", "next", "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"], {
      NEXT_DIST_DIR: ".next-e2e",
      API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
      NODE_ENV: "production",
    });
    await waitFor(`http://127.0.0.1:${WEB_PORT}/login`, 60_000, "web");
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
