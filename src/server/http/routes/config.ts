import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AppSettingsDto,
  ConfigResponse,
  ConnectionInfo,
  ConnectionKind,
  TestConnectionResponse,
} from "../../../shared/api-types.js";
import { settingsSchema } from "../../config/settings.js";
import type { AppContext } from "../../context.js";
import { indexers, syncState } from "../../db/schema.js";
import { parse } from "./util.js";

/** Read once at module load — cwd is the repo root (dev) or /app (container). */
export const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// dryRun is toggled only via POST /api/system/dry-run (typed confirm) — never here.
const configPatchSchema = settingsSchema.omit({ dryRun: true }).partial();

function syncStateNum(ctx: AppContext, key: string): number | null {
  const row = ctx.db.select().from(syncState).where(eq(syncState.key, key)).get();
  const n = row ? Number(row.value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function prowlarrLastSync(ctx: AppContext): number | null {
  return (
    ctx.db
      .select({ v: max(indexers.lastSyncedAt) })
      .from(indexers)
      .get()?.v ?? null
  );
}

function buildConnections(ctx: AppContext): Record<ConnectionKind, ConnectionInfo> {
  const env = ctx.env;
  return {
    sonarr: {
      url: env.SONARR_URL ?? null,
      keyPresent: Boolean(env.SONARR_API_KEY),
      lastSyncAt: syncStateNum(ctx, "sonarr.lastFullSyncAt"),
    },
    radarr: {
      url: env.RADARR_URL ?? null,
      keyPresent: Boolean(env.RADARR_API_KEY),
      lastSyncAt: syncStateNum(ctx, "radarr.lastFullSyncAt"),
    },
    prowlarr: {
      url: env.PROWLARR_URL ?? null,
      keyPresent: Boolean(env.PROWLARR_API_KEY),
      lastSyncAt: prowlarrLastSync(ctx),
    },
  };
}

function configResponse(ctx: AppContext): ConfigResponse {
  const webhookToken = ctx.auth.webhookToken();
  return {
    version: APP_VERSION,
    connections: buildConnections(ctx),
    settings: ctx.settings.get() satisfies AppSettingsDto,
    webhookPaths: {
      sonarr: `/api/webhooks/sonarr?token=${webhookToken}`,
      radarr: `/api/webhooks/radarr?token=${webhookToken}`,
    },
  };
}

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/config", async () => configResponse(ctx));

  app.put("/api/config", async (request, reply) => {
    const b = parse(reply, configPatchSchema, request.body);
    if (!b.ok) return;
    ctx.settings.update(b.data);
    return configResponse(ctx);
  });

  app.post("/api/config/test-connection", async (request, reply) => {
    const b = parse(
      reply,
      z.object({ service: z.enum(["sonarr", "radarr", "prowlarr"]) }),
      request.body,
    );
    if (!b.ok) return;
    const service = b.data.service;
    const client =
      service === "sonarr"
        ? ctx.services.sonarr
        : service === "radarr"
          ? ctx.services.radarr
          : ctx.services.prowlarr;
    if (!client) {
      const response: TestConnectionResponse = {
        ok: false,
        service,
        message: `${service} is not configured (endpoint or key missing)`,
      };
      return response;
    }
    try {
      const status = (await client.getSystemStatus()) as {
        version?: string;
        instanceName?: string;
        appName?: string;
      };
      const name = status.instanceName ?? status.appName;
      const response: TestConnectionResponse = {
        ok: true,
        service,
        message: `Connected${name ? ` to ${name}` : ""}`,
        ...(status.version ? { version: status.version } : {}),
      };
      return response;
    } catch (error) {
      const response: TestConnectionResponse = {
        ok: false,
        service,
        message: error instanceof Error ? error.message : "connection failed",
      };
      return response;
    }
  });
}
