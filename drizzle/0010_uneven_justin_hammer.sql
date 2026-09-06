CREATE TABLE `search_attempt_targets` (
	`attempt_id` integer NOT NULL,
	`hunt_state_id` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `hunt_state_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `search_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_attempt_targets_hunt_state` ON `search_attempt_targets` (`hunt_state_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO search_attempt_targets (attempt_id, hunt_state_id)
SELECT a.id, target.value FROM search_attempts a, json_each(a.target_ids) target;
--> statement-breakpoint
CREATE TRIGGER search_attempt_targets_insert AFTER INSERT ON search_attempts BEGIN
  INSERT OR IGNORE INTO search_attempt_targets (attempt_id, hunt_state_id)
  SELECT NEW.id, value FROM json_each(NEW.target_ids);
END;
--> statement-breakpoint
CREATE TRIGGER search_attempt_targets_update AFTER UPDATE OF target_ids ON search_attempts BEGIN
  DELETE FROM search_attempt_targets WHERE attempt_id = OLD.id;
  INSERT OR IGNORE INTO search_attempt_targets (attempt_id, hunt_state_id)
  SELECT NEW.id, value FROM json_each(NEW.target_ids);
END;
