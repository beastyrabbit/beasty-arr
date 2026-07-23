import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";

const loginBody = z.object({ apiKey: z.string().min(1) });

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success || !ctx.auth.verifyApiKey(parsed.data.apiKey)) {
        return reply.code(401).send({ error: "invalid key" });
      }
      const session = ctx.auth.createSession(request.headers["user-agent"]);
      reply.setCookie(SESSION_COOKIE, session.id, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        signed: true,
        secure: request.protocol === "https",
        expires: new Date(session.expiresAt),
      });
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) ctx.auth.revokeSession(unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({ via: request.auth?.via ?? null }));
}
