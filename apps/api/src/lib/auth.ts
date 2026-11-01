import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import * as s from "@nocon/database";
import { clientIp } from "./clientip.js";
import { HttpError, type Deps } from "./core.js";

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

/** At most MAX_SCRYPT scrypt operations run at once (each needs ~32 MiB and a libuv thread); the rest queue. */
export const MAX_SCRYPT = 2;
let scryptActive = 0;
let scryptStarted = 0;
const scryptQueue: Array<() => void> = [];
export function scryptStats() { return { active: scryptActive, queued: scryptQueue.length, started: scryptStarted }; }

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (scryptActive >= MAX_SCRYPT) await new Promise<void>((res) => scryptQueue.push(res));
  else scryptActive++;
  scryptStarted++;
  try { return await fn(); } finally {
    const next = scryptQueue.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else scryptActive--;
  }
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return withScryptSlot(() => new Promise<Buffer>((res, rej) => scrypt(password, salt, KEYLEN, SCRYPT, (e, k) => (e ? rej(e) : res(k)))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, , , , saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const COOKIE = "nocon_session";
const SESSION_MS = 30 * 24 * 3600_000;
/** Absolute lifetime: a session never lives longer than this, however often it is used. */
export const SESSION_MAX_MS = 90 * 24 * 3600_000;

export interface AuthInfo { userId: string; username: string; sessionId: string }
declare module "fastify" {
  interface FastifyRequest { auth?: AuthInfo }
}

export function setSessionCookie(d: Deps, reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: d.config.COOKIE_SECURE, path: "/", maxAge: SESSION_MS / 1000,
  });
}

export async function createSession(d: Deps, req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await d.db.insert(s.sessions).values({
    id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_MS),
    ip: clientIp(req), userAgent: (req.headers["user-agent"] ?? "").slice(0, 300) || null,
  });
  setSessionCookie(d, reply, token);
}

/** Resolves the session cookie; slides expiry and lastSeenAt at most once a minute. */
export async function loadAuth(d: Deps, req: FastifyRequest, reply?: FastifyReply): Promise<AuthInfo | null> {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const [row] = await d.db.select({ sess: s.sessions, username: s.users.username }).from(s.sessions)
    .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
    .where(and(eq(s.sessions.id, id), isNull(s.sessions.revokedAt), gt(s.sessions.expiresAt, new Date())));
  if (!row) return null;
  const absoluteEnd = row.sess.createdAt.getTime() + SESSION_MAX_MS;
  if (Date.now() >= absoluteEnd) return null;
  if (Date.now() - row.sess.lastSeenAt.getTime() > 60_000) {
    const expiresAt = new Date(Math.min(Date.now() + SESSION_MS, absoluteEnd));
    await d.db.update(s.sessions).set({ lastSeenAt: new Date(), expiresAt }).where(eq(s.sessions.id, id));
    if (reply) setSessionCookie(d, reply, token);
  }
  return { userId: row.sess.userId, username: row.username, sessionId: id };
}

export function requireAuthHook(d: Deps) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const a = await loadAuth(d, req, reply);
    if (!a) throw new HttpError(401, "unauthorized", "Sign in required");
    req.auth = a;
  };
}

/**
 * In-memory login throttle: 5 attempts/min per IP and 20/hour per username.
 * check() records the attempt immediately (before the slow password hash), so concurrent requests
 * cannot all slip under the limit; clear() forgives the attempt after a successful sign-in.
 */
export const THROTTLE_MAX_KEYS = 10_000;
export class LoginThrottle {
  private byIp = new Map<string, number[]>();
  private byUser = new Map<string, number[]>();
  private lastSweep = 0;

  private prune(list: number[] | undefined, windowMs: number) {
    const cutoff = Date.now() - windowMs;
    return (list ?? []).filter((t) => t > cutoff);
  }

  private sweep(map: Map<string, number[]>, windowMs: number) {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of map) if (!v.length || v[v.length - 1]! <= cutoff) map.delete(k);
    // Still over the cap (a flood of fresh keys): drop the oldest-inserted ones.
    for (const k of map.keys()) {
      if (map.size < THROTTLE_MAX_KEYS) break;
      map.delete(k);
    }
  }

  private maintain() {
    const now = Date.now();
    if (this.byIp.size < THROTTLE_MAX_KEYS && this.byUser.size < THROTTLE_MAX_KEYS && now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    this.sweep(this.byIp, 60_000);
    this.sweep(this.byUser, 3600_000);
  }

  /** Returns seconds to wait (0 = allowed, and the attempt has been recorded). */
  check(ip: string, username: string): number {
    this.maintain();
    const u = username.toLowerCase();
    const a = this.prune(this.byIp.get(ip), 60_000);
    const b = this.prune(this.byUser.get(u), 3600_000);
    let wait = 0;
    if (a.length >= 5) wait = Math.ceil((a[0]! + 60_000 - Date.now()) / 1000);
    else if (b.length >= 20) wait = Math.ceil((b[0]! + 3600_000 - Date.now()) / 1000);
    if (wait === 0) { a.push(Date.now()); b.push(Date.now()); }
    this.byIp.set(ip, a);
    this.byUser.set(u, b);
    return Math.max(wait, 0);
  }
  /** Failures are already recorded by check(); kept so callers read naturally. */
  fail(_ip: string, _username: string) { /* recorded in check() */ }
  /** Successful sign-in: forget this attempt and earlier failures for the IP and username. */
  clear(ip: string, username: string) {
    this.byIp.delete(ip);
    this.byUser.delete(username.toLowerCase());
  }
  size() { return { ips: this.byIp.size, users: this.byUser.size }; }
}
