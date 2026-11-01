import type { ErrorClass } from "@nocon/shared";

export type SourceKind = "channel" | "playlist" | "video" | "search";

export interface IdentifiedSource {
  platform: string;
  type: SourceKind;
  externalId: string;
  canonicalUrl: string;
  handle?: string;
}

export interface DiscoveredEntry {
  externalId: string;
  /** e.g. "youtube:<id>" */
  canonicalKey: string;
  url: string;
  title: string;
  durationSeconds?: number;
  publishedAt?: Date;
  channelId?: string;
  channelName?: string;
  isShort: boolean;
  isLive: boolean;
  position?: number;
  thumbnailUrl?: string;
  viewCount?: number;
  description?: string;
}

export interface MediaInfo {
  title: string;
  description: string;
  channel: { id: string; name: string; url: string };
  publishedAt: Date | null;
  durationSeconds: number;
  categories: string[];
  tags: string[];
  language: string | null;
  chapters: { start: number; end: number; title: string }[];
  thumbnailUrl: string | null;
  subtitleLanguages: string[];
  estimatedBytes: number;
  isLive: boolean;
  raw: unknown;
}

export interface SourceInfo {
  title: string;
  description: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  channelId?: string;
  channelName?: string;
}

export interface DiscoverOptions {
  limit?: number;
  offset?: number;
  includeShorts?: boolean;
  includeLive?: boolean;
  signal?: AbortSignal;
}

export interface AdapterCapabilities {
  channel: boolean;
  playlist: boolean;
  video: boolean;
  search: boolean;
  related: boolean;
}

export interface SourceAdapter {
  platform: string;
  capabilities: AdapterCapabilities;
  identify(input: string): IdentifiedSource | null;
  fetchSourceInfo(src: IdentifiedSource, opts?: { signal?: AbortSignal }): Promise<SourceInfo>;
  discover(src: IdentifiedSource, opts?: DiscoverOptions): Promise<DiscoveredEntry[]>;
  fetchMediaInfo(url: string, opts?: { signal?: AbortSignal }): Promise<MediaInfo>;
  search?(query: string, limit: number, opts?: { signal?: AbortSignal }): Promise<DiscoveredEntry[]>;
  classifyError(stderr: string): ErrorClass;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly errorClass: ErrorClass,
    public readonly stderr = "",
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
