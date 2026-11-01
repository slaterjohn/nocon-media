import { clientIp } from "../lib/clientip.js";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { logActivity, recomputeEffectivePriority } from "@nocon/database";
import { identifySource } from "@nocon/source-adapters";
import { badRequest, getAppSettings, HttpError, hostOf, idParam, iso, notFound, parse, parseBody, type Deps } from "../lib/core.js";
import { safeEqualHex, sha256 } from "../lib/auth.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomString(alphabet: string, n: number): string {
  // rejection sampling keeps the distribution uniform
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < n) for (const b of randomBytes(n * 2)) if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
  return out;
}

export function serverUrl(d: Deps, req: FastifyRequest): string {
  if (d.config.PUBLIC_XTREAM_URL) return d.config.PUBLIC_XTREAM_URL.replace(/\/+$/, "");
  const host = hostOf(req);
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return `${req.protocol}://${hostname}:${d.config.API_PORT_PUBLIC ?? d.config.API_PORT}`;
}

type ClientRow = typeof s.externalClients.$inferSelect;
const dto = (c: ClientRow) => ({
  id: c.id, name: c.name, kind: c.kind, username: c.username, status: c.status, allowXtream: c.allowXtream, allowM3u: c.allowM3u,
  lastUsedAt: iso(c.lastUsedAt), lastIp: c.lastIp, createdAt: iso(c.createdAt), rotatedAt: iso(c.rotatedAt),
});

function credentials(d: Deps, req: FastifyRequest, c: ClientRow, password: string) {
  const server = serverUrl(d, req);
  const isXtream = c.kind === "xtream";
  return {
    client: dto(c), password,
    m3uUrl: isXtream ? `${server}/get.php?username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=mp4` : null,
    xtream: isXtream ? { server, username: c.username, password } : null,
  };
}

export async function clientRoutes(app: FastifyInstance, d: Deps) {
  const load = async (id: string) => {
    const [c] = await d.db.select().from(s.externalClients).where(and(eq(s.externalClients.id, id), ne(s.externalClients.status, "revoked")));
    if (!c) throw notFound("Client not found");
    return c;
  };

  app.get("/api/clients", async (req) => {
    const rows = await d.db.select().from(s.externalClients).where(ne(s.externalClients.status, "revoked")).orderBy(asc(s.externalClients.createdAt));
    const st = await getAppSettings(d);
    return { items: rows.map(dto), serverUrl: serverUrl(d, req), xtreamEnabled: st.enableXtream, m3uEnabled: st.enableM3u };
  });

  app.post("/api/clients", async (req) => {
    const b = parseBody(req, z.object({
      name: z.string().trim().min(1).max(100), kind: z.enum(["xtream", "extension"]).default("xtream"),
      allowXtream: z.boolean().optional(), allowM3u: z.boolean().optional(),
    }));
    const password = randomString(ALNUM, 24);
    const [c] = await d.db.insert(s.externalClients).values({
      name: b.name, kind: b.kind, username: `nc-${randomString(LOWER, 6)}`, secretHash: sha256(password),
      allowXtream: b.allowXtream ?? true, allowM3u: b.allowM3u ?? true,
    }).returning();
    await logActivity(d.db, { type: "client.created", message: `External client "${b.name}" created`, entityType: "client", entityId: c!.id, data: { kind: b.kind, username: c!.username } });
    return credentials(d, req, c!, password);
  });

  app.post("/api/clients/:id/rotate", async (req) => {
    const { id } = parse(idParam, req.params);
    const cur = await load(id);
    const password = randomString(ALNUM, 24);
    const [c] = await d.db.update(s.externalClients).set({ secretHash: sha256(password), rotatedAt: new Date() }).where(eq(s.externalClients.id, cur.id)).returning();
    await logActivity(d.db, { type: "client.rotated", message: `Credentials for "${cur.name}" rotated`, entityType: "client", entityId: id });
    return credentials(d, req, c!, password);
  });

  app.patch("/api/clients/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parseBody(req, z.object({
      name: z.string().trim().min(1).max(100).optional(), status: z.enum(["active", "disabled"]).optional(),
      allowXtream: z.boolean().optional(), allowM3u: z.boolean().optional(),
    }));
    const cur = await load(id);
    const [c] = await d.db.update(s.externalClients).set(b).where(eq(s.externalClients.id, id)).returning();
    await logActivity(d.db, { type: "client.updated", message: `External client "${cur.name}" updated`, entityType: "client", entityId: id, data: { fields: Object.keys(b) } });
    return { client: dto(c!) };
  });

  app.delete("/api/clients/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const cur = await load(id);
    await d.db.update(s.externalClients).set({ status: "revoked", revokedAt: new Date() }).where(eq(s.externalClients.id, id));
    await logActivity(d.db, { type: "client.revoked", message: `External client "${cur.name}" revoked`, entityType: "client", entityId: id });
    return { ok: true };
  });
}

export async function extensionRoutes(app: FastifyInstance, d: Deps) {
  app.post("/api/ext/watch", async (req) => {
    const m = /^Bearer\s+([^:\s]+):(.+)$/i.exec(req.headers.authorization ?? "");
    let client: ClientRow | undefined;
    if (m) [client] = await d.db.select().from(s.externalClients).where(eq(s.externalClients.username, m[1]!));
    const ok = !!client && client.kind === "extension" && client.status === "active" && safeEqualHex(client.secretHash, sha256(m![2]!));
    if (!ok) throw new HttpError(401, "unauthorized", "Invalid extension credentials");
    const b = parseBody(req, z.object({
      url: z.string().max(2000).optional(), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
      watchedAt: z.coerce.date().optional(), progressSeconds: z.number().min(0).optional(),
    }));
    let videoId = b.videoId;
    if (!videoId && b.url) {
      const id = identifySource(b.url);
      if (id?.type === "video") videoId = id.externalId;
    }
    if (!videoId) throw badRequest("Provide a YouTube videoId or video url.");
    const key = `youtube:${videoId}`;
    const [media] = await d.db.select().from(s.media).where(eq(s.media.canonicalKey, key));
    await d.db.insert(s.watchEvents).values({
      canonicalKey: key, mediaId: media?.id ?? null, watchedAt: b.watchedAt ?? new Date(), origin: "extension",
      progressSeconds: b.progressSeconds ?? null,
    }).onConflictDoNothing();
    if (media) await recomputeEffectivePriority(d.db, media.id);
    await d.db.update(s.externalClients).set({ lastUsedAt: new Date(), lastIp: clientIp(req) }).where(eq(s.externalClients.id, client!.id));
    return { ok: true, mediaId: media?.id ?? null };
  });
  void sql;
}
