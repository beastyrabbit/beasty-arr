import { and, count, eq, gt, gte, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AppEventPayloads } from "../../shared/api-types.js";
import {
  type AiSeasonVerdict,
  type AiVerdictValue,
  type ArrSource,
  backoffForTier,
  EXHAUSTED_TIER,
  type HuntState,
  type SearchTrigger,
} from "../../shared/domain.js";
import { RadarrRequestError } from "../arr/radarr-client.js";
import { SonarrRequestError } from "../arr/sonarr-client.js";
import { isEnginePaused } from "../config/engine-flag.js";
import type { AppSettings, SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import {
  activityLog,
  aiCheckAttempts,
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
  type PlannedCommand,
  priorityScore,
} from "./selection.js";
import { aiPausedUntilFor, isAiVerdictValue } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** `announced` verdict without expectedAvailability: re-check in 30 days. */
const ANNOUNCED_FALLBACK_MS = 30 * DAY_MS;
const AI_FIRST_AGE_MS = 180 * DAY_MS;
const AI_FAILURE_COOLDOWN_MS = DAY_MS;
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
  recordDispatch(estimates: Map<number, number>, attemptId: number, source: ArrSource): void;
  releaseRejectedDispatch(attemptId: number, source: ArrSource): void;
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
  /** Manual Missing searches are tracked separately from German-audio forces. */
  trigger?: "forced" | "missing";
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
  heldSince?: number;
  inFlight: { label: string; source: ArrSource; startedAt: number }[];
};

export type QueueEntryView = {
  huntStateId: number;
  label: string;
  source: ArrSource;
  reason: "FORCED" | "SCHEDULED" | "RETRY";
  score: number;
};

export type QueueSnapshotView = {
  entries: QueueEntryView[];
  total: number;
  counts: {
    sonarr: number;
    radarr: number;
    forced: number;
    scheduled: number;
    retry: number;
  };
};

export type PausedEntryView = {
  huntStateId: number;
  label: string;
  source: ArrSource;
  since: number | null;
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
  perSeason?: AiSeasonVerdict[] | null;
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
    perSeason?: AiSeasonVerdict[] | null;
  },
  seasonNumber: number | null,
): AiVerdictValue | null {
  if (seasonNumber != null && verdict.perSeason?.length) {
    const entry = verdict.perSeason.find((p) => p.season === seasonNumber);
    if (entry && isAiVerdictValue(entry.verdict)) return entry.verdict;
    return null;
  }
  return verdict.verdict;
}

function effectiveVerdictDetail(
  verdict: AppliedVerdictInput,
  seasonNumber: number | null,
): {
  verdict: AiVerdictValue;
  confidence: number;
  expectedAvailability: number | null;
  recheckAfter: number;
  checkedAt: number;
} | null {
  if (seasonNumber != null && verdict.perSeason?.length) {
    const entry = verdict.perSeason.find((value) => value.season === seasonNumber);
    if (!entry || !isAiVerdictValue(entry.verdict)) return null;
    return {
      verdict: entry.verdict,
      confidence: entry.confidence ?? verdict.confidence,
      expectedAvailability: entry.expectedAvailability ?? verdict.expectedAvailability ?? null,
      recheckAfter: entry.recheckAfter ?? verdict.recheckAfter,
      checkedAt: entry.checkedAt ?? verdict.checkedAt,
    };
  }
  return {
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    expectedAvailability: verdict.expectedAvailability ?? null,
    recheckAfter: verdict.recheckAfter,
    checkedAt: verdict.checkedAt,
  };
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
  /**
   * Wired by the composition root after OracleService is constructed. `force`
   * means an explicit human request, which bypasses the daily cap and dry-run
   * AI suppression; automatic no-grab checks never do.
   */
  onAiCheckRequested?: (subjectKeys: string[], force: boolean) => void;

  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutMs: number;

  private cycleRunning = false;
  private lastCycleAt: number | null = null;
  private holdReason: string | null = null;
  private holdKey: string | null = null;
  private heldSince: number | null = null;
  private holdObservedThisCycle = false;
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

  /** Operator recovery only after checking upstream acceptance; never replays a command. */
  resolveInterruptedAttempt(
    attemptId: number,
    resolution:
      | { action: "attach_command"; commandId: number; note: string }
      | { action: "confirm_not_accepted"; note: string },
  ): boolean {
    if (this.cycleRunning) return false;
    const attempt = this.db
      .select()
      .from(searchAttempts)
      .where(eq(searchAttempts.id, attemptId))
      .get();
    if (
      !attempt ||
      attempt.dryRun ||
      attempt.status !== "interrupted" ||
      attempt.completedAt !== null ||
      attempt.arrCommandId !== null
    )
      return false;
    this.db.transaction((tx) => {
      tx.update(searchAttempts)
        .set(
          resolution.action === "attach_command"
            ? { arrCommandId: resolution.commandId, status: "queued" }
            : { status: "failed", result: "error", completedAt: this.now() },
        )
        .where(eq(searchAttempts.id, attemptId))
        .run();
      if (resolution.action === "confirm_not_accepted")
        this.budget?.releaseRejectedDispatch(attemptId, attempt.source);
      this.logActivity(
        "info",
        "hunt.search",
        `Operator resolved interrupted search ${attemptId}: ${resolution.action}`,
        { attemptId, ...resolution },
      );
    });
    this.bus.emit("hunt.search.result", {
      label: attempt.targetLabel ?? "Recovered search",
      source: attempt.source,
      result: resolution.action === "attach_command" ? null : "error",
      attemptId,
      status: resolution.action === "attach_command" ? "queued" : "failed",
    });
    return true;
  }

  async runCycle(signal?: AbortSignal, opts: { manualOnly?: boolean } = {}): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    const cycleStart = this.now();
    this.holdObservedThisCycle = false;
    try {
      const cfg = this.settings.get();
      this.expireUserPauses();
      this.resetTiersOnFreshImports();
      this.liftAiPausesWithSeasonEvidence();

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

      const scheduledSources = opts.manualOnly
        ? new Set<ArrSource>()
        : await this.openScheduledSources(reachable, cfg.queueGateEnabled, cfg.queueGateThreshold);

      let accountingAvailable = true;
      if (this.budget) {
        try {
          await this.budget.refresh();
        } catch (err) {
          accountingAvailable = false;
          this.log.warn({ err }, "budget refresh failed; holding automatic searches");
        }
      } else if (!this.warnedNoBudget) {
        this.warnedNoBudget = true;
        this.log.warn("no budget manager configured — dispatching without budget gating");
      }

      const reachableSources = new Set(reachable.map((r) => r.source));
      const unresolved = await this.reconcileIncompleteAttempts(reachable);
      const nowMs = this.now();
      const manual = this.loadManualBatch(reachableSources, cfg, nowMs).filter(
        (candidate) => !unresolved.has(candidate.huntStateId),
      );
      const scheduled = this.loadScheduledCandidates(scheduledSources, cfg, nowMs).filter(
        (candidate) => !unresolved.has(candidate.huntStateId),
      );
      // Human force requests are commands, not planning suggestions. Drain all
      // of them before applying the normal command ceiling to scheduled work.
      const missingManualIds = this.missingManualHuntStateIds(manual);
      const forcedManual = manual.filter(
        (candidate) => !missingManualIds.has(candidate.huntStateId),
      );
      const missingManual = manual.filter((candidate) =>
        missingManualIds.has(candidate.huntStateId),
      );
      const plan: { cmd: PlannedCommand; trigger: SearchTrigger }[] = [
        ...groupCommands(forcedManual).map((cmd) => ({ cmd, trigger: "forced" as const })),
        ...groupCommands(missingManual, { episodeIdsOnly: true }).map((cmd) => ({
          cmd,
          trigger: "missing" as const,
        })),
        // Automatic Hunts must keep their exact upgrade-only scope. A broad
        // SeasonSearch also includes fileless episodes and would bypass the
        // manual Missing workflow. Explicit Force keeps broad season grouping.
        ...groupCommands(scheduled, { episodeIdsOnly: true }).map((cmd) => ({
          cmd,
          trigger: "scheduled" as const,
        })),
      ];
      if (plan.length === 0) return;
      this.bus.emit("hunt.batch.started", {
        count: plan.length,
        targets: manual.length + scheduled.length,
      });

      const clientBySource = new Map(reachable.map((r) => [r.source, r.client]));
      const chains = new Map<ArrSource, Promise<void>>();
      const budgetHolds = new Set<string>();
      let scheduledDispatched = 0;
      try {
        for (let planIndex = 0; planIndex < plan.length; planIndex++) {
          const { cmd, trigger } = plan[planIndex];
          if (signal?.aborted) break;
          if (!this.isImmediateTrigger(trigger) && scheduledDispatched >= cfg.maxCommandsPerCycle)
            break;
          await chains.get(cmd.source);
          if (signal?.aborted) break;
          const current = this.settings.get();
          if (!this.isImmediateTrigger(trigger)) {
            if (isEnginePaused(this.db)) {
              this.setHold("automatic hunting is paused", { logActivity: false });
              continue;
            }
            if (!accountingAvailable) {
              this.setHold(
                "budget observation unavailable; retry accounting before automatic searches",
                { type: "budget", level: "warn" },
              );
              continue;
            }
          }
          let estimates: Map<number, number> | null = null;
          if (this.budget) {
            estimates = this.budget.estimateCommand({
              kind: cmd.kind,
              searchOps: cmd.searchOps,
              anime: cmd.anime,
            });
            // Force is explicit permission to spend the required queries now.
            // Keep estimating and recording usage so later scheduled work sees it.
            if (!this.isImmediateTrigger(trigger)) {
              const decision = this.budget.mayDispatch(estimates);
              if (!decision.ok) {
                if (cmd.covered.length > 1 && cmd.name !== "SeasonSearch") {
                  // Retry exact targets individually when the combined estimate cannot fit.
                  plan.splice(
                    planIndex + 1,
                    0,
                    ...cmd.covered.flatMap((candidate) =>
                      groupCommands([candidate], { episodeIdsOnly: true }).map((single) => ({
                        cmd: single,
                        trigger,
                      })),
                    ),
                  );
                  continue;
                }
                if (!budgetHolds.has(decision.holdReason)) {
                  budgetHolds.add(decision.holdReason);
                  this.setHold(decision.holdReason, { type: "budget", level: "warn" });
                }
                // A later, smaller command or the other arr may still fit. Budget
                // rejection is command-scoped, not a reason to abandon the plan.
                continue;
              }
            }
          }
          if (!this.isImmediateTrigger(trigger)) scheduledDispatched += 1;
          const attemptId = this.insertAttempt(cmd, trigger, current.dryRun, estimates);
          if (current.dryRun) {
            this.completeDryRun(cmd, trigger, attemptId, estimates);
            continue;
          }
          this.budget?.recordDispatch(estimates as Map<number, number>, attemptId, cmd.source);
          const client = clientBySource.get(cmd.source);
          if (!client) continue; // unreachable source: never planned, defensive only
          chains.set(cmd.source, this.dispatchAndTrack(cmd, trigger, attemptId, client, signal));
        }
      } finally {
        await Promise.all(chains.values());
      }
    } finally {
      if (!this.holdObservedThisCycle) {
        this.holdReason = null;
        this.holdKey = null;
        this.heldSince = null;
      }
      this.lastCycleAt = cycleStart;
      this.cycleRunning = false;
    }
  }

  // ============ dispatch + polling ============

  private async reconcileIncompleteAttempts(reachable: ReachableClient[]): Promise<Set<number>> {
    const held = new Set<number>();
    const clients = new Map(reachable.map(({ source, client }) => [source, client]));
    const attempts = this.db
      .select()
      .from(searchAttempts)
      .where(and(eq(searchAttempts.dryRun, false), isNull(searchAttempts.completedAt)))
      .all();
    for (const attempt of attempts) {
      let status: string | undefined;
      const client = clients.get(attempt.source);
      if (client && attempt.arrCommandId != null) {
        try {
          status = (await client.getCommand(attempt.arrCommandId)).status;
        } catch {
          // Missing command records and network errors are both ambiguous.
        }
      }
      if (status === "completed" || status === "failed" || status === "aborted") {
        const covered = this.db
          .select()
          .from(huntState)
          .where(inArray(huntState.id, attempt.targetIds))
          .all();
        const candidates: HuntCandidate[] = covered.map((row) => ({
          huntStateId: row.id,
          source: row.source,
          kind: row.targetKind,
          targetId: row.targetId,
          seriesId: row.seriesId,
          seasonNumber: row.seasonNumber,
          episodeNumber: null,
          title: attempt.targetLabel ?? "Recovered search",
          year: null,
          anime: false,
          score: 0,
          bucket: "upgrade",
          searchCount: row.searchCount,
          manualPriority: row.manualPriority,
        }));
        await this.afterCommand(
          {
            source: attempt.source,
            kind: attempt.source === "sonarr" ? "tv" : "movie",
            name: attempt.commandName as PlannedCommand["name"],
            payload: attempt.payload as PlannedCommand["payload"],
            searchOps: candidates.length,
            anime: false,
            label: attempt.targetLabel ?? "Recovered search",
            covered: candidates,
          },
          attempt.trigger as SearchTrigger,
          attempt.id,
          status === "completed" ? "completed" : "failed",
        );
      } else {
        for (const id of attempt.targetIds) held.add(id);
        this.setHold(
          `search ${attempt.id} awaiting command reconciliation${attempt.arrCommandId == null ? "; acceptance unknown" : ""}`,
          { key: "recovery", level: "warn" },
        );
      }
    }
    return held;
  }

  private async openScheduledSources(
    reachable: ReachableClient[],
    enabled: boolean,
    threshold: number,
  ): Promise<Set<ArrSource>> {
    if (!enabled) return new Set(reachable.map(({ source }) => source));
    const open = new Set<ArrSource>();
    const gated: string[] = [];
    for (const { source, client } of reachable) {
      try {
        const size = (await client.getQueueStats()).totalRecords;
        if (size <= threshold) open.add(source);
        else gated.push(`${source} ${size} > ${threshold}`);
      } catch (err) {
        this.log.warn({ err, source }, "queue stats failed — gating this arr's scheduled hunts");
        gated.push(`${source} queue unavailable`);
      }
    }
    if (gated.length > 0) {
      this.setHold(`download queue gate: ${gated.join(", ")}`, {
        type: "hunt.search",
        level: "info",
        key: "queue_gate",
      });
    }
    return open;
  }

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
      commandName: cmd.name,
      attemptId,
      dryRun: true,
    } satisfies AppEventPayloads["hunt.search.started"]);
    this.bus.emit("hunt.search.result", {
      label: cmd.label,
      source: cmd.source,
      result: null,
      attemptId,
      status: "completed",
      dryRun: true,
    });
    if (this.isImmediateTrigger(trigger)) {
      // The manual request was serviced (simulated) — keep the queue moving in dry-run.
      this.clearManualPriorities(cmd.covered.map((c) => c.huntStateId));
      // A separate forced request may overlap this Missing command. Consume
      // its explicit AI flag once the last covered target has been serviced.
      const forcedAiRecheck = this.consumeCompletedManualAiRequestFor(cmd.covered);
      this.markManualRequestsDone(now);
      if (forcedAiRecheck) {
        this.onAiCheckRequested?.(this.subjectKeysFor(cmd.covered), true);
      }
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
        commandName: cmd.name,
        attemptId,
        dryRun: false,
      } satisfies AppEventPayloads["hunt.search.started"]);
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
        const rejected =
          (err instanceof SonarrRequestError || err instanceof RadarrRequestError) &&
          [400, 401, 403, 404, 405, 422, 429].includes(err.status);
        const status = rejected ? "failed" : "interrupted";
        this.db
          .update(searchAttempts)
          .set({ status, result: "error", completedAt: rejected ? this.now() : null })
          .where(eq(searchAttempts.id, attemptId))
          .run();
        if (rejected) this.budget?.releaseRejectedDispatch(attemptId, cmd.source);
        this.bus.emit("hunt.search.result", {
          label: cmd.label,
          source: cmd.source,
          result: "error",
          attemptId,
          status,
        });
        return; // Acceptance is unknown; keep targets and budget reserved for reconciliation.
      }
      const arrCommandId = sent.id ?? null;
      this.db
        .update(searchAttempts)
        .set({ arrCommandId, status: "queued" })
        .where(eq(searchAttempts.id, attemptId))
        .run();
      const finalStatus =
        arrCommandId === null
          ? "timeout" // Acceptance cannot be reconciled without a command id.
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
    if (finalStatus === "timeout") {
      this.db
        .update(searchAttempts)
        .set({ status: "interrupted" })
        .where(eq(searchAttempts.id, attemptId))
        .run();
      this.bus.emit("hunt.search.result", {
        label: cmd.label,
        source: cmd.source,
        result: null,
        attemptId,
        status: "interrupted",
      });
      return;
    }
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

    // A Force+AI request may be queued while a scheduled command is in flight.
    // Suppress the automatic analysis until that explicit request is dispatched.
    const manualAiPending = this.manualAiRequestedFor(cmd.covered);
    const relationById = this.retryRelations(cmd.covered, now);
    const retryAtByGroup = new Map<string, number>();
    for (const c of cmd.covered) {
      const row = this.db.select().from(huntState).where(eq(huntState.id, c.huntStateId)).get();
      if (!row) continue;
      const patch: Partial<typeof huntState.$inferInsert> = {
        searchCount: row.searchCount + 1,
        // Imports can land while Sonarr/Radarr is still polling the command.
        // Compare them against dispatch time, not completion time.
        lastSearchAt: attempt?.createdAt ?? now,
      };
      const grabPending = row.awaitingImportSince != null;
      // Missing is a separate, manual completeness workflow. Its attempts must
      // not advance the German-hunt retry ladder shared by a season/series.
      if (trigger !== "missing" && !grabPending && HUNTABLE_STATES.includes(row.state)) {
        const relation = relationById.get(row.id);
        const relatedTier = Math.max(
          row.tier,
          relation?.seasonTier ?? 0,
          relation?.seriesTier ?? 0,
        );
        const newTier = relatedTier + 1;
        patch.tier = newTier;
        const retryGroup =
          row.targetKind === "episode"
            ? `${row.source}:${row.seriesId}:${row.seasonNumber}:${relatedTier}`
            : `${row.source}:${row.targetId}:${relatedTier}`;
        let retryAt = retryAtByGroup.get(retryGroup);
        if (retryAt == null) {
          let retryDelay = this.jittered(backoffForTier(relatedTier));
          if (row.targetKind === "movie") {
            retryDelay = Math.max(retryDelay, this.settings.get().movieRetryDays * DAY_MS);
          } else if (relation?.releasing) {
            retryDelay = Math.max(
              retryDelay,
              this.settings.get().releasingSeasonRetryDays * DAY_MS,
            );
          }
          retryAt = now + retryDelay;
          retryAtByGroup.set(retryGroup, retryAt);
        }
        patch.nextEligibleAt = retryAt;
        if (newTier >= EXHAUSTED_TIER && row.state !== "exhausted") {
          patch.state = "exhausted";
          patch.stateChangedAt = now;
        }
      }
      // A Force/Missing request can arrive while a scheduled command is in flight.
      // Only the immediate command is allowed to consume that manual priority;
      // otherwise the scheduler follow-up must still dispatch the explicit request.
      if (this.isImmediateTrigger(trigger) && row.manualPriority > 0) patch.manualPriority = 0;
      this.db.update(huntState).set(patch).where(eq(huntState.id, row.id)).run();
    }
    // Preserve an explicit AI recheck even when an overlapping Missing request
    // caused the final covered target to be dispatched as a Missing command.
    const forcedAiRecheck =
      this.isImmediateTrigger(trigger) && this.consumeCompletedManualAiRequestFor(cmd.covered);
    if (this.isImmediateTrigger(trigger)) this.markManualRequestsDone(now);
    const subjectKeys = this.subjectKeysFor(cmd.covered);
    if (forcedAiRecheck) this.onAiCheckRequested?.(subjectKeys, true);
    else if (trigger !== "missing" && result !== "error" && !manualAiPending) {
      this.onAiCheckRequested?.(subjectKeys, false);
    }
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
      .set({
        userPaused: false,
        userPausedAt: null,
        userPausedUntil: null,
        userPausedNote: null,
      })
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

  /**
   * One German episode proves that season's dub exists. If an older series-wide
   * AI verdict paused sibling episodes, lift those pauses immediately.
   */
  private liftAiPausesWithSeasonEvidence(): void {
    const germanSeasons = new Set(
      this.db
        .selectDistinct({
          seriesId: episodes.seriesId,
          seasonNumber: episodes.seasonNumber,
        })
        .from(episodes)
        .where(eq(episodes.hasGerman, true))
        .all()
        .map((row) => `${row.seriesId}:${row.seasonNumber}`),
    );
    if (germanSeasons.size === 0) return;
    const rows = this.db
      .select()
      .from(huntState)
      .where(
        and(
          eq(huntState.source, "sonarr"),
          eq(huntState.targetKind, "episode"),
          eq(huntState.state, "ai_paused"),
        ),
      )
      .all()
      .filter(
        (row) =>
          row.seriesId != null &&
          row.seasonNumber != null &&
          germanSeasons.has(`${row.seriesId}:${row.seasonNumber}`),
      );
    const now = this.now();
    const mirror = this.mirrorFallbackStates(rows);
    for (const row of rows) {
      const state = mirror.get(row.id) ?? "missing";
      this.db
        .update(huntState)
        .set({ state, stateChangedAt: now, nextEligibleAt: null })
        .where(eq(huntState.id, row.id))
        .run();
      this.bus.emit("item.updated", {
        source: row.source,
        kind: row.targetKind,
        id: row.targetId,
        seriesId: row.seriesId,
        state,
      } satisfies AppEventPayloads["item.updated"]);
    }
  }

  /**
   * Retry pressure is item/season scoped. A fresh season must not inherit a
   * long-running series' lifetime search count.
   */
  private retryRelations(
    covered: HuntCandidate[],
    now: number,
  ): Map<number, { seasonTier: number; seriesTier: number; releasing: boolean }> {
    const out = new Map<number, { seasonTier: number; seriesTier: number; releasing: boolean }>();
    const seriesIds = [
      ...new Set(
        covered.map((candidate) => candidate.seriesId).filter((id): id is number => id != null),
      ),
    ];
    for (const seriesId of seriesIds) {
      const rows = this.episodeJoinRows([eq(huntState.seriesId, seriesId)]);
      for (const candidate of covered.filter((item) => item.seriesId === seriesId)) {
        const seasonRows = rows.filter((row) => row.ep.seasonNumber === candidate.seasonNumber);
        const seasonTier = seasonRows.reduce((max, row) => Math.max(max, row.hs.tier), 0);
        const releasing = seasonRows.some(
          (row) =>
            row.s.status === "continuing" &&
            row.ep.airDateUtc != null &&
            row.ep.airDateUtc >= now - 28 * DAY_MS,
        );
        out.set(candidate.huntStateId, { seasonTier, seriesTier: 0, releasing });
      }
    }
    return out;
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
    germanSeasons: Set<string>,
  ): HuntCandidate {
    const verdict = verdicts.get(`sonarr:${row.ep.seriesId}`) ?? null;
    const eff = verdict ? effectiveVerdict(verdict, row.ep.seasonNumber) : null;
    const seasonVerdict = verdict?.perSeason?.find((entry) => entry.season === row.ep.seasonNumber);
    const expectedAvailability =
      seasonVerdict?.expectedAvailability ?? verdict?.expectedAvailability ?? null;
    const announcedDue =
      eff === "announced" && (expectedAvailability == null || expectedAvailability <= now);
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
        existsVerdict:
          eff === "exists" || germanSeasons.has(`${row.ep.seriesId}:${row.ep.seasonNumber}`),
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
    const germanSeasons = this.germanSeasonKeys();
    const out: HuntCandidate[] = [];
    const filters = [
      gt(huntState.manualPriority, 0),
      notInArray(huntState.state, [...NEVER_SEARCH_STATES]),
    ];
    if (reachable.has("sonarr")) {
      for (const row of this.episodeJoinRows(filters)) {
        out.push(this.buildEpisodeCandidate(row, verdicts, now, germanSeasons));
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
    const germanSeasons = this.germanSeasonKeys();
    const lag = this.loadDubLagOverrides();
    const aiFirstEnabled = this.aiFirstSlotsAvailable(cfg, now);
    const recentAiFailures = aiFirstEnabled ? this.recentAiFailureSubjects(now) : new Set<string>();
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
        // Missing media is handled only by the explicit Missing workflow.
        if (!row.ep.hasFile) continue;
        // Exhausted upgrades only re-enter once their backoff passed.
        if (row.hs.state === "exhausted" && row.hs.nextEligibleAt == null) continue;
        if (!cfg.huntSpecials && row.ep.seasonNumber === 0) continue;
        if (row.hs.state === "non_german") {
          const subjectKey = `sonarr:${row.ep.seriesId}`;
          const verdict = verdicts.get(subjectKey) ?? null;
          const exactVerdict =
            verdict?.perSeason?.find((entry) => entry.season === row.ep.seasonNumber) ?? null;
          const currentSeasonVerdict = verdict?.perSeason?.length
            ? Boolean(exactVerdict && (exactVerdict.recheckAfter ?? verdict.recheckAfter) > now)
            : Boolean(verdict && verdict.recheckAfter > now);
          if (
            aiFirstEnabled &&
            row.hs.searchCount === 0 &&
            row.ep.airDateUtc != null &&
            row.ep.airDateUtc <= now - AI_FIRST_AGE_MS &&
            !germanSeasons.has(`${row.ep.seriesId}:${row.ep.seasonNumber}`) &&
            !recentAiFailures.has(subjectKey) &&
            !currentSeasonVerdict
          ) {
            continue;
          }
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
        const cand = this.buildEpisodeCandidate(row, verdicts, now, germanSeasons);
        upgradeBucket.push(cand);
      }
    }
    if (reachable.has("radarr")) {
      for (const row of this.movieJoinRows(filters)) {
        if (!row.m.hasFile) continue;
        if (row.hs.state === "exhausted" && row.hs.nextEligibleAt == null) continue;
        if (row.hs.state === "non_german") {
          const subjectKey = `radarr:${row.m.id}`;
          const release = row.m.digitalRelease ?? row.m.physicalRelease;
          const verdict = verdicts.get(subjectKey) ?? null;
          if (
            aiFirstEnabled &&
            row.hs.searchCount === 0 &&
            release != null &&
            release <= now - AI_FIRST_AGE_MS &&
            !recentAiFailures.has(subjectKey) &&
            !(verdict && verdict.recheckAfter > now)
          ) {
            continue;
          }
          const lagDays =
            lag.movie.get(row.m.id) ?? Math.max(cfg.dubLagDaysDefault, cfg.movieRetryDays);
          const blockedUntil = firstUpgradeBlockedUntil({
            fileImportedAt: row.m.fileImportedAt,
            lastSearchAt: row.hs.lastSearchAt,
            dubLagDays: lagDays,
          });
          if (blockedUntil != null && blockedUntil > now) continue;
        }
        const cand = this.buildMovieCandidate(row, verdicts, now);
        upgradeBucket.push(cand);
      }
    }
    const byScore = (a: HuntCandidate, b: HuntCandidate) => b.score - a.score;
    upgradeBucket.sort(byScore);
    return upgradeBucket;
  }

  private aiFirstSlotsAvailable(cfg: AppSettings, now: number): boolean {
    if (cfg.aiProvider === "off" || cfg.dryRun) return false;
    if (!cfg.aiDailyLimitEnabled) return true;
    const date = new Date(now);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const row = this.db
      .select({ n: count() })
      .from(aiCheckAttempts)
      .where(
        and(
          gte(aiCheckAttempts.startedAt, dayStart),
          lt(aiCheckAttempts.startedAt, dayStart + DAY_MS),
        ),
      )
      .get();
    return (row?.n ?? 0) < cfg.aiMaxChecksPerDay;
  }

  private recentAiFailureSubjects(now: number): Set<string> {
    return new Set(
      this.db
        .select({ subjectKey: aiCheckAttempts.subjectKey })
        .from(aiCheckAttempts)
        .where(
          and(
            eq(aiCheckAttempts.status, "failed"),
            gte(aiCheckAttempts.startedAt, now - AI_FAILURE_COOLDOWN_MS),
          ),
        )
        .all()
        .map((row) => row.subjectKey),
    );
  }

  private germanSeasonKeys(): Set<string> {
    return new Set(
      this.db
        .selectDistinct({ seriesId: episodes.seriesId, seasonNumber: episodes.seasonNumber })
        .from(episodes)
        .where(eq(episodes.hasGerman, true))
        .all()
        .map((row) => `${row.seriesId}:${row.seasonNumber}`),
    );
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
      const detail = effectiveVerdictDetail(verdict, row.seasonNumber);
      if (detail === null) continue;
      const eff = detail.verdict;
      const patch: Partial<typeof huntState.$inferInsert> = { aiVerdictId: verdict.id };
      const mirrorState = mirrorStates.get(row.id) ?? "missing";
      const germanSeasonEvidence =
        source === "sonarr" &&
        row.seriesId != null &&
        row.seasonNumber != null &&
        this.seasonHasGerman(row.seriesId, row.seasonNumber);
      if (
        eff === "unlikely" &&
        !germanSeasonEvidence &&
        detail.confidence >= cfg.aiPauseConfidence
      ) {
        patch.state = "ai_paused";
        patch.nextEligibleAt = aiPausedUntilFor({
          checkedAt: detail.checkedAt,
          recheckAfter: detail.recheckAfter,
        });
        if (row.state !== "ai_paused") patch.stateChangedAt = now;
      } else {
        if (eff === "announced") {
          patch.tier = 2;
          patch.nextEligibleAt =
            detail.expectedAvailability != null && detail.expectedAvailability > now
              ? detail.expectedAvailability
              : now + ANNOUNCED_FALLBACK_MS;
        } else if (eff === "exists" || germanSeasonEvidence) {
          patch.tier = 2;
          // Positive evidence increases urgency. Use a concrete timestamp so
          // exhausted rows are eligible too (null means unscheduled for them).
          patch.nextEligibleAt = now;
        }
        if (row.state === "ai_paused") {
          patch.state = mirrorState;
          patch.stateChangedAt = now;
          if (eff !== "announced" && eff !== "exists" && !germanSeasonEvidence) {
            patch.nextEligibleAt = null;
          }
        }
      }
      this.db.update(huntState).set(patch).where(eq(huntState.id, row.id)).run();
      if (patch.state && patch.state !== row.state) {
        this.bus.emit("item.updated", {
          source: row.source,
          kind: row.targetKind,
          id: row.targetId,
          seriesId: row.seriesId,
          state: patch.state,
        } satisfies AppEventPayloads["item.updated"]);
      }
      applied += 1;
    }
    this.bus.emit("queue.updated", { reason: "ai_verdict", subjectKey: verdict.subjectKey });
    return { applied };
  }

  // ============ force / pause / resume ============

  forceSubject(req: ForceSubjectRequest): {
    queuedTargets: number;
    queuePosition: 1;
    requestId: number;
  } {
    const now = this.now();
    const targets = this.resolveSubjectTargets(req, { wideExclusions: true });
    if (targets.length === 0) return { queuedTargets: 0, queuePosition: 1, requestId: 0 };
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
    const requestSubject = this.manualRequestSubject(req);
    const request = this.db
      .insert(manualRequests)
      .values({
        createdAt: now,
        subject: requestSubject,
        withAiRecheck: req.withAiRecheck ?? false,
        status: "pending",
      })
      .returning({ id: manualRequests.id })
      .get();
    this.bus.emit("queue.updated", { reason: req.trigger ?? "forced", subject: requestSubject });
    return { queuedTargets: targets.length, queuePosition: 1, requestId: request.id };
  }

  pauseSubject(req: PauseSubjectRequest): { pausedTargets: number } {
    const now = this.now();
    const targets = this.resolveSubjectTargets(req, { wideExclusions: false });
    for (const row of targets) {
      this.db
        .update(huntState)
        .set({
          userPaused: true,
          userPausedAt: now,
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
        userPausedAt: null,
        userPausedUntil: null,
        userPausedNote: null,
      };
      if (req.overrideAi && row.state === "ai_paused") {
        patch.state = mirrorStates.get(row.id) ?? "missing";
        patch.stateChangedAt = now;
        patch.nextEligibleAt = null;
      }
      if (req.force) patch.nextEligibleAt = now;
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

  private manualRequestSubject(req: ForceSubjectRequest): string {
    const subject = this.subjectString(req);
    return req.trigger === "missing" ? `missing:${subject}` : subject;
  }

  private parsedManualSubject(subject: string): {
    trigger: "forced" | "missing";
    source: ArrSource;
    kind: SubjectKind;
    id: number;
    season: number | null;
  } | null {
    const parts = subject.split(":");
    const missing = parts[0] === "missing";
    if (missing) parts.shift();
    const [source, kind, rawId, rawSeason] = parts;
    const id = Number(rawId);
    if ((source !== "sonarr" && source !== "radarr") || !Number.isFinite(id)) return null;
    if (!["series", "season", "episode", "movie"].includes(kind)) return null;
    const season = rawSeason == null ? null : Number(rawSeason);
    return {
      trigger: missing ? "missing" : "forced",
      source,
      kind: kind as SubjectKind,
      id,
      season: season != null && Number.isFinite(season) ? season : null,
    };
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

  private manualAiRequestedFor(covered: HuntCandidate[]): boolean {
    return this.findManualAiRequest(covered) != null;
  }

  /**
   * Consume the AI flag only after every command in the human request finished,
   * so one series force produces one complete, season-aware oracle check.
   */
  private consumeCompletedManualAiRequestFor(covered: HuntCandidate[]): boolean {
    const request = this.findManualAiRequest(covered);
    if (!request || this.subjectStillQueued(request.subject)) return false;
    this.db
      .update(manualRequests)
      .set({ withAiRecheck: false })
      .where(eq(manualRequests.id, request.id))
      .run();
    return true;
  }

  private findManualAiRequest(covered: HuntCandidate[]): typeof manualRequests.$inferSelect | null {
    const rows = this.db
      .select()
      .from(manualRequests)
      .where(and(ne(manualRequests.status, "done"), eq(manualRequests.withAiRecheck, true)))
      .all();
    return rows.find((row) => this.subjectMatchesCovered(row.subject, covered)) ?? null;
  }

  private subjectMatchesCovered(subject: string, covered: HuntCandidate[]): boolean {
    const parsed = this.parsedManualSubject(subject);
    if (!parsed) return false;
    const { source, kind, id, season } = parsed;
    return covered.some((candidate) => {
      if (candidate.source !== source) return false;
      if (kind === "movie") return candidate.kind === "movie" && candidate.targetId === id;
      if (kind === "episode") return candidate.kind === "episode" && candidate.targetId === id;
      if (kind === "series") return candidate.kind === "episode" && candidate.seriesId === id;
      if (kind === "season") {
        return (
          candidate.kind === "episode" &&
          candidate.seriesId === id &&
          candidate.seasonNumber === season
        );
      }
      return false;
    });
  }

  private subjectKeysFor(covered: HuntCandidate[]): string[] {
    return [
      ...new Set(
        covered.map((candidate) =>
          candidate.kind === "movie"
            ? `radarr:${candidate.targetId}`
            : `sonarr:${candidate.seriesId}`,
        ),
      ),
    ];
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
    const parsed = this.parsedManualSubject(subject);
    if (!parsed) return false;
    const { source, kind, id, season } = parsed;
    const conds = [eq(huntState.source, source), gt(huntState.manualPriority, 0)];
    if (kind === "series") {
      conds.push(eq(huntState.seriesId, id));
    } else if (kind === "season") {
      conds.push(eq(huntState.seriesId, id));
      if (season != null) conds.push(eq(huntState.seasonNumber, season));
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

  private missingManualHuntStateIds(candidates: HuntCandidate[]): Set<number> {
    const missingRequests = this.db
      .select({ subject: manualRequests.subject })
      .from(manualRequests)
      .where(ne(manualRequests.status, "done"))
      .all()
      .filter((request) => request.subject.startsWith("missing:"));
    const ids = new Set<number>();
    for (const candidate of candidates) {
      if (
        missingRequests.some((request) => this.subjectMatchesCovered(request.subject, [candidate]))
      ) {
        ids.add(candidate.huntStateId);
      }
    }
    return ids;
  }

  private isImmediateTrigger(trigger: SearchTrigger): boolean {
    return trigger === "forced" || trigger === "missing";
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
      heldSince: this.heldSince ?? undefined,
      inFlight: [...this.inFlight.values()],
    };
  }

  /** Exact next-tick time from whoever owns the schedule (optional; falls back to lastCycleAt + tick). */
  setNextTickAt(ts: number | null): void {
    this.nextTickAtOverride = ts;
  }

  queueView(limit = DEFAULT_QUEUE_VIEW_LIMIT): QueueEntryView[] {
    return this.queueSnapshot(limit).entries;
  }

  queueSnapshot(limit = DEFAULT_QUEUE_VIEW_LIMIT): QueueSnapshotView {
    const cfg = this.settings.get();
    const now = this.now();
    const both = new Set<ArrSource>(["sonarr", "radarr"]);
    // The public queue is only the automatic plan. Forced work is dispatched
    // immediately and appears as the current hunt or in search history.
    const all: QueueEntryView[] = [];
    for (const c of this.loadScheduledCandidates(both, cfg, now)) {
      all.push({
        huntStateId: c.huntStateId,
        label: candidateLabel(c),
        source: c.source,
        reason: c.searchCount > 0 ? "RETRY" : "SCHEDULED",
        score: c.score,
      });
    }
    const counts = {
      sonarr: all.filter((entry) => entry.source === "sonarr").length,
      radarr: all.filter((entry) => entry.source === "radarr").length,
      forced: all.filter((entry) => entry.reason === "FORCED").length,
      scheduled: all.filter((entry) => entry.reason === "SCHEDULED").length,
      retry: all.filter((entry) => entry.reason === "RETRY").length,
    };
    return { entries: all.slice(0, limit), total: all.length, counts };
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
        since: r.userPausedAt,
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

  private seasonHasGerman(seriesId: number, seasonNumber: number): boolean {
    return (
      this.db
        .select({ id: episodes.id })
        .from(episodes)
        .where(
          and(
            eq(episodes.seriesId, seriesId),
            eq(episodes.seasonNumber, seasonNumber),
            eq(episodes.hasGerman, true),
          ),
        )
        .limit(1)
        .get() != null
    );
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
    opts: { type?: string; level?: "info" | "warn"; logActivity?: boolean; key?: string } = {},
  ): void {
    const key = opts.key ?? reason;
    if (this.holdKey !== key || this.heldSince === null) this.heldSince = this.now();
    this.holdKey = key;
    this.holdReason = reason;
    this.holdObservedThisCycle = true;
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
