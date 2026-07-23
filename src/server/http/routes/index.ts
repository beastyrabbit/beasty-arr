import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { registerAuthRoutes } from "./auth.js";
import { registerEventRoutes } from "./events.js";
import { registerHealthRoutes } from "./health.js";

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  registerHealthRoutes(app);
  await registerAuthRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  // Later milestones append: status, library, hunt, budget, fixer, ai, config, webhooks.
}
