import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./service.js";

export const SESSION_COOKIE = "beasty_session";

/** Routes reachable without auth. Kept deliberately tiny (Huntarr lesson). */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/login"]);

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type AuthContext = { via: "api-key" | "session" };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function registerAuthGuard(app: FastifyInstance, auth: AuthService): void {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split("?")[0];
    if (!url.startsWith("/api/")) return; // SPA assets
    if (PUBLIC_ROUTES.has(url)) return;
    // Webhooks authenticate via token query param handled in their route.
    if (url.startsWith("/api/webhooks/")) return;

    const headerKey = request.headers["x-api-key"];
    if (typeof headerKey === "string" && auth.verifyApiKey(headerKey)) {
      request.auth = { via: "api-key" };
      return;
    }

    const rawCookie = request.cookies?.[SESSION_COOKIE];
    if (rawCookie) {
      const unsigned = request.unsignCookie(rawCookie);
      if (unsigned.valid && unsigned.value && auth.verifySession(unsigned.value)) {
        // CSRF hardening for cookie-authed mutations: same-origin check.
        if (MUTATING_METHODS.has(request.method)) {
          const origin = request.headers.origin;
          if (origin) {
            const host = request.headers.host;
            let originHost: string | null = null;
            try {
              originHost = new URL(origin).host;
            } catch {
              originHost = null;
            }
            if (!host || originHost !== host) {
              return reply.code(403).send({ error: "cross-origin request rejected" });
            }
          }
        }
        request.auth = { via: "session" };
        return;
      }
    }

    return reply.code(401).send({ error: "unauthorized" });
  });
}
