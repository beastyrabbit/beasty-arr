ALTER TABLE `budget_buckets` ADD `source_queries` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `hunt_state` ADD `awaiting_import_download_id` text;