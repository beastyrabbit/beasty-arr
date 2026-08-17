import { desc, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  FixerAnalysisDto,
  FixerAnalysisState,
  FixerAnalyzeResponse,
  FixerApplyResponse,
  FixerBulkStatusResponse,
  FixerHistoryEntry,
  FixerHistoryResponse,
  FixerIgnoreResponse,
  FixerQueueItemDto,
  FixerQueueResponse,
  FixerRemoveResponse,
} from "../../../shared/api-types.js";
import { ARR_SOURCES } from "../../../shared/domain.js";
import type {
  ManualImportCandidate,
  QueueRemovalOptions,
  ResolutionProposal,
  ValidationResult,
} from "../../../shared/fixer-types.js";
import type { AppContext } from "../../context.js";
import { fixerAnalyses } from "../../db/schema.js";
import type { FixerAnalysisEvent } from "../../fixer/ai-port.js";
import { toResolverEvent } from "../../fixer/events-map.js";
import { type FixerAnalysisRow, manualRemovalOptions } from "../../fixer/service.js";
import { dryRunResult, notFound, parse, serviceUnavailable } from "./util.js";

const serviceParamsSchema = z.object({
  service: z.enum(ARR_SOURCES),
  id: z.coerce.number().int(),
});

// ============ mappers ============

function analysisStateOf(row: FixerAnalysisRow): FixerAnalysisState {
  if (row.status === "running") return "analyzing";
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "failed") return "error";
  const proposal = row.proposal as unknown as ResolutionProposal | null;
  const validation = row.validation as unknown as ValidationResult | null;
  if (!proposal) return "error";
  if (proposal.action === "needs_review" || (validation && !validation.ok)) return "needs_review";
  return "proposal";
}

function toAnalysisDto(row: FixerAnalysisRow): FixerAnalysisDto {
  return {
    id: row.id,
    createdAt: row.createdAt,
    service: row.service,
    queueItemId: row.queueItemId,
    downloadId: row.downloadId,
    itemLabel: row.itemLabel,
    status: row.status as FixerAnalysisDto["status"],
    proposal: (row.proposal as unknown as ResolutionProposal | null) ?? null,
    validation: (row.validation as unknown as ValidationResult | null) ?? null,
    candidates: (row.candidates as unknown as ManualImportCandidate[] | null) ?? null,
    events: ((row.events ?? []) as FixerAnalysisEvent[]).map(toResolverEvent),
    error: row.error,
    completedAt: row.completedAt,
  };
}

/** Latest analysis per `${service}:${queueItemId}` from the recent analysis rows. */
function latestAnalyses(ctx: AppContext): Map<string, FixerAnalysisRow> {
  const rows = ctx.db
    .select()
    .from(fixerAnalyses)
    .orderBy(desc(fixerAnalyses.createdAt))
    .limit(500)
    .all();
  const map = new Map<string, FixerAnalysisRow>();
  for (const r of rows) {
    const key = `${r.service}:${r.queueItemId}`;
    if (!map.has(key)) map.set(key, r);
  }
  return map;
}

export function registerFixerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const buildQueueResponse = (
    snapshot: Awaited<ReturnType<AppContext["services"]["fixer"]["getQueue"]>>,
  ): FixerQueueResponse => {
    const analyses = latestAnalyses(ctx);
    const items: FixerQueueItemDto[] = snapshot.items.map((item) => {
      const analysis = analyses.get(`${item.service}:${item.id}`);
      const proposal = analysis?.proposal as unknown as ResolutionProposal | null | undefined;
      return {
        ...item,
        analysisId: analysis?.id ?? null,
        analysisState: analysis ? analysisStateOf(analysis) : null,
        confidence: proposal?.confidence ?? null,
      };
    });
    return { items, fetchedAt: snapshot.fetchedAt };
  };

  app.get("/api/fixer/queue", async () => {
    return buildQueueResponse(await ctx.services.fixer.getQueue());
  });

  app.post("/api/fixer/queue/refresh", async () => {
    return buildQueueResponse(await ctx.services.fixer.refreshQueue());
  });

  app.post("/api/fixer/items/:service/:id/analyze", async (request, reply) => {
    const p = parse(reply, serviceParamsSchema, request.params);
    if (!p.ok) return;
    try {
      const { analysisId } = await ctx.services.fixer.analyze(p.data.service, p.data.id);
      ctx.bus.emit("fixer.queue.changed", { queueItemId: p.data.id });
      const response: FixerAnalyzeResponse = { analysisId };
      return reply.code(202).send(response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/not configured/i.test(msg)) return serviceUnavailable(reply, msg);
      if (/not found/i.test(msg)) return notFound(reply, msg);
      return reply.code(500).send({ error: msg });
    }
  });

  app.post("/api/fixer/items/:service/:id/cancel", async (request, reply) => {
    const p = parse(reply, serviceParamsSchema, request.params);
    if (!p.ok) return;
    ctx.services.fixer.cancel(p.data.service, p.data.id);
    return { ok: true };
  });

  app.get("/api/fixer/analyses/:id", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.string().min(1) }), request.params);
    if (!p.ok) return;
    const row = ctx.services.fixer.getAnalysis(p.data.id);
    if (!row) return notFound(reply, "analysis not found");
    return toAnalysisDto(row);
  });

  app.post("/api/fixer/analyses/:id/apply", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.string().min(1) }), request.params);
    if (!p.ok) return;
    const b = parse(
      reply,
      z.object({ candidateIds: z.array(z.string()).optional() }),
      request.body ?? {},
    );
    if (!b.ok) return;
    if (!ctx.services.fixer.getAnalysis(p.data.id)) return notFound(reply, "analysis not found");
    const outcome = await ctx.services.fixer.apply(p.data.id, b.data.candidateIds);
    if (outcome.dryRun) {
      if (!outcome.ok) {
        const response: FixerApplyResponse = { ok: false, message: outcome.message };
        return response;
      }
      const response: FixerApplyResponse = dryRunResult(outcome.message);
      return response;
    }
    const response: FixerApplyResponse = {
      ok: outcome.ok,
      message: outcome.message,
      ...(outcome.commandId === undefined ? {} : { commandId: outcome.commandId }),
    };
    return response;
  });

  app.post("/api/fixer/items/:service/:id/remove", async (request, reply) => {
    const p = parse(reply, serviceParamsSchema, request.params);
    if (!p.ok) return;
    const b = parse(
      reply,
      z.object({
        removeFromClient: z.boolean().optional(),
        blocklist: z.boolean().optional(),
        skipRedownload: z.boolean().optional(),
        changeCategory: z.boolean().optional(),
      }),
      request.body ?? {},
    );
    if (!b.ok) return;
    const options: QueueRemovalOptions = { ...manualRemovalOptions, ...b.data };
    const outcome = await ctx.services.fixer.removeQueueItem(p.data.service, p.data.id, options, {
      sourceKind: "user",
    });
    if (outcome.dryRun) {
      const response: FixerRemoveResponse = dryRunResult(outcome.message);
      return response;
    }
    if (!outcome.ok) return reply.code(502).send({ error: outcome.message });
    const response: FixerRemoveResponse = { ok: true };
    return response;
  });

  app.post("/api/fixer/items/:service/:id/ignore", async (request, reply) => {
    const p = parse(reply, serviceParamsSchema, request.params);
    if (!p.ok) return;
    const outcome = await ctx.services.fixer.ignoreQueueItem(p.data.service, p.data.id, {
      sourceKind: "user",
    });
    if (outcome.dryRun) {
      const response: FixerIgnoreResponse = dryRunResult(outcome.message);
      return response;
    }
    if (!outcome.ok) return reply.code(502).send({ error: outcome.message });
    const response: FixerIgnoreResponse = { ok: true };
    return response;
  });

  app.post("/api/fixer/bulk/start", async (request, reply) => {
    const b = parse(
      reply,
      z
        .object({
          targets: z
            .array(
              z.object({
                service: z.enum(ARR_SOURCES),
                queueItemId: z.number().int(),
              }),
            )
            .optional(),
          skipAnalyzed: z.boolean().optional(),
        })
        .optional(),
      request.body ?? {},
    );
    if (!b.ok) return;
    const result = await ctx.services.fixerBulk.start(b.data ?? {});
    if (!result.ok)
      return reply.code(409).send({ error: result.message ?? "bulk already running" });
    return { ok: true };
  });

  app.post("/api/fixer/bulk/cancel", async () => {
    ctx.services.fixerBulk.cancel();
    return { ok: true };
  });

  app.get("/api/fixer/bulk/status", async () => {
    const s = ctx.services.fixerBulk.getStatus();
    const response: FixerBulkStatusResponse = {
      running: s.running,
      total: s.total,
      completed: s.completed,
      failed: s.failed,
      activeItemIds: s.inFlight.map((e) => e.queueItemId),
      autoApply: s.autoApply,
    };
    return response;
  });

  app.get("/api/fixer/history", async (request, reply) => {
    const q = parse(
      reply,
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    if (!q.ok) return;
    const pageResult = ctx.services.fixer.listHistory({
      page: q.data.page,
      pageSize: q.data.pageSize,
    });

    const analysisIds = [
      ...new Set(
        pageResult.items.map((r) => r.analysisId).filter((id): id is string => id != null),
      ),
    ];
    const proposalByAnalysis = new Map<string, ResolutionProposal>();
    if (analysisIds.length) {
      for (const row of ctx.db
        .select({ id: fixerAnalyses.id, proposal: fixerAnalyses.proposal })
        .from(fixerAnalyses)
        .where(inArray(fixerAnalyses.id, analysisIds))
        .all()) {
        if (row.proposal)
          proposalByAnalysis.set(row.id, row.proposal as unknown as ResolutionProposal);
      }
    }

    const items: FixerHistoryEntry[] = pageResult.items.map((r) => ({
      id: r.id,
      at: r.at,
      service: r.service,
      itemLabel: r.itemLabel,
      action: r.action as FixerHistoryEntry["action"],
      sourceKind: r.sourceKind as FixerHistoryEntry["sourceKind"],
      confidence: r.confidence,
      analysisId: r.analysisId,
      dryRun: r.dryRun,
      result: r.result as FixerHistoryEntry["result"],
      detail: r.detail,
      proposal: r.analysisId ? (proposalByAnalysis.get(r.analysisId) ?? null) : null,
    }));
    const response: FixerHistoryResponse = {
      items,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
      total: pageResult.total,
    };
    return response;
  });
}
