import { and, count, desc, eq, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ACTIVITY_TYPES,
  type ActivityEntry,
  type ActivityResponse,
  type AiVerdictDto,
  type AttemptResult,
  type AttemptStatus,
  type AttemptsResponse,
  type SearchAttemptDto,
  type VerdictsResponse,
} from "../../../shared/api-types.js";
import { AI_VERDICTS, ARR_SOURCES, SEARCH_TRIGGERS } from "../../../shared/domain.js";
import type { AppContext } from "../../context.js";
import { activityLog, aiVerdicts, searchAttempts } from "../../db/schema.js";
import { notFound, pageOffset, parse } from "./util.js";

const pageSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
};

const attemptsQuerySchema = z.object({
  ...pageSchema,
  source: z.enum(ARR_SOURCES).optional(),
  trigger: z.enum(SEARCH_TRIGGERS).optional(),
});

const activityQuerySchema = z.object({
  ...pageSchema,
  type: z.enum(ACTIVITY_TYPES).optional(),
});

const verdictsQuerySchema = z.object({
  ...pageSchema,
  verdict: z.enum(AI_VERDICTS).optional(),
});

function whereOf(conds: SQL[]): SQL | undefined {
  return conds.length ? and(...conds) : undefined;
}

export function registerLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/attempts", async (request, reply) => {
    const q = parse(reply, attemptsQuerySchema, request.query);
    if (!q.ok) return;
    const conds: SQL[] = [];
    if (q.data.source) conds.push(eq(searchAttempts.source, q.data.source));
    if (q.data.trigger) conds.push(eq(searchAttempts.trigger, q.data.trigger));
    const where = whereOf(conds);
    const total = ctx.db.select({ n: count() }).from(searchAttempts).where(where).get()?.n ?? 0;
    const rows = ctx.db
      .select()
      .from(searchAttempts)
      .where(where)
      .orderBy(desc(searchAttempts.createdAt), desc(searchAttempts.id))
      .limit(q.data.pageSize)
      .offset(pageOffset(q.data.page, q.data.pageSize))
      .all();
    const items: SearchAttemptDto[] = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      source: r.source,
      commandName: r.commandName,
      targetLabel: r.targetLabel,
      trigger: r.trigger as SearchAttemptDto["trigger"],
      estimatedQueries: r.estimatedQueries,
      status: r.status as AttemptStatus,
      result: (r.result as AttemptResult | null) ?? null,
      dryRun: r.dryRun,
      completedAt: r.completedAt,
    }));
    const response: AttemptsResponse = {
      items,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
    };
    return response;
  });

  app.get("/api/activity", async (request, reply) => {
    const q = parse(reply, activityQuerySchema, request.query);
    if (!q.ok) return;
    const where = q.data.type ? eq(activityLog.type, q.data.type) : undefined;
    const total = ctx.db.select({ n: count() }).from(activityLog).where(where).get()?.n ?? 0;
    const rows = ctx.db
      .select()
      .from(activityLog)
      .where(where)
      .orderBy(desc(activityLog.at), desc(activityLog.id))
      .limit(q.data.pageSize)
      .offset(pageOffset(q.data.page, q.data.pageSize))
      .all();
    const items: ActivityEntry[] = rows.map((r) => ({
      id: r.id,
      at: r.at,
      level: r.level as ActivityEntry["level"],
      type: r.type as ActivityEntry["type"],
      message: r.message,
      data: r.data ?? null,
    }));
    const response: ActivityResponse = {
      items,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
    };
    return response;
  });

  app.get("/api/verdicts", async (request, reply) => {
    const q = parse(reply, verdictsQuerySchema, request.query);
    if (!q.ok) return;
    const where = q.data.verdict ? eq(aiVerdicts.verdict, q.data.verdict) : undefined;
    const total = ctx.db.select({ n: count() }).from(aiVerdicts).where(where).get()?.n ?? 0;
    const rows = ctx.db
      .select()
      .from(aiVerdicts)
      .where(where)
      .orderBy(desc(aiVerdicts.checkedAt), desc(aiVerdicts.id))
      .limit(q.data.pageSize)
      .offset(pageOffset(q.data.page, q.data.pageSize))
      .all();
    const items: AiVerdictDto[] = rows.map((r) => ({
      id: r.id,
      subjectKind: r.subjectKind as AiVerdictDto["subjectKind"],
      subjectKey: r.subjectKey,
      title: r.title,
      year: r.year,
      verdict: r.verdict,
      confidence: r.confidence,
      germanTitle: r.germanTitle,
      perSeason: r.perSeason,
      evidence: r.evidence,
      expectedAvailability: r.expectedAvailability,
      provider: r.provider,
      model: r.model,
      promptVersion: r.promptVersion,
      checkedAt: r.checkedAt,
      recheckAfter: r.recheckAfter,
      superseded: r.supersededBy != null,
    }));
    const response: VerdictsResponse = {
      items,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
    };
    return response;
  });

  app.post("/api/verdicts/:id/invalidate", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.coerce.number().int() }), request.params);
    if (!p.ok) return;
    const q = parse(reply, z.object({ recheck: z.coerce.boolean().optional() }), request.query);
    if (!q.ok) return;
    const row = ctx.db.select().from(aiVerdicts).where(eq(aiVerdicts.id, p.data.id)).get();
    if (!row) return notFound(reply, "verdict not found");
    ctx.services.oracle.invalidateVerdicts(row.subjectKey);
    if (q.data.recheck) {
      // Explicit user re-check; runs live (even in dry-run) so do it in the
      // background — the SSE ai.check.completed event refreshes the GUI.
      void ctx.services.oracle
        .recheckSubject(row.subjectKey, false)
        .catch((err) =>
          request.log.warn({ err, subjectKey: row.subjectKey }, "verdict recheck failed"),
        );
    }
    return { ok: true };
  });
}
