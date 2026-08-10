import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AiBulkStatusResponse,
  AiModelsResponse,
  AiStatusResponse,
  CodexLoginStartResponse,
  CodexLoginState,
  CodexLoginStatusResponse,
} from "../../../shared/api-types.js";
import type { CodexLoginStatus } from "../../ai/codex-auth.js";
import { aiStatus, listModels } from "../../ai/models.js";
import type { ProviderId } from "../../ai/providers.js";
import type { AppContext } from "../../context.js";
import { toAiStatusValue } from "./status.js";
import { dataDirOf, notFound, parse } from "./util.js";

/** codex-auth's internal login states → the api-types enum the GUI polls on. */
function mapCodexStatus(status: CodexLoginStatus): CodexLoginState {
  switch (status) {
    case "pending":
      return "pending";
    case "waiting_user":
      return "authenticating";
    case "done":
      return "authenticated";
    default:
      return "failed";
  }
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/ai/status", async () => {
    const cfg = ctx.settings.get();
    const status = aiStatus({ dataDir: dataDirOf(ctx), env: ctx.env, settings: ctx.settings });
    const response: AiStatusResponse = {
      provider: status.provider,
      model: status.model,
      status: toAiStatusValue(status.status),
      detail: status.detail ?? null,
      checksToday: ctx.services.oracle.countCheckedToday(),
      capPerDay: cfg.aiMaxChecksPerDay,
      dailyLimitEnabled: cfg.aiDailyLimitEnabled,
      parallelism: cfg.aiParallelism,
    };
    return response;
  });

  app.get("/api/ai/bulk/status", async () => {
    const response: AiBulkStatusResponse = ctx.services.oracle.getBulkStatus();
    return response;
  });

  app.post("/api/ai/bulk/start", async (request, reply) => {
    const body = parse(
      reply,
      z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(),
      request.body ?? {},
    );
    if (!body.ok) return;
    const result = ctx.services.oracle.startBulk(body.data);
    if (!result.ok) return reply.code(409).send({ error: result.message ?? "AI bulk unavailable" });
    return reply.code(202).send({ ok: true, total: result.total });
  });

  app.post("/api/ai/bulk/cancel", async () => {
    ctx.services.oracle.cancelBulk();
    return { ok: true };
  });

  app.get("/api/ai/models", async () => {
    const cfg = ctx.settings.get();
    if (cfg.aiProvider === "off") {
      const response: AiModelsResponse = { options: [], source: "pi-registry" };
      return response;
    }
    const provider = cfg.aiProvider as ProviderId;
    try {
      const models = await listModels(provider, {
        dataDir: dataDirOf(ctx),
        env: ctx.env,
        settings: ctx.settings,
      });
      const response: AiModelsResponse = {
        options: models.map((m) => ({
          provider: m.provider,
          model: m.id,
          label: m.name,
          isDefault: m.id === cfg.aiModel,
        })),
        source: "pi-registry",
        warning: models.some((m) => !m.available) ? "some models are unreachable" : undefined,
      };
      return response;
    } catch (error) {
      const response: AiModelsResponse = {
        options: [],
        source: "pi-registry",
        warning: error instanceof Error ? error.message : "model catalog unavailable",
      };
      return response;
    }
  });

  app.post("/api/ai/recheck", async (request, reply) => {
    const body = parse(
      reply,
      z.object({ subjectKey: z.string().regex(/^(sonarr|radarr):\d+$/) }),
      request.body,
    );
    if (!body.ok) return;
    // A human-triggered check overrides dry-run suppression and the daily cap.
    void ctx.services.oracle
      .recheckSubject(body.data.subjectKey, true)
      .catch((error) =>
        request.log.warn(
          { err: error, subjectKey: body.data.subjectKey },
          "forced oracle recheck failed",
        ),
      );
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/ai/codex-login/start", async (_request, reply) => {
    const { loginId } = ctx.services.codexLogin.startCodexLogin();
    const response: CodexLoginStartResponse = { id: loginId };
    return reply.code(202).send(response);
  });

  app.get("/api/ai/codex-login/:id", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.string().min(1) }), request.params);
    if (!p.ok) return;
    const state = ctx.services.codexLogin.getCodexLogin(p.data.id);
    if (!state) return notFound(reply, "login flow not found");
    const response: CodexLoginStatusResponse = {
      id: p.data.id,
      status: mapCodexStatus(state.status),
      verificationUri: state.verificationUri ?? null,
      userCode: state.userCode ?? null,
      error: state.error ?? null,
    };
    return response;
  });
}
