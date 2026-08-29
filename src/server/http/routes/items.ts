import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  ForceResponse,
  ItemSubjectKind,
  OverrideResponse,
  PauseResponse,
  ResumeResponse,
} from "../../../shared/api-types.js";
import { ITEM_SUBJECT_KINDS } from "../../../shared/api-types.js";
import { ARR_SOURCES, type ArrSource, TARGET_MODES } from "../../../shared/domain.js";
import type { AppContext } from "../../context.js";
import { itemOverrides } from "../../db/schema.js";
import type { SubjectKind } from "../../hunt/engine.js";
import { dryRunResult, notFound, parse, serviceUnavailable } from "./util.js";

const paramsSchema = z.object({
  source: z.enum(ARR_SOURCES),
  kind: z.enum(ITEM_SUBJECT_KINDS),
  id: z.coerce.number().int(),
});

const forceBodySchema = z.object({
  scope: z
    .object({
      seasonNumber: z.number().int().optional(),
      episodeIds: z.array(z.number().int()).optional(),
    })
    .optional(),
  withAiRecheck: z.boolean().optional(),
});

const pauseBodySchema = z.object({
  until: z.number().int().nullable().optional(),
  note: z.string().optional(),
});

const resumeBodySchema = z.object({
  force: z.boolean().optional(),
  overrideAi: z.boolean().optional(),
});

const overrideBodySchema = z.object({
  targetMode: z.enum(TARGET_MODES).nullable(),
  dubLagDays: z.number().int().min(0).nullable().optional(),
  note: z.string().nullable().optional(),
});

function arrClientFor(ctx: AppContext, source: ArrSource) {
  return source === "sonarr" ? ctx.services.sonarr : ctx.services.radarr;
}

function subjectLabel(source: ArrSource, kind: string, id: number): string {
  return `${source} ${kind} ${id}`;
}

export function registerItemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/items/:source/:kind/:id/force", async (request, reply) => {
    const p = parse(reply, paramsSchema, request.params);
    if (!p.ok) return;
    const b = parse(reply, forceBodySchema, request.body ?? {});
    if (!b.ok) return;
    const { source, kind, id } = p.data;
    if (!arrClientFor(ctx, source)) {
      return serviceUnavailable(reply, `${source} is not configured`);
    }

    const engine = ctx.services.engine;
    const withAiRecheck = b.data.withAiRecheck;
    let queuedTargets = 0;
    let requestId = 0;
    if (kind === "series" && b.data.scope?.episodeIds?.length) {
      for (const episodeId of b.data.scope.episodeIds) {
        const result = engine.forceSubject({
          source,
          kind: "episode",
          id: episodeId,
          withAiRecheck,
        });
        queuedTargets += result.queuedTargets;
        if (requestId === 0) requestId = result.requestId;
      }
    } else {
      const engineKind: SubjectKind =
        kind === "series" && b.data.scope?.seasonNumber != null ? "season" : (kind as SubjectKind);
      const result = engine.forceSubject({
        source,
        kind: engineKind,
        id,
        seasonNumber: b.data.scope?.seasonNumber,
        withAiRecheck,
      });
      queuedTargets += result.queuedTargets;
      requestId = result.requestId;
    }
    if (queuedTargets === 0) return notFound(reply, "no huntable targets for this subject");
    // Human force means now: do not wait for the next periodic tick.
    void ctx.scheduler.trigger("hunt.cycle");

    if (ctx.settings.get().dryRun) {
      const response: ForceResponse = dryRunResult(
        `would force a search for ${subjectLabel(source, kind, id)} (${queuedTargets} target(s))`,
      );
      return response;
    }
    const response: ForceResponse = { queuePosition: 1, requestId };
    return response;
  });

  app.post("/api/items/:source/:kind/:id/pause", async (request, reply) => {
    const p = parse(reply, paramsSchema, request.params);
    if (!p.ok) return;
    const b = parse(reply, pauseBodySchema, request.body ?? {});
    if (!b.ok) return;
    const { source, kind, id } = p.data;
    const result = ctx.services.engine.pauseSubject({
      source,
      kind: kind as SubjectKind,
      id,
      until: b.data.until ?? undefined,
      note: b.data.note,
    });
    if (result.pausedTargets === 0) return notFound(reply, "no targets to pause for this subject");
    const response: PauseResponse = { ok: true };
    return response;
  });

  app.post("/api/items/:source/:kind/:id/resume", async (request, reply) => {
    const p = parse(reply, paramsSchema, request.params);
    if (!p.ok) return;
    const b = parse(reply, resumeBodySchema, request.body ?? {});
    if (!b.ok) return;
    const { source, kind, id } = p.data;
    const engine = ctx.services.engine;
    const resumed = engine.resumeSubject({
      source,
      kind: kind as SubjectKind,
      id,
      force: b.data.force,
      overrideAi: b.data.overrideAi,
    });
    if (resumed.resumedTargets === 0)
      return notFound(reply, "no targets to resume for this subject");

    if (!b.data.force) {
      const response: ResumeResponse = { ok: true };
      return response;
    }
    // force: also enqueue a forced search right away (dry-run gated at dispatch).
    if (!arrClientFor(ctx, source)) {
      return serviceUnavailable(reply, `${source} is not configured`);
    }
    engine.forceSubject({ source, kind: kind as SubjectKind, id, withAiRecheck: false });
    void ctx.scheduler.trigger("hunt.cycle");
    if (ctx.settings.get().dryRun) {
      const response: ResumeResponse = dryRunResult(
        `would resume and force a search for ${subjectLabel(source, kind, id)}`,
      );
      return response;
    }
    const response: ResumeResponse = { ok: true, queuePosition: 1 };
    return response;
  });

  app.put("/api/items/:source/:kind/:id/override", async (request, reply) => {
    const p = parse(reply, paramsSchema, request.params);
    if (!p.ok) return;
    const b = parse(reply, overrideBodySchema, request.body);
    if (!b.ok) return;
    const { source, kind, id } = p.data;
    if (kind === "episode") {
      return reply
        .code(400)
        .send({ error: "overrides are set at series/movie level, not episode" });
    }
    const subjectKind: "series" | "movie" = kind === "movie" ? "movie" : "series";
    const targetMode = b.data.targetMode;
    const dubLagDays = b.data.dubLagDays ?? null;
    const note = b.data.note ?? null;

    if (targetMode === null && dubLagDays === null && note === null) {
      ctx.db
        .delete(itemOverrides)
        .where(
          and(
            eq(itemOverrides.source, source),
            eq(itemOverrides.subjectKind, subjectKind),
            eq(itemOverrides.subjectId, id),
            eq(itemOverrides.seasonNumber, -1),
          ),
        )
        .run();
    } else {
      ctx.db
        .insert(itemOverrides)
        .values({
          source,
          subjectKind,
          subjectId: id,
          seasonNumber: -1,
          targetMode,
          dubLagDays,
          note,
        })
        .onConflictDoUpdate({
          target: [
            itemOverrides.source,
            itemOverrides.subjectKind,
            itemOverrides.subjectId,
            itemOverrides.seasonNumber,
          ],
          set: { targetMode, dubLagDays, note },
        })
        .run();
    }

    // Re-derive immediately so the badge reflects the new target mode (read-only arr call).
    if (subjectKind === "movie") await ctx.services.sync.targetedRefreshMovie(id);
    else await ctx.services.sync.targetedRefreshSeries(id);

    const response: OverrideResponse = { ok: true };
    return response;
  });
}

export type { ItemSubjectKind };
