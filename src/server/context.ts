import type { RadarrClient } from "./arr/radarr-client.js";
import type { SonarrClient } from "./arr/sonarr-client.js";
import type { AuthService } from "./auth/service.js";
import type { BudgetManager } from "./budget/manager.js";
import type { Env } from "./config/env.js";
import type { SettingsService } from "./config/settings.js";
import type { Db, SqliteHandle } from "./db/index.js";
import type { EventBus } from "./events/bus.js";
import type { ProwlarrClient } from "./prowlarr/client.js";
import type { Scheduler } from "./scheduler/index.js";
import type { SyncService } from "./sync/service.js";

/**
 * Composition root shared by all routes and services.
 * Clients are null when their env endpoints are not configured; every
 * consumer must degrade gracefully.
 */
export type AppServices = {
  sonarr: SonarrClient | null;
  radarr: RadarrClient | null;
  prowlarr: ProwlarrClient | null;
  sync: SyncService;
  budget: BudgetManager | null;
  /** Populated by later milestones (hunt engine, oracle, fixer). */
  [key: string]: unknown;
};

export type AppContext = {
  env: Env;
  db: Db;
  sqlite: SqliteHandle;
  settings: SettingsService;
  auth: AuthService;
  bus: EventBus;
  scheduler: Scheduler;
  services: AppServices;
};
