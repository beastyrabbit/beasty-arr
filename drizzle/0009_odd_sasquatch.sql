ALTER TABLE `pending_self_estimates` ADD `reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `pending_self_estimates` ADD `observed_ids` text DEFAULT '[]' NOT NULL;