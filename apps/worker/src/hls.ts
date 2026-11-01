import path from "node:path";
import fsp from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@nocon/database";
import { FILES, hlsRemux } from "@nocon/media-core";
import { resolveInside } from "@nocon/shared";
import { getVolume, type WorkerContext } from "./context.js";

/** Builds <mediaDir>/hls/index.m3u8 by stream-copy remux. No transcoding. */
export async function runHls(ctx: WorkerContext, data: { mediaId: string }): Promise<{ status: "created" | "skipped"; reason?: string }> {
  const { db } = ctx;
  const [media] = await db.select().from(s.media).where(eq(s.media.id, data.mediaId));
  if (!media || media.availability !== "available" || !media.mediaDir || !media.volumeId) return { status: "skipped", reason: "not available" };
  const volume = await getVolume(ctx, media.volumeId);
  if (!volume?.isOnline) return { status: "skipped", reason: "volume offline" };
  const [main] = await db.select().from(s.mediaFiles)
    .where(and(eq(s.mediaFiles.mediaId, media.id), inArray(s.mediaFiles.kind, ["video", "audio"]))).limit(1);
  if (!main) return { status: "skipped", reason: "no primary file" };

  const input = resolveInside(volume.mountPath, main.relativePath);
  const outDir = resolveInside(volume.mountPath, `${media.mediaDir}/${FILES.hlsDir}`);
  await fsp.rm(outDir, { recursive: true, force: true });
  await hlsRemux(ctx.config.FFMPEG_PATH, input, outDir, { nice: true, signal: ctx.signal });

  const rel = `${media.mediaDir}/${FILES.hlsDir}/${FILES.hlsPlaylist}`;
  const size = (await fsp.stat(path.join(outDir, FILES.hlsPlaylist))).size;
  await db.delete(s.mediaFiles).where(and(eq(s.mediaFiles.mediaId, media.id), eq(s.mediaFiles.kind, "hls")));
  await db.insert(s.mediaFiles).values({
    mediaId: media.id, volumeId: volume.id, kind: "hls", relativePath: rel, sizeBytes: size, mimeType: "application/vnd.apple.mpegurl", container: "hls",
  });
  return { status: "created" };
}
