import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as s from "@nocon/database";
import { redactUrl, resolveInside } from "@nocon/shared";
import { serveFile, mimeFor } from "@nocon/streaming";
import { sha256 } from "./auth.js";
import { type Deps } from "./core.js";

export interface ResolvedFile { abs: string; mime: string }

/** Absolute path of a media file iff its volume is online and the file exists. */
export async function resolveMediaFile(d: Deps, mediaId: string, kinds: Array<typeof s.mediaFiles.$inferSelect["kind"]>, fileId?: string): Promise<ResolvedFile | null> {
  const rows = await d.db.select({ f: s.mediaFiles, v: s.storageVolumes }).from(s.mediaFiles)
    .innerJoin(s.storageVolumes, eq(s.storageVolumes.id, s.mediaFiles.volumeId))
    .where(and(eq(s.mediaFiles.mediaId, mediaId), inArray(s.mediaFiles.kind, kinds), ...(fileId ? [eq(s.mediaFiles.id, fileId)] : [])))
    .orderBy(asc(s.mediaFiles.createdAt));
  const order = (k: string) => kinds.indexOf(k as never);
  rows.sort((a, b) => order(a.f.kind) - order(b.f.kind));
  const row = rows[0];
  if (!row || !row.v.isOnline) return null;
  const [m] = await d.db.select({ availability: s.media.availability }).from(s.media).where(eq(s.media.id, mediaId));
  if (!m || (kinds.includes("video") && m.availability !== "available")) return null;
  try {
    const abs = resolveInside(row.v.mountPath, row.f.relativePath);
    if (!fs.statSync(abs).isFile()) return null;
    return { abs, mime: row.f.mimeType && kinds.includes("video") ? mimeForVideo(abs, row.f.mimeType) : mimeFor(abs) };
  } catch { return null; }
}

function mimeForVideo(abs: string, _stored: string): string {
  return mimeFor(abs); // trust the extension of the real file over stored metadata
}

/** Streams a file on the raw socket. Fastify hooks (cookies, rate limit headers) no longer apply after hijack. */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, abs: string, mime?: string, cacheControl?: string) {
  reply.hijack();
  // Hijacked responses skip Fastify's onResponse logging, so log completion here.
  let logged = false;
  const done = () => {
    if (logged) return;
    logged = true;
    req.log.info({
      req: { method: req.method, url: redactUrl(req.url) }, statusCode: reply.raw.statusCode,
      ranged: typeof req.headers.range === "string", aborted: !reply.raw.writableFinished,
    }, "request completed");
  };
  reply.raw.once("finish", done);
  reply.raw.once("close", done);
  await serveFile(req.raw, reply.raw, abs, { mime: mime ?? mimeFor(abs), cacheControl });
}

const lastSeen = new Map<string, number>();

/** Upserts a stream_sessions row, at most once per 15 s per session. */
export async function recordStream(d: Deps, o: { clientType: "web" | "xtream" | "m3u"; clientId: string; mediaId: string; ip: string }) {
  const id = sha256(`${o.clientType}${o.clientId}${o.mediaId}${o.ip}`);
  const now = Date.now();
  if (now - (lastSeen.get(id) ?? 0) < 15_000) return;
  lastSeen.set(id, now);
  if (lastSeen.size > 5000) for (const [k, t] of lastSeen) if (now - t > 60_000) lastSeen.delete(k);
  try {
    await d.db.insert(s.streamSessions).values({ id, mediaId: o.mediaId, clientType: o.clientType, clientId: o.clientId, ip: o.ip })
      .onConflictDoUpdate({ target: s.streamSessions.id, set: { lastSeenAt: sql`now()` } });
  } catch { /* streaming must not fail because of bookkeeping */ }
}

export { path };
