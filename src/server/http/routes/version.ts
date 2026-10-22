import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "../../version.js";

export function registerVersionRoutes(app: FastifyInstance): void {
  app.get("/api/version", async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").send({ version: APP_VERSION });
  });
}
