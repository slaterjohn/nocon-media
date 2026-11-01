import { YouTubeAdapter, type YouTubeAdapterOptions } from "./youtube/adapter.js";
import { identifyYouTube } from "./youtube/identify.js";
import type { IdentifiedSource, SourceAdapter } from "./types.js";

export const SUPPORTED_PLATFORMS = ["youtube"] as const;

export function getAdapter(platform: string, opts: YouTubeAdapterOptions): SourceAdapter {
  if (platform === "youtube") return new YouTubeAdapter(opts);
  throw new Error(`Unsupported platform: ${platform}`);
}

/** Tries every registered platform's strict identifier. */
export function identifySource(input: string): IdentifiedSource | null {
  return identifyYouTube(input);
}
