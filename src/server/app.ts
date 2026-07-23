import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthGuard } from "./auth/plugin.js";
import { AuthService, generateDevApiKey, loadOrCreateSessionSecret } from "./auth/service.js";
import { type Env, loadEnv } from "./config/env.js";
import { SettingsService } from "./config/settings.js";
import type { AppContext } from "./context.js";
import { createDb } from "./db/index.js";
import { EventBus } from "./events/bus.js";
import { registerRoutes } from "./http/routes/index.js";
import { Scheduler } from "./scheduler/index.js";

export type BuildAppOptions = {
  env?: Partial<Env>;
  /** In-memory DB + no migrations folder lookup for tests. */
  dataDir?: string;
  migrationsFolder?: string | null;
  serveStatic?: boolean;
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

  const ctx: AppContext = {
    env,
    db,
    sqlite,
    settings: new SettingsService(db),
    auth: new AuthService(db, apiKey),
    bus: new EventBus(),
    scheduler: new Scheduler(app.log),
    services: {},
  };

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
    sqlite.close();
  });

  return { app, ctx };
}
