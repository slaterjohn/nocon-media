import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientIp } from "../lib/clientip.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as s from "@nocon/database";
import { ipAllowed, resolveInside } from "@nocon/shared";
import {
  authFailed, authResponse, emptyList, m3uPlaylist, shortEpg, vodCategories, vodInfo, vodStreams, xmltvEmpty,
  type ServerCtx, type XtreamUser,
} from "@nocon/xtream";
import { effectiveCidrs, getAppSettings, hostOf, type Deps } from "../lib/core.js";
import { safeEqualHex, sha256 } from "../lib/auth.js";
import { buildCatalog } from "../lib/xtream.js";
import { recordStream, resolveMediaFile, sendFile } from "../lib/serve.js";
import { eq as _eq } from "drizzle-orm";

type Client = typeof s.externalClients.$inferSelect;

export function publicBase(d: Deps, req: FastifyRequest): string {
  if (d.config.PUBLIC_XTREAM_URL) return d.config.PUBLIC_XTREAM_URL.replace(/\/+$/, "");
  return `${req.protocol}://${hostOf(req)}`;
}

export function serverCtx(d: Deps, req: FastifyRequest): ServerCtx {
  const u = new URL(publicBase(d, req));
  const protocol = u.protocol === "https:" ? "https" : "http";
  return {
    host: u.hostname, port: Number(u.port || (protocol === "https" ? 443 : 80)), protocol,
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", now: new Date(),
  };
}

/** Looks up an Xtream/M3U client; always does the hash compare so timing does not reveal valid usernames. */
export async function authClient(d: Deps, req: FastifyRequest, username: string | undefined, password: string | undefined, need: "xtream" | "m3u"): Promise<Client | null> {
  if (!username || !password) return null;
  const [c] = await d.db.select().from(s.externalClients).where(eq(s.externalClients.username, username));
  const match = safeEqualHex(c?.secretHash ?? sha256("x".repeat(24)), sha256(password));
  if (!c || !match || c.status !== "active" || c.kind !== "xtream") return null;
  if (need === "xtream" && !c.allowXtream) return null;
  if (need === "m3u" && !c.allowM3u) return null;
  if (!c.lastUsedAt || Date.now() - c.lastUsedAt.getTime() > 60_000) {
    await d.db.update(s.externalClients).set({ lastUsedAt: new Date(), lastIp: clientIp(req) }).where(eq(s.externalClients.id, c.id)).catch(() => undefined);
  }
  return c;
}

const creds = z.object({ username: z.string().optional(), password: z.string().optional() }).passthrough();

export async function xtreamRoutes(app: FastifyInstance, d: Deps) {
  /** Disabled => 404; outside trusted networks => 403. */
  const gate = (feature: "xtream" | "either") => async (req: FastifyRequest, reply: FastifyReply) => {
    const st = await getAppSettings(d);
    const on = feature === "xtream" ? st.enableXtream : st.enableXtream || st.enableM3u;
    if (!on) return reply.code(404).send({ error: "not_found", message: "Not found" });
    if (!ipAllowed(clientIp(req), effectiveCidrs(d, st))) return reply.code(403).send({ error: "forbidden", message: "This network is not allowed to use external player access." });
  };
  const merged = (req: FastifyRequest) => ({
    ...(typeof req.body === "object" && req.body ? (req.body as Record<string, unknown>) : {}),
    ...(req.query as Record<string, unknown>),
  });

  const playerApi = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = merged(req) as Record<string, string | undefined>;
    const p = creds.parse(q);
    const client = await authClient(d, req, p.username, p.password, "xtream");
    if (!client) return authFailed();
    const user: XtreamUser = { username: client.username, password: p.password!, createdAt: client.createdAt, status: "Active" };
    const ctx = serverCtx(d, req);
    const action = q.action;
    if (!action) return authResponse(user, ctx);
    const catalog = () => buildCatalog(d, { baseUrl: publicBase(d, req), username: client.username, password: p.password! });
    switch (action) {
      case "get_vod_categories": return vodCategories((await catalog()).categories);
      case "get_vod_streams": return vodStreams((await catalog()).vods, q.category_id);
      case "get_vod_info": {
        const v = (await catalog()).vods.find((x) => String(x.streamId) === String(q.vod_id));
        return v ? vodInfo(v) : { info: [], movie_data: [] };
      }
      case "get_live_categories": case "get_live_streams": case "get_series_categories": case "get_series": return emptyList();
      case "get_short_epg": case "get_simple_data_table": return shortEpg();
      default: return authResponse(user, ctx);
    }
    void reply;
  };
  app.get("/player_api.php", { preHandler: gate("xtream") }, playerApi);
  app.post("/player_api.php", { preHandler: gate("xtream") }, playerApi);

  app.get("/get.php", { preHandler: gate("either") }, async (req, reply) => {
    const p = creds.parse(req.query);
    const st = await getAppSettings(d);
    const client = st.enableM3u ? await authClient(d, req, p.username, p.password, "m3u") : null;
    if (!client) return reply.code(401).type("text/plain").send("Unauthorized");
    const { categories, vods } = await buildCatalog(d, { baseUrl: publicBase(d, req), username: client.username, password: p.password! });
    return reply.type("audio/x-mpegurl; charset=utf-8").send(m3uPlaylist({ baseUrl: publicBase(d, req), username: client.username, password: p.password!, vods, categories }));
  });

  app.get("/xmltv.php", { preHandler: gate("xtream") }, async (req, reply) => {
    const p = creds.parse(req.query);
    if (!(await authClient(d, req, p.username, p.password, "xtream"))) return reply.code(401).type("text/plain").send("Unauthorized");
    return reply.type("application/xml; charset=utf-8").send(xmltvEmpty());
  });

  app.get("/movie/:username/:password/:file", { preHandler: gate("either") }, async (req, reply) => {
    const { username, password, file } = req.params as { username: string; password: string; file: string };
    const m = /^(\d+)\.([A-Za-z0-9]+)$/.exec(file);
    if (!m) return reply.code(404).send({ error: "not_found", message: "Not found" });
    const st = await getAppSettings(d);
    let client = await authClient(d, req, username, password, "xtream");
    let type: "xtream" | "m3u" = "xtream";
    if (!client && st.enableM3u) { client = await authClient(d, req, username, password, "m3u"); type = "m3u"; }
    if (!client) return reply.code(401).type("text/plain").send("Unauthorized");
    const [media] = await d.db.select({ id: s.media.id }).from(s.media).where(eq(s.media.streamId, Number(m[1])));
    const f = media ? await resolveMediaFile(d, media.id, ["video", "audio"]) : null;
    if (!media || !f) return reply.code(404).send({ error: "unavailable", message: "Not available" });
    if (req.method === "GET") await recordStream(d, { clientType: type, clientId: client.id, mediaId: media.id, ip: clientIp(req) });
    await sendFile(req, reply, f.abs, f.mime);
  });

  app.get("/xtream-art/:username/:password/:file", { preHandler: gate("either") }, async (req, reply) => {
    const { username, password, file } = req.params as { username: string; password: string; file: string };
    const m = /^([0-9a-f-]{36})\.jpg$/i.exec(file);
    if (!m) return reply.code(404).send({ error: "not_found", message: "Not found" });
    const client = (await authClient(d, req, username, password, "xtream")) ?? (await authClient(d, req, username, password, "m3u"));
    if (!client) return reply.code(401).type("text/plain").send("Unauthorized");
    const f = await resolveMediaFile(d, m[1]!, ["thumbnail"]);
    if (!f) return reply.code(404).send({ error: "not_found", message: "No artwork" });
    await sendFile(req, reply, f.abs, f.mime, "private, max-age=86400");
  });
  void and; void _eq; void resolveInside;
}
