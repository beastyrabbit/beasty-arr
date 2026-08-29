import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { registerAiRoutes } from "./ai.js";
import { registerBudgetRoutes } from "./budget.js";
import { registerConfigRoutes } from "./config.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerEventRoutes } from "./events.js";
import { registerFixerRoutes } from "./fixer.js";
import { registerHealthRoutes } from "./health.js";
import { registerHuntRoutes } from "./hunt.js";
import { registerItemRoutes } from "./items.js";
import { registerLibraryRoutes } from "./library.js";
import { registerLogRoutes } from "./logs.js";
import { registerMissingRoutes } from "./missing.js";
import { registerStatusRoutes } from "./status.js";
import { registerWebhookRoutes } from "./webhooks.js";

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  registerHealthRoutes(app);
  registerEventRoutes(app, ctx);
  registerStatusRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerHuntRoutes(app, ctx);
  registerMissingRoutes(app, ctx);
  registerBudgetRoutes(app, ctx);
  registerLogRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerFixerRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerDiagnosticsRoutes(app, ctx);
}
