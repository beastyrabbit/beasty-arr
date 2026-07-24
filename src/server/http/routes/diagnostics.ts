import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { activityLog, searchAttempts } from "../../db/schema.js";
import { APP_VERSION } from "./config.js";
import { isEnginePaused, loadStateCounts } from "./util.js";

const RECENT_ACTIVITY = 200;
const RECENT_ATTEMPTS = 100;

/**
 * Redacted support bundle. Deliberately built from a fixed allow-list of
 * non-secret fields: settings (behavior only), connection presence booleans
 * (never urls or keys), engine/budget status, recent logs. No env secrets or
 * API keys ever enter this object.
 */
export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/diagnostics/export", async (_request, reply) => {
    const now = Date.now();
    const cfg = ctx.settings.get();
    const bundle = {
      generatedAt: now,
      version: APP_VERSION,
      dryRun: cfg.dryRun,
      enginePaused: isEnginePaused(ctx),
      connections: {
        sonarr: {
          keyPresent: Boolean(ctx.env.SONARR_API_KEY),
          configured: Boolean(ctx.env.SONARR_URL),
        },
        radarr: {
          keyPresent: Boolean(ctx.env.RADARR_API_KEY),
          configured: Boolean(ctx.env.RADARR_URL),
        },
        prowlarr: {
          keyPresent: Boolean(ctx.env.PROWLARR_API_KEY),
          configured: Boolean(ctx.env.PROWLARR_URL),
        },
      },
      settings: cfg,
      engine: ctx.services.engine.engineStatus(),
      budget: ctx.services.budget ? ctx.services.budget.getStatus() : null,
      counts: loadStateCounts(ctx),
      scheduler: ctx.scheduler.status(),
      recentActivity: ctx.db
        .select()
        .from(activityLog)
        .orderBy(desc(activityLog.at), desc(activityLog.id))
        .limit(RECENT_ACTIVITY)
        .all(),
      recentAttempts: ctx.db
        .select()
        .from(searchAttempts)
        .orderBy(desc(searchAttempts.createdAt), desc(searchAttempts.id))
        .limit(RECENT_ATTEMPTS)
        .all(),
    };
    reply.header(
      "content-disposition",
      `attachment; filename="beasty-arr-diagnostics-${new Date(now).toISOString().slice(0, 10)}.json"`,
    );
    return bundle;
  });
}
