export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DOWNLOAD_STATES = [
  "discovered",
  "queued",
  "checking",
  "waiting_for_storage",
  "downloading",
  "processing",
  "verifying",
  "ready",
  "paused",
  "failed",
  "unavailable",
  "evicted",
] as const;
export type DownloadState = (typeof DOWNLOAD_STATES)[number];

/** States in which a download row still "owns" its media (prevents duplicates). */
export const ACTIVE_DOWNLOAD_STATES: DownloadState[] = [
  "discovered",
  "queued",
  "checking",
  "waiting_for_storage",
  "downloading",
  "processing",
  "verifying",
  "paused",
];
/** States where a worker process is actively doing work. */
export const RUNNING_DOWNLOAD_STATES: DownloadState[] = ["checking", "downloading", "processing", "verifying"];
export const TERMINAL_DOWNLOAD_STATES: DownloadState[] = ["ready", "failed", "unavailable", "evicted"];

export const MEDIA_AVAILABILITY = [
  "discovered",
  "queued",
  "downloading",
  "available",
  "evicted",
  "unavailable",
  "failed",
] as const;
export type MediaAvailability = (typeof MEDIA_AVAILABILITY)[number];

export const SOURCE_TYPES = ["channel", "playlist", "video", "search", "history", "discovery"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_STATUSES = ["active", "paused", "error"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const RETENTION_MODES = ["all", "none", "latest_n", "last_days", "quota", "rolling", "prefer_unwatched"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export const DISCOVERY_MODES = ["auto", "approval", "discovery_only"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

export const FILE_KINDS = ["video", "audio", "thumbnail", "subtitle", "sidecar", "hls", "avatar", "banner", "info"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const ERROR_CLASSES = ["unavailable", "private", "rate_limited", "network", "auth", "storage", "invalid", "unknown"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const DEPLOYMENT_PROFILES = ["lightweight", "standard"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

export const QUEUES = {
  sync: "sync",
  download: "download",
  processing: "processing",
  discovery: "discovery",
  maintenance: "maintenance",
} as const;
