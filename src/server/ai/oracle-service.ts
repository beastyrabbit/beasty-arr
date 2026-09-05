import { setTimeout as sleep } from "node:timers/promises";
import { and, count, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AiSeasonVerdict, ArrSource } from "../../shared/domain.js";
import type { SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import {
  activityLog,
  aiCheckAttempts,
  aiVerdicts,
  dubCatalogEvidence,
  episodes,
  huntState,
  itemOverrides,
  movies,
  series,
} from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import { AI_PAUSE_MIN_MS } from "../hunt/state.js";
import {
  type DubCatalogEvidence,
  type DubCatalogLookupResult,
  lookupDubCatalog,
} from "./dub-catalog.js";
import {
  buildDubCheckSession,
  type DnsLookupFn,
  finalizeDubVerdict,
  PROMPT_VERSION,
} from "./existence-check.js";
import type { PiRunner, ProviderId } from "./providers.js";

export type AiVerdictRow = typeof aiVerdicts.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POST_SEARCH_GRACE_MS = 2 * 60 * 1000;
const AI_FAILURE_COOLDOWN_MS = DAY_MS;
const CATALOG_RECHECK_MS = 30 * DAY_MS;
const CATALOG_NO_MATCH_SOURCE = "wikidata-no-match";
const WIKIDATA_QUERY_URL = "https://query.wikidata.org/sparql";
/** Sentinel for manual invalidation: non-null "superseded" without a successor row. */
export const INVALIDATED_SENTINEL = 0;

/** States that make a subject a candidate for an oracle check. */
const HUNTABLE_STATES = ["missing", "non_german", "exhausted"] as const;
const AI_FIRST_AGE_MS = 180 * DAY_MS;

const GERMAN_ORIGINAL = new Set(["german", "deutsch", "de"]);

export type OracleCheckSubject = {
  subjectKey: string; // 'sonarr:12' | 'radarr:9'
  subjectKind: "series" | "movie";
  source: ArrSource;
  subjectId: number;
  title: string;
  year: number | null;
  originalLanguage: string | null;
  externalIds: { tvdbId?: number; tmdbId?: number; imdbId?: string };
  seasons?: number[];
  confirmedGermanSeasons?: number[];
  catalogEvidence?: DubCatalogEvidence;
};

export type OracleSubject = OracleCheckSubject & {
  exhausted: boolean;
  maxSearchCount: number;
};

export type OracleBatchResult = {
  selected: number;
  checked: number;
  failed: number;
  skippedReason?: "provider_off" | "dry_run" | "daily_cap" | "state_refresh_failed";
};

export type OracleServiceOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  postSearchGraceMs?: number;
  /** Refreshes Arr history after the grace period so late grabs suppress paid AI checks. */
  refreshAutomaticState?: () => Promise<void>;
  searxngUrl?: string;
  /** Injected into the fetch_url tool (tests use fakes; prod omits). */
  fetchImpl?: typeof fetch;
  lookupFn?: DnsLookupFn;
  catalogFetchImpl?: typeof fetch;
  catalogLookup?: (
    subjects: OracleCheckSubject[],
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
  ) => Promise<DubCatalogLookupResult | Map<string, DubCatalogEvidence>>;
};

export type OracleBulkStatus = {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
  remaining: number;
  startedAt: number | null;
  completedAt: number | null;
  cancelled: boolean;
  active: { subjectKey: string; title: string }[];
};

export class OracleService {
  /** Set by the orchestrator to huntEngine.applyVerdict at wire time. */
  onVerdict?: (row: AiVerdictRow) => void;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly postSearchGraceMs: number;
  private readonly refreshAutomaticState: () => Promise<void>;
  private readonly checksInFlight = new Set<string>();
  private automaticCheckChain: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  private readonly tasks = new Set<Promise<AiVerdictRow>>();
  private bulkTask: Promise<void> | null = null;

  async stop(): Promise<void> {
    this.shutdown.abort();
    this.cancelBulk();
    await Promise.allSettled([this.automaticCheckChain, this.bulkTask, ...this.tasks]);
  }

  private bulkAbort: AbortController | null = null;
  private bulkStatus: OracleBulkStatus = OracleService.idleBulkStatus();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly runner: PiRunner,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly opts: OracleServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => sleep(ms, undefined, { signal: this.shutdown.signal }));
    this.postSearchGraceMs = opts.postSearchGraceMs ?? DEFAULT_POST_SEARCH_GRACE_MS;
    this.refreshAutomaticState = opts.refreshAutomaticState ?? (async () => undefined);
    const recoveryAt = this.now();
    this.db
      .update(aiCheckAttempts)
      .set({
        status: "failed",
        completedAt: recoveryAt,
        error: "Application restarted before the AI attempt completed.",
      })
      .where(
        and(
          eq(aiCheckAttempts.status, "running"),
          lt(aiCheckAttempts.startedAt, recoveryAt - 60 * 60 * 1000),
        ),
      )
      .run();
    this.normalizeUnlikelyVerdictHorizons();
  }

  /** Bring verdicts written under the old short retry policy up to the one-year contract. */
  private normalizeUnlikelyVerdictHorizons(): void {
    const rows = this.db.select().from(aiVerdicts).where(isNull(aiVerdicts.supersededBy)).all();
    for (const row of rows) {
      const minimum = row.checkedAt + AI_PAUSE_MIN_MS;
      let changed = false;
      const perSeason = row.perSeason?.map((entry) => {
        if (
          entry.verdict !== "unlikely" ||
          (entry.recheckAfter ?? row.recheckAfter) >=
            (entry.checkedAt ?? row.checkedAt) + AI_PAUSE_MIN_MS
        ) {
          return entry;
        }
        changed = true;
        return { ...entry, recheckAfter: (entry.checkedAt ?? row.checkedAt) + AI_PAUSE_MIN_MS };
      });
      const recheckAfter =
        row.verdict === "unlikely" && row.recheckAfter < minimum ? minimum : row.recheckAfter;
      if (recheckAfter !== row.recheckAfter) changed = true;
      if (!changed) continue;
      this.db
        .update(aiVerdicts)
        .set({ recheckAfter, perSeason: perSeason ?? row.perSeason })
        .where(eq(aiVerdicts.id, row.id))
        .run();
    }
  }

  private static idleBulkStatus(): OracleBulkStatus {
    return {
      running: false,
      total: 0,
      completed: 0,
      failed: 0,
      remaining: 0,
      startedAt: null,
      completedAt: null,
      cancelled: false,
      active: [],
    };
  }

  getBulkStatus(): OracleBulkStatus {
    return { ...this.bulkStatus, active: [...this.bulkStatus.active] };
  }

  startBulk(options: { limit?: number } = {}): { ok: boolean; total: number; message?: string } {
    if (this.bulkStatus.running) {
      return { ok: false, total: this.bulkStatus.total, message: "AI bulk is already running." };
    }
    const cfg = this.settings.get();
    if (cfg.aiProvider === "off") {
      return { ok: false, total: 0, message: "AI provider is disabled." };
    }
    if (cfg.dryRun) {
      return { ok: false, total: 0, message: "AI bulk is disabled while dry-run is active." };
    }
    const remaining = this.remainingDailyChecks();
    if (remaining <= 0) {
      return { ok: false, total: 0, message: "Daily AI limit is exhausted." };
    }
    const all = this.selectSubjects({ includeUnsearched: true });
    const dailyCapped = Number.isFinite(remaining) ? all.slice(0, remaining) : all;
    const subjects = options.limit ? dailyCapped.slice(0, options.limit) : dailyCapped;
    this.bulkAbort = new AbortController();
    this.bulkStatus = {
      ...OracleService.idleBulkStatus(),
      running: true,
      total: subjects.length,
      remaining: subjects.length,
      startedAt: this.now(),
    };
    this.bulkTask = this.runBulkSubjects(subjects, this.bulkAbort.signal);
    return { ok: true, total: subjects.length };
  }

  cancelBulk(): boolean {
    if (!this.bulkStatus.running || !this.bulkAbort) return false;
    this.bulkStatus.cancelled = true;
    this.bulkAbort.abort();
    return true;
  }

  /**
   * Nightly batch: pick due subjects per trigger policy, capped per calendar
   * day, and run checks with bounded parallelism. Fully skipped in dry-run and when the
   * provider is off — hunting never depends on AI.
   */
  async runDailyBatch(signal?: AbortSignal): Promise<OracleBatchResult> {
    const settings = this.settings.get();
    if (settings.dryRun) {
      this.log.info("dub oracle: skipped (dry-run)");
      return { selected: 0, checked: 0, failed: 0, skippedReason: "dry_run" };
    }

    // The free deterministic catalog is useful before both searches and paid
    // AI. Run it for unsearched subjects as part of normal automation, with a
    // durable negative-result cache so WDQS is not queried every night.
    const catalogCandidates = this.selectSubjects({ includeUnsearched: true }).filter((subject) =>
      this.catalogCheckDue(subject.subjectKey),
    );
    if (catalogCandidates.length > 0 && !signal?.aborted) {
      try {
        await this.prepareBulkSubjects(catalogCandidates, signal ?? new AbortController().signal);
      } catch (error) {
        this.log.warn({ err: error }, "nightly dub catalog lookup failed; continuing with AI");
      }
    }

    if (settings.aiProvider === "off") {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "provider_off" };
    }
    const remaining = this.remainingDailyChecks();
    if (remaining <= 0) {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "daily_cap" };
    }
    const all = this.selectSubjects();
    const subjects = Number.isFinite(remaining) ? all.slice(0, remaining) : all;
    const result = await this.runSubjects(subjects, signal);
    return { selected: subjects.length, ...result };
  }

  /**
   * Trigger policy (exported for tests): subjects (series/movies, grouped)
   * with no valid verdict AND either an exhausted hunt item or enough failed
   * searches. German-original and original_ok/ignore subjects are never
   * checked. A season with any known German file is also excluded: that file
   * is stronger evidence than an AI lookup that the season dub exists.
   */
  selectSubjects(options: { includeUnsearched?: boolean } = {}): OracleSubject[] {
    const settings = this.settings.get();
    const now = this.now();
    const overrides = this.subjectOverrides();
    const validVerdicts = this.validVerdictScopes(now);
    const recentFailures = new Set(
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

    type Agg = {
      subject: OracleCheckSubject;
      exhausted: boolean;
      maxSearchCount: number;
      seasons: Set<number>;
    };
    const aggregates = new Map<string, Agg>();

    const addRow = (
      subject: OracleCheckSubject,
      row: { state: string; searchCount: number },
      season: number | null,
    ) => {
      let agg = aggregates.get(subject.subjectKey);
      if (!agg) {
        agg = {
          subject,
          exhausted: false,
          maxSearchCount: 0,
          seasons: new Set(),
        };
        aggregates.set(subject.subjectKey, agg);
      }
      if (row.state === "exhausted") agg.exhausted = true;
      agg.maxSearchCount = Math.max(agg.maxSearchCount, row.searchCount);
      if (season != null) agg.seasons.add(season);
    };

    const seriesRows = this.db
      .select({
        state: huntState.state,
        searchCount: huntState.searchCount,
        hasFile: episodes.hasFile,
        seasonNumber: huntState.seasonNumber,
        airDateUtc: episodes.airDateUtc,
        seriesId: series.id,
        title: series.title,
        year: series.year,
        tvdbId: series.tvdbId,
        imdbId: series.imdbId,
        originalLanguage: series.originalLanguage,
      })
      .from(huntState)
      .innerJoin(series, eq(huntState.seriesId, series.id))
      .leftJoin(episodes, eq(huntState.targetId, episodes.id))
      .where(
        and(
          eq(huntState.source, "sonarr"),
          eq(huntState.targetKind, "episode"),
          inArray(huntState.state, [...HUNTABLE_STATES]),
          isNull(huntState.awaitingImportSince),
        ),
      )
      .all();
    for (const row of seriesRows) {
      if (!row.hasFile) continue;
      const subjectKey = `sonarr:${row.seriesId}`;
      if (
        validVerdicts.subjects.has(subjectKey) ||
        (row.seasonNumber != null && validVerdicts.seasons.has(`${subjectKey}:${row.seasonNumber}`))
      ) {
        continue;
      }
      if (row.seasonNumber != null && germanSeasons.has(`${row.seriesId}:${row.seasonNumber}`)) {
        continue;
      }
      if (
        !options.includeUnsearched &&
        row.state !== "exhausted" &&
        row.searchCount < settings.aiMinSearchesBeforeCheck &&
        !(
          row.state === "non_german" &&
          row.searchCount === 0 &&
          row.airDateUtc != null &&
          row.airDateUtc <= now - AI_FIRST_AGE_MS
        )
      ) {
        continue;
      }
      addRow(
        {
          subjectKey: `sonarr:${row.seriesId}`,
          subjectKind: "series",
          source: "sonarr",
          subjectId: row.seriesId,
          title: row.title,
          year: row.year,
          originalLanguage: row.originalLanguage,
          externalIds: {
            tvdbId: row.tvdbId ?? undefined,
            imdbId: row.imdbId ?? undefined,
          },
        },
        row,
        row.seasonNumber,
      );
    }

    const movieRows = this.db
      .select({
        state: huntState.state,
        searchCount: huntState.searchCount,
        hasFile: movies.hasFile,
        movieId: movies.id,
        title: movies.title,
        year: movies.year,
        tmdbId: movies.tmdbId,
        imdbId: movies.imdbId,
        originalLanguage: movies.originalLanguage,
        digitalRelease: movies.digitalRelease,
        physicalRelease: movies.physicalRelease,
      })
      .from(huntState)
      .innerJoin(movies, eq(huntState.targetId, movies.id))
      .where(
        and(
          eq(huntState.source, "radarr"),
          eq(huntState.targetKind, "movie"),
          inArray(huntState.state, [...HUNTABLE_STATES]),
          isNull(huntState.awaitingImportSince),
        ),
      )
      .all();
    for (const row of movieRows) {
      if (!row.hasFile) continue;
      if (validVerdicts.subjects.has(`radarr:${row.movieId}`)) continue;
      if (
        !options.includeUnsearched &&
        row.state !== "exhausted" &&
        row.searchCount < settings.aiMinSearchesBeforeCheck &&
        !(
          row.state === "non_german" &&
          row.searchCount === 0 &&
          (row.digitalRelease ?? row.physicalRelease) != null &&
          (row.digitalRelease ?? row.physicalRelease ?? now) <= now - AI_FIRST_AGE_MS
        )
      ) {
        continue;
      }
      addRow(
        {
          subjectKey: `radarr:${row.movieId}`,
          subjectKind: "movie",
          source: "radarr",
          subjectId: row.movieId,
          title: row.title,
          year: row.year,
          originalLanguage: row.originalLanguage,
          externalIds: {
            tmdbId: row.tmdbId ?? undefined,
            imdbId: row.imdbId ?? undefined,
          },
        },
        row,
        null,
      );
    }

    const selected: OracleSubject[] = [];
    for (const agg of aggregates.values()) {
      const { subject } = agg;
      if (recentFailures.has(subject.subjectKey)) continue;
      const lang = subject.originalLanguage?.trim().toLowerCase();
      if (lang && GERMAN_ORIGINAL.has(lang)) continue;
      const override = overrides.get(
        `${subject.source}:${subject.subjectKind}:${subject.subjectId}`,
      );
      if (override === "original_ok" || override === "ignore") continue;
      selected.push({
        ...subject,
        catalogEvidence: this.catalogEvidenceFor(subject.subjectKey) ?? undefined,
        seasons: agg.seasons.size ? [...agg.seasons].sort((a, b) => a - b) : undefined,
        confirmedGermanSeasons:
          subject.subjectKind === "series"
            ? [...germanSeasons]
                .filter((key) => key.startsWith(`${subject.subjectId}:`))
                .map((key) => Number(key.split(":")[1]))
                .filter((season) => Number.isInteger(season))
                .sort((a, b) => a - b)
            : undefined,
        exhausted: agg.exhausted,
        maxSearchCount: agg.maxSearchCount,
      });
    }
    selected.sort(
      (a, b) =>
        Number(b.exhausted) - Number(a.exhausted) ||
        b.maxSearchCount - a.maxSearchCount ||
        a.title.localeCompare(b.title),
    );
    return selected;
  }

  /**
   * Immediate automatic check after a completed search found no grab. It uses
   * the same eligibility rules and daily budget as the nightly batch. Dry-run
   * never spends AI tokens; explicit human rechecks use recheckSubject instead.
   */
  async checkAfterFailedSearch(subjectKeys: string[]): Promise<OracleBatchResult> {
    const settings = this.settings.get();
    if (settings.aiProvider === "off") {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "provider_off" };
    }
    if (settings.dryRun) {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "dry_run" };
    }
    const graceEndsAt = this.now() + this.postSearchGraceMs;
    const task = this.automaticCheckChain.then(async () => {
      this.shutdown.signal.throwIfAborted();
      const remainingGraceMs = graceEndsAt - this.now();
      if (remainingGraceMs > 0) await this.sleep(remainingGraceMs);
      this.shutdown.signal.throwIfAborted();
      try {
        await this.refreshAutomaticState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(
          { err: message, subjectKeys },
          "automatic dub oracle state refresh failed — skipping AI checks",
        );
        return {
          selected: 0,
          checked: 0,
          failed: 0,
          skippedReason: "state_refresh_failed" as const,
        };
      }
      return this.runAutomaticChecksAfterFailure(subjectKeys);
    });
    this.automaticCheckChain = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async runAutomaticChecksAfterFailure(subjectKeys: string[]): Promise<OracleBatchResult> {
    const settings = this.settings.get();
    if (settings.aiProvider === "off") {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "provider_off" };
    }
    if (settings.dryRun) {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "dry_run" };
    }
    const remaining = this.remainingDailyChecks();
    if (remaining <= 0) {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "daily_cap" };
    }
    const requested = new Set(subjectKeys);
    const subjects = this.selectSubjects().filter(
      (subject) =>
        requested.has(subject.subjectKey) && !this.checksInFlight.has(subject.subjectKey),
    );
    const selected = Number.isFinite(remaining) ? subjects.slice(0, remaining) : subjects;
    const result = await this.runSubjects(selected);
    return { selected: selected.length, ...result };
  }

  /**
   * Manual re-check: invalidate the current verdict and run now. Runs even in
   * dry-run (explicit user action); `force` additionally bypasses the daily cap.
   */
  async recheckSubject(subjectKey: string, force = false): Promise<AiVerdictRow> {
    const settings = this.settings.get();
    if (settings.aiProvider === "off") {
      throw new Error("AI provider is disabled (aiProvider=off).");
    }
    const subject = this.loadSubject(subjectKey);
    if (!subject) throw new Error(`Unknown oracle subject: ${subjectKey}`);
    const attemptId = this.tryStartAttempt(subject, force);
    if (attemptId === null) {
      throw new Error("Daily AI check budget exhausted — use force to override.");
    }
    // Keep the last good verdict active until its replacement succeeds. The
    // insert path supersedes it atomically after a validated result exists.
    return await this.runTrackedCheck(subject, attemptId);
  }

  /** Explicit invalidation without replacement; rechecks keep the old row until success. */
  invalidateVerdicts(subjectKey: string): void {
    this.db
      .update(aiVerdicts)
      .set({ supersededBy: INVALIDATED_SENTINEL })
      .where(and(eq(aiVerdicts.subjectKey, subjectKey), isNull(aiVerdicts.supersededBy)))
      .run();
  }

  countCheckedToday(): number {
    const now = new Date(this.now());
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
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
    return row?.n ?? 0;
  }

  private remainingDailyChecks(): number {
    const cfg = this.settings.get();
    return cfg.aiDailyLimitEnabled
      ? Math.max(0, cfg.aiMaxChecksPerDay - this.countCheckedToday())
      : Number.POSITIVE_INFINITY;
  }

  /** SQLite insert is synchronous, so parallel workers cannot oversubscribe the cap. */
  private tryStartAttempt(subject: OracleCheckSubject, force = false): number | null {
    if (!force && this.remainingDailyChecks() <= 0) return null;
    const cfg = this.settings.get();
    return this.db
      .insert(aiCheckAttempts)
      .values({
        subjectKey: subject.subjectKey,
        provider: cfg.aiProvider,
        model: cfg.aiModel,
        status: "running",
        startedAt: this.now(),
      })
      .returning({ id: aiCheckAttempts.id })
      .get().id;
  }

  private finishAttempt(id: number, status: "succeeded" | "failed" | "cancelled", error?: string) {
    this.db
      .update(aiCheckAttempts)
      .set({ status, completedAt: this.now(), error: error ?? null })
      .where(eq(aiCheckAttempts.id, id))
      .run();
  }

  private async runSubjects(
    subjects: OracleCheckSubject[],
    signal?: AbortSignal,
    hooks: {
      started?: (subject: OracleCheckSubject) => void;
      completed?: (subject: OracleCheckSubject, failed: boolean) => void;
    } = {},
  ): Promise<{ checked: number; failed: number }> {
    let cursor = 0;
    let checked = 0;
    let failed = 0;
    const worker = async () => {
      while (!signal?.aborted) {
        const subject = subjects[cursor++];
        if (!subject) return;
        if (this.checksInFlight.has(subject.subjectKey)) continue;
        const attemptId = this.tryStartAttempt(subject);
        if (attemptId === null) return;
        this.checksInFlight.add(subject.subjectKey);
        hooks.started?.(subject);
        let subjectFailed = false;
        try {
          await this.runTrackedCheck(subject, attemptId, signal);
          checked += 1;
        } catch (error) {
          subjectFailed = true;
          if (!signal?.aborted) {
            failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn(
              { subjectKey: subject.subjectKey, err: message },
              "dub oracle check failed",
            );
            this.logActivity("warn", `Dub oracle check failed: ${subject.title}`, {
              subjectKey: subject.subjectKey,
              error: message,
            });
          }
        } finally {
          this.checksInFlight.delete(subject.subjectKey);
          hooks.completed?.(subject, subjectFailed);
        }
      }
    };
    const workers = Math.min(this.settings.get().aiParallelism, subjects.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return { checked, failed };
  }

  private async runBulkSubjects(
    subjects: OracleCheckSubject[],
    signal: AbortSignal,
  ): Promise<void> {
    const hooks = {
      started: (subject: OracleCheckSubject) => {
        this.bulkStatus.active = [
          ...this.bulkStatus.active,
          { subjectKey: subject.subjectKey, title: subject.title },
        ];
      },
      completed: (subject: OracleCheckSubject, failed: boolean) => {
        this.bulkStatus.active = this.bulkStatus.active.filter(
          (entry) => entry.subjectKey !== subject.subjectKey,
        );
        if (!signal.aborted) {
          if (failed) this.bulkStatus.failed += 1;
          else this.bulkStatus.completed += 1;
        }
        this.bulkStatus.remaining = Math.max(
          0,
          this.bulkStatus.total - this.bulkStatus.completed - this.bulkStatus.failed,
        );
      },
    };
    try {
      const prepared = await this.prepareBulkSubjects(subjects, signal);
      this.bulkStatus.completed += prepared.catalogCompleted;
      this.bulkStatus.remaining = Math.max(
        0,
        this.bulkStatus.total - this.bulkStatus.completed - this.bulkStatus.failed,
      );
      if (!signal.aborted) {
        await this.runSubjects(prepared.pending, signal, hooks);
      }
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn({ err: message }, "AI bulk catalog prefilter failed; continuing with AI");
        await this.runSubjects(subjects, signal, hooks);
      }
    } finally {
      this.bulkStatus.running = false;
      this.bulkStatus.active = [];
      this.bulkStatus.completedAt = this.now();
      this.bulkAbort = null;
    }
  }

  private async prepareBulkSubjects(
    subjects: OracleCheckSubject[],
    signal: AbortSignal,
  ): Promise<{ pending: OracleCheckSubject[]; catalogCompleted: number }> {
    if (signal.aborted || subjects.length === 0) {
      return { pending: [], catalogCompleted: 0 };
    }
    const lookup = this.opts.catalogLookup ?? lookupDubCatalog;
    const lookupResult = await lookup(subjects, this.opts.catalogFetchImpl, signal);
    const evidence = lookupResult instanceof Map ? lookupResult : lookupResult.evidence;
    const checkedSubjectKeys =
      lookupResult instanceof Map
        ? new Set(subjects.map((subject) => subject.subjectKey))
        : lookupResult.checkedSubjectKeys;
    if (!(lookupResult instanceof Map) && lookupResult.failures.length > 0) {
      this.log.warn(
        {
          failedBatches: lookupResult.failures.length,
          failedSubjects: lookupResult.failures.reduce(
            (total, failure) => total + failure.subjectKeys.length,
            0,
          ),
          errors: lookupResult.failures.map((failure) => failure.error),
        },
        "dub catalog lookup partially failed; uncached subjects continue without catalog evidence",
      );
    }
    const pending: OracleCheckSubject[] = [];
    let catalogCompleted = 0;
    for (const subject of subjects) {
      const match = evidence.get(subject.subjectKey);
      if (!match) {
        if (!checkedSubjectKeys.has(subject.subjectKey)) {
          pending.push(subject);
          continue;
        }
        this.db
          .insert(dubCatalogEvidence)
          .values({
            subjectKey: subject.subjectKey,
            source: CATALOG_NO_MATCH_SOURCE,
            sourceId: "",
            url: WIKIDATA_QUERY_URL,
            checkedAt: this.now(),
          })
          .onConflictDoUpdate({
            target: dubCatalogEvidence.subjectKey,
            set: {
              source: CATALOG_NO_MATCH_SOURCE,
              sourceId: "",
              url: WIKIDATA_QUERY_URL,
              checkedAt: this.now(),
            },
          })
          .run();
        pending.push(subject);
        continue;
      }
      this.db
        .insert(dubCatalogEvidence)
        .values({
          subjectKey: subject.subjectKey,
          source: match.source,
          sourceId: match.sourceId,
          url: match.url,
          checkedAt: this.now(),
        })
        .onConflictDoUpdate({
          target: dubCatalogEvidence.subjectKey,
          set: {
            source: match.source,
            sourceId: match.sourceId,
            url: match.url,
            checkedAt: this.now(),
          },
        })
        .run();
      if (subject.subjectKind === "movie") {
        this.storeCatalogMovieVerdict(subject, match);
        catalogCompleted += 1;
      } else {
        pending.push({ ...subject, catalogEvidence: match });
      }
    }
    return { pending, catalogCompleted };
  }

  private storeCatalogMovieVerdict(
    subject: OracleCheckSubject,
    evidence: DubCatalogEvidence,
  ): AiVerdictRow {
    const now = this.now();
    const inserted = this.db
      .insert(aiVerdicts)
      .values({
        subjectKind: "movie",
        subjectKey: subject.subjectKey,
        title: subject.title,
        year: subject.year,
        externalIds: subject.externalIds,
        verdict: "exists",
        confidence: 1,
        germanTitle: null,
        perSeason: null,
        evidence: [`Deutsche Synchronkartei catalog entry via Wikidata: ${evidence.url}`],
        expectedAvailability: null,
        provider: "wikidata",
        model: "P3844",
        promptVersion: "dub-catalog-v1",
        checkedAt: now,
        recheckAfter: now + this.settings.get().aiExistsRetryDays * DAY_MS,
        supersededBy: null,
      })
      .returning()
      .get();
    this.db
      .update(aiVerdicts)
      .set({ supersededBy: inserted.id })
      .where(
        and(
          eq(aiVerdicts.subjectKey, subject.subjectKey),
          isNull(aiVerdicts.supersededBy),
          ne(aiVerdicts.id, inserted.id),
        ),
      )
      .run();
    this.onVerdict?.(inserted);
    this.bus.emit("ai.check.completed", {
      subjectKey: subject.subjectKey,
      title: subject.title,
      verdictId: inserted.id,
      verdict: "exists",
      confidence: 1,
      source: "wikidata",
    });
    return inserted;
  }

  private runTrackedCheck(
    subject: OracleCheckSubject,
    attemptId: number,
    signal?: AbortSignal,
  ): Promise<AiVerdictRow> {
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const task = this.performTrackedCheck(subject, attemptId, combined);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  private async performTrackedCheck(
    subject: OracleCheckSubject,
    attemptId: number,
    signal?: AbortSignal,
  ): Promise<AiVerdictRow> {
    try {
      const verdict = await this.runCheck(subject, signal);
      this.finishAttempt(attemptId, "succeeded");
      return verdict;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishAttempt(attemptId, signal?.aborted ? "cancelled" : "failed", message);
      throw error;
    }
  }

  private async runCheck(subject: OracleCheckSubject, signal?: AbortSignal): Promise<AiVerdictRow> {
    signal?.throwIfAborted();
    const settings = this.settings.get();
    const provider = settings.aiProvider as ProviderId;
    this.bus.emit("ai.check.started", {
      subjectKey: subject.subjectKey,
      subjectKind: subject.subjectKind,
      title: subject.title,
    });
    const session = buildDubCheckSession(
      {
        kind: subject.subjectKind,
        title: subject.title,
        year: subject.year,
        originalLanguage: subject.originalLanguage,
        externalIds: subject.externalIds,
        seasons: subject.seasons,
        confirmedGermanSeasons: subject.confirmedGermanSeasons,
        catalogEvidence: subject.catalogEvidence
          ? { source: subject.catalogEvidence.source, url: subject.catalogEvidence.url }
          : undefined,
      },
      {
        searxngUrl: this.opts.searxngUrl,
        fetchImpl: this.opts.fetchImpl,
        lookupFn: this.opts.lookupFn,
      },
    );
    let result: Awaited<ReturnType<PiRunner>>;
    try {
      result = await this.runner({
        system: session.system,
        prompt: session.prompt,
        tools: session.tools,
        terminatingTool: session.terminatingTool,
        provider,
        model: settings.aiModel,
        signal,
        onEvent: (event) =>
          this.log.debug({ subjectKey: subject.subjectKey, event }, "dub oracle step"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bus.emit("ai.check.completed", { subjectKey: subject.subjectKey, error: message });
      throw error;
    }

    signal?.throwIfAborted();
    if (!session.fetchSucceeded()) {
      const error = new Error(
        "Dub oracle returned no successfully fetched web source; verdict was discarded.",
      );
      this.bus.emit("ai.check.completed", {
        subjectKey: subject.subjectKey,
        error: error.message,
      });
      throw error;
    }

    const rawVerdict = session.getVerdict();
    if (!rawVerdict) {
      const error = new Error("Dub oracle returned no structured verdict; response was discarded.");
      this.bus.emit("ai.check.completed", {
        subjectKey: subject.subjectKey,
        error: error.message,
      });
      throw error;
    }

    let final = finalizeDubVerdict(rawVerdict, true);
    const discard = (message: string): never => {
      const error = new Error(message);
      this.bus.emit("ai.check.completed", {
        subjectKey: subject.subjectKey,
        error: error.message,
      });
      throw error;
    };
    if (subject.subjectKind === "series" && subject.seasons?.length) {
      const requested = [...subject.seasons].sort((a, b) => a - b);
      const reported = (final.perSeason ?? []).map((entry) => entry.season).sort((a, b) => a - b);
      const exactCoverage =
        requested.length === reported.length &&
        requested.every((season, index) => season === reported[index]);
      if (!exactCoverage) {
        discard(
          `Dub oracle returned invalid season coverage; expected exactly [${requested.join(", ")}], received [${reported.join(", ")}]. Verdict was discarded.`,
        );
      }
    }
    const titlePageHasGermanAudio = session.titlePageHasGermanAudio();
    const titlePageShowsGermanProduction = session.titlePageShowsGermanProduction();
    const localizedGermanSeasonReleases = session.localizedGermanSeasonReleases();
    const officialGermanSeasonReleases = session.officialGermanSeasonReleases();
    const originalOnlySeasonReleases = session.originalOnlySeasonReleases();
    if (subject.subjectKind === "movie" && titlePageHasGermanAudio) {
      final = {
        ...final,
        verdict: "exists",
        confidence: 1,
        perSeason: null,
        evidence: ["Deterministic validation: a fetched exact-title Audio section lists German."],
        expectedAvailability: null,
        recheckAfterDays: settings.aiExistsRetryDays,
      };
    } else if (titlePageShowsGermanProduction) {
      final = {
        ...final,
        verdict: "exists",
        confidence: 1,
        perSeason:
          subject.subjectKind === "series" && subject.seasons?.length
            ? subject.seasons.map((season) => ({
                season,
                verdict: "exists" as const,
                confidence: 1,
                note: "German production; no language replacement is needed.",
                evidence: [
                  "Deterministic validation: a fetched exact-title page identifies a German country of origin.",
                ],
                expectedAvailability: null,
                recheckAfterDays: settings.aiExistsRetryDays,
              }))
            : null,
        evidence: [
          "Deterministic validation: a fetched exact-title page identifies a German country of origin.",
        ],
        expectedAvailability: null,
        recheckAfterDays: settings.aiExistsRetryDays,
      };
    }
    if (
      subject.subjectKind === "series" &&
      localizedGermanSeasonReleases.length > 0 &&
      final.perSeason
    ) {
      const releases = new Map(
        localizedGermanSeasonReleases.map((release) => [release.season, release.url]),
      );
      final = {
        ...final,
        perSeason: final.perSeason.map((entry) => {
          const url = releases.get(entry.season);
          if (!url) return entry;
          return {
            ...entry,
            verdict: "exists" as const,
            confidence: 1,
            note: "Exact season guide documents a localized German broadcast.",
            evidence: [
              `Deterministic validation: localized German episode titles and a German premiere are documented for this exact season: ${url}`,
            ],
            expectedAvailability: null,
            recheckAfterDays: settings.aiExistsRetryDays,
          };
        }),
      };
    }
    if (
      subject.subjectKind === "series" &&
      originalOnlySeasonReleases.length > 0 &&
      final.perSeason
    ) {
      const releases = new Map(
        originalOnlySeasonReleases.map((release) => [release.season, release.url]),
      );
      final = {
        ...final,
        perSeason: final.perSeason.map((entry) => {
          const url = releases.get(entry.season);
          if (!url) return entry;
          return {
            ...entry,
            verdict: "unlikely" as const,
            confidence: 1,
            note: "Exact season evidence identifies the German release as OmU, not dubbed.",
            evidence: [
              `Deterministic validation: the exact season page identifies the German release as OmU: ${url}`,
            ],
            expectedAvailability: null,
            recheckAfterDays: settings.aiUnlikelyRetryDays,
          };
        }),
      };
    }
    if (subject.subjectKind === "series" && final.perSeason) {
      const independentlyConfirmedSeasons = new Set([
        ...(subject.confirmedGermanSeasons ?? []),
        ...localizedGermanSeasonReleases.map((release) => release.season),
        ...officialGermanSeasonReleases.map((release) => release.season),
      ]);
      let rejectedUnverifiedPositive = false;
      final = {
        ...final,
        perSeason: final.perSeason.map((entry) => {
          if (
            entry.verdict !== "exists" ||
            titlePageShowsGermanProduction ||
            independentlyConfirmedSeasons.has(entry.season)
          ) {
            return entry;
          }
          rejectedUnverifiedPositive = true;
          return {
            ...entry,
            verdict: "unknown" as const,
            confidence: Math.min(entry.confidence, 0.6),
            note: "No independent season-specific source confirms the claimed German dub; aggregator-only positive evidence is insufficient.",
            evidence: [
              "Deterministic validation: no downloaded German episode, localized German season broadcast, or exact season-specific non-aggregator dub source was fetched.",
            ],
            expectedAvailability: null,
            recheckAfterDays: 7,
          };
        }),
        evidence: rejectedUnverifiedPositive
          ? [
              ...final.evidence,
              "Deterministic validation rejected one or more positive seasons without independent season-specific proof.",
            ]
          : final.evidence,
      };
    }
    if (subject.subjectKind === "movie" && final.verdict !== "exists" && titlePageHasGermanAudio) {
      discard(
        "Dub oracle returned a non-existing verdict although a fetched exact-title Audio section lists German. Verdict was discarded.",
      );
    }
    const now = this.now();
    const evidence = [
      ...(subject.catalogEvidence
        ? [`Deutsche Synchronkartei catalog entry via Wikidata: ${subject.catalogEvidence.url}`]
        : []),
      ...session.fetchedUrls().map((url) => `Fetched web source: ${url}`),
      ...final.evidence,
    ];
    const confirmedSeriesExists =
      subject.subjectKind === "series" &&
      (Boolean(subject.catalogEvidence) || Boolean(subject.confirmedGermanSeasons?.length));
    let perSeason: AiSeasonVerdict[] | null =
      subject.subjectKind === "series" && subject.seasons?.length
        ? subject.seasons.map((season) => {
            const reported = final.perSeason?.find((entry) => entry.season === season);
            if (!reported) throw new Error(`validated season ${season} is missing`);
            const { recheckAfterDays, ...seasonVerdict } = reported;
            const effectiveRecheckDays =
              reported.verdict === "unlikely"
                ? settings.aiUnlikelyRetryDays
                : reported.verdict === "exists"
                  ? settings.aiExistsRetryDays
                  : recheckAfterDays;
            return {
              ...seasonVerdict,
              checkedAt: now,
              recheckAfter: now + effectiveRecheckDays * DAY_MS,
            };
          })
        : null;
    if (perSeason) {
      const refreshed = new Set(perSeason.map((entry) => entry.season));
      const previous = this.db
        .select()
        .from(aiVerdicts)
        .where(and(eq(aiVerdicts.subjectKey, subject.subjectKey), isNull(aiVerdicts.supersededBy)))
        .all();
      const retained = new Map<number, AiSeasonVerdict>();
      for (const row of previous) {
        for (const entry of row.perSeason ?? []) {
          if (!refreshed.has(entry.season) && (entry.recheckAfter ?? row.recheckAfter) > now) {
            retained.set(entry.season, {
              ...entry,
              checkedAt: entry.checkedAt ?? row.checkedAt,
              recheckAfter: entry.recheckAfter ?? row.recheckAfter,
            });
          }
        }
      }
      perSeason = [...perSeason, ...retained.values()].sort((a, b) => a.season - b.season);
    }
    const seasonVerdicts = perSeason?.map((entry) => entry.verdict) ?? [];
    const derivedSeriesVerdict = seasonVerdicts.includes("exists")
      ? "exists"
      : seasonVerdicts.includes("announced")
        ? "announced"
        : seasonVerdicts.length > 0 && seasonVerdicts.every((verdict) => verdict === "unlikely")
          ? "unlikely"
          : "unknown";
    const overallVerdict = confirmedSeriesExists
      ? "exists"
      : subject.subjectKind === "series" && perSeason?.length
        ? derivedSeriesVerdict
        : final.verdict;
    const overallConfidence = confirmedSeriesExists
      ? 1
      : subject.subjectKind === "series" && perSeason?.length
        ? Math.min(...perSeason.map((entry) => entry.confidence ?? final.confidence))
        : final.confidence;
    const recheckDays =
      overallVerdict === "unlikely"
        ? settings.aiUnlikelyRetryDays
        : overallVerdict === "exists"
          ? settings.aiExistsRetryDays
          : final.recheckAfterDays;
    const inserted = this.db.transaction((tx) => {
      const inserted = tx
        .insert(aiVerdicts)
        .values({
          subjectKind: subject.subjectKind,
          subjectKey: subject.subjectKey,
          title: subject.title,
          year: subject.year,
          externalIds: subject.externalIds,
          verdict: overallVerdict,
          confidence: overallConfidence,
          germanTitle: final.germanTitle,
          perSeason,
          evidence,
          expectedAvailability: final.expectedAvailability,
          provider: result.provider,
          model: result.model,
          promptVersion: PROMPT_VERSION,
          checkedAt: now,
          recheckAfter: perSeason?.length
            ? Math.min(
                ...perSeason.map((entry) => entry.recheckAfter ?? now + recheckDays * DAY_MS),
              )
            : now + recheckDays * DAY_MS,
          supersededBy: null,
        })
        .returning()
        .get();
      tx.update(aiVerdicts)
        .set({ supersededBy: inserted.id })
        .where(
          and(
            eq(aiVerdicts.subjectKey, subject.subjectKey),
            isNull(aiVerdicts.supersededBy),
            ne(aiVerdicts.id, inserted.id),
          ),
        )
        .run();
      return inserted;
    });

    this.logActivity(
      "info",
      `Dub oracle: ${subject.title} → ${overallVerdict} (${overallConfidence.toFixed(2)})`,
      {
        subjectKey: subject.subjectKey,
        verdictId: inserted.id,
        verdict: overallVerdict,
        confidence: overallConfidence,
        provider: result.provider,
        model: result.model,
      },
    );
    this.bus.emit("ai.check.completed", {
      subjectKey: subject.subjectKey,
      title: subject.title,
      verdictId: inserted.id,
      verdict: overallVerdict,
      confidence: overallConfidence,
    });
    this.onVerdict?.(inserted);
    return inserted;
  }

  private loadSubject(subjectKey: string): OracleCheckSubject | null {
    const match = subjectKey.match(/^(sonarr|radarr):(\d+)$/);
    if (!match) return null;
    const source = match[1] as ArrSource;
    const id = Number(match[2]);
    if (source === "sonarr") {
      const row = this.db.select().from(series).where(eq(series.id, id)).get();
      if (!row) return null;
      const seasonRows = this.db
        .selectDistinct({ seasonNumber: episodes.seasonNumber })
        .from(episodes)
        .where(eq(episodes.seriesId, id))
        .all();
      const seasons = seasonRows
        .map((entry) => entry.seasonNumber)
        .filter((season) => season > 0)
        .sort((a, b) => a - b);
      const confirmedGermanSeasons = this.db
        .selectDistinct({ seasonNumber: episodes.seasonNumber })
        .from(episodes)
        .where(and(eq(episodes.seriesId, id), eq(episodes.hasGerman, true)))
        .all()
        .map((entry) => entry.seasonNumber)
        .filter((season) => season > 0)
        .sort((a, b) => a - b);
      return {
        subjectKey,
        subjectKind: "series",
        source,
        subjectId: id,
        title: row.title,
        year: row.year,
        originalLanguage: row.originalLanguage,
        externalIds: { tvdbId: row.tvdbId ?? undefined, imdbId: row.imdbId ?? undefined },
        seasons: seasons.length ? seasons : undefined,
        confirmedGermanSeasons: confirmedGermanSeasons.length ? confirmedGermanSeasons : undefined,
        catalogEvidence: this.catalogEvidenceFor(subjectKey) ?? undefined,
      };
    }
    const row = this.db.select().from(movies).where(eq(movies.id, id)).get();
    if (!row) return null;
    return {
      subjectKey,
      subjectKind: "movie",
      source,
      subjectId: id,
      title: row.title,
      year: row.year,
      originalLanguage: row.originalLanguage,
      externalIds: { tmdbId: row.tmdbId ?? undefined, imdbId: row.imdbId ?? undefined },
      catalogEvidence: this.catalogEvidenceFor(subjectKey) ?? undefined,
    };
  }

  /** Subject-level target_mode overrides keyed `${source}:${kind}:${id}`. */
  private subjectOverrides(): Map<string, string | null> {
    const rows = this.db
      .select({
        source: itemOverrides.source,
        subjectKind: itemOverrides.subjectKind,
        subjectId: itemOverrides.subjectId,
        targetMode: itemOverrides.targetMode,
      })
      .from(itemOverrides)
      .where(eq(itemOverrides.seasonNumber, -1))
      .all();
    return new Map(
      rows.map((row) => [`${row.source}:${row.subjectKind}:${row.subjectId}`, row.targetMode]),
    );
  }

  /**
   * Active verdict coverage. Modern series verdicts cover their explicit
   * seasons; movies and legacy series verdicts without per-season detail cover
   * the complete subject.
   */
  private validVerdictScopes(now: number): { subjects: Set<string>; seasons: Set<string> } {
    const rows = this.db
      .select({
        subjectKey: aiVerdicts.subjectKey,
        subjectKind: aiVerdicts.subjectKind,
        perSeason: aiVerdicts.perSeason,
        recheckAfter: aiVerdicts.recheckAfter,
      })
      .from(aiVerdicts)
      .where(isNull(aiVerdicts.supersededBy))
      .all();
    const subjects = new Set<string>();
    const seasons = new Set<string>();
    for (const row of rows) {
      if (row.subjectKind === "series" && row.perSeason?.length) {
        for (const entry of row.perSeason) {
          if ((entry.recheckAfter ?? row.recheckAfter) > now) {
            seasons.add(`${row.subjectKey}:${entry.season}`);
          }
        }
      } else {
        if (row.recheckAfter > now) subjects.add(row.subjectKey);
      }
    }
    return { subjects, seasons };
  }

  private catalogEvidenceFor(subjectKey: string): DubCatalogEvidence | null {
    const row = this.db
      .select()
      .from(dubCatalogEvidence)
      .where(eq(dubCatalogEvidence.subjectKey, subjectKey))
      .get();
    if (!row || row.source !== "wikidata-synchronkartei") return null;
    return {
      subjectKey,
      source: "wikidata-synchronkartei",
      sourceId: row.sourceId,
      url: row.url,
    };
  }

  private catalogCheckDue(subjectKey: string): boolean {
    const row = this.db
      .select({ checkedAt: dubCatalogEvidence.checkedAt })
      .from(dubCatalogEvidence)
      .where(eq(dubCatalogEvidence.subjectKey, subjectKey))
      .get();
    return !row || row.checkedAt <= this.now() - CATALOG_RECHECK_MS;
  }

  private logActivity(level: "info" | "warn", message: string, data: Record<string, unknown>) {
    this.db
      .insert(activityLog)
      .values({ at: this.now(), level, type: "ai.check", message, data })
      .run();
  }
}
