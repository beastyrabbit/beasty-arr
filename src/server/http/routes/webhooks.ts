import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { parse } from "./util.js";

/**
 * Arr webhook accelerator. The global auth guard exempts /api/webhooks/*, so the
 * token is verified here against APP_API_KEY (Sonarr/Radarr can only put it in
 * the URL query). Any event that touches a series/movie enqueues a targeted
 * refresh; the engine is fully functional without these.
 */
const webhookBodySchema = z
  .object({
    eventType: z.string().optional(),
    series: z.object({ id: z.number().int().optional() }).partial().passthrough().optional(),
    movie: z.object({ id: z.number().int().optional() }).partial().passthrough().optional(),
  })
  .passthrough();

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/webhooks/:source", async (request, reply) => {
    const p = parse(reply, z.object({ source: z.enum(["sonarr", "radarr"]) }), request.params);
    if (!p.ok) return;
    const token = (request.query as { token?: unknown }).token;
    if (typeof token !== "string" || !ctx.auth.verifyApiKey(token)) {
      return reply.code(401).send({ error: "invalid or missing token" });
    }
    const b = parse(reply, webhookBodySchema, request.body ?? {});
    if (!b.ok) return;

    if (p.data.source === "sonarr") {
      const seriesId = b.data.series?.id;
      if (typeof seriesId === "number") {
        void ctx.services.sync.targetedRefreshSeries(seriesId).catch((err) => {
          request.log.warn({ err, seriesId }, "webhook series refresh failed");
        });
      }
    } else {
      const movieId = b.data.movie?.id;
      if (typeof movieId === "number") {
        void ctx.services.sync.targetedRefreshMovie(movieId).catch((err) => {
          request.log.warn({ err, movieId }, "webhook movie refresh failed");
        });
      }
    }
    return reply.code(204).send();
  });
}
