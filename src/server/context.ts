import type { AuthService } from "./auth/service.js";
import type { Env } from "./config/env.js";
import type { SettingsService } from "./config/settings.js";
import type { Db, SqliteHandle } from "./db/index.js";
import type { EventBus } from "./events/bus.js";
import type { Scheduler } from "./scheduler/index.js";

/**
 * Composition root shared by all routes and services.
 * Later milestones extend this with sync/hunt/budget/fixer/ai services;
 * keep additions as concrete types here so routes stay honest about
 * their dependencies.
 */
export type AppContext = {
  env: Env;
  db: Db;
  sqlite: SqliteHandle;
  settings: SettingsService;
  auth: AuthService;
  bus: EventBus;
  scheduler: Scheduler;
  /** Populated by later milestones; typed loosely until those land. */
  services: Record<string, unknown>;
};
