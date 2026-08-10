CREATE TABLE `dub_catalog_evidence` (
	`subject_key` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`checked_at` integer NOT NULL
);
