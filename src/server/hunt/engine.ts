import { and, eq, gt, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  type AiVerdictValue,
  type ArrSource,
  backoffForTier,
  EXHAUSTED_TIER,
  type HuntState,
  type SearchTrigger,
} from "../../shared/domain.js";
import type { AppSettings, SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  itemOverrides,
  manualRequests,
  movies,
  searchAttempts,
  series,
} from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import {
  candidateLabel,
  firstUpgradeBlockedUntil,
  groupCommands,
  type HuntCandidate,
  interleaveByRatio,
  type PlannedCommand,
  parseRatio,
  priorityScore,
} from "./selection.js";
import { aiPausedUntilFor, isAiVerdictValue } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;
/** `announced` verdict without expectedAvailability: re-check in 30 days. */
const ANNOUNCED_FALLBACK_MS = 30 * DAY_MS;
const BACKOFF_JITTER_FRACTION = 0.1;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_QUEUE_VIEW_LIMIT = 25;

const HUNTABLE_STATES: readonly HuntState[] = ["missing", "non_german", "exhausted"];
/** Never searched, not even manually. */
const NEVER_SEARCH_STATES: readonly HuntState[] = ["unmonitored", "ignored", "profile_blocked"];

// ============ ports (structural; the orchestrator adapts real services) ============

/** Command surface the engine needs from an arr client (SonarrClient/RadarrClient satisfy it). */
export type HuntArrClientPort = {
  getSystemStatus(): Promise<unknown>;
  getQueueStats(): Promise<{ totalRecords: number }>;
  sendCommand(
    body: { name: string } & Record<string, unknown>,
  ): Promise<{ id?: number; status?: string }>;
  getCommand(id: number): Promise<{ id?: number; status?: string }>;
};

/** Mirrors src/server/budget/manager.ts BudgetManager. */
export type BudgetManagerPort = {
  refresh(): Promise<void>;
  estimateCommand(input: {
    kind: "tv" | "movie";
    searchOps: number;
    anime?: boolean;
  }): Map<number, number>;
  mayDispatch(estimates: Map<number, number>): { ok: true } | { ok: false; holdReason: string };
  recordDispatch(estimates: Map<number, number>, attemptId: number): void;
};

/** Mirrors src/server/sync/service.ts SyncService targeted refresh. */
export type SyncRefreshPort = {
  targetedRefreshSeries(seriesId: number): Promise<void>;
  targetedRefreshMovie(movieId: number): Promise<void>;
};

export type HuntEngineOptions = {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Uniform [0,1) source for backoff jitter; injectable for tests. */
  random?: () => number;
  pollIntervalMs?: number;
  commandTimeoutMs?: number;
};

// ============ public view + request types ============

export type SubjectKind = "series" | "season" | "episode" | "movie";

export type ForceSubjectRequest = {
  source: ArrSource;
  kind: SubjectKind;
  id: number;
  seasonNumber?: number;
  withAiRecheck?: boolean;
};

export type PauseSubjectRequest = {
  source: ArrSource;
  kind: SubjectKind;
  id: number;
  seasonNumber?: number;
  /** Epoch ms; absent = paused indefinitely. */
  until?: number;
  note?: string;
};

export type ResumeSubjectRequest = {
  source: ArrSource;
  kind: SubjectKind;
  id: number;
  seasonNumber?: number;
  /** Clear nextEligibleAt so the item is immediately eligible. */
  force?: boolean;
  /** Also lift an ai_paused state. */
  overrideAi?: boolean;
};

export type EngineStatusView = {
  state: "idle" | "hunting" | "held";
  dryRun: boolean;
  nextTickAt?: number;
  lastCycleAt?: number;
  holdReason?: string;
  inFlight: { label: string; source: ArrSource; startedAt: number }[];
};

export type QueueEntryView = {
  huntStateId: number;
  label: string;
  source: ArrSource;
  reason: "FORCED" | "SCHEDULED" | "RETRY";
  score: number;
};

export type PausedEntryView = {
  huntStateId: number;
  label: string;
  source: ArrSource;
  until: number | null;
  note: string | null;
};

export type AiPausedEntryView = {
  huntStateId: number;
  label: string;
  source: ArrSource;
  nextEligibleAt: number | null;
  verdict: {
    id: number;
    verdict: AiVerdictValue;
    confidence: number;
    checkedAt: number;
    recheckAfter: number;
    germanTitle: string | null;
  } | null;
};

export type PausedView = {
  manual: PausedEntryView[];
  aiPaused: AiPausedEntryView[];
};

/** Structural subset of an ai_verdicts row — the Dub Oracle passes its inserted row. */
export type AppliedVerdictInput = {
  id: number;
  /** 'sonarr:<seriesId>' | 'radarr:<movieId>' */
  subjectKey: string;
  verdict: AiVerdictValue;
  confidence: number;
  perSeason?: { season: number; verdict: string; note?: string }[] | null;
  checkedAt: number;
  recheckAfter: number;
  expectedAvailability?: number | null;
};

type HsRow = typeof huntState.$inferSelect;
type VerdictRow = typeof aiVerdicts.$inferSelect;
type EpisodeJoinRow = {
  hs: HsRow;
  ep: typeof episodes.$inferSelect;
  s: typeof series.$inferSelect;
};
type MovieJoinRow = { hs: HsRow; m: typeof movies.$inferSelect };

type DubLagOverrides = {
  season: Map<string, number>;
  series: Map<number, number>;
  movie: Map<number, number>;
};

type ReachableClient = { source: ArrSource; client: HuntArrClientPort };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function effectiveVerdict(
  verdict: {
    verdict: AiVerdictValue;
    perSeason?: { season: number; verdict: string; note?: string }[] | null;
  },
  seasonNumber: number | null,
): AiVerdictValue {
  if (seasonNumber != null && verdict.perSeason) {
    const entry = verdict.perSeason.find((p) => p.season === seasonNumber);
    if (entry && isAiVerdictValue(entry.verdict)) return entry.verdict;
  }
  return verdict.verdict;
}

/**
 * The hunt engine: selects eligible items each cycle, groups them into
 * budget-gated arr search commands, dispatches + polls them, and walks the
 * backoff ladder. All arr/budget/sync access goes through narrow ports.
 *
 * Tier-reset strategy: instead of bus listeners (item.updated carries no
 * fileImportedAt delta), every cycle starts by resetting tier=0 on rows whose
 * mirrored fileImportedAt is newer than lastSearchAt — an import landed after
 * our last search, however it was detected (history poll, webhook, reconcile).
 * Deterministic, idempotent, and immune to missed events.
 */
export class HuntEngine {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutMs: number;

  private cycleRunning = false;
  private lastCycleAt: number | null = null;
  private holdReason: string | null = null;
  private nextTickAtOverride: number | null = null;
  private warnedNoBudget = false;
  private readonly inFlight = new Map<
    number,
    { label: string; source: ArrSource; startedAt: number }
  >();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly clients: {
      sonarr: HuntArrClientPort | null;
      radarr: HuntArrClientPort | null;
    },
    private readonly budget: BudgetManagerPort | null,
    private readonly sync: SyncRefreshPort,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    opts: HuntEngineOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  // ============ cycle ============

  async runCycle(signal?: AbortSignal): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    const cycleStart = this.now();
    this.holdReason = null;
    try {
      const cfg = this.settings.get();
      this.expireUserPauses();
      this.resetTiersOnFreshImports();

      const configured: [ArrSource, HuntArrClientPort | null][] = [
        ["sonarr", this.clients.sonarr],
        ["radarr", this.clients.radarr],
      ];
      const present = configured.filter((c): c is [ArrSource, HuntArrClientPort] => c[1] !== null);
      if (present.length === 0) {
        this.setHold("no arr clients configured", { logActivity: false });
        return;
      }
      const reachable: ReachableClient[] = [];
      for (const [source, client] of present) {
        try {
          await client.getSystemStatus();
          reachable.push({ source, client });
        } catch (err) {
          this.log.warn({ err, source }, "arr unreachable — excluded from this hunt cycle");
        }
      }
      if (reachable.length === 0) {
        this.setHold("all configured arrs unreachable", { logActivity: false });
        return;
      }

      let queueTotal = 0;
      let queueGate = false;
      for (const { source, client } of reachable) {
        try {
          queueTotal += (await client.getQueueStats()).totalRecords;
        } catch (err) {
          this.log.warn({ err, source }, "queue stats failed — gating scheduled hunts");
          queueGate = true;
        }
      }
      if (queueTotal > cfg.queueGateThreshold) queueGate = true;
      if (queueGate) {
        this.setHold(
          `download queue gate: ${queueTotal} items > threshold ${cfg.queueGateThreshold}`,
          { type: "hunt.search", level: "info" },
        );
      }

      if (this.budget) {
        try {
          await this.budget.refresh();
        } catch (err) {
          this.log.warn({ err }, "budget refresh failed — gating on last known ledger");
        }
      } else if (!this.warnedNoBudget) {
        this.warnedNoBudget = true;
        this.log.warn("no budget manager configured — dispatching without budget gating");
      }

      const reachableSources = new Set(reachable.map((r) => r.source));
      const nowMs = this.now();
      const manual = this.loadManualBatch(reachableSources, cfg, nowMs);
      const scheduled = queueGate ? [] : this.loadScheduledCandidates(reachableSources, cfg, nowMs);
      const plan: { cmd: PlannedCommand; trigger: SearchTrigger }[] = [
        ...groupCommands(manual).map((cmd) => ({ cmd, trigger: "forced" as const })),
        ...groupCommands(scheduled).map((cmd) => ({ cmd, trigger: "scheduled" as const })),
      ];
      if (plan.length === 0) return;
      this.bus.emit("hunt.batch.started", {
        count: plan.length,
        targets: manual.length + scheduled.length,
      });

      const clientBySource = new Map(reachable.map((r) => [r.source, r.client]));
      const chains = new Map<ArrSource, Promise<void>>();
      let dispatched = 0;
      try {
        for (const { cmd, trigger } of plan) {
          if (signal?.aborted) break;
          if (dispatched >= cfg.maxCommandsPerCycle) break;
          await chains.get(cmd.source);
          let estimates: Map<number, number> | null = null;
          if (this.budget) {
            estimates = this.budget.estimateCommand({
              kind: cmd.kind,
              searchOps: cmd.searchOps,
              anime: cmd.anime,
            });
            const decision = this.budget.mayDispatch(estimates);
            if (!decision.ok) {
              this.setHold(decision.holdReason, { type: "budget", level: "warn" });
              break;
            }
          }
          dispatched += 1;
          const attemptId = this.insertAttempt(cmd, trigger, cfg.dryRun, estimates);
          if (cfg.dryRun) {
            this.completeDryRun(cmd, trigger, attemptId, estimates);
            continue;
          }
          this.budget?.recordDispatch(estimates as Map<number, number>, attemptId);
          const client = clientBySource.get(cmd.source);
          if (!client) continue; // unreachable source: never planned, defensive only
          chains.set(cmd.source, this.dispatchAndTrack(cmd, trigger, attemptId, client, signal));
        }
      } finally {
        await Promise.all(chains.values());
      }
    } finally {
      this.lastCycleAt = cycleStart;
      this.cycleRunning = false;
    }
  }

  // ============ dispatch + polling ============

  private insertAttempt(
    cmd: PlannedCommand,
    trigger: SearchTrigger,
    dryRun: boolean,
    estimates: Map<number, number> | null,
  ): number {
    const estimatedQueries = estimates
      ? [...estimates.values()].reduce((sum, v) => sum + v, 0)
      : cmd.searchOps; // no budget manager: best-effort ops count
    const row = this.db
      .insert(searchAttempts)
      .values({
        createdAt: this.now(),
        source: cmd.source,
        commandName: cmd.name,
        payload: cmd.payload,
        targetIds: cmd.covered.map((c) => c.huntStateId),
        targetLabel: cmd.label,
        trigger,
        estimatedQueries,
        status: "dispatched",
        dryRun,
      })
      .returning({ id: searchAttempts.id })
      .get();
    return row.id;
  }

  private completeDryRun(
    cmd: PlannedCommand,
    trigger: SearchTrigger,
    attemptId: number,
    estimates: Map<number, number> | null,
  ): void {
    const now = this.now();
    this.db
      .update(searchAttempts)
      .set({ status: "completed", completedAt: now })
      .where(eq(searchAttempts.id, attemptId))
      .run();
    const estimated = estimates
      ? [...estimates.values()].reduce((sum, v) => sum + v, 0)
      : cmd.searchOps;
    this.logActivity(
      "info",
      "hunt.search",
      `[dry-run] would dispatch ${cmd.name}: ${cmd.label} (${trigger}, est ${estimated} queries)`,
      { attemptId, source: cmd.source, command: cmd.name, trigger, dryRun: true },
    );
    this.bus.emit("hunt.search.started", {
      label: cmd.label,
      source: cmd.source,
      command: cmd.name,
      attemptId,
      trigger,
      dryRun: true,
    });
    this.bus.emit("hunt.search.result", {
      label: cmd.label,
      source: cmd.source,
      result: null,
      attemptId,
      status: "completed",
      dryRun: true,
    });
    if (trigger === "forced") {
      // The manual request was serviced (simulated) — keep the queue moving in dry-run.
      this.clearManualPriorities(cmd.covered.map((c) => c.huntStateId));
      this.markManualRequestsDone(now);
    }
    this.bus.emit("queue.updated", { attemptId, dryRun: true });
  }

  private async dispatchAndTrack(
    cmd: PlannedCommand,
    trigger: SearchTrigger,
    attemptId: number,
    client: HuntArrClientPort,
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = this.now();
    this.inFlight.set(attemptId, { label: cmd.label, source: cmd.source, startedAt });
    try {
      this.bus.emit("hunt.search.started", {
        label: cmd.label,
        source: cmd.source,
        command: cmd.name,
        attemptId,
        trigger,
        dryRun: false,
      });
      this.logActivity("info", "hunt.search", `Dispatched ${cmd.name}: ${cmd.label} (${trigger})`, {
        attemptId,
        source: cmd.source,
        command: cmd.name,
        trigger,
      });
      let sent: { id?: number; status?: string };
      try {
        sent = await client.sendCommand(cmd.payload);
      } catch (err) {
        this.log.warn({ err, label: cmd.label }, "arr command dispatch failed");
        this.db
          .update(searchAttempts)
          .set({ status: "failed", result: "error", completedAt: this.now() })
          .where(eq(searchAttempts.id, attemptId))
          .run();
        this.bus.emit("hunt.search.result", {
          label: cmd.label,
          source: cmd.source,
          result: "error",
          attemptId,
          status: "failed",
        });
        return; // no search happened: no tier bump, manual entries stay queued
      }
      const arrCommandId = sent.id ?? null;
      this.db
        .update(searchAttempts)
        .set({ arrCommandId, status: "queued" })
        .where(eq(searchAttempts.id, attemptId))
        .run();
      const finalStatus =
        arrCommandId === null
          ? "completed" // arr accepted but returned no id — nothing to poll
          : await this.pollCommand(client, arrCommandId, attemptId, startedAt, signal);
      await this.afterCommand(cmd, trigger, attemptId, finalStatus);
    } finally {
      this.inFlight.delete(attemptId);
    }
  }

  private async pollCommand(
    client: HuntArrClientPort,
    arrCommandId: number,
    attemptId: number,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<"completed" | "failed" | "timeout"> {
    const deadline = startedAt + this.commandTimeoutMs;
    let markedStarted = false;
    while (!signal?.aborted && this.now() < deadline) {
      await this.sleep(this.pollIntervalMs, signal);
      if (signal?.aborted) break;
      let res: { status?: string };
      try {
        res = await client.getCommand(arrCommandId);
      } catch (err) {
        this.log.warn({ err, arrCommandId }, "command poll failed — retrying");
        continue;
      }
      const status = res.status ?? "";
      if (status === "completed") return "completed";
      if (status === "failed" || status === "aborted") return "failed";
      if (status === "started" && !markedStarted) {
        markedStarted = true;
        this.db
          .update(searchAttempts)
          .set({ status: "started" })
          .where(eq(searchAttempts.id, attemptId))
          .run();
      }
    }
    return "timeout";
  }

  private async afterCommand(
    cmd: PlannedCommand,
    trigger: SearchTrigger,
    attemptId: number,
    finalStatus: "completed" | "failed" | "timeout",
  ): Promise<void> {
    const refreshSeriesIds = new Set<number>();
    const refreshMovieIds = new Set<number>();
    for (const c of cmd.covered) {
      if (c.kind === "episode" && c.seriesId != null) refreshSeriesIds.add(c.seriesId);
      else if (c.kind === "movie") refreshMovieIds.add(c.targetId);
    }
    for (const seriesId of refreshSeriesIds) {
      try {
        await this.sync.targetedRefreshSeries(seriesId);
      } catch (err) {
        this.log.warn({ err, seriesId }, "post-search series refresh failed");
      }
    }
    for (const movieId of refreshMovieIds) {
      try {
        await this.sync.targetedRefreshMovie(movieId);
      } catch (err) {
        this.log.warn({ err, movieId }, "post-search movie refresh failed");
      }
    }

    const now = this.now();
    const attempt = this.db
      .select()
      .from(searchAttempts)
      .where(eq(searchAttempts.id, attemptId))
      .get();
    // 'grabbed' may already be set by the sync history poll; otherwise no_grab
    // for now — sync upgrades it when a matching grab shows up within 24h.
    let result = attempt?.result ?? null;
    if (result === null) result = finalStatus === "failed" ? "error" : "no_grab";
    this.db
      .update(searchAttempts)
      .set({ status: finalStatus, result, completedAt: now })
      .where(eq(searchAttempts.id, attemptId))
      .run();
    this.bus.emit("hunt.search.result", {
      label: cmd.label,
      source: cmd.source,
      result,
      attemptId,
      status: finalStatus,
    });
    this.logActivity(
      finalStatus === "completed" ? "info" : "warn",
      "hunt.search",
      `${cmd.name} ${finalStatus}: ${cmd.label} (${result})`,
      { attemptId, source: cmd.source, result, status: finalStatus },
    );

    for (const c of cmd.covered) {
      const row = this.db.select().from(huntState).where(eq(huntState.id, c.huntStateId)).get();
      if (!row) continue;
      const patch: Partial<typeof huntState.$inferInsert> = {
        searchCount: row.searchCount + 1,
        lastSearchAt: now,
      };
      const grabPending = row.awaitingImportSince != null;
      if (!grabPending && HUNTABLE_STATES.includes(row.state)) {
        const newTier = row.tier + 1;
        patch.tier = newTier;
        // Walk the ladder from the start: delay for the Nth failure = ladder[N-1].
        patch.nextEligibleAt = now + this.jittered(backoffForTier(row.tier));
        if (newTier >= EXHAUSTED_TIER && row.state !== "exhausted") {
          patch.state = "exhausted";
          patch.stateChangedAt = now;
        }
      }
      if (row.manualPriority > 0) patch.manualPriority = 0;
      this.db.update(huntState).set(patch).where(eq(huntState.id, row.id)).run();
    }
    if (trigger === "forced") this.markManualRequestsDone(now);
    this.bus.emit("queue.updated", { attemptId });
  }

  private jittered(ms: number): number {
    const factor = 1 + (this.random() * 2 - 1) * BACKOFF_JITTER_FRACTION;
    return Math.round(ms * factor);
  }

  // ============ cycle-start maintenance ============

  private expireUserPauses(): void {
    const now = this.now();
    this.db
      .update(huntState)
      .set({ userPaused: false, userPausedUntil: null, userPausedNote: null })
      .where(
        and(
          eq(huntState.userPaused, true),
          sql`${huntState.userPausedUntil} IS NOT NULL AND ${huntState.userPausedUntil} <= ${now}`,
        ),
      )
      .run();
  }

  /** See class doc: import landed after our last search → back to tier 0. */
  private resetTiersOnFreshImports(): void {
    const epRows = this.db
      .select({ hs: huntState, hasFile: episodes.hasFile, hasGerman: episodes.hasGerman })
      .from(huntState)
      .innerJoin(episodes, eq(huntState.targetId, episodes.id))
      .where(
        and(
          eq(huntState.source, "sonarr"),
          eq(huntState.targetKind, "episode"),
          gt(huntState.tier, 0),
          sql`${episodes.fileImportedAt} IS NOT NULL AND ${huntState.lastSearchAt} IS NOT NULL AND ${episodes.fileImportedAt} > ${huntState.lastSearchAt}`,
        ),
      )
      .all();
    const movieRows = this.db
      .select({ hs: huntState, hasFile: movies.hasFile, hasGerman: movies.hasGerman })
      .from(huntState)
      .innerJoin(movies, eq(huntState.targetId, movies.id))
      .where(
        and(
          eq(huntState.source, "radarr"),
          eq(huntState.targetKind, "movie"),
          gt(huntState.tier, 0),
          sql`${movies.fileImportedAt} IS NOT NULL AND ${huntState.lastSearchAt} IS NOT NULL AND ${movies.fileImportedAt} > ${huntState.lastSearchAt}`,
        ),
      )
      .all();
    const now = this.now();
    for (const { hs, hasFile, hasGerman } of [...epRows, ...movieRows]) {
      const patch: Partial<typeof huntState.$inferInsert> = { tier: 0, nextEligibleAt: null };
      if (hs.state === "exhausted") {
        // Un-exhaust from the mirror; the next sync derive refines this.
        patch.state = !hasFile ? "missing" : hasGerman ? "german" : "non_german";
        patch.stateChangedAt = now;
      }
      this.db.update(huntState).set(patch).where(eq(huntState.id, hs.id)).run();
    }
  }

  // ============ selection ============

  private loadVerdicts(): Map<string, VerdictRow> {
    const rows = this.db.select().from(aiVerdicts).where(isNull(aiVerdicts.supersededBy)).all();
    const out = new Map<string, VerdictRow>();
    for (const row of rows) {
      const current = out.get(row.subjectKey);
      if (!current || row.checkedAt > current.checkedAt) out.set(row.subjectKey, row);
    }
    return out;
  }

  private loadDubLagOverrides(): DubLagOverrides {
    const rows = this.db
      .select()
      .from(itemOverrides)
      .where(sql`${itemOverrides.dubLagDays} IS NOT NULL`)
      .all();
    const out: DubLagOverrides = { season: new Map(), series: new Map(), movie: new Map() };
    for (const row of rows) {
      if (row.dubLagDays == null) continue;
      if (row.subjectKind === "season") {
        out.season.set(`${row.subjectId}:${row.seasonNumber}`, row.dubLagDays);
      } else if (row.subjectKind === "series") {
        out.series.set(row.subjectId, row.dubLagDays);
      } else if (row.subjectKind === "movie") {
        out.movie.set(row.subjectId, row.dubLagDays);
      }
    }
    return out;
  }

  private episodeJoinRows(extra: ReturnType<typeof sql>[]): EpisodeJoinRow[] {
    return this.db
      .select({ hs: huntState, ep: episodes, s: series })
      .from(huntState)
      .innerJoin(episodes, eq(huntState.targetId, episodes.id))
      .innerJoin(series, eq(episodes.seriesId, series.id))
      .where(and(eq(huntState.source, "sonarr"), eq(huntState.targetKind, "episode"), ...extra))
      .all();
  }

  private movieJoinRows(extra: ReturnType<typeof sql>[]): MovieJoinRow[] {
    return this.db
      .select({ hs: huntState, m: movies })
      .from(huntState)
      .innerJoin(movies, eq(huntState.targetId, movies.id))
      .where(and(eq(huntState.source, "radarr"), eq(huntState.targetKind, "movie"), ...extra))
      .all();
  }

  private buildEpisodeCandidate(
    row: EpisodeJoinRow,
    verdicts: Map<string, VerdictRow>,
    now: number,
  ): HuntCandidate {
    const verdict = verdicts.get(`sonarr:${row.ep.seriesId}`) ?? null;
    const eff = verdict ? effectiveVerdict(verdict, row.ep.seasonNumber) : null;
    const announcedDue =
      eff === "announced" &&
      (verdict?.expectedAvailability == null || verdict.expectedAvailability <= now);
    const daysSinceRelease = row.ep.airDateUtc != null ? (now - row.ep.airDateUtc) / DAY_MS : null;
    return {
      huntStateId: row.hs.id,
      source: "sonarr",
      kind: "episode",
      targetId: row.ep.id,
      seriesId: row.ep.seriesId,
      seasonNumber: row.ep.seasonNumber,
      episodeNumber: row.ep.episodeNumber,
      title: row.s.title,
      year: row.s.year,
      anime: row.s.seriesType === "anime",
      score: priorityScore({
        announcedDue,
        existsVerdict: eff === "exists",
        daysSinceRelease,
        tier: row.hs.tier,
        searchCount: row.hs.searchCount,
      }),
      bucket: row.ep.hasFile ? "upgrade" : "missing",
      searchCount: row.hs.searchCount,
      manualPriority: row.hs.manualPriority,
    };
  }

  private buildMovieCandidate(
    row: MovieJoinRow,
    verdicts: Map<string, VerdictRow>,
    now: number,
  ): HuntCandidate {
    const verdict = verdicts.get(`radarr:${row.m.id}`) ?? null;
    const eff = verdict ? effectiveVerdict(verdict, null) : null;
    const announcedDue =
      eff === "announced" &&
      (verdict?.expectedAvailability == null || verdict.expectedAvailability <= now);
    const release = row.m.digitalRelease ?? row.m.physicalRelease;
    return {
      huntStateId: row.hs.id,
      source: "radarr",
      kind: "movie",
      targetId: row.m.id,
      seriesId: null,
      seasonNumber: null,
      episodeNumber: null,
      title: row.m.title,
      year: row.m.year,
      anime: false,
      score: priorityScore({
        announcedDue,
        existsVerdict: eff === "exists",
        daysSinceRelease: release != null ? (now - release) / DAY_MS : null,
        tier: row.hs.tier,
        searchCount: row.hs.searchCount,
      }),
      bucket: row.m.hasFile ? "upgrade" : "missing",
      searchCount: row.hs.searchCount,
      manualPriority: row.hs.manualPriority,
    };
  }

  /**
   * Manual queue: manualPriority desc. Ignores eligibility, backoff, ai/user
   * pause and the specials filter (explicit user intent), but never touches
   * unmonitored/ignored/profile_blocked items.
   */
  private loadManualBatch(
    reachable: Set<ArrSource>,
    _cfg: AppSettings,
    now: number,
  ): HuntCandidate[] {
    const verdicts = this.loadVerdicts();
    const out: HuntCandidate[] = [];
    const filters = [
      gt(huntState.manualPriority, 0),
      notInArray(huntState.state, [...NEVER_SEARCH_STATES]),
    ];
    if (reachable.has("sonarr")) {
      for (const row of this.episodeJoinRows(filters)) {
        out.push(this.buildEpisodeCandidate(row, verdicts, now));
      }
    }
    if (reachable.has("radarr")) {
      for (const row of this.movieJoinRows(filters)) {
        out.push(this.buildMovieCandidate(row, verdicts, now));
      }
    }
    out.sort((a, b) => b.manualPriority - a.manualPriority || b.score - a.score);
    return out;
  }

  private loadScheduledCandidates(
    reachable: Set<ArrSource>,
    cfg: AppSettings,
    now: number,
  ): HuntCandidate[] {
    const verdicts = this.loadVerdicts();
    const lag = this.loadDubLagOverrides();
    const missingBucket: HuntCandidate[] = [];
    const upgradeBucket: HuntCandidate[] = [];
    const filters = [
      inArray(huntState.state, [...HUNTABLE_STATES]),
      eq(huntState.userPaused, false),
      isNull(huntState.awaitingImportSince),
      eq(huntState.manualPriority, 0),
      sql`(${huntState.nextEligibleAt} IS NULL OR ${huntState.nextEligibleAt} <= ${now})`,
    ];
    if (reachable.has("sonarr")) {
      for (const row of this.episodeJoinRows(filters)) {
        // Exhausted items only re-enter once their (90d-capped) backoff passed.
        if (row.hs.state === "exhausted" && row.hs.nextEligibleAt == null) continue;
        if (!cfg.huntSpecials && row.ep.seasonNumber === 0) continue;
        if (row.hs.state === "non_german") {
          const lagDays =
            lag.season.get(`${row.ep.seriesId}:${row.ep.seasonNumber}`) ??
            lag.series.get(row.ep.seriesId) ??
            cfg.dubLagDaysDefault;
          const blockedUntil = firstUpgradeBlockedUntil({
            fileImportedAt: row.ep.fileImportedAt,
            lastSearchAt: row.hs.lastSearchAt,
            dubLagDays: lagDays,
          });
          if (blockedUntil != null && blockedUntil > now) continue;
        }
        const cand = this.buildEpisodeCandidate(row, verdicts, now);
        (cand.bucket === "missing" ? missingBucket : upgradeBucket).push(cand);
      }
    }
    if (reachable.has("radarr")) {
      for (const row of this.movieJoinRows(filters)) {
        if (row.hs.state === "exhausted" && row.hs.nextEligibleAt == null) continue;
        if (row.hs.state === "non_german") {
          const lagDays = lag.movie.get(row.m.id) ?? cfg.dubLagDaysDefault;
          const blockedUntil = firstUpgradeBlockedUntil({
            fileImportedAt: row.m.fileImportedAt,
            lastSearchAt: row.hs.lastSearchAt,
            dubLagDays: lagDays,
          });
          if (blockedUntil != null && blockedUntil > now) continue;
        }
        const cand = this.buildMovieCandidate(row, verdicts, now);
        (cand.bucket === "missing" ? missingBucket : upgradeBucket).push(cand);
      }
    }
    const byScore = (a: HuntCandidate, b: HuntCandidate) => b.score - a.score;
    missingBucket.sort(byScore);
    upgradeBucket.sort(byScore);
    return interleaveByRatio(missingBucket, upgradeBucket, parseRatio(cfg.missingToUpgradeRatio));
  }

  // ============ oracle contract ============

  /**
   * Apply a Dub-Oracle verdict at series scope (all episodes) or to a movie.
   * perSeason entries override the row verdict for their season — only
   * effectively-unlikely seasons pause.
   */
  applyVerdict(verdict: AppliedVerdictInput): { applied: number } {
    const [source, idStr] = verdict.subjectKey.split(":");
    const subjectId = Number(idStr);
    if ((source !== "sonarr" && source !== "radarr") || !Number.isFinite(subjectId)) {
      this.log.warn({ subjectKey: verdict.subjectKey }, "applyVerdict: malformed subjectKey");
      return { applied: 0 };
    }
    const rows =
      source === "sonarr"
        ? this.db
            .select()
            .from(huntState)
            .where(
              and(
                eq(huntState.source, "sonarr"),
                eq(huntState.targetKind, "episode"),
                eq(huntState.seriesId, subjectId),
              ),
            )
            .all()
        : this.db
            .select()
            .from(huntState)
            .where(
              and(
                eq(huntState.source, "radarr"),
                eq(huntState.targetKind, "movie"),
                eq(huntState.targetId, subjectId),
              ),
            )
            .all();
    const applicable = rows.filter(
      (r) => HUNTABLE_STATES.includes(r.state) || r.state === "ai_paused",
    );
    if (applicable.length === 0) return { applied: 0 };

    const cfg = this.settings.get();
    const now = this.now();
    const mirrorStates = this.mirrorFallbackStates(applicable);
    let applied = 0;
    for (const row of applicable) {
      const eff = effectiveVerdict(verdict, row.seasonNumber);
      const patch: Partial<typeof huntState.$inferInsert> = { aiVerdictId: verdict.id };
      if (eff === "unlikely" && verdict.confidence >= cfg.aiPauseConfidence) {
        patch.state = "ai_paused";
        patch.nextEligibleAt = this.aiPauseHorizon(verdict, row);
        if (row.state !== "ai_paused") patch.stateChangedAt = now;
      } else {
        if (eff === "announced") {
          patch.tier = 2;
          patch.nextEligibleAt = verdict.expectedAvailability ?? now + ANNOUNCED_FALLBACK_MS;
        } else if (eff === "exists") {
          patch.tier = 2;
          patch.nextEligibleAt = null;
        }
        if (row.state === "ai_paused") {
          patch.state = mirrorStates.get(row.id) ?? "missing";
          patch.stateChangedAt = now;
          if (eff !== "announced") patch.nextEligibleAt = null;
        }
      }
      this.db.update(huntState).set(patch).where(eq(huntState.id, row.id)).run();
      if (patch.state && patch.state !== row.state) {
        this.bus.emit("item.updated", {
          source: row.source,
          kind: row.targetKind,
          targetId: row.targetId,
          seriesId: row.seriesId,
          state: patch.state,
          previousState: row.state,
          reason: "ai_verdict",
        });
      }
      applied += 1;
    }
    this.bus.emit("queue.updated", { reason: "ai_verdict", subjectKey: verdict.subjectKey });
    return { applied };
  }

  /**
   * Pause horizon: max(180d after check, recheckAfter); consecutive `unlikely`
   * verdicts double the previously-applied horizon, capped at 365d.
   */
  private aiPauseHorizon(verdict: AppliedVerdictInput, row: HsRow): number {
    const base = aiPausedUntilFor(verdict) - verdict.checkedAt;
    let duration = base;
    if (row.state === "ai_paused" && row.aiVerdictId != null && row.nextEligibleAt != null) {
      const prev = this.db
        .select()
        .from(aiVerdicts)
        .where(eq(aiVerdicts.id, row.aiVerdictId))
        .get();
      if (prev && effectiveVerdict(prev, row.seasonNumber) === "unlikely") {
        const prevDuration = Math.max(0, row.nextEligibleAt - prev.checkedAt);
        duration = Math.max(base, Math.min(YEAR_MS, 2 * prevDuration));
      }
    }
    return verdict.checkedAt + duration;
  }

  // ============ force / pause / resume ============

  forceSubject(req: ForceSubjectRequest): { queuedTargets: number; queuePosition: 1 } {
    const now = this.now();
    const targets = this.resolveSubjectTargets(req, { wideExclusions: true });
    if (targets.length === 0) return { queuedTargets: 0, queuePosition: 1 };
    const maxRow = this.db
      .select({ max: sql<number | null>`max(${huntState.manualPriority})` })
      .from(huntState)
      .get();
    const priority = (maxRow?.max ?? 0) + 1;
    const mirrorStates = this.mirrorFallbackStates(targets.filter((t) => t.state === "ai_paused"));
    for (const row of targets) {
      const patch: Partial<typeof huntState.$inferInsert> = { manualPriority: priority };
      if (row.state === "ai_paused") {
        patch.state = mirrorStates.get(row.id) ?? "missing";
        patch.stateChangedAt = now;
        patch.nextEligibleAt = null;
      }
      this.db.update(huntState).set(patch).where(eq(huntState.id, row.id)).run();
    }
    this.db
      .insert(manualRequests)
      .values({
        createdAt: now,
        subject: this.subjectString(req),
        withAiRecheck: req.withAiRecheck ?? false,
        status: "pending",
      })
      .run();
    this.bus.emit("queue.updated", { reason: "forced", subject: this.subjectString(req) });
    return { queuedTargets: targets.length, queuePosition: 1 };
  }

  pauseSubject(req: PauseSubjectRequest): { pausedTargets: number } {
    const targets = this.resolveSubjectTargets(req, { wideExclusions: false });
    for (const row of targets) {
      this.db
        .update(huntState)
        .set({
          userPaused: true,
          userPausedUntil: req.until ?? null,
          userPausedNote: req.note ?? null,
          // The manual queue ignores user_paused, so a queued entry must be dropped.
          manualPriority: 0,
        })
        .where(eq(huntState.id, row.id))
        .run();
    }
    this.markManualRequestsDone(this.now());
    this.bus.emit("queue.updated", { reason: "paused", subject: this.subjectString(req) });
    return { pausedTargets: targets.length };
  }

  resumeSubject(req: ResumeSubjectRequest): { resumedTargets: number } {
    const now = this.now();
    const targets = this.resolveSubjectTargets(req, { wideExclusions: false });
    const mirrorStates = this.mirrorFallbackStates(
      targets.filter((t) => t.state === "ai_paused" && req.overrideAi),
    );
    for (const row of targets) {
      const patch: Partial<typeof huntState.$inferInsert> = {
        userPaused: false,
        userPausedUntil: null,
        userPausedNote: null,
      };
      if (req.overrideAi && row.state === "ai_paused") {
        patch.state = mirrorStates.get(row.id) ?? "missing";
        patch.stateChangedAt = now;
        patch.nextEligibleAt = null;
      }
      if (req.force) patch.nextEligibleAt = null;
      this.db.update(huntState).set(patch).where(eq(huntState.id, row.id)).run();
    }
    this.bus.emit("queue.updated", { reason: "resumed", subject: this.subjectString(req) });
    return { resumedTargets: targets.length };
  }

  private subjectString(req: {
    source: ArrSource;
    kind: SubjectKind;
    id: number;
    seasonNumber?: number;
  }): string {
    const base = `${req.source}:${req.kind}:${req.id}`;
    return req.kind === "season" && req.seasonNumber != null ? `${base}:${req.seasonNumber}` : base;
  }

  private resolveSubjectTargets(
    req: { source: ArrSource; kind: SubjectKind; id: number; seasonNumber?: number },
    opts: { wideExclusions: boolean },
  ): HsRow[] {
    const cfg = this.settings.get();
    let rows: HsRow[];
    if (req.kind === "movie" || req.kind === "episode") {
      const row = this.db
        .select()
        .from(huntState)
        .where(
          and(
            eq(huntState.source, req.source),
            eq(huntState.targetKind, req.kind),
            eq(huntState.targetId, req.id),
          ),
        )
        .get();
      rows = row ? [row] : [];
    } else {
      const conds = [
        eq(huntState.source, req.source),
        eq(huntState.targetKind, "episode"),
        eq(huntState.seriesId, req.id),
      ];
      if (req.kind === "season" && req.seasonNumber != null) {
        conds.push(eq(huntState.seasonNumber, req.seasonNumber));
      }
      rows = this.db
        .select()
        .from(huntState)
        .where(and(...conds))
        .all();
    }
    return rows.filter((r) => {
      if (NEVER_SEARCH_STATES.includes(r.state)) return false;
      if (opts.wideExclusions && (req.kind === "series" || req.kind === "season")) {
        // Wide scopes only queue actually-huntable items; direct ids are the
        // user's explicit call and stay unfiltered beyond never-search states.
        if (r.state === "german" || r.state === "unreleased") return false;
        const explicitSpecials = req.kind === "season" && req.seasonNumber === 0;
        if (!cfg.huntSpecials && !explicitSpecials && r.seasonNumber === 0) return false;
      }
      return true;
    });
  }

  // ============ queue management ============

  bumpQueueEntry(huntStateId: number): boolean {
    const row = this.db.select().from(huntState).where(eq(huntState.id, huntStateId)).get();
    if (!row) return false;
    const maxRow = this.db
      .select({ max: sql<number | null>`max(${huntState.manualPriority})` })
      .from(huntState)
      .get();
    this.db
      .update(huntState)
      .set({ manualPriority: (maxRow?.max ?? 0) + 1 })
      .where(eq(huntState.id, huntStateId))
      .run();
    this.bus.emit("queue.updated", { reason: "bumped", huntStateId });
    return true;
  }

  removeQueueEntry(huntStateId: number): boolean {
    const row = this.db.select().from(huntState).where(eq(huntState.id, huntStateId)).get();
    if (!row) return false;
    const now = this.now();
    if (row.manualPriority > 0) {
      this.db
        .update(huntState)
        .set({ manualPriority: 0 })
        .where(eq(huntState.id, huntStateId))
        .run();
      this.markManualRequestsDone(now);
    } else {
      this.db
        .update(huntState)
        .set({ nextEligibleAt: now + backoffForTier(row.tier) })
        .where(eq(huntState.id, huntStateId))
        .run();
    }
    this.bus.emit("queue.updated", { reason: "removed", huntStateId });
    return true;
  }

  private clearManualPriorities(huntStateIds: number[]): void {
    if (huntStateIds.length === 0) return;
    this.db
      .update(huntState)
      .set({ manualPriority: 0 })
      .where(inArray(huntState.id, huntStateIds))
      .run();
  }

  /** Mark manual_requests done once none of their resolved targets are still queued. */
  private markManualRequestsDone(now: number): void {
    const rows = this.db
      .select()
      .from(manualRequests)
      .where(ne(manualRequests.status, "done"))
      .all();
    for (const req of rows) {
      if (this.subjectStillQueued(req.subject)) continue;
      this.db
        .update(manualRequests)
        .set({ status: "done", completedAt: now })
        .where(eq(manualRequests.id, req.id))
        .run();
    }
  }

  private subjectStillQueued(subject: string): boolean {
    const parts = subject.split(":");
    const source = parts[0];
    const kind = parts[1];
    const id = Number(parts[2]);
    if ((source !== "sonarr" && source !== "radarr") || !Number.isFinite(id)) return false;
    const conds = [eq(huntState.source, source), gt(huntState.manualPriority, 0)];
    if (kind === "series") {
      conds.push(eq(huntState.seriesId, id));
    } else if (kind === "season") {
      conds.push(eq(huntState.seriesId, id));
      const season = Number(parts[3]);
      if (Number.isFinite(season)) conds.push(eq(huntState.seasonNumber, season));
    } else if (kind === "episode" || kind === "movie") {
      conds.push(eq(huntState.targetKind, kind), eq(huntState.targetId, id));
    } else {
      return false;
    }
    return (
      this.db
        .select({ id: huntState.id })
        .from(huntState)
        .where(and(...conds))
        .limit(1)
        .get() != null
    );
  }

  // ============ views ============

  engineStatus(): EngineStatusView {
    const cfg = this.settings.get();
    const state = this.cycleRunning ? "hunting" : this.holdReason ? "held" : "idle";
    const nextTickAt =
      this.nextTickAtOverride ??
      (this.lastCycleAt != null ? this.lastCycleAt + cfg.huntTickMinutes * 60_000 : undefined);
    return {
      state,
      dryRun: cfg.dryRun,
      nextTickAt: nextTickAt ?? undefined,
      lastCycleAt: this.lastCycleAt ?? undefined,
      holdReason: this.holdReason ?? undefined,
      inFlight: [...this.inFlight.values()],
    };
  }

  /** Exact next-tick time from whoever owns the schedule (optional; falls back to lastCycleAt + tick). */
  setNextTickAt(ts: number | null): void {
    this.nextTickAtOverride = ts;
  }

  queueView(limit = DEFAULT_QUEUE_VIEW_LIMIT): QueueEntryView[] {
    const cfg = this.settings.get();
    const now = this.now();
    const both = new Set<ArrSource>(["sonarr", "radarr"]);
    const entries: QueueEntryView[] = [];
    for (const c of this.loadManualBatch(both, cfg, now)) {
      entries.push({
        huntStateId: c.huntStateId,
        label: candidateLabel(c),
        source: c.source,
        reason: "FORCED",
        score: c.score,
      });
    }
    for (const c of this.loadScheduledCandidates(both, cfg, now)) {
      if (entries.length >= limit) break;
      entries.push({
        huntStateId: c.huntStateId,
        label: candidateLabel(c),
        source: c.source,
        reason: c.searchCount > 0 ? "RETRY" : "SCHEDULED",
        score: c.score,
      });
    }
    return entries.slice(0, limit);
  }

  pausedView(): PausedView {
    const manualRows = this.db.select().from(huntState).where(eq(huntState.userPaused, true)).all();
    const aiRows = this.db.select().from(huntState).where(eq(huntState.state, "ai_paused")).all();
    const labels = this.labelsFor([...manualRows, ...aiRows]);
    const verdictIds = [
      ...new Set(aiRows.map((r) => r.aiVerdictId).filter((id): id is number => id != null)),
    ];
    const verdictById = new Map<number, VerdictRow>();
    if (verdictIds.length > 0) {
      for (const v of this.db
        .select()
        .from(aiVerdicts)
        .where(inArray(aiVerdicts.id, verdictIds))
        .all()) {
        verdictById.set(v.id, v);
      }
    }
    return {
      manual: manualRows.map((r) => ({
        huntStateId: r.id,
        label: labels.get(r.id) ?? `${r.source} ${r.targetKind} ${r.targetId}`,
        source: r.source,
        until: r.userPausedUntil,
        note: r.userPausedNote,
      })),
      aiPaused: aiRows.map((r) => {
        const v = r.aiVerdictId != null ? verdictById.get(r.aiVerdictId) : undefined;
        return {
          huntStateId: r.id,
          label: labels.get(r.id) ?? `${r.source} ${r.targetKind} ${r.targetId}`,
          source: r.source,
          nextEligibleAt: r.nextEligibleAt,
          verdict: v
            ? {
                id: v.id,
                verdict: v.verdict,
                confidence: v.confidence,
                checkedAt: v.checkedAt,
                recheckAfter: v.recheckAfter,
                germanTitle: v.germanTitle,
              }
            : null,
        };
      }),
    };
  }

  // ============ plumbing ============

  private labelsFor(rows: HsRow[]): Map<number, string> {
    const out = new Map<number, string>();
    const epIds = rows.filter((r) => r.targetKind === "episode").map((r) => r.targetId);
    const movieIds = rows.filter((r) => r.targetKind === "movie").map((r) => r.targetId);
    const epLabel = new Map<number, string>();
    if (epIds.length > 0) {
      for (const row of this.db
        .select({
          id: episodes.id,
          seasonNumber: episodes.seasonNumber,
          episodeNumber: episodes.episodeNumber,
          title: series.title,
        })
        .from(episodes)
        .innerJoin(series, eq(episodes.seriesId, series.id))
        .where(inArray(episodes.id, epIds))
        .all()) {
        const s = String(row.seasonNumber).padStart(2, "0");
        const e = String(row.episodeNumber).padStart(2, "0");
        epLabel.set(row.id, `${row.title} S${s}E${e}`);
      }
    }
    const movieLabel = new Map<number, string>();
    if (movieIds.length > 0) {
      for (const row of this.db
        .select({ id: movies.id, title: movies.title, year: movies.year })
        .from(movies)
        .where(inArray(movies.id, movieIds))
        .all()) {
        movieLabel.set(row.id, row.year != null ? `${row.title} (${row.year})` : row.title);
      }
    }
    for (const r of rows) {
      const label =
        r.targetKind === "episode" ? epLabel.get(r.targetId) : movieLabel.get(r.targetId);
      if (label) out.set(r.id, label);
    }
    return out;
  }

  private mirrorFallbackStates(rows: HsRow[]): Map<number, "german" | "non_german" | "missing"> {
    const out = new Map<number, "german" | "non_german" | "missing">();
    if (rows.length === 0) return out;
    const facts = new Map<string, { hasFile: boolean; hasGerman: boolean }>();
    const epIds = rows.filter((r) => r.targetKind === "episode").map((r) => r.targetId);
    const movieIds = rows.filter((r) => r.targetKind === "movie").map((r) => r.targetId);
    if (epIds.length > 0) {
      for (const e of this.db
        .select({ id: episodes.id, hasFile: episodes.hasFile, hasGerman: episodes.hasGerman })
        .from(episodes)
        .where(inArray(episodes.id, epIds))
        .all()) {
        facts.set(`episode:${e.id}`, e);
      }
    }
    if (movieIds.length > 0) {
      for (const m of this.db
        .select({ id: movies.id, hasFile: movies.hasFile, hasGerman: movies.hasGerman })
        .from(movies)
        .where(inArray(movies.id, movieIds))
        .all()) {
        facts.set(`movie:${m.id}`, m);
      }
    }
    for (const r of rows) {
      const f = facts.get(`${r.targetKind}:${r.targetId}`);
      if (!f?.hasFile) out.set(r.id, "missing");
      else out.set(r.id, f.hasGerman ? "german" : "non_german");
    }
    return out;
  }

  private setHold(
    reason: string,
    opts: { type?: string; level?: "info" | "warn"; logActivity?: boolean } = {},
  ): void {
    this.holdReason = reason;
    this.log.info({ reason }, "hunt cycle held");
    if (opts.logActivity !== false) {
      this.logActivity(opts.level ?? "warn", opts.type ?? "budget", `Hunt held: ${reason}`, {
        holdReason: reason,
      });
    }
    this.bus.emit("system.status", { component: "hunt", state: "held", holdReason: reason });
  }

  private logActivity(
    level: "info" | "warn",
    type: string,
    message: string,
    data: Record<string, unknown>,
  ): void {
    this.db.insert(activityLog).values({ at: this.now(), level, type, message, data }).run();
  }
}
