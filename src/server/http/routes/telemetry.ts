import type { FastifyInstance } from "fastify";
import { telemetryConfig } from "../../telemetry/config.js";

export function registerTelemetryRoutes(app: FastifyInstance, env: NodeJS.ProcessEnv): void {
  app.get("/api/client-config", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send(telemetryConfig(env)),
  );
}
