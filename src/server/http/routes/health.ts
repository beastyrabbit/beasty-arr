import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  // Unauthenticated by design; leaks nothing (no version, no config).
  app.get("/api/health", async () => ({ status: "ok" }));
}
