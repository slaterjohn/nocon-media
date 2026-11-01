// API types mirroring docs/api.md. Fields the contract leaves open are typed loosely.

export type Priority = "P0" | "P1" | "P2" | "P3";
export type Availability =
  | "discovered"
  | "queued"
  | "downloading"
  | "available"
  | "evicted"
  | "unavailable"
  | "failed";

export interface ListResponse<T> {
  items: T[];
  total?: number;
  nextCursor?: string | null;
}

export interface User {
  id: string;
  username: string;
}

export interface MediaSummary {
  id: string;
  streamId: number;
  title: string;
  channelName: string | null;
  creatorId: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  downloadedAt: string | null;
  availability: Availability;
  playable: boolean;
  temporarilyUnavailable: boolean;
  effectivePriority: Priority;
  pinned: boolean;
  favourite: boolean;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
  progress: { positionSeconds: number; durationSeconds: number; completed: boolean } | null;
}

export interface MediaFile {
  id: string;
  kind: string;
  mimeType: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  language: string | null;
  label: string | null;
}

export interface MediaDetail extends MediaSummary {
  description: string | null;
  url: string | null;
  platform: string | null;
  externalId: string | null;
  categories: string[];
  tags: string[];
  language: string | null;
  manualPriority: Priority | null;
  retainOverride: boolean;
  recommendationScore: number | null;
  sources: { id: string; name: string; type: string; priority: Priority }[];
  files: MediaFile[];
  subtitles: { id: string; language: string; label: string; url: string }[];
  chapters: { startSeconds: number; endSeconds: number; title: string }[];
  streamUrl: string | null;
  hlsUrl: string | null;
  directPlay: boolean;
  recommendation: { score: number; explanation: unknown; strategy: string; status: string } | null;
  evictions: { at: string; reason: string; reclaimedBytes: number }[];
}

export type SourceType = "channel" | "playlist" | "search" | "video" | "history" | "discovery" | string;
export type SourceStatus = "active" | "paused" | "error" | string;

export type RetentionMode =
  | "all"
  | "none"
  | "latest_n"
  | "last_days"
  | "quota"
  | "rolling"
  | "prefer_unwatched";

export interface Retention {
  mode: RetentionMode;
  count?: number;
  days?: number;
  quotaBytes?: number;
}

export type ScheduleKind = "once" | "hourly" | "daily" | "weekly" | "cron" | "manual";
export interface Schedule {
  kind: ScheduleKind;
  cron?: string;
}

export interface SourceFilters {
  maxAgeDays?: number | null;
  minDurationSec?: number | null;
  maxDurationSec?: number | null;
  maxHistorical?: number | null;
  maxNewPerRun?: number | null;
  includeShorts?: boolean;
  includeLive?: boolean;
  requiredKeywords?: string[];
  excludedKeywords?: string[];
  preferredLanguage?: string | null;
}

export type Resolution = 2160 | 1440 | 1080 | 720 | 480 | 360;

export interface DownloadOptions {
  resolution?: Resolution | null;
  audioOnly: boolean;
  subtitles: { enabled: boolean; languages: string[]; auto: boolean };
}

export type DiscoveryMode = "auto" | "approval" | "discovery_only";

export interface DiscoveryOptions {
  enabled: boolean;
  depth: number;
  mode: DiscoveryMode;
  maxRecommendations: number;
}

export interface Source {
  id: string;
  name: string;
  platform: string;
  type: SourceType;
  url: string | null;
  externalId: string | null;
  query: string | null;
  system: boolean;
  status: SourceStatus;
  priority: Priority;
  retention: Retention;
  automaticEviction: boolean;
  schedule: Schedule;
  filters: SourceFilters;
  downloadOptions: DownloadOptions;
  discovery: DiscoveryOptions;
  autoDownload: boolean;
  volumeId: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  needsAttention: boolean;
  avatarUrl: string | null;
  mediaCount: number;
  downloadedCount: number;
  storageBytes: number;
  /** True when an authentication cookies file is stored. The file itself is never exposed. */
  hasCookies: boolean;
  createdAt: string;
}

export interface SourceRun {
  id: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  discoveredCount: number;
  newCount: number;
  queuedCount: number;
  error: string | null;
}

export interface Download {
  id: string;
  mediaId: string;
  title: string;
  sourceId: string | null;
  sourceName: string | null;
  state: string;
  priority: Priority;
  progress: number;
  bytesDownloaded: number | null;
  totalBytes: number | null;
  estimatedBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  attempts: number;
  error: string | null;
  errorClass: string | null;
  waitingReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Volume {
  id: string;
  name: string;
  mountPath: string;
  filesystem: string | null;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  reservedBytes: number;
  isWritable: boolean;
  isOnline: boolean;
  isDefault: boolean;
  acceptsNew: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface Dashboard {
  media: { total: number; available: number; evicted: number; discovered: number };
  storage: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    byPriority: Record<Priority, number>;
  };
  downloads: { active: number; pending: number; failed: number; waitingForStorage: number };
  sources: {
    total: number;
    active: number;
    paused: number;
    error: number;
    needsAttention: number;
    lastSyncAt: string | null;
  };
  streams: { active: number };
  connectivity: { online: boolean; checkedAt: string | null };
  worker: { online: boolean; paused: boolean; lastHeartbeat: string | null };
  notifications: { unread: number };
}

export interface ActivityEvent {
  id: string;
  at: string;
  type: string;
  severity: "info" | "warning" | "error" | string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
}

export interface AppNotification {
  id: string;
  key: string;
  severity: "info" | "warning" | "error" | string;
  title: string;
  body: string | null;
  remediation: string | null;
  count: number;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  resolvedAt: string | null;
}

export interface DiscoveryBudget {
  enabled: boolean;
  mode: DiscoveryMode;
  maxDepth: number;
  maxDiscovered: number;
  maxDownloaded: number;
  maxStorageBytes: number;
  maxDurationSec: number;
  maxAgeDays: number;
  minScore: number;
  cooldownDays: number;
  intervalHours?: number;
}

export interface Settings {
  profile: "lightweight" | "standard";
  defaultResolution: number;
  softThreshold: number;
  minFreePercent: number;
  enableXtream: boolean;
  enableM3u: boolean;
  enableHls: boolean;
  discovery: DiscoveryBudget;
  redownloadCooldownDays: number;
  xtreamAllowedCidrs: string[];
}

export interface Recommendation {
  id: string;
  media: MediaSummary;
  score: number;
  explanation: { components?: Record<string, number>; reasons?: string[] };
  strategy: string;
  depth: number;
  seed: { id: string; title: string } | null;
  status: string;
  createdAt: string;
}

export interface SimCandidate {
  mediaId: string;
  title: string;
  sizeBytes: number;
  priority: Priority;
  sources: string[];
}

/** StorageService.simulate result (packages/storage-manager/README.md). */
export interface SimulationResult {
  volumeId: string;
  requiredBytes: number;
  availableBytes: number;
  totalBytes: number;
  candidates: SimCandidate[];
  reclaimedBytes: number;
  resultingAvailable: number;
  sufficient: boolean;
  affectedSources: string[];
}

/** StorageService.simulatePolicyChange result. Item fields are not specified, so they are optional. */
export interface PolicyChangeResult {
  losingProtection: { mediaId?: string; id?: string; title?: string; sizeBytes?: number; priority?: Priority }[];
  totalBytes: number;
}

export interface EvictionRecord {
  id: string;
  planId: string;
  media: { id: string; title: string };
  reason: string;
  previousPriority: Priority | null;
  reclaimedBytes: number;
  restorable: boolean;
  status: string;
  createdAt: string;
}

export interface StorageOverview {
  volumes: Volume[];
  byPriority: Record<Priority, number>;
  reservations: { downloadId: string; title: string; bytes: number; writtenBytes: number }[];
  thresholds: { soft: number; minFree: number };
}

export interface ReconcileJob {
  state: "queued" | "waiting" | "active" | "running" | "completed" | "failed" | string;
  result?: ReconcileResult | null;
  error?: string | null;
}

/** What the worker's reconcile job returns (apps/worker/src/reconcile.ts). */
export interface ReconcileResult {
  dryRun: boolean;
  found: number;
  rebuilt: number;
  missingFiles: { mediaId: string; canonicalKey: string; relativePath: string }[];
  orphans: { volumeId: string; relDir: string }[];
  duplicates: { canonicalKey: string; relDirs: string[] }[];
  issues: string[];
}

export interface ExternalClient {
  id: string;
  name: string;
  kind: "xtream" | "extension" | string;
  username: string;
  status: "active" | "disabled" | string;
  allowXtream: boolean;
  allowM3u: boolean;
  lastUsedAt: string | null;
  lastIp: string | null;
  createdAt: string;
  rotatedAt: string | null;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface SystemHealth {
  cpu: { percent: number; cores: number; load: number[] };
  memory: { totalBytes: number; usedBytes: number; processRss: number };
  temperatureC: number | null;
  volumes: Volume[];
  worker: {
    online: boolean;
    paused: boolean;
    lastHeartbeat: string | null;
    queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
  };
  database: { ok: boolean; latencyMs: number };
  redis: { ok: boolean; latencyMs: number };
  downloads: { active: number };
  streams: { active: number };
  connectivity: { online: boolean; checkedAt?: string | null };
  recentErrors: ActivityEvent[];
  remediation: { key: string; message: string }[];
}

export interface ReadinessResult {
  ok: boolean;
  checks: { key: string; ok: boolean; message: string }[];
}

export interface SetupStatus {
  setupComplete: boolean;
  hasAdmin: boolean;
  steps: { admin: boolean; storage: boolean; profile: boolean };
  /** MEDIA_ROOT on the server; the setup wizard pre-fills it as the storage folder. */
  defaultMediaPath?: string;
}

export interface SetupChecks {
  database: { ok: boolean; message?: string };
  redis: { ok: boolean; message?: string };
  worker: { ok: boolean; lastHeartbeat?: string | null };
}

export interface StorageValidation {
  ok: boolean;
  exists: boolean;
  writable: boolean;
  onRootFs: boolean;
  mount: { mountPoint: string; fsType: string; source: string } | null;
  totalBytes: number | null;
  freeBytes: number | null;
  existingMarker: { id: string; name: string } | null;
  warnings: string[];
  errors: string[];
}

// ---- Viewer shapes (docs/api.md "Library", "Media", "Collections") ----

export interface Creator {
  id: string;
  name: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  mediaCount: number;
  playableCount: number;
}

export interface PlaylistRef {
  id: string;
  name: string;
  kind: "source" | "user" | string;
  count: number;
  thumbnailUrl: string | null;
}

/** Collection or user playlist. Count field names are not pinned down in the contract. */
export interface Collection {
  id: string;
  name: string;
  kind: "collection" | "playlist" | string;
  description?: string | null;
  count?: number;
  itemCount?: number;
  mediaCount?: number;
  thumbnailUrl?: string | null;
  items?: MediaSummary[];
}

export interface HomeData {
  continueWatching: MediaSummary[];
  recentlyDownloaded: MediaSummary[];
  newFromSubscriptions: MediaSummary[];
  recommended: MediaSummary[];
  favouriteChannels: Creator[];
  playlists: PlaylistRef[];
}

export interface SearchResults {
  media: MediaSummary[];
  creators: Creator[];
  playlists: PlaylistRef[];
  collections: Collection[];
}

export interface MediaResponse {
  media: MediaDetail;
  related: MediaSummary[];
  next: MediaSummary | null;
}
