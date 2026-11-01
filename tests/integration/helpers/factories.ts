import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as s from "./deps.js";
import { eq, initVolume, type Database, type Priority, type RetentionPolicy } from "./deps.js";

export interface TestVolume { id: string; path: string }

export async function createVolume(
  db: Database, o: { name?: string; acceptsNew?: boolean; online?: boolean; isDefault?: boolean } = {},
): Promise<TestVolume> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nocon-vol-"));
  const id = randomUUID();
  const name = o.name ?? `vol-${id.slice(0, 6)}`;
  await initVolume(dir, id, name);
  await db.insert(s.storageVolumes).values({
    id, name, mountPath: dir, isOnline: o.online ?? true, isWritable: o.online ?? true,
    acceptsNew: o.acceptsNew ?? true, isDefault: o.isDefault ?? false, lastVerifiedAt: new Date(),
  });
  return { id, path: dir };
}

export async function removeVolume(v: TestVolume): Promise<void> {
  await fsp.rm(v.path, { recursive: true, force: true });
}

export async function createSource(db: Database, o: {
  name?: string; priority?: Priority; retention?: RetentionPolicy; automaticEviction?: boolean; type?: "channel" | "playlist" | "video" | "search";
} = {}): Promise<{ id: string; name: string }> {
  const name = o.name ?? `source-${randomUUID().slice(0, 6)}`;
  const [row] = await db.insert(s.sources).values({
    name, type: o.type ?? "channel", priority: o.priority ?? "P1", retention: o.retention ?? { mode: "all" },
    automaticEviction: o.automaticEviction ?? true,
  }).returning({ id: s.sources.id });
  return { id: row!.id, name };
}

export interface CreateMediaOptions {
  volume: TestVolume;
  sizeBytes: number;
  title?: string;
  priority?: Priority;
  sourceIds?: string[];
  canonicalKey?: string;
  pinned?: boolean;
  favourite?: boolean;
  retainOverride?: boolean;
  publishedAt?: Date;
  downloadedAt?: Date;
  availability?: "available" | "evicted" | "discovered";
  recommendationScore?: number;
}

/** Inserts a media row plus a real (sparse) file of sizeBytes on the volume and its media_files row. */
export async function createMedia(db: Database, o: CreateMediaOptions): Promise<{ id: string; dir: string; file: string }> {
  const id = randomUUID();
  const mediaDir = `media/${id}`;
  const rel = `${mediaDir}/video.mp4`;
  const file = path.join(o.volume.path, rel);
  const available = (o.availability ?? "available") === "available";
  if (available) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "");
    await fsp.truncate(file, o.sizeBytes);
  }
  await db.insert(s.media).values({
    id, canonicalKey: o.canonicalKey ?? `youtube:${id}`, platform: "youtube", externalId: id.slice(0, 11),
    url: `https://example.test/watch?v=${id}`, title: o.title ?? `Video ${id.slice(0, 6)}`,
    availability: o.availability ?? "available", effectivePriority: o.priority ?? "P3",
    pinned: o.pinned ?? false, favourite: o.favourite ?? false, retainOverride: o.retainOverride ?? false,
    publishedAt: o.publishedAt ?? new Date(), downloadedAt: available ? (o.downloadedAt ?? new Date()) : null,
    recommendationScore: o.recommendationScore ?? null,
    volumeId: o.volume.id, mediaDir: available ? mediaDir : null, sizeBytes: available ? o.sizeBytes : null,
  });
  if (available) {
    await db.insert(s.mediaFiles).values({ mediaId: id, volumeId: o.volume.id, kind: "video", relativePath: rel, sizeBytes: o.sizeBytes });
  }
  for (const sourceId of o.sourceIds ?? []) await db.insert(s.mediaSources).values({ mediaId: id, sourceId });
  return { id, dir: path.join(o.volume.path, mediaDir), file };
}

export async function createDownload(db: Database, o: {
  mediaId: string; sourceId?: string; priority?: Priority; state?: typeof s.downloads.$inferInsert["state"]; volumeId?: string; estimatedBytes?: number;
}): Promise<string> {
  const [row] = await db.insert(s.downloads).values({
    mediaId: o.mediaId, sourceId: o.sourceId ?? null, priority: o.priority ?? "P1", state: o.state ?? "checking",
    volumeId: o.volumeId ?? null, estimatedBytes: o.estimatedBytes ?? null,
  }).returning({ id: s.downloads.id });
  return row!.id;
}

/** Creates a not-yet-downloaded media row (the target of an incoming download). */
export async function createPendingMedia(db: Database, o: { title?: string; priority?: Priority; sourceIds?: string[] } = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(s.media).values({
    id, canonicalKey: `youtube:${id}`, platform: "youtube", externalId: id.slice(0, 11), url: `https://example.test/${id}`,
    title: o.title ?? `Incoming ${id.slice(0, 6)}`, availability: "queued", effectivePriority: o.priority ?? "P1",
  });
  for (const sourceId of o.sourceIds ?? []) await db.insert(s.mediaSources).values({ mediaId: id, sourceId });
  return id;
}

export async function getMedia(db: Database, id: string) {
  const [m] = await db.select().from(s.media).where(eq(s.media.id, id));
  return m!;
}
