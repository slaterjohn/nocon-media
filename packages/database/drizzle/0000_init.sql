CREATE OR REPLACE FUNCTION nocon_tags_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(array_to_string($1, ' '), '') $$;--> statement-breakpoint
CREATE TYPE "public"."media_availability" AS ENUM('discovered', 'queued', 'downloading', 'available', 'evicted', 'unavailable', 'failed');--> statement-breakpoint
CREATE TYPE "public"."client_kind" AS ENUM('xtream', 'extension');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('active', 'disabled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."discovery_mode" AS ENUM('auto', 'approval', 'discovery_only');--> statement-breakpoint
CREATE TYPE "public"."download_state" AS ENUM('discovered', 'queued', 'checking', 'waiting_for_storage', 'downloading', 'processing', 'verifying', 'ready', 'paused', 'failed', 'unavailable', 'evicted');--> statement-breakpoint
CREATE TYPE "public"."eviction_status" AS ENUM('planned', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('video', 'audio', 'thumbnail', 'subtitle', 'sidecar', 'hls', 'avatar', 'banner', 'info');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('P0', 'P1', 'P2', 'P3');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('pending', 'approved', 'rejected', 'queued', 'catalogued');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'warning', 'error', 'critical');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('channel', 'playlist', 'video', 'search', 'history', 'discovery');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"severity" "severity" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_collection_id_media_id_pk" PRIMARY KEY("collection_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'collection' NOT NULL,
	"description" text,
	"show_in_xtream" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"description" text,
	"avatar_path" text,
	"banner_path" text,
	"artwork_volume_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_relationships" (
	"from_media_id" uuid NOT NULL,
	"to_media_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_relationships_from_media_id_to_media_id_strategy_pk" PRIMARY KEY("from_media_id","to_media_id","strategy")
);
--> statement-breakpoint
CREATE TABLE "download_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"download_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"error" text,
	"log_tail" text
);
--> statement-breakpoint
CREATE TABLE "download_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"download_id" uuid NOT NULL,
	"from_state" "download_state",
	"to_state" "download_state" NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"source_id" uuid,
	"state" "download_state" DEFAULT 'queued' NOT NULL,
	"priority" "priority" DEFAULT 'P1' NOT NULL,
	"volume_id" uuid,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"bytes_downloaded" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint,
	"estimated_bytes" bigint,
	"speed_bps" bigint,
	"eta_seconds" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"error_class" text,
	"waiting_reason" text,
	"temp_path" text,
	"requested_by" text DEFAULT 'source' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eviction_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"volume_id" uuid,
	"trigger_download_id" uuid,
	"previous_priority" "priority" NOT NULL,
	"retention_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reclaimed_bytes" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"restorable" boolean DEFAULT true NOT NULL,
	"status" "eviction_status" DEFAULT 'planned' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "client_kind" DEFAULT 'xtream' NOT NULL,
	"username" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"allow_xtream" boolean DEFAULT true NOT NULL,
	"allow_m3u" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "external_clients_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_id" serial NOT NULL,
	"canonical_key" text NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"creator_id" uuid,
	"channel_name" text,
	"published_at" timestamp with time zone,
	"duration_seconds" integer,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text,
	"is_short" boolean DEFAULT false NOT NULL,
	"is_live" boolean DEFAULT false NOT NULL,
	"view_count" bigint,
	"remote_thumbnail_url" text,
	"availability" "media_availability" DEFAULT 'discovered' NOT NULL,
	"effective_priority" "priority" DEFAULT 'P3' NOT NULL,
	"manual_priority" "priority",
	"pinned" boolean DEFAULT false NOT NULL,
	"favourite" boolean DEFAULT false NOT NULL,
	"retain_override" boolean DEFAULT false NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"recommendation_score" real,
	"volume_id" uuid,
	"media_dir" text,
	"size_bytes" bigint,
	"downloaded_at" timestamp with time zone,
	"evicted_at" timestamp with time zone,
	"redownload_after" timestamp with time zone,
	"unavailable_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transcript" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("media"."title", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("media"."channel_name", '')), 'B') ||
        setweight(to_tsvector('simple', nocon_tags_text("media"."tags")), 'B') ||
        setweight(to_tsvector('simple', nocon_tags_text("media"."categories")), 'C') ||
        setweight(to_tsvector('simple', coalesce("media"."description", '')), 'D')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_stream_id_unique" UNIQUE("stream_id"),
	CONSTRAINT "media_canonical_key_unique" UNIQUE("canonical_key")
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"volume_id" uuid NOT NULL,
	"kind" "file_kind" NOT NULL,
	"relative_path" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"mime_type" text,
	"container" text,
	"video_codec" text,
	"audio_codec" text,
	"width" integer,
	"height" integer,
	"bitrate" integer,
	"duration_seconds" double precision,
	"language" text,
	"label" text,
	"checksum_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_sources" (
	"media_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_sources_media_id_source_id_pk" PRIMARY KEY("media_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"severity" "severity" DEFAULT 'warning' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"remediation" text,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "playback_history" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"position_seconds" double precision DEFAULT 0 NOT NULL,
	"duration_seconds" double precision,
	"completed" boolean DEFAULT false NOT NULL,
	"watch_count" integer DEFAULT 0 NOT NULL,
	"first_watched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_watched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"score" real NOT NULL,
	"explanation" jsonb NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"seed_media_id" uuid,
	"strategy" text NOT NULL,
	"status" "recommendation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_media_id_unique" UNIQUE("media_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"queued_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT 'youtube' NOT NULL,
	"type" "source_type" NOT NULL,
	"url" text,
	"external_id" text,
	"query" text,
	"system" boolean DEFAULT false NOT NULL,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"priority" "priority" DEFAULT 'P1' NOT NULL,
	"retention" jsonb DEFAULT '{"mode":"all"}'::jsonb NOT NULL,
	"automatic_eviction" boolean DEFAULT true NOT NULL,
	"schedule" jsonb DEFAULT '{"kind":"daily"}'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"download_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_download" boolean DEFAULT true NOT NULL,
	"volume_id" uuid,
	"creator_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"has_run" boolean DEFAULT false NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"volume_id" uuid NOT NULL,
	"download_id" uuid NOT NULL,
	"bytes" bigint NOT NULL,
	"written_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
CREATE TABLE "storage_volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mount_path" text NOT NULL,
	"filesystem" text,
	"device" text,
	"total_bytes" bigint,
	"free_bytes" bigint,
	"is_writable" boolean DEFAULT false NOT NULL,
	"is_online" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"accepts_new" boolean DEFAULT true NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_volumes_mount_path_unique" UNIQUE("mount_path")
);
--> statement-breakpoint
CREATE TABLE "stream_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"media_id" uuid NOT NULL,
	"client_type" text NOT NULL,
	"client_id" text,
	"ip" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "watch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"media_id" uuid,
	"watched_at" timestamp with time zone NOT NULL,
	"origin" text NOT NULL,
	"title" text,
	"progress_seconds" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_artwork_volume_id_storage_volumes_id_fk" FOREIGN KEY ("artwork_volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_relationships" ADD CONSTRAINT "discovery_relationships_from_media_id_media_id_fk" FOREIGN KEY ("from_media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_relationships" ADD CONSTRAINT "discovery_relationships_to_media_id_media_id_fk" FOREIGN KEY ("to_media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_attempts" ADD CONSTRAINT "download_attempts_download_id_downloads_id_fk" FOREIGN KEY ("download_id") REFERENCES "public"."downloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_download_id_downloads_id_fk" FOREIGN KEY ("download_id") REFERENCES "public"."downloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eviction_records" ADD CONSTRAINT "eviction_records_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eviction_records" ADD CONSTRAINT "eviction_records_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eviction_records" ADD CONSTRAINT "eviction_records_trigger_download_id_downloads_id_fk" FOREIGN KEY ("trigger_download_id") REFERENCES "public"."downloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sources" ADD CONSTRAINT "media_sources_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sources" ADD CONSTRAINT "media_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_history" ADD CONSTRAINT "playback_history_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_seed_media_id_media_id_fk" FOREIGN KEY ("seed_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_download_id_downloads_id_fk" FOREIGN KEY ("download_id") REFERENCES "public"."downloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD CONSTRAINT "stream_sessions_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_at_idx" ON "activity_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "activity_type_idx" ON "activity_events" USING btree ("type","at");--> statement-breakpoint
CREATE INDEX "activity_entity_idx" ON "activity_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "chapters_media_idx" ON "chapters" USING btree ("media_id","start_seconds");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_platform_ext_uq" ON "creators" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "download_attempts_dl_idx" ON "download_attempts" USING btree ("download_id");--> statement-breakpoint
CREATE INDEX "download_events_dl_idx" ON "download_events" USING btree ("download_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "downloads_active_media_uq" ON "downloads" USING btree ("media_id") WHERE "downloads"."state" not in ('ready','failed','evicted','unavailable');--> statement-breakpoint
CREATE INDEX "downloads_state_idx" ON "downloads" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "eviction_media_idx" ON "eviction_records" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "eviction_created_idx" ON "eviction_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "eviction_status_idx" ON "eviction_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_search_idx" ON "media" USING gin ("search");--> statement-breakpoint
CREATE INDEX "media_avail_prio_idx" ON "media" USING btree ("availability","effective_priority");--> statement-breakpoint
CREATE INDEX "media_published_idx" ON "media" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "media_downloaded_idx" ON "media" USING btree ("downloaded_at");--> statement-breakpoint
CREATE INDEX "media_creator_idx" ON "media" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "media_volume_idx" ON "media" USING btree ("volume_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_path_uq" ON "media_files" USING btree ("volume_id","relative_path");--> statement-breakpoint
CREATE INDEX "media_files_media_idx" ON "media_files" USING btree ("media_id","kind");--> statement-breakpoint
CREATE INDEX "media_sources_source_idx" ON "media_sources" USING btree ("source_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_open_key_uq" ON "notifications" USING btree ("key") WHERE "notifications"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "playback_last_idx" ON "playback_history" USING btree ("last_watched_at");--> statement-breakpoint
CREATE INDEX "recommendations_status_idx" ON "recommendations" USING btree ("status","score");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_runs_source_idx" ON "source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "sources_next_run_idx" ON "sources" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_system_type_uq" ON "sources" USING btree ("type") WHERE "sources"."system" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_dl_uq" ON "storage_reservations" USING btree ("download_id") WHERE "storage_reservations"."released_at" is null;--> statement-breakpoint
CREATE INDEX "reservations_volume_idx" ON "storage_reservations" USING btree ("volume_id") WHERE "storage_reservations"."released_at" is null;--> statement-breakpoint
CREATE INDEX "stream_sessions_seen_idx" ON "stream_sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_events_uq" ON "watch_events" USING btree ("canonical_key","watched_at","origin");