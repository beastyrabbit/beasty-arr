ALTER TABLE `budget_buckets` ADD `hunt_sonarr_queries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_buckets` ADD `hunt_radarr_queries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_buckets` ADD `sonarr_queries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_buckets` ADD `radarr_queries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_buckets` ADD `other_queries` integer DEFAULT 0 NOT NULL;