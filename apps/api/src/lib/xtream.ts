import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import * as s from "@nocon/database";
import { getSetting, setSetting } from "@nocon/database";
import type { XtreamCategory, XtreamVod } from "@nocon/xtream";
import type { Deps } from "./core.js";

const SETTING = "xtream.categoryIds";
const FIRST_DYNAMIC_ID = 1000;
let chain: Promise<unknown> = Promise.resolve();

/** Stable numeric category ids: assigned once, persisted in settings, never reused. Serialised per process. */
async function assignIds(d: Deps, keys: string[]): Promise<Map<string, number>> {
  const run = async () => {
    const map = await getSetting<Record<string, number>>(d.db, SETTING, {});
    let next = Math.max(FIRST_DYNAMIC_ID - 1, ...Object.values(map)) + 1;
    let changed = false;
    for (const k of keys) if (map[k] === undefined) { map[k] = next++; changed = true; }
    if (changed) await setSetting(d.db, SETTING, map);
    return new Map(Object.entries(map));
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

export interface Catalog {
  categories: XtreamCategory[];
  vods: XtreamVod[];
  /** streamId -> media id */
  mediaByStream: Map<number, string>;
}

export async function buildCatalog(d: Deps, o: { baseUrl: string; username: string; password: string }): Promise<Catalog> {
  const rows = await d.db.select({ m: s.media, f: s.mediaFiles }).from(s.media)
    .innerJoin(s.mediaFiles, and(eq(s.mediaFiles.mediaId, s.media.id), inArray(s.mediaFiles.kind, ["video", "audio"])))
    .innerJoin(s.storageVolumes, and(eq(s.storageVolumes.id, s.mediaFiles.volumeId), eq(s.storageVolumes.isOnline, true)))
    .where(eq(s.media.availability, "available"))
    .orderBy(desc(s.media.downloadedAt), asc(s.media.id));
  const primary = new Map<string, { m: typeof rows[number]["m"]; f: typeof rows[number]["f"] }>();
  for (const r of rows) {
    const cur = primary.get(r.m.id);
    if (!cur || (cur.f.kind !== "video" && r.f.kind === "video")) primary.set(r.m.id, r);
  }
  const items = [...primary.values()];
  const ids = items.map((i) => i.m.id);

  const srcLinks = ids.length ? await d.db.select({ mediaId: s.mediaSources.mediaId, id: s.sources.id, name: s.sources.name })
    .from(s.mediaSources).innerJoin(s.sources, eq(s.sources.id, s.mediaSources.sourceId))
    .where(and(inArray(s.mediaSources.mediaId, ids), eq(s.sources.system, false))) : [];
  const colLinks = ids.length ? await d.db.select({ mediaId: s.collectionItems.mediaId, id: s.collections.id, name: s.collections.name })
    .from(s.collectionItems).innerJoin(s.collections, eq(s.collections.id, s.collectionItems.collectionId))
    .where(and(inArray(s.collectionItems.mediaId, ids), eq(s.collections.showInXtream, true))) : [];

  // keys per media, in primary-category order
  const names = new Map<string, string>();
  const keysOf = new Map<string, string[]>();
  const add = (mediaId: string, key: string, name: string) => {
    names.set(key, name);
    const l = keysOf.get(mediaId) ?? [];
    if (!l.includes(key)) l.push(key);
    keysOf.set(mediaId, l);
  };
  for (const l of srcLinks) add(l.mediaId, `source:${l.id}`, l.name);
  for (const l of colLinks) add(l.mediaId, `collection:${l.id}`, l.name);
  for (const i of items) for (const c of i.m.categories) if (c.trim()) add(i.m.id, `category:${c.trim().toLowerCase()}`, c.trim());
  const recent = new Set(items.slice(0, 50).map((i) => i.m.id));
  for (const i of items) {
    if (i.m.favourite) add(i.m.id, "favourites", "Favourites");
    if (recent.has(i.m.id)) add(i.m.id, "recent", "Recently added");
  }

  const dynamic = [...names.keys()].filter((k) => k !== "recent" && k !== "favourites").sort();
  const idMap = dynamic.length ? await assignIds(d, dynamic) : new Map<string, number>();
  const idFor = (k: string) => (k === "recent" ? 1 : k === "favourites" ? 2 : idMap.get(k)!);

  const categories: XtreamCategory[] = [{ id: 1, name: "Recently added" }, { id: 2, name: "Favourites" }];
  for (const k of dynamic) categories.push({ id: idFor(k), name: names.get(k)! });

  const esc = encodeURIComponent;
  const vods: XtreamVod[] = items.map(({ m, f }) => ({
    streamId: m.streamId, title: m.title, description: m.description ?? "",
    thumbnailUrl: `${o.baseUrl}/xtream-art/${esc(o.username)}/${esc(o.password)}/${m.id}.jpg`,
    categoryIds: (keysOf.get(m.id) ?? []).map(idFor), addedAt: m.downloadedAt ?? m.createdAt,
    publishedAt: m.publishedAt ?? undefined, durationSeconds: m.durationSeconds ?? undefined,
    containerExtension: path.extname(f.relativePath).slice(1).toLowerCase() || "mp4",
    genre: m.categories[0], channelName: m.channelName ?? undefined,
    video: f.width && f.height ? { codec: f.videoCodec ?? "", width: f.width, height: f.height } : undefined,
    audio: f.audioCodec ? { codec: f.audioCodec } : undefined, bitrate: f.bitrate ?? undefined,
  }));
  return { categories, vods, mediaByStream: new Map(items.map((i) => [i.m.streamId, i.m.id])) };
}
