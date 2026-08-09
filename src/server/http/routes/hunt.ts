import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AiDormantItem,
  CycleResponse,
  DryRunToggleResponse,
  EngineActionResponse,
  HuntPausedResponse,
  HuntQueueItem,
  HuntQueueResponse,
  HuntStatusResponse,
  ItemSubjectKind,
  NowHunting,
  PausedItem,
  SystemActionResponse,
} from "../../../shared/api-types.js";
import type { ArrSource, SearchTrigger } from "../../../shared/domain.js";
import { INVALIDATED_SENTINEL } from "../../ai/oracle-service.js";
import type { AppContext } from "../../context.js";
import {
  aiVerdicts,
  episodes,
  huntState,
  movies,
  searchAttempts,
  series,
} from "../../db/schema.js";
import { arrHealthAll, isEnginePaused, notFound, parse, setEnginePaused } from "./util.js";

type HsRow = typeof huntState.$inferSelect;

const IN_FLIGHT_STATUSES = ["dispatched", "queued", "started"] as const;

function padCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function reasonToTrigger(reason: "FORCED" | "SCHEDULED" | "RETRY"): SearchTrigger {
  return reason === "FORCED" ? "forced" : reason === "RETRY" ? "retry" : "scheduled";
}

/** Batch-load episode/movie descriptors for a set of hunt_state ids. */
function describeHuntStates(ctx: AppContext, ids: number[]) {
  const rows = ids.length
    ? ctx.db.select().from(huntState).where(inArray(huntState.id, ids)).all()
    : [];
  const rowById = new Map<number, HsRow>(rows.map((r) => [r.id, r]));
  const epIds = rows.filter((r) => r.targetKind === "episode").map((r) => r.targetId);
  const movieIds = rows.filter((r) => r.targetKind === "movie").map((r) => r.targetId);
  const epInfo = new Map<
    number,
    { seriesTitle: string; seasonNumber: number; episodeNumber: number }
  >();
  if (epIds.length) {
    for (const e of ctx.db
      .select({
        id: episodes.id,
        seasonNumber: episodes.seasonNumber,
        episodeNumber: episodes.episodeNumber,
        seriesTitle: series.title,
      })
      .from(episodes)
      .innerJoin(series, eq(episodes.seriesId, series.id))
      .where(inArray(episodes.id, epIds))
      .all()) {
      epInfo.set(e.id, {
        seriesTitle: e.seriesTitle,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
      });
    }
  }
  const movieInfo = new Map<number, { title: string; year: number | null }>();
  if (movieIds.length) {
    for (const m of ctx.db
      .select({ id: movies.id, title: movies.title, year: movies.year })
      .from(movies)
      .where(inArray(movies.id, movieIds))
      .all()) {
      movieInfo.set(m.id, { title: m.title, year: m.year });
    }
  }
  return {
    describe(id: number): {
      kind: ItemSubjectKind;
      targetId: number;
      seriesId: number | null;
      title: string;
      scopeLabel: string;
    } {
      const row = rowById.get(id);
      if (!row) return { kind: "episode", targetId: 0, seriesId: null, title: "", scopeLabel: "" };
      if (row.targetKind === "movie") {
        const info = movieInfo.get(row.targetId);
        return {
          kind: "movie",
          targetId: row.targetId,
          seriesId: null,
          title: info?.title ?? "",
          scopeLabel: info?.year ? String(info.year) : "",
        };
      }
      const info = epInfo.get(row.targetId);
      return {
        kind: "episode",
        targetId: row.targetId,
        seriesId: row.seriesId,
        title: info?.seriesTitle ?? "",
        scopeLabel: info ? padCode(info.seasonNumber, info.episodeNumber) : "",
      };
    },
  };
}

type PausedViewData = ReturnType<AppContext["services"]["engine"]["pausedView"]>;
type HuntDescriber = ReturnType<typeof describeHuntStates>;

function manualPauseItems(view: PausedViewData, descriptors: HuntDescriber): PausedItem[] {
  return view.manual.map((entry) => {
    const item = descriptors.describe(entry.huntStateId);
    return {
      source: entry.source,
      kind: item.kind,
      targetId: item.targetId,
      title: item.title || entry.label,
      label: entry.label,
      targetCount: 1,
      since: entry.since,
      until: entry.until,
      note: entry.note,
    };
  });
}

function aiPauseItems(
  view: PausedViewData,
  descriptors: HuntDescriber,
  evidenceById: Map<number, string[]>,
): AiDormantItem[] {
  const grouped = new Map<string, AiDormantItem>();
  for (const entry of view.aiPaused) {
    const item = descriptors.describe(entry.huntStateId);
    const groupedSeries = entry.source === "sonarr" && item.seriesId != null;
    const kind = groupedSeries ? "series" : item.kind;
    const targetId = groupedSeries ? (item.seriesId as number) : item.targetId;
    const verdictId = entry.verdict?.id ?? 0;
    const key = `${entry.source}:${kind}:${targetId}:${verdictId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.targetCount += 1;
      const wakeAt = entry.nextEligibleAt ?? entry.verdict?.recheckAfter ?? 0;
      if (wakeAt > 0) existing.wakeAt = Math.min(existing.wakeAt, wakeAt);
      continue;
    }
    grouped.set(key, {
      source: entry.source,
      kind,
      targetId,
      title: item.title || entry.label,
      targetCount: 1,
      verdictId,
      verdict: entry.verdict?.verdict ?? "unlikely",
      confidence: entry.verdict?.confidence ?? 0,
      evidence: entry.verdict ? (evidenceById.get(entry.verdict.id) ?? []) : [],
      checkedAt: entry.verdict?.checkedAt ?? 0,
      wakeAt: entry.nextEligibleAt ?? entry.verdict?.recheckAfter ?? 0,
    });
  }
  return [...grouped.values()].sort(
    (left, right) => left.wakeAt - right.wakeAt || left.title.localeCompare(right.title),
  );
}

async function queueSize(
  client: { getQueueStats(): Promise<{ totalRecords: number }> } | null,
): Promise<number> {
  if (!client) return 0;
  try {
    return (await client.getQueueStats()).totalRecords;
  } catch {
    return 0;
  }
}

function currentHunt(ctx: AppContext): NowHunting | null {
  const row = ctx.db
    .select()
    .from(searchAttempts)
    .where(
      and(
        isNull(searchAttempts.completedAt),
        inArray(searchAttempts.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .orderBy(desc(searchAttempts.createdAt))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    attemptId: row.id,
    source: row.source,
    commandName: row.commandName,
    label: row.targetLabel ?? "",
    startedAt: row.createdAt,
    status: row.status,
    dryRun: row.dryRun,
  };
}

/** Reset an exhausted/ai_paused row to its plain mirror-derived state. */
function mirrorBasicStates(
  ctx: AppContext,
  rows: HsRow[],
): Map<number, "german" | "non_german" | "missing"> {
  const out = new Map<number, "german" | "non_german" | "missing">();
  const epIds = rows.filter((r) => r.targetKind === "episode").map((r) => r.targetId);
  const movieIds = rows.filter((r) => r.targetKind === "movie").map((r) => r.targetId);
  const facts = new Map<string, { hasFile: boolean; hasGerman: boolean }>();
  if (epIds.length) {
    for (const e of ctx.db
      .select({ id: episodes.id, hasFile: episodes.hasFile, hasGerman: episodes.hasGerman })
      .from(episodes)
      .where(inArray(episodes.id, epIds))
      .all()) {
      facts.set(`episode:${e.id}`, e);
    }
  }
  if (movieIds.length) {
    for (const m of ctx.db
      .select({ id: movies.id, hasFile: movies.hasFile, hasGerman: movies.hasGerman })
      .from(movies)
      .where(inArray(movies.id, movieIds))
      .all()) {
      facts.set(`movie:${m.id}`, m);
    }
  }
  for (const r of rows) {
    const f = facts.get(`${r.targetKind}:${r.targetId}`);
    out.set(r.id, !f?.hasFile ? "missing" : f.hasGerman ? "german" : "non_german");
  }
  return out;
}

export function registerHuntRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/hunt/status", async () => {
    const cfg = ctx.settings.get();
    const view = ctx.services.engine.engineStatus();
    const [health, sonarrSize, radarrSize] = await Promise.all([
      arrHealthAll(ctx),
      queueSize(ctx.services.sonarr),
      queueSize(ctx.services.radarr),
    ]);
    const threshold = cfg.queueGateThreshold;
    const response: HuntStatusResponse = {
      engine: isEnginePaused(ctx) ? "paused" : "running",
      dryRun: cfg.dryRun,
      nextTickAt: view.nextTickAt ?? null,
      lastTickAt: view.lastCycleAt ?? null,
      holdReason: view.holdReason ?? null,
      heldSince: view.heldSince ?? null,
      current: currentHunt(ctx),
      queueGate: {
        enabled: cfg.queueGateEnabled,
        threshold,
        sonarr: { size: sonarrSize, open: !cfg.queueGateEnabled || sonarrSize <= threshold },
        radarr: { size: radarrSize, open: !cfg.queueGateEnabled || radarrSize <= threshold },
      },
      arrHealth: health,
    };
    return response;
  });

  app.get("/api/hunt/queue", async () => {
    const snapshot = ctx.services.engine.queueSnapshot();
    const entries = snapshot.entries;
    const desc_ = describeHuntStates(
      ctx,
      entries.map((e) => e.huntStateId),
    );
    const items: HuntQueueItem[] = entries.map((e, i) => {
      const d = desc_.describe(e.huntStateId);
      return {
        id: e.huntStateId,
        position: i + 1,
        source: e.source,
        kind: d.kind,
        targetId: d.targetId,
        seriesId: d.seriesId,
        title: d.title || e.label,
        scopeLabel: d.scopeLabel,
        reason: reasonToTrigger(e.reason),
        score: e.score,
        estimatedQueries: null,
      };
    });
    const response: HuntQueueResponse = { items, total: snapshot.total, counts: snapshot.counts };
    return response;
  });

  app.post("/api/hunt/queue/:id/bump", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.coerce.number().int() }), request.params);
    if (!p.ok) return;
    if (!ctx.services.engine.bumpQueueEntry(p.data.id))
      return notFound(reply, "queue entry not found");
    return { ok: true };
  });

  app.delete("/api/hunt/queue/:id", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.coerce.number().int() }), request.params);
    if (!p.ok) return;
    if (!ctx.services.engine.removeQueueEntry(p.data.id))
      return notFound(reply, "queue entry not found");
    return { ok: true };
  });

  app.get("/api/hunt/paused", async () => {
    const view = ctx.services.engine.pausedView();
    const ids = [...view.manual, ...view.aiPaused].map((e) => e.huntStateId);
    const desc_ = describeHuntStates(ctx, ids);
    const verdictIds = [
      ...new Set(view.aiPaused.map((e) => e.verdict?.id).filter((id): id is number => id != null)),
    ];
    const evidenceById = new Map<number, string[]>();
    if (verdictIds.length) {
      for (const v of ctx.db
        .select({ id: aiVerdicts.id, evidence: aiVerdicts.evidence })
        .from(aiVerdicts)
        .where(inArray(aiVerdicts.id, verdictIds))
        .all()) {
        evidenceById.set(v.id, v.evidence);
      }
    }

    const userPaused = manualPauseItems(view, desc_);
    const aiDormant = aiPauseItems(view, desc_, evidenceById);
    const response: HuntPausedResponse = { userPaused, aiDormant };
    return response;
  });

  // ============ engine controls ============

  app.post("/api/engine/pause", async () => {
    setEnginePaused(ctx, true);
    ctx.bus.emit("system.status", { component: "engine", state: "paused" });
    const response: EngineActionResponse = { ok: true, engine: "paused" };
    return response;
  });

  app.post("/api/engine/resume", async () => {
    setEnginePaused(ctx, false);
    ctx.bus.emit("system.status", { component: "engine", state: "running" });
    const response: EngineActionResponse = { ok: true, engine: "running" };
    return response;
  });

  app.post("/api/engine/cycle", async () => {
    const job = ctx.scheduler.status().find((j) => j.name === "hunt.cycle");
    const started = Boolean(job && !job.running);
    if (started) void ctx.scheduler.trigger("hunt.cycle");
    const response: CycleResponse = { ok: true, started };
    return response;
  });

  // ============ system (danger zone) ============

  app.post("/api/system/dry-run", async (request, reply) => {
    const b = parse(
      reply,
      z.object({ enabled: z.boolean(), confirm: z.string().optional() }),
      request.body,
    );
    if (!b.ok) return;
    if (ctx.env.NODE_ENV === "development" && b.data.enabled === false) {
      return reply.code(409).send({
        error:
          "live mode is disabled in local development; run a production deployment to enable it",
      });
    }
    if (b.data.enabled === false && b.data.confirm !== "live") {
      return reply.code(400).send({ error: 'type "live" to confirm going live' });
    }
    ctx.settings.update({ dryRun: b.data.enabled });
    ctx.bus.emit("system.dryrun.changed", { dryRun: b.data.enabled });
    const response: DryRunToggleResponse = { dryRun: b.data.enabled };
    return response;
  });

  app.post("/api/system/resync", async () => {
    void ctx.scheduler.trigger("sync.full");
    const response: SystemActionResponse = { ok: true, detail: "full reconcile requested" };
    return response;
  });

  app.post("/api/system/reset-hunt-state", async () => {
    ctx.db
      .update(huntState)
      .set({
        tier: 0,
        searchCount: 0,
        nextEligibleAt: null,
        lastSearchAt: null,
        awaitingImportSince: null,
        awaitingImportDownloadId: null,
        manualPriority: 0,
      })
      .run();
    const exhausted = ctx.db.select().from(huntState).where(eq(huntState.state, "exhausted")).all();
    if (exhausted.length) {
      const now = Date.now();
      const mirror = mirrorBasicStates(ctx, exhausted);
      for (const row of exhausted) {
        ctx.db
          .update(huntState)
          .set({ state: mirror.get(row.id) ?? "missing", stateChangedAt: now })
          .where(eq(huntState.id, row.id))
          .run();
      }
    }
    void ctx.scheduler.trigger("sync.full");
    ctx.bus.emit("queue.updated", { reason: "reset-hunt-state" });
    const response: SystemActionResponse = { ok: true, detail: "hunt state reset" };
    return response;
  });

  app.post("/api/system/clear-verdicts", async () => {
    ctx.db
      .update(aiVerdicts)
      .set({ supersededBy: INVALIDATED_SENTINEL })
      .where(isNull(aiVerdicts.supersededBy))
      .run();
    const dormant = ctx.db.select().from(huntState).where(eq(huntState.state, "ai_paused")).all();
    if (dormant.length) {
      const now = Date.now();
      const mirror = mirrorBasicStates(ctx, dormant);
      for (const row of dormant) {
        ctx.db
          .update(huntState)
          .set({
            state: mirror.get(row.id) ?? "missing",
            stateChangedAt: now,
            aiVerdictId: null,
            nextEligibleAt: null,
          })
          .where(eq(huntState.id, row.id))
          .run();
      }
    }
    ctx.bus.emit("queue.updated", { reason: "clear-verdicts" });
    const response: SystemActionResponse = { ok: true, detail: "verdicts cleared" };
    return response;
  });
}

export type { ArrSource };
