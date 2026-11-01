import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import * as s from "@nocon/database";
import { transitionDownload } from "@nocon/database";
import { RUNNING_DOWNLOAD_STATES, TERMINAL_DOWNLOAD_STATES, type DownloadState } from "@nocon/shared";
import { enqueue, HttpError, type Deps } from "./core.js";

export const enqueueDownload = (d: Deps, log: FastifyBaseLogger, downloadId: string) =>
  enqueue(d, log, "download", "download", { downloadId }, `download-${downloadId}`);

export async function getDownload(d: Deps, id: string) {
  const [dl] = await d.db.select().from(s.downloads).where(eq(s.downloads.id, id));
  if (!dl) throw new HttpError(404, "not_found", "Download not found");
  return dl;
}

/** Cancels a download. Running ones get the cancel flag (the worker aborts); others fail immediately. */
export async function cancelDownload(d: Deps, id: string): Promise<void> {
  const dl = await getDownload(d, id);
  if (TERMINAL_DOWNLOAD_STATES.includes(dl.state)) throw new HttpError(409, "conflict", `Download is already ${dl.state}`);
  if (RUNNING_DOWNLOAD_STATES.includes(dl.state)) {
    await d.db.update(s.downloads).set({ cancelRequested: true, updatedAt: new Date() }).where(eq(s.downloads.id, id));
    return;
  }
  await d.db.update(s.downloads).set({ cancelRequested: true }).where(eq(s.downloads.id, id));
  await transitionDownload(d.db, id, "failed" as DownloadState, { error: "Cancelled", errorClass: "invalid" }, "cancelled");
  await d.db.update(s.media).set({ availability: "discovered", updatedAt: new Date() })
    .where(eq(s.media.id, dl.mediaId));
}
