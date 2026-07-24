import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createCodexLoginService, seedOpenAICodexAuthFromCodex } from "./ai/codex-auth.js";
import { createFixerRunner } from "./ai/fixer-adapter.js";
import { OracleService } from "./ai/oracle-service.js";
import { createPiRunner, getAuthStorage } from "./ai/providers.js";
import { RadarrClient } from "./arr/radarr-client.js";
import { SonarrClient } from "./arr/sonarr-client.js";
import { registerAuthGuard } from "./auth/plugin.js";
import { AuthService, generateDevApiKey, loadOrCreateSessionSecret } from "./auth/service.js";
import { BudgetManager } from "./budget/manager.js";
import { isEnginePaused } from "./config/engine-flag.js";
import { type Env, loadEnv } from "./config/env.js";
import { SettingsService } from "./config/settings.js";
import type { AppContext } from "./context.js";
import { createDb } from "./db/index.js";
import { EventBus } from "./events/bus.js";
import { FixerBulk } from "./fixer/bulk.js";
import { FixerService } from "./fixer/service.js";
import { registerRoutes } from "./http/routes/index.js";
import { HuntEngine } from "./hunt/engine.js";
import { ProwlarrClient } from "./prowlarr/client.js";
import { Scheduler } from "./scheduler/index.js";
import { backupDatabase, snapshotDailyStats } from "./stats/maintenance.js";
import { radarrSyncPort, sonarrSyncPort } from "./sync/adapters.js";
import { SyncService } from "./sync/service.js";

export type BuildAppOptions = {
  env?: Partial<Env>;
  /** In-memory DB + no migrations folder lookup for tests. */
  dataDir?: string;
  migrationsFolder?: string | null;
  serveStatic?: boolean;
  /** Background jobs are off in tests unless explicitly enabled. */
  registerJobs?: boolean;
};

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const env = { ...loadEnv(), ...opts.env } as Env;
  const dataDir = opts.dataDir ?? env.DATA_DIR;

  const app = Fastify({
    trustProxy: true,
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers['x-api-key']",
          "req.headers.cookie",
          "req.headers.authorization",
          "*.apiKey",
          "*.api_key",
        ],
        censor: "[redacted]",
      },
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // cwd is the repo root in dev (tsx) and /app in the container — both contain drizzle/.
  const migrationsFolder =
    opts.migrationsFolder === null
      ? undefined
      : (opts.migrationsFolder ?? path.resolve(process.cwd(), "drizzle"));
  const { db, sqlite } = createDb(dataDir, { migrationsFolder });

  let apiKey = env.APP_API_KEY;
  if (!apiKey) {
    apiKey = generateDevApiKey();
    app.log.warn(`APP_API_KEY not set — generated dev key: ${apiKey}`);
  }

  const settings = new SettingsService(db);
  const bus = new EventBus();

  const sonarr =
    env.SONARR_URL && env.SONARR_API_KEY
      ? new SonarrClient({ baseUrl: env.SONARR_URL, apiKey: env.SONARR_API_KEY })
      : null;
  const radarr =
    env.RADARR_URL && env.RADARR_API_KEY
      ? new RadarrClient({ baseUrl: env.RADARR_URL, apiKey: env.RADARR_API_KEY })
      : null;
  const prowlarr =
    env.PROWLARR_URL && env.PROWLARR_API_KEY
      ? new ProwlarrClient({ baseUrl: env.PROWLARR_URL, apiKey: env.PROWLARR_API_KEY })
      : null;

  const sync = new SyncService(
    db,
    settings,
    sonarr ? sonarrSyncPort(sonarr) : null,
    radarr ? radarrSyncPort(radarr) : null,
    bus,
    app.log,
  );
  const budget = prowlarr ? new BudgetManager(db, settings, prowlarr, bus, app.log) : null;
  const engine = new HuntEngine(db, settings, { sonarr, radarr }, budget, sync, bus, app.log);

  const piRunner = createPiRunner({ dataDir, env, settings });
  const codexLogin = createCodexLoginService(dataDir);
  const oracle = new OracleService(db, settings, piRunner, bus, app.log, {
    searxngUrl: env.SEARXNG_URL,
  });
  oracle.onVerdict = (row) => engine.applyVerdict(row);

  const fixer = new FixerService(
    db,
    settings,
    { sonarr, radarr },
    createFixerRunner(piRunner),
    bus,
    app.log,
  );
  const fixerBulk = new FixerBulk(fixer, settings, app.log);

  const ctx: AppContext = {
    env,
    db,
    sqlite,
    settings,
    auth: new AuthService(db, apiKey),
    bus,
    scheduler: new Scheduler(app.log),
    services: {
      sonarr,
      radarr,
      prowlarr,
      sync,
      budget,
      engine,
      oracle,
      piRunner,
      codexLogin,
      fixer,
      fixerBulk,
    },
  };

  if (env.NODE_ENV === "development") {
    void seedOpenAICodexAuthFromCodex(getAuthStorage(dataDir)).catch(() => undefined);
  }

  if (opts.registerJobs ?? env.NODE_ENV !== "test") {
    const tickMs = settings.get().huntTickMinutes * 60_000;
    ctx.scheduler.registerJob({
      name: "hunt.cycle",
      intervalMs: tickMs,
      run: async (signal) => {
        // Incremental sync first so the cycle selects against fresh state.
        await sync.incrementalSync(signal);
        if (isEnginePaused(db)) return; // user paused hunting; sync stays live
        await engine.runCycle(signal);
      },
    });
    ctx.scheduler.registerJob({
      name: "sync.full",
      intervalMs: 24 * 60 * 60 * 1000,
      alignToUtcHour: 3,
      run: (signal) => sync.fullReconcile(signal),
    });
    ctx.scheduler.registerJob({
      name: "oracle.daily",
      intervalMs: 24 * 60 * 60 * 1000,
      alignToUtcHour: 4,
      run: async (signal) => {
        await oracle.runDailyBatch(signal);
      },
    });
    ctx.scheduler.registerJob({
      name: "stats.daily",
      intervalMs: 60 * 60 * 1000,
      run: async () => snapshotDailyStats(db),
    });
    ctx.scheduler.registerJob({
      name: "db.backup",
      intervalMs: 24 * 60 * 60 * 1000,
      alignToUtcHour: 2,
      run: async () => backupDatabase(sqlite, dataDir, app.log),
    });
  }

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // SPA serves its own assets; no external origins used
  });
  await app.register(fastifyCookie, { secret: loadOrCreateSessionSecret(dataDir) });
  await app.register(fastifyRateLimit, { global: false });

  registerAuthGuard(app, ctx.auth);
  await registerRoutes(app, ctx);

  if (opts.serveStatic ?? env.NODE_ENV === "production") {
    await app.register(fastifyStatic, {
      root: path.resolve(import.meta.dirname, "../..", "web"),
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    ctx.scheduler.stop();
    fixer.cancelAll();
    fixerBulk.cancel();
    sqlite.close();
  });

  return { app, ctx };
}
