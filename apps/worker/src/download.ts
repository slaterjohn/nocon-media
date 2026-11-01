import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import * as s from "@nocon/database";
import { logActivity, recomputeEffectivePriority, transitionDownload, upsertMedia, type Download } from "@nocon/database";
import {
  buildDownloadArgs, extractThumbnail, inspectStaging, mediaDirFor, moveIntoLibrary, probe, remuxToMp4, runDownload, sha256File,
  validateMedia, writeSidecar, FILES,
} from "@nocon/media-core";
import { InvalidTransitionError, type DownloadOptions, type DownloadState } from "@nocon/shared";
import { AdapterError, type MediaInfo } from "@nocon/source-adapters";
import { requiredBytes } from "@nocon/storage-manager";
import {
  adapterForSource, appSettings, classifyError, errMessage, getVolume, stagingDirFor, type Volume, type WorkerContext,
} from "./context.js";

export type DownloadOutcome =
  | "ready" | "skipped" | "deferred" | "waiting_for_storage" | "retry" | "failed" | "unavailable" | "cancelled" | "paused" | "interrupted";

const RUNNING: DownloadState[] = ["checking", "downloading", "processing", "verifying"];
const MAIN_EXTS = new Set(["mp4", "m4a", "webm"]);
const MIME: Record<string, string> = { mp4: "video/mp4", m4a: "audio/mp4", webm: "video/webm", mkv: "video/x-matroska", jpg: "image/jpeg", vtt: "text/vtt", json: "application/json" };

type AbortReason = "shutdown" | "cancel" | "paused" | "storage_exceeded" | "external";

class Stop extends Error {
  constructor(public readonly outcome: DownloadOutcome) { super(outcome); }
}

/** Retry delay: 2^attempts minutes, capped at 6 h. */
export const retryDelayMs = (attempts: number): number => Math.min(2 ** Math.max(1, attempts), 360) * 60_000;

export async function processDownload(ctx: WorkerContext, data: { downloadId: string }): Promise<DownloadOutcome> {
  const { db, log, storage } = ctx;
  const [initial] = await db.select().from(s.downloads).where(eq(s.downloads.id, data.downloadId));
  if (!initial || initial.state !== "queued") return "skipped";
  if (initial.cancelRequested) {
    await transitionDownload(db, initial.id, "failed", { error: "Cancelled", cancelRequested: false }, "cancelled");
    return "cancelled";
  }
  if (!ctx.isOnline() || ctx.isPaused()) return "deferred";
  if (initial.nextAttemptAt && initial.nextAttemptAt.getTime() > Date.now()) return "deferred";

  const [media0] = await db.select().from(s.media).where(eq(s.media.id, initial.mediaId));
  if (!media0) return "skipped";
  const source = initial.sourceId ? (await db.select().from(s.sources).where(eq(s.sources.id, initial.sourceId)))[0] : undefined;
  const adapter = adapterForSource(ctx, source ?? { platform: media0.platform, metadata: {} });

  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, ctx.signal]);
  let abortReason: AbortReason | null = null;
  const stopWith = (r: AbortReason): void => { abortReason ??= r; abort.abort(); };
  let staging: string | null = null;
  let attemptId: string | null = null;
  let monitor: NodeJS.Timeout | undefined;
  let dl: Download = initial;

  const finishAttempt = async (outcome: string, error?: string): Promise<void> => {
    if (!attemptId) return;
    await db.update(s.downloadAttempts).set({ finishedAt: new Date(), outcome, error: error ?? null }).where(eq(s.downloadAttempts.id, attemptId));
    attemptId = null;
  };
  const cleanup = async (reason: string): Promise<void> => {
    await storage.releaseReservation(dl.id, reason).catch(() => undefined);
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  };
  const set = async (to: DownloadState, patch: s.DownloadPatch = {}, reason?: string): Promise<void> => {
    dl = await transitionDownload(db, dl.id, to, patch, reason);
  };

  try {
    // ---- b) checking
    await set("checking", {
      attempts: initial.attempts + 1, startedAt: initial.startedAt ?? new Date(), error: null, errorClass: null,
      waitingReason: null, nextAttemptAt: null, progress: 0, bytesDownloaded: 0, speedBps: null, etaSeconds: null,
    }, "started");
    const [att] = await db.insert(s.downloadAttempts).values({ downloadId: dl.id }).returning({ id: s.downloadAttempts.id });
    attemptId = att!.id;

    // The URL stored on the media row may originate from an untrusted sidecar: only ever download a vetted
    // canonical YouTube video URL that matches the row's own platform and id.
    const ident = adapter.identify(media0.url);
    if (!ident || ident.type !== "video" || ident.platform !== media0.platform || ident.externalId !== media0.externalId) {
      throw new AdapterError("Refusing to download a URL that is not the canonical video URL", "invalid");
    }
    const info = await adapter.fetchMediaInfo(ident.canonicalUrl, { signal });
    const media = await refreshMediaFromInfo(ctx, media0, info);
    const estimated = info.estimatedBytes > 0 ? info.estimatedBytes : Math.max(50 * 1024 * 1024, (info.durationSeconds || 0) * 750_000);
    dl = (await db.update(s.downloads).set({ estimatedBytes: Math.round(estimated) }).where(eq(s.downloads.id, dl.id)).returning())[0]!;

    // ---- c) storage admission
    const admit = await storage.admitDownload({
      downloadId: dl.id, mediaId: media.id, priority: dl.priority, autoEvict: source?.automaticEviction ?? true,
      estimatedBytes: estimated, ...(source?.volumeId ? { volumeId: source.volumeId } : {}),
    });
    if (admit.status === "rejected") {
      if (admit.reason === "cancelled") {
        await set("failed", { error: "Cancelled", cancelRequested: false }, "cancelled");
        await finishAttempt("cancelled");
        return "cancelled";
      }
      if (admit.reason === "already_ready") {
        await set("ready", { completedAt: new Date(), progress: 1 }, "already available");
        await finishAttempt("ready");
        return "ready";
      }
      throw new Stop("skipped");
    }
    if (admit.status === "insufficient") {
      await refreshDownload();
      if (dl.state === "checking") {
        await set("waiting_for_storage", { waitingReason: admit.reason === "no_volume" ? "no_volume" : "insufficient_storage" }, admit.reason ?? "insufficient");
      }
      await finishAttempt("waiting_for_storage");
      return "waiting_for_storage";
    }
    const volume = (await getVolume(ctx, admit.volumeId))!;
    staging = stagingDirFor(volume.mountPath, dl.id);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    // ---- d) downloading
    await set("downloading", { volumeId: volume.id, tempPath: staging }, "admitted");
    const options = resolveOptions(dl.options, (await appSettings(ctx)).defaultResolution);
    const args = buildDownloadArgs({
      url: ident.canonicalUrl, outputDir: staging, audioOnly: options.audioOnly ?? false,
      subtitles: options.subtitles ?? { enabled: true, languages: ["en"], auto: false },
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(typeof source?.metadata?.cookiesFile === "string" ? { cookiesFile: source.metadata.cookiesFile } : {}),
      extraArgs: ctx.config.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean),
    });

    let cur: { downloadedBytes: number; totalBytes: number | null } | null = null;
    let baseBytes = 0, baseTotal = 0;
    let latest: { downloadedBytes: number; totalBytes: number | null; speedBps: number | null; etaSeconds: number | null } | null = null;
    let reserved = requiredBytes(estimated);
    let lastWritten = -1;
    const tick = async (): Promise<void> => {
      const [row] = await db.select({ state: s.downloads.state, cancel: s.downloads.cancelRequested }).from(s.downloads).where(eq(s.downloads.id, dl.id));
      if (!row || row.cancel) return stopWith("cancel");
      if (row.state === "paused") return stopWith("paused");
      if (row.state !== "downloading") return stopWith("external");
      if (!latest || latest.downloadedBytes === lastWritten) return;
      const p = latest;
      lastWritten = p.downloadedBytes;
      await db.update(s.downloads).set({
        progress: p.totalBytes ? Math.min(0.99, p.downloadedBytes / p.totalBytes) : 0, bytesDownloaded: Math.round(p.downloadedBytes),
        totalBytes: p.totalBytes ? Math.round(p.totalBytes) : null, speedBps: p.speedBps ? Math.round(p.speedBps) : null,
        etaSeconds: p.etaSeconds !== null ? Math.round(p.etaSeconds) : null, updatedAt: new Date(),
      }).where(eq(s.downloads.id, dl.id));
      await storage.updateReservationProgress(dl.id, Math.round(p.downloadedBytes));
      const want = requiredBytes(Math.max(p.totalBytes ?? 0, p.downloadedBytes));
      if (want > reserved) {
        if (await storage.extendReservation(dl.id, want)) reserved = want;
        else stopWith("storage_exceeded");
      }
    };
    let ticking = false;
    monitor = setInterval(() => {
      if (ticking) return;
      ticking = true;
      tick().catch((e) => log.warn({ err: errMessage(e) }, "download monitor failed")).finally(() => { ticking = false; });
    }, ctx.progressIntervalMs);

    const run = await runDownload({
      ytDlpPath: ctx.config.YTDLP_PATH, args, signal, nice: process.platform !== "win32", timeoutMs: 6 * 3600_000,
      onProgress: (p) => {
        // yt-dlp downloads the video and audio streams one after the other and reports each from zero. A drop in
        // downloaded bytes means the previous stream finished, so fold it into a running base.
        if (cur && p.downloadedBytes < cur.downloadedBytes) { baseBytes += cur.totalBytes ?? cur.downloadedBytes; baseTotal += cur.totalBytes ?? cur.downloadedBytes; }
        cur = p;
        const total = cur.totalBytes ? baseTotal + cur.totalBytes : null;
        const downloaded = baseBytes + p.downloadedBytes;
        latest = { downloadedBytes: total ? Math.min(downloaded, total) : downloaded, totalBytes: total, speedBps: p.speedBps, etaSeconds: p.etaSeconds };
      },
    });
    clearInterval(monitor);
    monitor = undefined;
    await tick().catch(() => undefined);

    if (run.aborted || abortReason) return await handleAbort(abortReason ?? "shutdown");
    if (run.exitCode !== 0) {
      throw new AdapterError(`yt-dlp exited with ${run.exitCode}${run.timedOut ? " (timeout)" : ""}`, run.timedOut ? "network" : adapter.classifyError(run.stderrTail), run.stderrTail);
    }

    // ---- e) processing
    await set("processing", { progress: 0.99 });
    let insp = await inspectStaging(staging);
    if (!insp.mainFile) throw new AdapterError("yt-dlp produced no media file", "invalid");
    let mainFile = insp.mainFile;
    let probed = await probe(ctx.config.FFPROBE_PATH, path.join(staging, mainFile));
    const ext = path.extname(mainFile).slice(1).toLowerCase();
    if (!MAIN_EXTS.has(ext)) {
      const out = probed.video ? "media.mp4" : "media.m4a";
      await remuxToMp4(ctx.config.FFMPEG_PATH, path.join(staging, mainFile), path.join(staging, out), { nice: true, signal });
      await fsp.rm(path.join(staging, mainFile), { force: true });
      mainFile = out;
      probed = await probe(ctx.config.FFPROBE_PATH, path.join(staging, mainFile));
    }
    if (ctx.config.profile.allowPreTranscode) log.debug({ downloadId: dl.id }, "pre-transcode is not implemented for the MVP, keeping original streams");
    let thumb = fs.existsSync(path.join(staging, FILES.thumbnail)) ? FILES.thumbnail : null;
    if (!thumb && ctx.config.profile.generateThumbnails && probed.video) {
      try {
        await extractThumbnail(ctx.config.FFMPEG_PATH, path.join(staging, mainFile), path.join(staging, FILES.thumbnail), probed.durationSeconds * 0.1, { nice: true, signal });
        thumb = FILES.thumbnail;
      } catch (e) {
        log.warn({ downloadId: dl.id, err: errMessage(e) }, "thumbnail extraction failed");
      }
    }

    // ---- f) verifying
    await set("verifying");
    insp = await inspectStaging(staging);
    const valid = validateMedia(probed);
    if (!valid.ok) throw new AdapterError(`Downloaded file failed validation: ${valid.reason}`, "invalid");
    const mainPath = path.join(staging, mainFile);
    const sha = await sha256File(mainPath);
    const [creator] = media.creatorId ? await db.select().from(s.creators).where(eq(s.creators.id, media.creatorId)) : [];
    const chapters = insp.chapters.length ? insp.chapters : info.chapters;
    await writeSidecar(staging, {
      canonicalKey: media.canonicalKey, originalUrl: media.url, title: media.title, description: media.description ?? "",
      creator: { id: creator?.externalId ?? "", name: creator?.name ?? media.channelName ?? "", ...(creator?.url ? { url: creator.url } : {}) },
      publishedAt: media.publishedAt?.toISOString() ?? null, durationSeconds: Math.round(probed.durationSeconds),
      categories: media.categories, tags: media.tags,
      technical: {
        container: ext || probed.container, videoCodec: probed.video?.codec ?? null, audioCodec: probed.audio?.codec ?? null,
        width: probed.video?.width ?? null, height: probed.video?.height ?? null, bitrate: probed.bitrate, sizeBytes: fs.statSync(mainPath).size,
      },
      artwork: { thumbnail: thumb }, subtitles: insp.subtitles, chapters, mainFile, checksums: { sha256: sha },
    });
    const relDir = mediaDirFor({ platform: media.platform, channelId: creator?.externalId ?? null, externalId: media.externalId });
    const moved = await moveIntoLibrary(staging, volume.mountPath, relDir);
    staging = null; // moved away

    const total = await registerFiles(ctx, media, volume, relDir, moved.files, { mainFile, probed, sha, subtitles: insp.subtitles });

    // ---- g) ready
    await set("ready", { completedAt: new Date(), progress: 1, bytesDownloaded: total, totalBytes: total, error: null, errorClass: null, tempPath: null }, "completed");
    await storage.releaseReservation(dl.id, "completed");
    await finishAttempt("ready");
    await logActivity(db, {
      type: "download.completed", message: `Downloaded "${media.title}"`, entityType: "media", entityId: media.id,
      data: { downloadId: dl.id, sizeBytes: total },
    });
    return "ready";
  } catch (err) {
    if (monitor) clearInterval(monitor);
    if (err instanceof Stop) {
      await cleanup("stopped");
      return err.outcome;
    }
    return await handleFailure(err);
  } finally {
    if (monitor) clearInterval(monitor);
  }

  async function refreshDownload(): Promise<void> {
    dl = (await db.select().from(s.downloads).where(eq(s.downloads.id, dl.id)))[0]!;
  }

  async function handleAbort(reason: AbortReason): Promise<DownloadOutcome> {
    await refreshDownload();
    if (reason === "shutdown") {
      if (RUNNING.includes(dl.state)) await set("queued", { tempPath: null }, "shutdown");
      await cleanup("shutdown");
      await finishAttempt("interrupted");
      return "interrupted";
    }
    if (reason === "cancel") {
      if (RUNNING.includes(dl.state)) await set("failed", { error: "Cancelled", cancelRequested: false, tempPath: null }, "cancelled");
      await cleanup("cancelled");
      await finishAttempt("cancelled", "Cancelled");
      return "cancelled";
    }
    if (reason === "storage_exceeded") {
      if (RUNNING.includes(dl.state)) await set("waiting_for_storage", { waitingReason: "storage_exceeded", tempPath: null }, "storage_exceeded");
      await cleanup("storage_exceeded");
      await finishAttempt("waiting_for_storage");
      return "waiting_for_storage";
    }
    // paused or changed by the API: the new state is already stored
    await cleanup(reason);
    await finishAttempt(reason);
    return reason === "paused" ? "paused" : "skipped";
  }

  async function handleFailure(err: unknown): Promise<DownloadOutcome> {
    await refreshDownload().catch(() => undefined);
    if (err instanceof InvalidTransitionError || !RUNNING.includes(dl.state)) {
      // The API moved the download (pause / cancel / retry) underneath us.
      await cleanup("external");
      await finishAttempt("external");
      return "skipped";
    }
    const errorClass = classifyError(adapter, err);
    const message = errMessage(err);
    log.warn({ downloadId: dl.id, errorClass, err: message }, "download failed");
    await cleanup("failed");
    await finishAttempt("failed", message);
    const base = { error: message, errorClass, tempPath: null, speedBps: null, etaSeconds: null };

    if (errorClass === "unavailable" || errorClass === "private") {
      if (dl.state === "checking" || dl.state === "downloading") {
        await set("unavailable", base, errorClass);
        await db.update(s.media).set({ unavailableReason: errorClass === "private" ? "private" : message, availability: "unavailable", updatedAt: new Date() })
          .where(eq(s.media.id, dl.mediaId));
        await logActivity(db, { type: "download.failed", severity: "warning", message: `"${media0.title}" is unavailable`, entityType: "media", entityId: dl.mediaId, data: { downloadId: dl.id, errorClass } });
        return "unavailable";
      }
    }
    // Network trouble never exhausts the retry budget; everything else does.
    const exhausted = errorClass !== "network" && dl.attempts >= dl.maxAttempts;
    if (exhausted) {
      await set("failed", base, errorClass);
      await logActivity(db, { type: "download.failed", severity: "error", message: `Download failed for "${media0.title}": ${message}`, entityType: "media", entityId: dl.mediaId, data: { downloadId: dl.id, errorClass, attempts: dl.attempts } });
      return "failed";
    }
    const delay = errorClass === "network" ? Math.min(retryDelayMs(dl.attempts), 30 * 60_000) : retryDelayMs(dl.attempts);
    await set("queued", { ...base, nextAttemptAt: new Date(Date.now() + delay) }, `retry:${errorClass}`);
    await logActivity(db, { type: "download.retry", message: `Will retry "${media0.title}" in ${Math.round(delay / 60_000)} min`, entityType: "media", entityId: dl.mediaId, data: { downloadId: dl.id, errorClass } });
    return "retry";
  }
}

function resolveOptions(o: DownloadOptions | undefined, defaultResolution: number): Partial<DownloadOptions> {
  return { ...(o ?? {}), resolution: (o?.resolution ?? defaultResolution) as DownloadOptions["resolution"] };
}

async function refreshMediaFromInfo(ctx: WorkerContext, media: typeof s.media.$inferSelect, info: MediaInfo): Promise<typeof s.media.$inferSelect> {
  const { db } = ctx;
  const { media: updated } = await upsertMedia(db, {
    canonicalKey: media.canonicalKey, platform: media.platform, externalId: media.externalId, url: media.url, title: info.title || media.title,
    description: info.description, channelId: info.channel.id || undefined, channelName: info.channel.name || undefined,
    publishedAt: info.publishedAt, durationSeconds: info.durationSeconds || undefined, categories: info.categories, tags: info.tags,
    language: info.language, thumbnailUrl: info.thumbnailUrl, isLive: info.isLive,
  });
  await db.transaction(async (tx) => {
    await tx.delete(s.chapters).where(eq(s.chapters.mediaId, media.id));
    if (info.chapters.length) {
      await tx.insert(s.chapters).values(info.chapters.map((c) => ({ mediaId: media.id, startSeconds: c.start, endSeconds: c.end, title: c.title })));
    }
  });
  return updated;
}

async function registerFiles(
  ctx: WorkerContext, media: typeof s.media.$inferSelect, volume: Volume, relDir: string, files: string[],
  main: { mainFile: string; probed: Awaited<ReturnType<typeof probe>>; sha: string; subtitles: { language: string; file: string }[] },
): Promise<number> {
  const { db } = ctx;
  const rows: (typeof s.mediaFiles.$inferInsert)[] = [];
  let total = 0;
  for (const rel of files) {
    const name = path.posix.basename(rel);
    if (rel.includes("/hls/")) continue;
    const size = (await fsp.stat(path.join(volume.mountPath, rel))).size;
    total += size;
    const ext = path.extname(name).slice(1).toLowerCase();
    const base = { mediaId: media.id, volumeId: volume.id, relativePath: rel, sizeBytes: size, mimeType: MIME[ext] ?? null };
    if (name === main.mainFile) {
      rows.push({
        ...base, kind: main.probed.video ? "video" : "audio", container: ext, videoCodec: main.probed.video?.codec ?? null,
        audioCodec: main.probed.audio?.codec ?? null, width: main.probed.video?.width ?? null, height: main.probed.video?.height ?? null,
        bitrate: main.probed.bitrate || null, durationSeconds: main.probed.durationSeconds, checksumSha256: main.sha,
      });
    } else if (name === FILES.thumbnail) rows.push({ ...base, kind: "thumbnail" });
    else if (name === FILES.sidecar) rows.push({ ...base, kind: "sidecar" });
    else if (name === FILES.info) rows.push({ ...base, kind: "info" });
    else {
      const sub = main.subtitles.find((x) => x.file === name);
      if (sub) rows.push({ ...base, kind: "subtitle", language: sub.language, label: sub.language });
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(s.mediaFiles).where(eq(s.mediaFiles.mediaId, media.id));
    if (rows.length) await tx.insert(s.mediaFiles).values(rows);
    await tx.update(s.media).set({
      availability: "available", volumeId: volume.id, mediaDir: relDir, sizeBytes: total, downloadedAt: new Date(), evictedAt: null,
      unavailableReason: null, redownloadAfter: null,
      durationSeconds: media.durationSeconds ?? Math.round(main.probed.durationSeconds), updatedAt: new Date(),
    }).where(eq(s.media.id, media.id));
  });
  await recomputeEffectivePriority(db, media.id);
  return total;
}
