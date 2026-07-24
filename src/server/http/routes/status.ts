import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AiStatusValue,
  DashboardSummary,
  StatsHistoryPoint,
  StatsHistoryResponse,
  StatusResponse,
  WinItem,
  WinsResponse,
} from "../../../shared/api-types.js";
import { AI_VERDICTS, type AiVerdictValue } from "../../../shared/domain.js";
import { aiStatus } from "../../ai/models.js";
import type { AppContext } from "../../context.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  fixerAnalyses,
  movies,
  searchAttempts,
  series,
  statsDaily,
} from "../../db/schema.js";
import {
  arrHealthAll,
  dataDirOf,
  type emptyStateCounts,
  germanPct,
  germanPctWithAiDone,
  isEnginePaused,
  loadStateCounts,
  parse,
  round1,
  startOfUtcDay,
} from "./util.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** models.ts reports "unavailable"; the DTO enum uses "error". */
export function toAiStatusValue(
  status: "configured" | "unauthenticated" | "unavailable" | "off",
): AiStatusValue {
  return status === "unavailable" ? "error" : status;
}

function langNames(langs: { name: string }[] | null | undefined): string[] {
  return (langs ?? []).map((l) => l.name);
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function huntsToday(ctx: AppContext, now: number): number {
  const row = ctx.db
    .select({ n: count() })
    .from(searchAttempts)
    .where(gte(searchAttempts.createdAt, startOfUtcDay(now)))
    .get();
  return row?.n ?? 0;
}

/** Max trailing24h/cap across limited indexers, 0..100. */
function budgetUsedPct(ctx: AppContext): number {
  const budget = ctx.services.budget;
  if (!budget) return 0;
  let max = 0;
  for (const ix of budget.getStatus()) {
    if (ix.cap == null || ix.cap <= 0) continue;
    max = Math.max(max, (ix.trailing24h / ix.cap) * 100);
  }
  return round1(Math.min(100, max));
}

async function fixerPending(ctx: AppContext): Promise<number> {
  try {
    return (await ctx.services.fixer.getQueue()).items.length;
  } catch {
    return 0;
  }
}

export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Homepage widget: counts only, cheap to poll.
  app.get("/api/status", async () => {
    const now = Date.now();
    const { total } = loadStateCounts(ctx);
    const ai = aiStatus({ dataDir: dataDirOf(ctx), env: ctx.env, settings: ctx.settings });
    const response: StatusResponse = {
      missingGerman: total.missing,
      otherAudio: total.non_german,
      germanPct: germanPct(total),
      huntsToday: huntsToday(ctx, now),
      budgetUsedPct: budgetUsedPct(ctx),
      fixerPending: await fixerPending(ctx),
      aiStatus: toAiStatusValue(ai.status),
    };
    return response;
  });

  app.get("/api/dashboard/summary", async () => {
    const now = Date.now();
    const cfg = ctx.settings.get();
    const counts = loadStateCounts(ctx);
    const engineView = ctx.services.engine.engineStatus();
    const ai = aiStatus({ dataDir: dataDirOf(ctx), env: ctx.env, settings: ctx.settings });
    const health = await arrHealthAll(ctx);

    const verdictCounts = Object.fromEntries(AI_VERDICTS.map((v) => [v, 0])) as Record<
      AiVerdictValue,
      number
    >;
    for (const row of ctx.db
      .select({ verdict: aiVerdicts.verdict, n: count() })
      .from(aiVerdicts)
      .where(isNull(aiVerdicts.supersededBy))
      .groupBy(aiVerdicts.verdict)
      .all()) {
      verdictCounts[row.verdict as AiVerdictValue] = row.n;
    }

    const analyzing =
      ctx.db
        .select({ n: count() })
        .from(fixerAnalyses)
        .where(eq(fixerAnalyses.status, "running"))
        .get()?.n ?? 0;
    const proposals =
      ctx.db
        .select({ n: count() })
        .from(fixerAnalyses)
        .where(
          and(eq(fixerAnalyses.status, "completed"), sql`${fixerAnalyses.proposal} IS NOT NULL`),
        )
        .get()?.n ?? 0;
    const fixerErrors =
      ctx.db
        .select({ n: count() })
        .from(fixerAnalyses)
        .where(eq(fixerAnalyses.status, "failed"))
        .get()?.n ?? 0;

    const response: DashboardSummary = {
      dryRun: cfg.dryRun,
      engine: {
        state: isEnginePaused(ctx) ? "paused" : "running",
        nextTickAt: engineView.nextTickAt ?? null,
        lastTickAt: engineView.lastCycleAt ?? null,
      },
      counts,
      germanPct: germanPct(counts.total),
      germanPctWithAiDone: germanPctWithAiDone(counts.total),
      deltaWeekPct: deltaWeekPct(ctx, counts.total, now),
      huntsToday: huntsToday(ctx, now),
      arrHealth: health,
      fixer: {
        pending: await fixerPending(ctx),
        analyzing,
        proposals,
        errors: fixerErrors,
      },
      ai: {
        status: toAiStatusValue(ai.status),
        checksToday: ctx.services.oracle.countCheckedToday(),
        capPerDay: cfg.aiMaxChecksPerDay,
        verdictCounts,
      },
    };
    return response;
  });

  app.get("/api/dashboard/wins", async (request, reply) => {
    const q = parse(
      reply,
      z.object({
        since: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(20),
      }),
      request.query,
    );
    if (!q.ok) return;
    const filters = [eq(activityLog.type, "hunt.win")];
    if (q.data.since != null) filters.push(gte(activityLog.at, q.data.since));
    const rows = ctx.db
      .select()
      .from(activityLog)
      .where(and(...filters))
      .orderBy(desc(activityLog.at))
      .limit(q.data.limit)
      .all();

    const epIds: number[] = [];
    const movieIds: number[] = [];
    for (const r of rows) {
      const d = (r.data ?? {}) as { kind?: string; targetId?: number };
      if (d.targetId == null) continue;
      if (d.kind === "episode") epIds.push(d.targetId);
      else if (d.kind === "movie") movieIds.push(d.targetId);
    }
    const epById = new Map<number, typeof episodes.$inferSelect & { seriesTitle: string | null }>();
    if (epIds.length > 0) {
      for (const row of ctx.db
        .select({ ep: episodes, seriesTitle: series.title })
        .from(episodes)
        .innerJoin(series, eq(episodes.seriesId, series.id))
        .where(inArray(episodes.id, epIds))
        .all()) {
        epById.set(row.ep.id, { ...row.ep, seriesTitle: row.seriesTitle });
      }
    }
    const movieById = new Map<number, typeof movies.$inferSelect>();
    if (movieIds.length > 0) {
      for (const m of ctx.db.select().from(movies).where(inArray(movies.id, movieIds)).all()) {
        movieById.set(m.id, m);
      }
    }

    const items: WinItem[] = rows.map((r) => {
      const d = (r.data ?? {}) as {
        source?: string;
        kind?: string;
        targetId?: number;
        seriesId?: number | null;
      };
      const source = d.source === "radarr" ? "radarr" : "sonarr";
      const fallbackLabel = r.message.replace(/^German achieved:\s*/, "");
      if (d.kind === "movie" && d.targetId != null) {
        const m = movieById.get(d.targetId);
        return {
          id: r.id,
          at: r.at,
          source,
          kind: "movie",
          targetId: d.targetId,
          seriesId: null,
          title: m?.title ?? fallbackLabel,
          label: m
            ? [m.year, m.quality].filter(Boolean).join(" · ") || fallbackLabel
            : fallbackLabel,
          quality: m?.quality ?? null,
          languages: langNames(m?.fileLanguages),
        };
      }
      const ep = d.targetId != null ? epById.get(d.targetId) : undefined;
      const code = ep
        ? `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`
        : "";
      return {
        id: r.id,
        at: r.at,
        source,
        kind: "episode",
        targetId: d.targetId ?? 0,
        seriesId: d.seriesId ?? ep?.seriesId ?? null,
        title: ep?.seriesTitle ?? fallbackLabel,
        label: ep ? [code, ep.title].filter(Boolean).join(" · ") : fallbackLabel,
        quality: ep?.quality ?? null,
        languages: langNames(ep?.fileLanguages),
      };
    });
    const response: WinsResponse = { items };
    return response;
  });

  app.get("/api/stats/history", async (request, reply) => {
    const q = parse(
      reply,
      z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      request.query,
    );
    if (!q.ok) return;
    const days = q.data.days;
    const cutoff = ymd(startOfUtcDay(Date.now()) - (days - 1) * DAY_MS);
    const rows = ctx.db
      .select()
      .from(statsDaily)
      .where(gte(statsDaily.date, cutoff))
      .orderBy(statsDaily.date)
      .all();
    const byDate = new Map<string, StatsHistoryPoint>();
    for (const r of rows) {
      let p = byDate.get(r.date);
      if (!p) {
        p = {
          date: r.date,
          german: 0,
          nonGerman: 0,
          missing: 0,
          unreleased: 0,
          aiPaused: 0,
          exhausted: 0,
          germanPct: 0,
          searchesRun: 0,
          queriesSpent: 0,
        };
        byDate.set(r.date, p);
      }
      p.german += r.german;
      p.nonGerman += r.nonGerman;
      p.missing += r.missing;
      p.unreleased += r.unreleased;
      p.aiPaused += r.aiPaused;
      p.exhausted += r.exhausted;
      p.searchesRun += r.searchesRun;
      p.queriesSpent += r.queriesSpent;
    }
    const points = [...byDate.values()].map((p) => {
      const denom = p.german + p.nonGerman + p.missing + p.exhausted;
      return { ...p, germanPct: denom === 0 ? 0 : round1((p.german / denom) * 100) };
    });
    const response: StatsHistoryResponse = { days, points };
    return response;
  });
}

/** Percentage-point change vs 7 days ago from stats_daily; null until history exists. */
function deltaWeekPct(
  ctx: AppContext,
  total: ReturnType<typeof emptyStateCounts>,
  now: number,
): number | null {
  const target = ymd(startOfUtcDay(now) - 7 * DAY_MS);
  const rows = ctx.db.select().from(statsDaily).where(eq(statsDaily.date, target)).all();
  if (rows.length === 0) return null;
  let german = 0;
  let denom = 0;
  for (const r of rows) {
    german += r.german;
    denom += r.german + r.nonGerman + r.missing + r.exhausted;
  }
  if (denom === 0) return null;
  const then = (german / denom) * 100;
  return round1(germanPct(total) - then);
}
