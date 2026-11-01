import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { redactUrl } from "@nocon/shared";
import { HttpError, isSetupComplete, type Deps } from "./lib/core.js";
import { clientIp, forwardedHost } from "./lib/clientip.js";
import { LoginThrottle, requireAuthHook } from "./lib/auth.js";
import { setupRoutes, authRoutes } from "./routes/auth.js";
import { sourceRoutes } from "./routes/sources.js";
import { downloadRoutes } from "./routes/downloads.js";
import { libraryRoutes } from "./routes/library.js";
import { mediaRoutes } from "./routes/media.js";
import { collectionRoutes } from "./routes/collections.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { storageRoutes } from "./routes/storage.js";
import { clientRoutes, extensionRoutes } from "./routes/clients.js";
import { activityRoutes } from "./routes/activity.js";
import { systemRoutes } from "./routes/system.js";
import { xtreamRoutes } from "./routes/xtream.js";

export interface BuildOptions { logStream?: Writable }

const STREAMING = /^\/api\/(media\/[^/]+\/(stream|thumbnail|subtitles|hls)\b|creators\/[^/]+\/(avatar|banner))/;
const XTREAM = /^\/(player_api\.php|get\.php|xmltv\.php|xtream-art)\b/;
/** Xtream stream URLs: players issue many range requests per playback, so they get their own, higher limit. */
const XTREAM_MOVIE = /^\/movie\//;
const CSRF_EXEMPT = new Set(["/api/ext/watch"]);
const GATE_EXEMPT = /^\/api\/(setup|auth)\//;

function originAllowed(req: FastifyRequest, allowedOrigins: Set<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = (forwardedHost(req) ?? req.headers.host ?? "").split(",")[0]!.trim().toLowerCase();
  try {
    const o = new URL(origin);
    if (o.host.toLowerCase() === expected) return true;
    // Fallback for deployments without NOCON_PROXY_SECRET: accept the configured public app origin(s).
    return allowedOrigins.has(o.origin.toLowerCase());
  } catch { return false; }
}

export async function buildApp(d: Deps, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: d.config.LOG_LEVEL,
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      redact: { paths: ["req.headers.cookie", "req.headers.authorization", "password", "*.password"], censor: "***" },
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string; hostname?: string; socket?: { remoteAddress?: string } }) => ({
          method: req.method, url: redactUrl(req.url ?? ""), hostname: req.hostname, remoteAddress: req.ip ?? req.socket?.remoteAddress,
        }),
      },
    },
    trustProxy: d.config.TRUST_PROXY && d.config.TRUSTED_PROXY_CIDRS.length ? d.config.TRUSTED_PROXY_CIDRS : d.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  const allowedOrigins = new Set<string>();
  for (const u of [d.config.APP_URL, ...d.config.ALLOWED_ORIGINS]) {
    try { allowedOrigins.add(new URL(u).origin.toLowerCase()); } catch { /* ignore invalid entries */ }
  }
  app.decorate("proxySecret", d.config.NOCON_PROXY_SECRET ?? "");
  app.decorate("trustProxyEnabled", d.config.TRUST_PROXY);
  const throttle = new LoginThrottle();
  app.decorate("loginThrottle", throttle);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: (req) => (XTREAM_MOVIE.test(req.url) ? 3000 : XTREAM.test(req.url) ? 300 : 600),
    timeWindow: "1 minute",
    keyGenerator: (req) => `${XTREAM_MOVIE.test(req.url) ? "m" : XTREAM.test(req.url) ? "x" : "a"}:${clientIp(req)}`,
    allowList: (req) => !(req.url.startsWith("/api") || XTREAM.test(req.url) || XTREAM_MOVIE.test(req.url)) || STREAMING.test(req.url.split("?")[0]!),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: "rate_limited", message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.` }),
  });

  // An empty JSON body (e.g. POST with Content-Type: application/json and no payload) is treated as "no body".
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch { done(new HttpError(400, "bad_request", "Body is not valid JSON")); }
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // ---- security headers on JSON responses (file responses set their own in @nocon/streaming)
  app.addHook("onSend", async (req, reply, payload) => {
    const ct = String(reply.getHeader("content-type") ?? "");
    if (ct.startsWith("application/json")) {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "no-referrer");
    }
    if (req.url.startsWith("/api")) reply.header("X-Frame-Options", "DENY");
    return payload;
  });

  // ---- CSRF + setup gate (all /api routes)
  let setupDone = false;
  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0]!;
    if (!url.startsWith("/api")) return;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !CSRF_EXEMPT.has(url)) {
      if (req.headers["x-nocon-csrf"] !== "1") throw new HttpError(403, "csrf", "Missing X-NoCon-CSRF header");
      if (!originAllowed(req, allowedOrigins)) throw new HttpError(403, "csrf", "Origin does not match host");
    }
    if (GATE_EXEMPT.test(url) || url === "/api/ext/watch") return;
    if (!setupDone) setupDone = await isSetupComplete(d);
    if (!setupDone) throw new HttpError(409, "setup_required", "Finish the setup wizard first");
  });

  // ---- error handling
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: "bad_request", message: "Invalid request", details: err.issues });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: { message: err.message, stack: d.config.NODE_ENV === "production" ? undefined : err.stack } }, "request failed");
      return reply.code(500).send({ error: "internal", message: d.config.NODE_ENV === "production" ? "Internal server error" : err.message });
    }
    const codes: Record<number, string> = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "bad_request", 415: "bad_request", 429: "rate_limited" };
    return reply.code(status).send({ error: codes[status] ?? "bad_request", message: err.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found", message: "Route not found" }));

  // ---- public
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try { await d.pool.query("select 1"); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });
  await app.register(async (a) => { await xtreamRoutes(a, d); });
  await app.register(async (a) => { await extensionRoutes(a, d); });
  await app.register(async (a) => { await setupRoutes(a, d); await authRoutes(a, d, throttle); });

  // ---- authenticated admin API
  await app.register(async (a) => {
    a.addHook("onRequest", requireAuthHook(d));
    await sourceRoutes(a, d);
    await downloadRoutes(a, d);
    await libraryRoutes(a, d);
    await mediaRoutes(a, d);
    await collectionRoutes(a, d);
    await discoveryRoutes(a, d);
    await storageRoutes(a, d);
    await clientRoutes(a, d);
    await activityRoutes(a, d);
    await systemRoutes(a, d);
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance { loginThrottle: LoginThrottle }
}
