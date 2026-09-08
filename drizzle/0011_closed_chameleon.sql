CREATE INDEX `idx_fixer_analyses_download` ON `fixer_analyses` (`service`,`download_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_fixer_analyses_queue_item` ON `fixer_analyses` (`service`,`queue_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_fixer_history_analysis` ON `fixer_history` (`analysis_id`,`at`,`id`);