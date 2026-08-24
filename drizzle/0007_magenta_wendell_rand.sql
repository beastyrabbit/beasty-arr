CREATE TABLE `ai_check_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_key` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_ai_attempts_started` ON `ai_check_attempts` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_attempts_subject` ON `ai_check_attempts` (`subject_key`,`started_at`);--> statement-breakpoint
INSERT INTO `ai_check_attempts` (`subject_key`, `provider`, `model`, `status`, `started_at`, `completed_at`)
SELECT `subject_key`, `provider`, `model`, 'succeeded', `checked_at`, `checked_at`
FROM `ai_verdicts`
WHERE `provider` <> 'wikidata';--> statement-breakpoint
UPDATE `ai_verdicts`
SET `superseded_by` = 0
WHERE `subject_kind` = 'series'
  AND `prompt_version` = 'dub-oracle-v14'
  AND `superseded_by` IS NULL;--> statement-breakpoint
UPDATE `hunt_state`
SET `next_eligible_at` = NULL
WHERE `state` = 'ai_paused';
