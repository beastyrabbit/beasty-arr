CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `idx_activity_at` ON `activity_log` (`at`);--> statement-breakpoint
CREATE TABLE `ai_verdicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`external_ids` text,
	`verdict` text NOT NULL,
	`confidence` real NOT NULL,
	`german_title` text,
	`per_season` text,
	`evidence` text NOT NULL,
	`expected_availability` integer,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`checked_at` integer NOT NULL,
	`recheck_after` integer NOT NULL,
	`superseded_by` integer
);
--> statement-breakpoint
CREATE INDEX `idx_verdicts_subject` ON `ai_verdicts` (`subject_key`,`checked_at`);--> statement-breakpoint
CREATE TABLE `budget_buckets` (
	`indexer_id` integer NOT NULL,
	`hour_utc` integer NOT NULL,
	`observed_queries` integer DEFAULT 0 NOT NULL,
	`observed_grabs` integer DEFAULT 0 NOT NULL,
	`hunt_queries` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`indexer_id`, `hour_utc`)
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY NOT NULL,
	`series_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_episode_number` integer,
	`title` text,
	`air_date_utc` integer,
	`monitored` integer NOT NULL,
	`has_file` integer NOT NULL,
	`episode_file_id` integer,
	`file_languages` text,
	`has_german` integer DEFAULT false NOT NULL,
	`quality` text,
	`quality_cutoff_not_met` integer,
	`language_cutoff_not_met` integer,
	`custom_format_score` integer,
	`file_imported_at` integer,
	`last_synced_at` integer NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_episodes_series_season` ON `episodes` (`series_id`,`season_number`);--> statement-breakpoint
CREATE INDEX `idx_episodes_german` ON `episodes` (`has_german`,`has_file`);--> statement-breakpoint
CREATE TABLE `fixer_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`service` text NOT NULL,
	`queue_item_id` integer NOT NULL,
	`download_id` text,
	`item_label` text NOT NULL,
	`status` text NOT NULL,
	`proposal` text,
	`validation` text,
	`candidates` text,
	`events` text,
	`error` text,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_fixer_analyses_created` ON `fixer_analyses` (`created_at`);--> statement-breakpoint
CREATE TABLE `fixer_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`service` text NOT NULL,
	`item_label` text NOT NULL,
	`action` text NOT NULL,
	`source_kind` text NOT NULL,
	`confidence` real,
	`analysis_id` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`result` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_fixer_history_at` ON `fixer_history` (`at`);--> statement-breakpoint
CREATE TABLE `hunt_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer NOT NULL,
	`series_id` integer,
	`season_number` integer,
	`state` text NOT NULL,
	`state_changed_at` integer NOT NULL,
	`search_count` integer DEFAULT 0 NOT NULL,
	`tier` integer DEFAULT 0 NOT NULL,
	`last_search_at` integer,
	`next_eligible_at` integer,
	`awaiting_import_since` integer,
	`manual_priority` integer DEFAULT 0 NOT NULL,
	`user_paused` integer DEFAULT false NOT NULL,
	`user_paused_until` integer,
	`user_paused_note` text,
	`ai_verdict_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_hunt_target` ON `hunt_state` (`source`,`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_hunt_eligible` ON `hunt_state` (`state`,`next_eligible_at`);--> statement-breakpoint
CREATE INDEX `idx_hunt_series` ON `hunt_state` (`series_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `indexer_snapshots` (
	`indexer_id` integer NOT NULL,
	`taken_at` integer NOT NULL,
	`queries_total` integer NOT NULL,
	`grabs_total` integer NOT NULL,
	PRIMARY KEY(`indexer_id`, `taken_at`)
);
--> statement-breakpoint
CREATE TABLE `indexers` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`query_limit` integer,
	`grab_limit` integer,
	`supports_tv` integer DEFAULT true NOT NULL,
	`supports_movies` integer DEFAULT true NOT NULL,
	`in_backoff` integer DEFAULT false NOT NULL,
	`last_synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `item_overrides` (
	`source` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` integer NOT NULL,
	`season_number` integer DEFAULT -1 NOT NULL,
	`target_mode` text,
	`dub_lag_days` integer,
	`note` text,
	PRIMARY KEY(`source`, `subject_kind`, `subject_id`, `season_number`)
);
--> statement-breakpoint
CREATE TABLE `manual_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`subject` text NOT NULL,
	`with_ai_recheck` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `movies` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`tmdb_id` integer,
	`imdb_id` text,
	`year` integer,
	`status` text,
	`is_available` integer,
	`digital_release` integer,
	`physical_release` integer,
	`original_language` text,
	`monitored` integer NOT NULL,
	`has_file` integer NOT NULL,
	`movie_file_id` integer,
	`file_languages` text,
	`has_german` integer DEFAULT false NOT NULL,
	`quality` text,
	`quality_cutoff_not_met` integer,
	`custom_format_score` integer,
	`file_imported_at` integer,
	`quality_profile_id` integer,
	`tags` text,
	`poster_url` text,
	`path` text,
	`last_synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_movies_german` ON `movies` (`has_german`,`has_file`);--> statement-breakpoint
CREATE TABLE `pending_self_estimates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`indexer_id` integer NOT NULL,
	`at` integer NOT NULL,
	`queries` integer NOT NULL,
	`attempt_id` integer
);
--> statement-breakpoint
CREATE TABLE `quality_profiles` (
	`source` text NOT NULL,
	`id` integer NOT NULL,
	`name` text,
	`upgrade_allowed` integer,
	`cutoff_format_score` integer,
	`min_format_score` integer,
	`raw` text,
	`last_synced_at` integer NOT NULL,
	PRIMARY KEY(`source`, `id`)
);
--> statement-breakpoint
CREATE TABLE `search_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	`command_name` text NOT NULL,
	`arr_command_id` integer,
	`payload` text NOT NULL,
	`target_ids` text NOT NULL,
	`target_label` text,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`estimated_queries` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_attempts_created` ON `search_attempts` (`created_at`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`tvdb_id` integer,
	`imdb_id` text,
	`year` integer,
	`status` text,
	`series_type` text,
	`original_language` text,
	`monitored` integer NOT NULL,
	`quality_profile_id` integer,
	`tags` text,
	`poster_url` text,
	`path` text,
	`last_synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stats_daily` (
	`date` text NOT NULL,
	`source` text NOT NULL,
	`german` integer DEFAULT 0 NOT NULL,
	`non_german` integer DEFAULT 0 NOT NULL,
	`missing` integer DEFAULT 0 NOT NULL,
	`unreleased` integer DEFAULT 0 NOT NULL,
	`ai_paused` integer DEFAULT 0 NOT NULL,
	`exhausted` integer DEFAULT 0 NOT NULL,
	`searches_run` integer DEFAULT 0 NOT NULL,
	`queries_spent` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `source`)
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
