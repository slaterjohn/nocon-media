// Shared helpers for tests/integration/api-*.test.ts. Lives here because tests may only add api*.test.ts files.
import os from "node:os";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../../packages/shared/src/index.js";
import { buildApp } from "../src/app.js";
import { closeRuntime, createRuntime, type Deps } from "../src/lib/core.js";
import { createTestDb, type TestDb } from "../../../tests/integration/helpers/index.js";
import { setSetting } from "../../../packages/database/src/index.js";

export interface Harness {
  app: FastifyInstance;
  deps: Deps;
  tdb: TestDb;
  logs: string[];
  close(): Promise<void>;
}

export interface Reply { status: number; body: any; headers: Record<string, any>; raw: Buffer; text: string }

export async function startApi(env: Record<string, string> = {}): Promise<Harness> {
  const tdb = await createTestDb();
  const config = loadConfig({
    DATABASE_URL: tdb.url, REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379",
    NODE_ENV: "test", LOG_LEVEL: "info", MEDIA_ROOTS_ALLOWED: os.tmpdir(), ...env,
  } as NodeJS.ProcessEnv);
  const deps = createRuntime(config, tdb.db, tdb.pool as never);
  const logs: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, cb) { logs.push(String(chunk)); cb(); } });
  const app = await buildApp(deps, { logStream });
  await app.ready();
  return {
    app, deps, tdb, logs,
    async close() {
      await app.close();
      await closeRuntime(deps);
      await tdb.drop();
    },
  };
}

/** Minimal cookie-jar client around app.inject. Adds the CSRF header to mutations. */
export class Client {
  cookie = "";
  constructor(private app: FastifyInstance, private opts: { csrf?: boolean } = {}) {}

  async call(method: string, url: string, o: { body?: unknown; headers?: Record<string, string>; remoteAddress?: string; payload?: Buffer | string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== "GET" && method !== "HEAD" && this.opts.csrf !== false && !("x-nocon-csrf" in headers)) headers["x-nocon-csrf"] = "1";
    const res = await this.app.inject({
      method: method as never, url, headers, remoteAddress: o.remoteAddress,
      ...(o.payload !== undefined ? { payload: o.payload } : o.body !== undefined ? { payload: JSON.stringify(o.body), headers: { ...headers, "content-type": "application/json" } } : {}),
    });
    const set = res.headers["set-cookie"];
    if (set) {
      const arr = Array.isArray(set) ? set : [set];
      for (const c of arr) {
        const kv = c.split(";")[0]!;
        if (/=;?$/.test(kv) || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookie = "";
        else this.cookie = kv;
      }
    }
    let body: any = null;
    const text = res.body;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.statusCode, body, headers: res.headers as Record<string, any>, raw: res.rawPayload, text };
  }
  get = (url: string, o = {}) => this.call("GET", url, o);
  post = (url: string, body?: unknown, o = {}) => this.call("POST", url, { body: body ?? {}, ...o });
  patch = (url: string, body?: unknown, o = {}) => this.call("PATCH", url, { body: body ?? {}, ...o });
  put = (url: string, body?: unknown, o = {}) => this.call("PUT", url, { body: body ?? {}, ...o });
  del = (url: string, o = {}) => this.call("DELETE", url, o);
}

/** Creates the admin and marks setup complete without walking through the wizard. */
export async function adminClient(h: Harness, username = "admin", password = "correct horse battery"): Promise<Client> {
  const c = new Client(h.app);
  const r = await c.post("/api/setup/admin", { username, password });
  if (r.status !== 200) throw new Error(`setup admin failed: ${r.status} ${r.text}`);
  await setSetting(h.tdb.db, "setup", { complete: true, completedAt: new Date().toISOString() });
  return c;
}
