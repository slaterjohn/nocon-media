import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, isNull, ne, sql, like } from "drizzle-orm";
import * as s from "@nocon/database";
import { logActivity, setSetting } from "@nocon/database";
import { RESOLUTIONS } from "@nocon/shared";
import {
  HttpError, parseBody, parse, conflict, iso, getAppSettings, saveAppSettings, withTimeout, type Deps,
} from "../lib/core.js";
import { clientIp } from "../lib/clientip.js";
import { COOKIE, createSession, hashPassword, loadAuth, requireAuthHook, verifyPassword, type LoginThrottle } from "../lib/auth.js";
import { registerVolume, validateStoragePath } from "../lib/volumes.js";
import { toVolumes } from "../lib/serialize.js";

const usernameSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.@-]+$/, "Use letters, numbers and . _ @ - only");
const passwordSchema = z.string().min(10, "Password must be at least 10 characters").max(256);

async function hasAdmin(d: Deps): Promise<boolean> {
  const [r] = await d.db.select({ n: sql<number>`count(*)::int` }).from(s.users);
  return (r?.n ?? 0) > 0;
}

export async function readHeartbeat(d: Deps): Promise<{ at: string; paused?: boolean; [k: string]: unknown } | null> {
  try {
    const raw = await withTimeout(d.redis.get("nocon:worker:heartbeat"), 1500);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function setupRoutes(app: FastifyInstance, d: Deps) {
  /** Setup routes work while no admin exists, or for a logged-in admin. */
  const guard = async (req: FastifyRequest) => {
    if (!(await hasAdmin(d))) return;
    if (!(await loadAuth(d, req))) throw new HttpError(401, "unauthorized", "Sign in required");
  };

  app.get("/api/setup/status", async () => {
    const admin = await hasAdmin(d);
    const [vol] = await d.db.select({ id: s.storageVolumes.id }).from(s.storageVolumes).limit(1);
    const [setup] = await d.db.select().from(s.settings).where(eq(s.settings.key, "setup"));
    const [appRow] = await d.db.select().from(s.settings).where(eq(s.settings.key, "app"));
    return {
      setupComplete: (setup?.value as { complete?: boolean } | undefined)?.complete === true,
      hasAdmin: admin, steps: { admin, storage: !!vol, profile: !!appRow },
      defaultMediaPath: d.config.MEDIA_ROOT,
    };
  });

  app.post("/api/setup/admin", async (req, reply) => {
    const body = parseBody(req, z.object({ username: usernameSchema, password: passwordSchema }));
    if (await hasAdmin(d)) throw conflict("An administrator already exists");
    const hash = await hashPassword(body.password);
    const user = await d.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(727003)`);
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.users);
      if ((r?.n ?? 0) > 0) throw conflict("An administrator already exists");
      const [u] = await tx.insert(s.users).values({ username: body.username, passwordHash: hash, lastLoginAt: new Date() }).returning();
      return u!;
    });
    await createSession(d, req, reply, user.id);
    await logActivity(d.db, { type: "auth.admin_created", message: `Administrator "${user.username}" created`, entityType: "user", entityId: user.id });
    return { user: { id: user.id, username: user.username } };
  });

  app.get("/api/setup/checks", { preHandler: guard }, async () => {
    let db: { ok: boolean; message: string };
    try { await d.pool.query("select 1"); db = { ok: true, message: "Connected" }; } catch (e) { db = { ok: false, message: (e as Error).message }; }
    let redis = { ok: false };
    try { await withTimeout(d.redis.ping(), 1500); redis = { ok: true }; } catch { /* down */ }
    const hb = await readHeartbeat(d);
    return { database: db, redis, worker: { ok: !!hb, lastHeartbeat: hb?.at ?? null } };
  });

  app.post("/api/setup/storage/validate", { preHandler: guard }, async (req) => {
    const body = parseBody(req, z.object({ path: z.string().min(1).max(1024), name: z.string().max(100).optional() }));
    return (await validateStoragePath(d, body.path)).result;
  });

  app.post("/api/setup/storage", { preHandler: guard }, async (req) => {
    const body = parseBody(req, z.object({ path: z.string().min(1).max(1024), name: z.string().trim().min(1).max(100) }));
    return { volume: await registerVolume(d, body.path, body.name) };
  });

  app.post("/api/setup/complete", { preHandler: guard }, async (req) => {
    const body = parseBody(req, z.object({
      profile: z.enum(["lightweight", "standard"]),
      defaultResolution: z.number().int().refine((n) => (RESOLUTIONS as readonly number[]).includes(n), "Unsupported resolution"),
      softThreshold: z.number().int().min(50).max(99),
      minFreePercent: z.number().int().min(1).max(50),
      enableXtream: z.boolean(), enableM3u: z.boolean(),
    }));
    if (!(await hasAdmin(d))) throw new HttpError(400, "bad_request", "Create the administrator first");
    const vols = await toVolumes(d);
    if (!vols.length) throw new HttpError(400, "bad_request", "Add a storage folder first");
    const cur = await getAppSettings(d, true);
    await saveAppSettings(d, { ...cur, ...body });
    await setSetting(d.db, "setup", { complete: true, completedAt: new Date().toISOString() });
    await logActivity(d.db, { type: "setup.completed", message: "Setup completed" });
    return { ok: true };
  });
}

let dummyHash: Promise<string> | undefined;

export async function authRoutes(app: FastifyInstance, d: Deps, throttle: LoginThrottle) {
  const auth = requireAuthHook(d);

  app.post("/api/auth/login", async (req, reply) => {
    const body = parseBody(req, z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(256) }));
    const ip = clientIp(req);
    const wait = throttle.check(ip, body.username);
    if (wait > 0) {
      reply.header("Retry-After", String(wait));
      throw new HttpError(429, "rate_limited", `Too many sign-in attempts. Try again in ${wait}s.`);
    }
    const [u] = await d.db.select().from(s.users).where(eq(s.users.username, body.username));
    dummyHash ??= hashPassword("not-a-real-password");
    const ok = await verifyPassword(body.password, u?.passwordHash ?? (await dummyHash));
    if (!u || !ok) {
      throttle.fail(ip, body.username);
      await logActivity(d.db, { type: "auth.login_failed", severity: "warning", message: "Failed sign-in attempt", data: { ip } });
      throw new HttpError(401, "unauthorized", "Wrong username or password");
    }
    throttle.clear(ip, body.username);
    await createSession(d, req, reply, u.id);
    await d.db.update(s.users).set({ lastLoginAt: new Date() }).where(eq(s.users.id, u.id));
    return { user: { id: u.id, username: u.username } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const a = await loadAuth(d, req);
    if (a) await d.db.update(s.sessions).set({ revokedAt: new Date() }).where(eq(s.sessions.id, a.sessionId));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: auth }, async (req) => ({ user: { id: req.auth!.userId, username: req.auth!.username } }));

  app.get("/api/auth/sessions", { preHandler: auth }, async (req) => {
    const rows = await d.db.select().from(s.sessions)
      .where(and(eq(s.sessions.userId, req.auth!.userId), isNull(s.sessions.revokedAt), sql`${s.sessions.expiresAt} > now()`))
      .orderBy(sql`${s.sessions.lastSeenAt} desc`);
    return {
      items: rows.map((r) => ({
        id: r.id.slice(0, 16), createdAt: iso(r.createdAt), lastSeenAt: iso(r.lastSeenAt), ip: r.ip, userAgent: r.userAgent,
        current: r.id === req.auth!.sessionId,
      })),
    };
  });

  app.delete("/api/auth/sessions/:id", { preHandler: auth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/) }), req.params);
    const res = await d.db.update(s.sessions).set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, req.auth!.userId), like(s.sessions.id, `${id}%`), isNull(s.sessions.revokedAt)))
      .returning({ id: s.sessions.id });
    if (!res.length) throw new HttpError(404, "not_found", "Session not found");
    return { ok: true };
  });

  app.delete("/api/auth/sessions", { preHandler: auth }, async (req) => {
    await d.db.update(s.sessions).set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, req.auth!.userId), ne(s.sessions.id, req.auth!.sessionId), isNull(s.sessions.revokedAt)));
    return { ok: true };
  });

  app.post("/api/auth/password", { preHandler: auth }, async (req) => {
    const body = parseBody(req, z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }));
    const [u] = await d.db.select().from(s.users).where(eq(s.users.id, req.auth!.userId));
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) throw new HttpError(400, "bad_request", "Current password is wrong");
    await d.db.update(s.users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(s.users.id, u.id));
    await d.db.update(s.sessions).set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, u.id), ne(s.sessions.id, req.auth!.sessionId), isNull(s.sessions.revokedAt)));
    await logActivity(d.db, { type: "auth.password_changed", message: "Administrator password changed", entityType: "user", entityId: u.id });
    return { ok: true };
  });
}
