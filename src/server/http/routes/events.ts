import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import type { AppEvent } from "../../events/bus.js";

function formatSse(event: AppEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
  });
  app.get("/api/events", (request, reply) => {
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // proxies: do not buffer
    });
    reply.raw.write(": connected\n\n");

    const lastIdHeader = request.headers["last-event-id"];
    const lastId =
      typeof lastIdHeader === "string" ? Number.parseInt(lastIdHeader, 10) : Number.NaN;
    if (!Number.isNaN(lastId)) {
      for (const event of ctx.bus.since(lastId)) reply.raw.write(formatSse(event));
    }

    const unsubscribe = ctx.bus.subscribe((event) => {
      reply.raw.write(formatSse(event));
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);
    heartbeat.unref?.();

    request.raw.on("close", () => {
      streams.delete(reply.raw);
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
