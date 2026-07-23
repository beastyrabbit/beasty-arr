import type { CodexLoginService } from "./ai/codex-auth.js";
import type { OracleService } from "./ai/oracle-service.js";
import type { PiRunner } from "./ai/providers.js";
import type { RadarrClient } from "./arr/radarr-client.js";
import type { SonarrClient } from "./arr/sonarr-client.js";
import type { AuthService } from "./auth/service.js";
import type { BudgetManager } from "./budget/manager.js";
import type { Env } from "./config/env.js";
import type { SettingsService } from "./config/settings.js";
import type { Db, SqliteHandle } from "./db/index.js";
import type { EventBus } from "./events/bus.js";
import type { FixerBulk } from "./fixer/bulk.js";
import type { FixerService } from "./fixer/service.js";
import type { HuntEngine } from "./hunt/engine.js";
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
  engine: HuntEngine;
  oracle: OracleService;
  piRunner: PiRunner;
  codexLogin: CodexLoginService;
  fixer: FixerService;
  fixerBulk: FixerBulk;
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
