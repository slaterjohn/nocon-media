import type { DownloadState } from "./enums.js";

const T: Record<DownloadState, DownloadState[]> = {
  discovered: ["queued", "paused", "failed", "unavailable"],
  queued: ["checking", "paused", "failed", "unavailable", "waiting_for_storage"],
  checking: ["downloading", "waiting_for_storage", "queued", "paused", "failed", "unavailable", "ready"],
  waiting_for_storage: ["queued", "checking", "paused", "failed"],
  downloading: ["processing", "queued", "paused", "failed", "unavailable", "waiting_for_storage"],
  processing: ["verifying", "queued", "paused", "failed"],
  verifying: ["ready", "queued", "failed"],
  ready: ["evicted", "queued"],
  paused: ["queued", "failed"],
  failed: ["queued"],
  unavailable: ["queued"],
  evicted: ["queued"],
};

export function canTransition(from: DownloadState, to: DownloadState): boolean {
  return from === to || T[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(public from: DownloadState, public to: DownloadState) {
    super(`Invalid download transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: DownloadState, to: DownloadState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const transitionTable = T;
