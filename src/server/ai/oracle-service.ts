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
  skippedReason?: "provider_off" | "dry_run" | "daily_cap";
};

export type OracleServiceOptions = {
  now?: () => number;
  searxngUrl?: string;
  /** Injected into the fetch_url tool (tests use fakes; prod omits). */
  fetchImpl?: typeof fetch;
  lookupFn?: DnsLookupFn;
};

function monthsAgo(now: number, months: number): number {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
}

function movieReleaseAt(movie: {
  digitalRelease: number | null;
  physicalRelease: number | null;
  year: number | null;
}): number | null {
  if (movie.digitalRelease != null && movie.physicalRelease != null) {
    return Math.min(movie.digitalRelease, movie.physicalRelease);
  }
  // No release dates mirrored: assume released at the end of its year.
  return (
    movie.digitalRelease ??
    movie.physicalRelease ??
    (movie.year != null ? Date.UTC(movie.year, 11, 31) : null)
  );
}

export class OracleService {
  /** Set by the orchestrator to huntEngine.applyVerdict at wire time. */
  onVerdict?: (row: AiVerdictRow) => void;

  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly runner: PiRunner,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly opts: OracleServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
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
   * with no valid verdict AND either an exhausted hunt item or
   * (max searchCount >= aiMinSearchesBeforeCheck AND released more than
   * aiMinAgeMonths ago). German-original and original_ok/ignore subjects are
   * never checked.
   */
  selectSubjects(): OracleSubject[] {
    const settings = this.settings.get();
    const now = this.now();
    const ageCutoff = monthsAgo(now, settings.aiMinAgeMonths);
    const overrides = this.subjectOverrides();
    const validVerdicts = this.validVerdictKeys(now);

    type Agg = {
      subject: OracleCheckSubject;
      exhausted: boolean;
      maxSearchCount: number;
      oldestReleaseAt: number | null;
      seasons: Set<number>;
    };
    const aggregates = new Map<string, Agg>();

    const addRow = (
      subject: OracleCheckSubject,
      row: { state: string; searchCount: number },
      releaseAt: number | null,
      season: number | null,
    ) => {
      let agg = aggregates.get(subject.subjectKey);
      if (!agg) {
        agg = {
          subject,
          exhausted: false,
          maxSearchCount: 0,
          oldestReleaseAt: null,
          seasons: new Set(),
        };
        aggregates.set(subject.subjectKey, agg);
      }
      if (row.state === "exhausted") agg.exhausted = true;
      agg.maxSearchCount = Math.max(agg.maxSearchCount, row.searchCount);
      if (releaseAt != null) {
        agg.oldestReleaseAt =
          agg.oldestReleaseAt == null ? releaseAt : Math.min(agg.oldestReleaseAt, releaseAt);
      }
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
        ),
      )
      .all();
    for (const row of seriesRows) {
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
        row.airDateUtc,
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
        ),
      )
      .all();
    for (const row of movieRows) {
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
        movieReleaseAt(row),
        null,
      );
    }

    const selected: OracleSubject[] = [];
    for (const agg of aggregates.values()) {
      const { subject } = agg;
      if (validVerdicts.has(subject.subjectKey)) continue;
      const lang = subject.originalLanguage?.trim().toLowerCase();
      if (lang && GERMAN_ORIGINAL.has(lang)) continue;
      const override = overrides.get(
        `${subject.source}:${subject.subjectKind}:${subject.subjectId}`,
      );
      if (override === "original_ok" || override === "ignore") continue;
      const aged =
        agg.maxSearchCount >= settings.aiMinSearchesBeforeCheck &&
        agg.oldestReleaseAt != null &&
        agg.oldestReleaseAt <= ageCutoff;
      if (!agg.exhausted && !aged) continue;
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
        perSeason: final.perSeason,
        evidence: final.evidence,
        expectedAvailability: final.expectedAvailability,
        provider: result.provider,
        model: result.model,
        promptVersion: PROMPT_VERSION,
        checkedAt: now,
        recheckAfter: now + final.recheckAfterDays * DAY_MS,
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

  /** Subject keys with an active (non-superseded, not yet due) verdict. */
  private validVerdictKeys(now: number): Set<string> {
    const rows = this.db
      .select({ subjectKey: aiVerdicts.subjectKey, recheckAfter: aiVerdicts.recheckAfter })
      .from(aiVerdicts)
      .where(isNull(aiVerdicts.supersededBy))
      .all();
    return new Set(rows.filter((row) => row.recheckAfter > now).map((row) => row.subjectKey));
  }

  private logActivity(level: "info" | "warn", message: string, data: Record<string, unknown>) {
    this.db
      .insert(activityLog)
      .values({ at: this.now(), level, type: "ai.check", message, data })
      .run();
  }
}
