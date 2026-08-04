import { and, count, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ArrSource } from "../../shared/domain.js";
import type { SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  itemOverrides,
  movies,
  series,
} from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
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
/** Sentinel for manual invalidation: non-null "superseded" without a successor row. */
export const INVALIDATED_SENTINEL = 0;

/** States that make a subject a candidate for an oracle check. */
const HUNTABLE_STATES = ["missing", "non_german", "exhausted"] as const;

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
};

export class OracleService {
  /** Set by the orchestrator to huntEngine.applyVerdict at wire time. */
  onVerdict?: (row: AiVerdictRow) => void;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly postSearchGraceMs: number;
  private readonly refreshAutomaticState: () => Promise<void>;
  private readonly automaticChecksInFlight = new Set<string>();
  private automaticCheckChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly runner: PiRunner,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly opts: OracleServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.postSearchGraceMs = opts.postSearchGraceMs ?? DEFAULT_POST_SEARCH_GRACE_MS;
    this.refreshAutomaticState = opts.refreshAutomaticState ?? (async () => undefined);
  }

  /**
   * Nightly batch: pick due subjects per trigger policy, capped per calendar
   * day, and run checks sequentially. Fully skipped in dry-run and when the
   * provider is off — hunting never depends on AI.
   */
  async runDailyBatch(signal?: AbortSignal): Promise<OracleBatchResult> {
    const settings = this.settings.get();
    if (settings.aiProvider === "off") {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "provider_off" };
    }
    if (settings.dryRun) {
      this.log.info("dub oracle: skipped (dry-run)");
      return { selected: 0, checked: 0, failed: 0, skippedReason: "dry_run" };
    }
    const remaining = settings.aiMaxChecksPerDay - this.countCheckedToday();
    if (remaining <= 0) {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "daily_cap" };
    }
    const subjects = this.selectSubjects().slice(0, remaining);
    let checked = 0;
    let failed = 0;
    for (const subject of subjects) {
      if (signal?.aborted) break;
      try {
        await this.runCheck(subject, signal);
        checked += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn({ subjectKey: subject.subjectKey, err: message }, "dub oracle check failed");
        this.logActivity("warn", `Dub oracle check failed: ${subject.title}`, {
          subjectKey: subject.subjectKey,
          error: message,
        });
        if (signal?.aborted) break;
      }
    }
    return { selected: subjects.length, checked, failed };
  }

  /**
   * Trigger policy (exported for tests): subjects (series/movies, grouped)
   * with no valid verdict AND either an exhausted hunt item or enough failed
   * searches. German-original and original_ok/ignore subjects are never
   * checked. A season with any known German file is also excluded: that file
   * is stronger evidence than an AI lookup that the season dub exists.
   */
  selectSubjects(): OracleSubject[] {
    const settings = this.settings.get();
    const now = this.now();
    const overrides = this.subjectOverrides();
    const validVerdicts = this.validVerdictScopes(now);
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
      if (row.state !== "exhausted" && row.searchCount < settings.aiMinSearchesBeforeCheck) {
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
      if (validVerdicts.subjects.has(`radarr:${row.movieId}`)) continue;
      if (row.state !== "exhausted" && row.searchCount < settings.aiMinSearchesBeforeCheck) {
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
      const lang = subject.originalLanguage?.trim().toLowerCase();
      if (lang && GERMAN_ORIGINAL.has(lang)) continue;
      const override = overrides.get(
        `${subject.source}:${subject.subjectKind}:${subject.subjectId}`,
      );
      if (override === "original_ok" || override === "ignore") continue;
      selected.push({
        ...subject,
        seasons: agg.seasons.size ? [...agg.seasons].sort((a, b) => a - b) : undefined,
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
      const remainingGraceMs = graceEndsAt - this.now();
      if (remainingGraceMs > 0) await this.sleep(remainingGraceMs);
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
    let remaining = settings.aiMaxChecksPerDay - this.countCheckedToday();
    if (remaining <= 0) {
      return { selected: 0, checked: 0, failed: 0, skippedReason: "daily_cap" };
    }
    const requested = new Set(subjectKeys);
    const subjects = this.selectSubjects().filter(
      (subject) =>
        requested.has(subject.subjectKey) && !this.automaticChecksInFlight.has(subject.subjectKey),
    );
    let checked = 0;
    let failed = 0;
    for (const subject of subjects) {
      if (remaining <= 0) break;
      remaining -= 1;
      this.automaticChecksInFlight.add(subject.subjectKey);
      try {
        await this.runCheck(subject);
        checked += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(
          { subjectKey: subject.subjectKey, err: message },
          "automatic dub oracle check failed",
        );
        this.logActivity("warn", `Dub oracle check failed: ${subject.title}`, {
          subjectKey: subject.subjectKey,
          error: message,
        });
      } finally {
        this.automaticChecksInFlight.delete(subject.subjectKey);
      }
    }
    return { selected: subjects.length, checked, failed };
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
    if (!force && this.countCheckedToday() >= settings.aiMaxChecksPerDay) {
      throw new Error("Daily AI check budget exhausted — use force to override.");
    }
    const subject = this.loadSubject(subjectKey);
    if (!subject) throw new Error(`Unknown oracle subject: ${subjectKey}`);
    this.invalidateVerdicts(subjectKey);
    return await this.runCheck(subject);
  }

  /** Mark all active verdict rows for a subject invalid without a successor. */
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
      .from(aiVerdicts)
      .where(and(gte(aiVerdicts.checkedAt, dayStart), lt(aiVerdicts.checkedAt, dayStart + DAY_MS)))
      .get();
    return row?.n ?? 0;
  }

  private async runCheck(subject: OracleCheckSubject, signal?: AbortSignal): Promise<AiVerdictRow> {
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

    const final = finalizeDubVerdict(session.getVerdict(), session.fetchSucceeded());
    const now = this.now();
    const perSeason =
      subject.subjectKind === "series" && subject.seasons?.length
        ? subject.seasons.map((season) => {
            const reported = final.perSeason?.find((entry) => entry.season === season);
            return reported ?? { season, verdict: final.verdict };
          })
        : final.perSeason;
    const recheckDays =
      final.verdict === "unlikely"
        ? settings.aiUnlikelyRetryDays
        : final.verdict === "exists"
          ? settings.aiExistsRetryDays
          : final.recheckAfterDays;
    const inserted = this.db
      .insert(aiVerdicts)
      .values({
        subjectKind: subject.subjectKind,
        subjectKey: subject.subjectKey,
        title: subject.title,
        year: subject.year,
        externalIds: subject.externalIds,
        verdict: final.verdict,
        confidence: final.confidence,
        germanTitle: final.germanTitle,
        perSeason,
        evidence: final.evidence,
        expectedAvailability: final.expectedAvailability,
        provider: result.provider,
        model: result.model,
        promptVersion: PROMPT_VERSION,
        checkedAt: now,
        recheckAfter: now + recheckDays * DAY_MS,
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

    this.logActivity(
      "info",
      `Dub oracle: ${subject.title} → ${final.verdict} (${final.confidence.toFixed(2)})`,
      {
        subjectKey: subject.subjectKey,
        verdictId: inserted.id,
        verdict: final.verdict,
        confidence: final.confidence,
        provider: result.provider,
        model: result.model,
      },
    );
    this.bus.emit("ai.check.completed", {
      subjectKey: subject.subjectKey,
      title: subject.title,
      verdictId: inserted.id,
      verdict: final.verdict,
      confidence: final.confidence,
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
      if (row.recheckAfter <= now) continue;
      if (row.subjectKind === "series" && row.perSeason?.length) {
        for (const entry of row.perSeason) seasons.add(`${row.subjectKey}:${entry.season}`);
      } else {
        subjects.add(row.subjectKey);
      }
    }
    return { subjects, seasons };
  }

  private logActivity(level: "info" | "warn", message: string, data: Record<string, unknown>) {
    this.db
      .insert(activityLog)
      .values({ at: this.now(), level, type: "ai.check", message, data })
      .run();
  }
}
