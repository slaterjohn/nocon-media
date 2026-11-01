import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    /** NOCON_PROXY_SECRET, or "" when unset. */
    proxySecret: string;
    /** True when TRUST_PROXY=true (Fastify then validates X-Forwarded-* itself). */
    trustProxyEnabled: boolean;
  }
}

const verified = new WeakMap<FastifyRequest, boolean>();

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** True when the request carries the shared proxy secret (i.e. it really came from the NoConMedia web proxy). */
export function proxyVerified(req: FastifyRequest): boolean {
  const cached = verified.get(req);
  if (cached !== undefined) return cached;
  const secret = req.server.proxySecret;
  let ok = false;
  const given = header(req, "x-nocon-proxy-secret");
  if (secret && given) {
    const a = Buffer.from(given), b = Buffer.from(secret);
    ok = a.length === b.length && timingSafeEqual(a, b);
  }
  verified.set(req, ok);
  return ok;
}

/** The caller's IP: x-nocon-client-ip when the proxy secret matches, otherwise the socket/trusted-proxy address. */
export function clientIp(req: FastifyRequest): string {
  if (proxyVerified(req)) {
    const ip = header(req, "x-nocon-client-ip")?.trim();
    if (ip && isIP(ip)) return ip;
  }
  return req.ip;
}

/** X-Forwarded-Host is only honoured behind a trusted proxy (TRUST_PROXY=true) or with a valid proxy secret. */
export function forwardedHost(req: FastifyRequest): string | undefined {
  if (!req.server.trustProxyEnabled && !proxyVerified(req)) return undefined;
  const v = header(req, "x-forwarded-host");
  return v ? v.split(",")[0]!.trim() : undefined;
}
