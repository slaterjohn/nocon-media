import { sql, type SQL } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, timestamp, boolean, integer, bigint, real, jsonb, primaryKey, index, uniqueIndex,
  serial, bigserial, customType, doublePrecision,
} from "drizzle-orm/pg-core";
import {
  PRIORITIES, DOWNLOAD_STATES, MEDIA_AVAILABILITY, SOURCE_TYPES, SOURCE_STATUSES, FILE_KINDS, DISCOVERY_MODES,
  type RetentionPolicy, type Schedule, type SourceFilters, type DownloadOptions, type DiscoveryOptions,
} from "@nocon/shared";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () => ts("updated_at").notNull().defaultNow();
const big = (name: string) => bigint(name, { mode: "number" });

export const priorityEnum = pgEnum("priority", PRIORITIES);
export const downloadStateEnum = pgEnum("download_state", DOWNLOAD_STATES);
export const availabilityEnum = pgEnum("media_availability", MEDIA_AVAILABILITY);
export const sourceTypeEnum = pgEnum("source_type", SOURCE_TYPES);
export const sourceStatusEnum = pgEnum("source_status", SOURCE_STATUSES);
export const fileKindEnum = pgEnum("file_kind", FILE_KINDS);
export const discoveryModeEnum = pgEnum("discovery_mode", DISCOVERY_MODES);
export const recommendationStatusEnum = pgEnum("recommendation_status", ["pending", "approved", "rejected", "queued", "catalogued"]);
export const clientKindEnum = pgEnum("client_kind", ["xtream", "extension"]);
export const clientStatusEnum = pgEnum("client_status", ["active", "disabled", "revoked"]);
export const severityEnum = pgEnum("severity", ["info", "warning", "error", "critical"]);
export const evictionStatusEnum = pgEnum("eviction_status", ["planned", "completed", "failed", "cancelled"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("admin"),
  createdAt: created(),
  lastLoginAt: ts("last_login_at"),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token)
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: created(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  revokedAt: ts("revoked_at"),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updated(),
});

export const storageVolumes = pgTable("storage_volumes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  mountPath: text("mount_path").notNull().unique(),
  filesystem: text("filesystem"),
  device: text("device"),
  totalBytes: big("total_bytes"),
  freeBytes: big("free_bytes"),
  isWritable: boolean("is_writable").notNull().default(false),
  isOnline: boolean("is_online").notNull().default(false),
  isDefault: boolean("is_default").notNull().default(false),
  acceptsNew: boolean("accepts_new").notNull().default(true),
  lastVerifiedAt: ts("last_verified_at"),
  lastError: text("last_error"),
  createdAt: created(),
});

export const creators = pgTable("creators", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: text("platform").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  url: text("url"),
  description: text("description"),
  avatarPath: text("avatar_path"), // relative to volume
  bannerPath: text("banner_path"),
  artworkVolumeId: uuid("artwork_volume_id").references(() => storageVolumes.id, { onDelete: "set null" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("creators_platform_ext_uq").on(t.platform, t.externalId)]);

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("youtube"),
  type: sourceTypeEnum("type").notNull(),
  url: text("url"),
  externalId: text("external_id"),
  query: text("query"),
  system: boolean("system").notNull().default(false), // built-in history / discovery sources
  status: sourceStatusEnum("status").notNull().default("active"),
  priority: priorityEnum("priority").notNull().default("P1"),
  retention: jsonb("retention").$type<RetentionPolicy>().notNull().default({ mode: "all" }),
  automaticEviction: boolean("automatic_eviction").notNull().default(true),
  schedule: jsonb("schedule").$type<Schedule>().notNull().default({ kind: "daily" }),
  filters: jsonb("filters").$type<SourceFilters>().notNull().default(sql`'{}'::jsonb`),
  downloadOptions: jsonb("download_options").$type<DownloadOptions>().notNull().default(sql`'{}'::jsonb`),
  discovery: jsonb("discovery").$type<DiscoveryOptions>().notNull().default(sql`'{}'::jsonb`),
  autoDownload: boolean("auto_download").notNull().default(true),
  volumeId: uuid("volume_id").references(() => storageVolumes.id, { onDelete: "set null" }),
  creatorId: uuid("creator_id").references(() => creators.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  lastCheckedAt: ts("last_checked_at"),
  lastSuccessAt: ts("last_success_at"),
  nextRunAt: ts("next_run_at"),
  hasRun: boolean("has_run").notNull().default(false),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  needsAttention: boolean("needs_attention").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("sources_next_run_idx").on(t.status, t.nextRunAt),
  uniqueIndex("sources_system_type_uq").on(t.type).where(sql`${t.system} = true`),
]);

export const sourceRuns = pgTable("source_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull().default("schedule"),
  status: text("status").notNull().default("running"), // running | success | failed | skipped_offline
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  discoveredCount: integer("discovered_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  queuedCount: integer("queued_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  error: text("error"),
}, (t) => [index("source_runs_source_idx").on(t.sourceId, t.startedAt)]);

export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  streamId: serial("stream_id").notNull().unique(), // numeric id for Xtream
  canonicalKey: text("canonical_key").notNull().unique(),
  platform: text("platform").notNull(),
  externalId: text("external_id").notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  creatorId: uuid("creator_id").references(() => creators.id, { onDelete: "set null" }),
  channelName: text("channel_name"),
  publishedAt: ts("published_at"),
  durationSeconds: integer("duration_seconds"),
  categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  language: text("language"),
  isShort: boolean("is_short").notNull().default(false),
  isLive: boolean("is_live").notNull().default(false),
  viewCount: big("view_count"),
  remoteThumbnailUrl: text("remote_thumbnail_url"),
  availability: availabilityEnum("availability").notNull().default("discovered"),
  effectivePriority: priorityEnum("effective_priority").notNull().default("P3"),
  manualPriority: priorityEnum("manual_priority"),
  pinned: boolean("pinned").notNull().default(false),
  favourite: boolean("favourite").notNull().default(false),
  retainOverride: boolean("retain_override").notNull().default(false),
  approved: boolean("approved").notNull().default(false),
  recommendationScore: real("recommendation_score"),
  volumeId: uuid("volume_id").references(() => storageVolumes.id, { onDelete: "set null" }),
  mediaDir: text("media_dir"), // relative dir on volume
  sizeBytes: big("size_bytes"),
  downloadedAt: ts("downloaded_at"),
  evictedAt: ts("evicted_at"),
  redownloadAfter: ts("redownload_after"),
  unavailableReason: text("unavailable_reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  transcript: text("transcript"), // reserved for future transcript search
  search: tsvector("search").generatedAlwaysAs((): SQL =>
    sql`setweight(to_tsvector('simple', coalesce(${media.title}, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(${media.channelName}, '')), 'B') ||
        setweight(to_tsvector('simple', nocon_tags_text(${media.tags})), 'B') ||
        setweight(to_tsvector('simple', nocon_tags_text(${media.categories})), 'C') ||
        setweight(to_tsvector('simple', coalesce(${media.description}, '')), 'D')`),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("media_search_idx").using("gin", t.search),
  index("media_avail_prio_idx").on(t.availability, t.effectivePriority),
  index("media_published_idx").on(t.publishedAt),
  index("media_downloaded_idx").on(t.downloadedAt),
  index("media_creator_idx").on(t.creatorId),
  index("media_volume_idx").on(t.volumeId),
]);

export const mediaSources = pgTable("media_sources", {
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  position: integer("position"),
  depth: integer("depth").notNull().default(0),
  reason: text("reason"),
  discoveredAt: ts("discovered_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.mediaId, t.sourceId] }), index("media_sources_source_idx").on(t.sourceId, t.position)]);

export const mediaFiles = pgTable("media_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  volumeId: uuid("volume_id").notNull().references(() => storageVolumes.id, { onDelete: "cascade" }),
  kind: fileKindEnum("kind").notNull(),
  relativePath: text("relative_path").notNull(),
  sizeBytes: big("size_bytes").notNull().default(0),
  mimeType: text("mime_type"),
  container: text("container"),
  videoCodec: text("video_codec"),
  audioCodec: text("audio_codec"),
  width: integer("width"),
  height: integer("height"),
  bitrate: integer("bitrate"),
  durationSeconds: doublePrecision("duration_seconds"),
  language: text("language"),
  label: text("label"),
  checksumSha256: text("checksum_sha256"),
  createdAt: created(),
}, (t) => [uniqueIndex("media_files_path_uq").on(t.volumeId, t.relativePath), index("media_files_media_idx").on(t.mediaId, t.kind)]);

export const chapters = pgTable("chapters", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  startSeconds: doublePrecision("start_seconds").notNull(),
  endSeconds: doublePrecision("end_seconds"),
  title: text("title").notNull(),
}, (t) => [index("chapters_media_idx").on(t.mediaId, t.startSeconds)]);

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("collection"), // collection | playlist
  description: text("description"),
  showInXtream: boolean("show_in_xtream").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
});

export const collectionItems = pgTable("collection_items", {
  collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  addedAt: ts("added_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.collectionId, t.mediaId] })]);

export const downloads = pgTable("downloads", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  state: downloadStateEnum("state").notNull().default("queued"),
  priority: priorityEnum("priority").notNull().default("P1"),
  volumeId: uuid("volume_id").references(() => storageVolumes.id, { onDelete: "set null" }),
  options: jsonb("options").$type<DownloadOptions>().notNull().default(sql`'{}'::jsonb`),
  progress: real("progress").notNull().default(0),
  bytesDownloaded: big("bytes_downloaded").notNull().default(0),
  totalBytes: big("total_bytes"),
  estimatedBytes: big("estimated_bytes"),
  speedBps: big("speed_bps"),
  etaSeconds: integer("eta_seconds"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextAttemptAt: ts("next_attempt_at"),
  error: text("error"),
  errorClass: text("error_class"),
  waitingReason: text("waiting_reason"),
  tempPath: text("temp_path"),
  requestedBy: text("requested_by").notNull().default("source"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
  startedAt: ts("started_at"),
  completedAt: ts("completed_at"),
}, (t) => [
  uniqueIndex("downloads_active_media_uq").on(t.mediaId).where(sql`${t.state} not in ('ready','failed','evicted','unavailable')`),
  index("downloads_state_idx").on(t.state, t.createdAt),
]);

export const downloadAttempts = pgTable("download_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  downloadId: uuid("download_id").notNull().references(() => downloads.id, { onDelete: "cascade" }),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  outcome: text("outcome"),
  error: text("error"),
  logTail: text("log_tail"),
}, (t) => [index("download_attempts_dl_idx").on(t.downloadId)]);

export const downloadEvents = pgTable("download_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  downloadId: uuid("download_id").notNull().references(() => downloads.id, { onDelete: "cascade" }),
  fromState: downloadStateEnum("from_state"),
  toState: downloadStateEnum("to_state").notNull(),
  reason: text("reason"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("download_events_dl_idx").on(t.downloadId, t.at)]);

export const storageReservations = pgTable("storage_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  volumeId: uuid("volume_id").notNull().references(() => storageVolumes.id, { onDelete: "cascade" }),
  downloadId: uuid("download_id").notNull().references(() => downloads.id, { onDelete: "cascade" }),
  bytes: big("bytes").notNull(),
  writtenBytes: big("written_bytes").notNull().default(0),
  createdAt: created(),
  releasedAt: ts("released_at"),
  releaseReason: text("release_reason"),
}, (t) => [
  uniqueIndex("reservations_active_dl_uq").on(t.downloadId).where(sql`${t.releasedAt} is null`),
  index("reservations_volume_idx").on(t.volumeId).where(sql`${t.releasedAt} is null`),
]);

export const evictionRecords = pgTable("eviction_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull(),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "restrict" }),
  volumeId: uuid("volume_id").references(() => storageVolumes.id, { onDelete: "set null" }),
  triggerDownloadId: uuid("trigger_download_id").references(() => downloads.id, { onDelete: "set null" }),
  previousPriority: priorityEnum("previous_priority").notNull(),
  retentionSnapshot: jsonb("retention_snapshot").notNull().default(sql`'[]'::jsonb`),
  reclaimedBytes: big("reclaimed_bytes").notNull().default(0),
  reason: text("reason").notNull(),
  restorable: boolean("restorable").notNull().default(true),
  status: evictionStatusEnum("status").notNull().default("planned"),
  error: text("error"),
  createdAt: created(),
  completedAt: ts("completed_at"),
}, (t) => [index("eviction_media_idx").on(t.mediaId), index("eviction_created_idx").on(t.createdAt), index("eviction_status_idx").on(t.status)]);

export const playbackHistory = pgTable("playback_history", {
  mediaId: uuid("media_id").primaryKey().references(() => media.id, { onDelete: "cascade" }),
  positionSeconds: doublePrecision("position_seconds").notNull().default(0),
  durationSeconds: doublePrecision("duration_seconds"),
  completed: boolean("completed").notNull().default(false),
  watchCount: integer("watch_count").notNull().default(0),
  firstWatchedAt: ts("first_watched_at").notNull().defaultNow(),
  lastWatchedAt: ts("last_watched_at").notNull().defaultNow(),
}, (t) => [index("playback_last_idx").on(t.lastWatchedAt)]);

export const watchEvents = pgTable("watch_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonicalKey: text("canonical_key").notNull(),
  mediaId: uuid("media_id").references(() => media.id, { onDelete: "set null" }),
  watchedAt: ts("watched_at").notNull(),
  origin: text("origin").notNull(), // takeout | extension | local
  title: text("title"),
  progressSeconds: doublePrecision("progress_seconds"),
  createdAt: created(),
}, (t) => [uniqueIndex("watch_events_uq").on(t.canonicalKey, t.watchedAt, t.origin)]);

export const recommendations = pgTable("recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaId: uuid("media_id").notNull().unique().references(() => media.id, { onDelete: "cascade" }),
  score: real("score").notNull(),
  explanation: jsonb("explanation").notNull(),
  depth: integer("depth").notNull().default(1),
  seedMediaId: uuid("seed_media_id").references(() => media.id, { onDelete: "set null" }),
  strategy: text("strategy").notNull(),
  status: recommendationStatusEnum("status").notNull().default("pending"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("recommendations_status_idx").on(t.status, t.score)]);

export const discoveryRelationships = pgTable("discovery_relationships", {
  fromMediaId: uuid("from_media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  toMediaId: uuid("to_media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  strategy: text("strategy").notNull(),
  weight: real("weight").notNull().default(1),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.fromMediaId, t.toMediaId, t.strategy] })]);

export const externalClients = pgTable("external_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: clientKindEnum("kind").notNull().default("xtream"),
  username: text("username").notNull().unique(),
  secretHash: text("secret_hash").notNull(),
  status: clientStatusEnum("status").notNull().default("active"),
  allowXtream: boolean("allow_xtream").notNull().default(true),
  allowM3u: boolean("allow_m3u").notNull().default(true),
  lastUsedAt: ts("last_used_at"),
  lastIp: text("last_ip"),
  createdAt: created(),
  rotatedAt: ts("rotated_at"),
  revokedAt: ts("revoked_at"),
});

export const streamSessions = pgTable("stream_sessions", {
  id: text("id").primaryKey(), // hash(client + media + ip)
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  clientType: text("client_type").notNull(), // web | xtream | m3u
  clientId: text("client_id"),
  ip: text("ip"),
  startedAt: ts("started_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
}, (t) => [index("stream_sessions_seen_idx").on(t.lastSeenAt)]);

export const activityEvents = pgTable("activity_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  type: text("type").notNull(),
  severity: severityEnum("severity").notNull().default("info"),
  message: text("message").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
}, (t) => [index("activity_at_idx").on(t.at), index("activity_type_idx").on(t.type, t.at), index("activity_entity_idx").on(t.entityType, t.entityId)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  severity: severityEnum("severity").notNull().default("warning"),
  title: text("title").notNull(),
  body: text("body"),
  remediation: text("remediation"),
  count: integer("count").notNull().default(1),
  createdAt: created(),
  updatedAt: updated(),
  readAt: ts("read_at"),
  resolvedAt: ts("resolved_at"),
}, (t) => [uniqueIndex("notifications_open_key_uq").on(t.key).where(sql`${t.resolvedAt} is null`)]);
