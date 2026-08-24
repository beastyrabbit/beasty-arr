import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AiVerdictSummary,
  EpisodeItem,
  ItemHistoryEntry,
  LibrarySort,
  MovieDetail,
  MovieListItem,
  MovieListResponse,
  OverrideInfo,
  PauseInfo,
  SearchResponse,
  SearchResult,
  SeasonItem,
  SeriesDetail,
  SeriesListItem,
  SeriesListResponse,
  SortOrder,
  StateCounts,
} from "../../../shared/api-types.js";
import { LIBRARY_SORTS } from "../../../shared/api-types.js";
import { HUNT_STATES, type HuntState } from "../../../shared/domain.js";
import type { AppContext } from "../../context.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  itemOverrides,
  movies,
  searchAttempts,
  series,
} from "../../db/schema.js";
import {
  aggregateSeriesState,
  consideredCount,
  emptyStateCounts,
  notFound,
  pageOffset,
  parse,
} from "./util.js";

type VerdictRow = typeof aiVerdicts.$inferSelect;
type HsRow = typeof huntState.$inferSelect;

const IN_FLIGHT_STATUSES = ["dispatched", "queued", "started"] as const;
const HISTORY_LIMIT = 60;
const ATTEMPT_SCAN_LIMIT = 400;

// ============ shared loaders ============

function inFlightHuntStateIds(ctx: AppContext): Set<number> {
  const rows = ctx.db
    .select({ targetIds: searchAttempts.targetIds })
    .from(searchAttempts)
    .where(
      and(
        isNull(searchAttempts.completedAt),
        inArray(searchAttempts.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .all();
  const set = new Set<number>();
  for (const r of rows) for (const id of r.targetIds) set.add(id);
  return set;
}

function loadActiveVerdicts(ctx: AppContext): Map<string, VerdictRow> {
  const rows = ctx.db.select().from(aiVerdicts).where(isNull(aiVerdicts.supersededBy)).all();
  const out = new Map<string, VerdictRow>();
  for (const r of rows) {
    const cur = out.get(r.subjectKey);
    if (!cur || r.checkedAt > cur.checkedAt) out.set(r.subjectKey, r);
  }
  return out;
}

function verdictSummary(row: VerdictRow | undefined): AiVerdictSummary | null {
  if (!row) return null;
  return {
    id: row.id,
    verdict: row.verdict,
    confidence: row.confidence,
    checkedAt: row.checkedAt,
    recheckAfter: row.recheckAfter,
    expectedAvailability: row.expectedAvailability,
    evidence: row.evidence,
    germanTitle: row.germanTitle,
    perSeason: row.perSeason,
  };
}

function seriesPause(rows: HsRow[]): PauseInfo {
  const paused = rows.filter((r) => r.userPaused);
  if (paused.length === 0 || paused.length !== rows.length) {
    // Not fully paused: surface the first pause detail only when every relevant row shares it.
    if (paused.length === 0) return { paused: false, since: null, until: null, note: null };
  }
  const first = paused[0];
  return {
    paused: paused.length === rows.length,
    since: null,
    until: first?.userPausedUntil ?? null,
    note: first?.userPausedNote ?? null,
  };
}

function moviePause(row: HsRow): PauseInfo {
  return {
    paused: row.userPaused,
    since: null,
    until: row.userPausedUntil,
    note: row.userPausedNote,
  };
}

function langNames(langs: { name: string }[] | null | undefined): string[] {
  return (langs ?? []).map((l) => l.name);
}

// ============ sorting ============

const STATE_SORT_ORDER: HuntState[] = [
  "german",
  "non_german",
  "missing",
  "exhausted",
  "ai_paused",
  "profile_blocked",
  "unreleased",
  "unmonitored",
  "ignored",
];
function stateRank(state: HuntState): number {
  const i = STATE_SORT_ORDER.indexOf(state);
  return i < 0 ? STATE_SORT_ORDER.length : i;
}

function germanRatio(item: { germanEpisodes: number; consideredEpisodes: number }): number {
  return item.consideredEpisodes === 0 ? 0 : item.germanEpisodes / item.consideredEpisodes;
}

// ============ series list ============

type SeriesAccumulator = {
  rows: HsRow[];
  counts: StateCounts;
  lastSearchAt: number | null;
  nextSearchAt: number | null;
  queued: boolean;
  searching: boolean;
};

function buildSeriesItems(ctx: AppContext): SeriesListItem[] {
  const inFlight = inFlightHuntStateIds(ctx);
  const verdicts = loadActiveVerdicts(ctx);
  const seriesRows = ctx.db.select().from(series).all();
  const hs = ctx.db
    .select()
    .from(huntState)
    .where(and(eq(huntState.source, "sonarr"), eq(huntState.targetKind, "episode")))
    .all();

  const bySeriesId = new Map<number, SeriesAccumulator>();
  for (const row of hs) {
    if (row.seriesId == null) continue;
    let acc = bySeriesId.get(row.seriesId);
    if (!acc) {
      acc = {
        rows: [],
        counts: emptyStateCounts(),
        lastSearchAt: null,
        nextSearchAt: null,
        queued: false,
        searching: false,
      };
      bySeriesId.set(row.seriesId, acc);
    }
    acc.rows.push(row);
    acc.counts[row.state] += 1;
    if (row.lastSearchAt != null)
      acc.lastSearchAt = Math.max(acc.lastSearchAt ?? 0, row.lastSearchAt);
    const huntable =
      row.state === "missing" || row.state === "non_german" || row.state === "exhausted";
    if (huntable && !row.userPaused && row.nextEligibleAt != null) {
      acc.nextSearchAt =
        acc.nextSearchAt == null
          ? row.nextEligibleAt
          : Math.min(acc.nextSearchAt, row.nextEligibleAt);
    }
    if (row.manualPriority > 0) acc.queued = true;
    if (inFlight.has(row.id)) acc.searching = true;
  }

  return seriesRows.map((s) => {
    const acc = bySeriesId.get(s.id);
    const counts = acc?.counts ?? emptyStateCounts();
    return {
      id: s.id,
      title: s.title,
      year: s.year,
      posterUrl: s.posterUrl,
      seriesType: s.seriesType,
      monitored: s.monitored,
      state: aggregateSeriesState(counts),
      episodeCounts: counts,
      germanEpisodes: counts.german,
      consideredEpisodes: consideredCount(counts),
      verdict: verdictSummary(verdicts.get(`sonarr:${s.id}`)),
      pause: seriesPause(acc?.rows ?? []),
      queued: acc?.queued ?? false,
      searching: acc?.searching ?? false,
      lastSearchAt: acc?.lastSearchAt ?? null,
      nextSearchAt: acc?.nextSearchAt ?? null,
      arrUrl: null,
    };
  });
}

// ============ movie list ============

function buildMovieItems(ctx: AppContext): MovieListItem[] {
  const inFlight = inFlightHuntStateIds(ctx);
  const verdicts = loadActiveVerdicts(ctx);
  const movieRows = ctx.db.select().from(movies).all();
  const hsByMovieId = new Map<number, HsRow>();
  for (const row of ctx.db
    .select()
    .from(huntState)
    .where(and(eq(huntState.source, "radarr"), eq(huntState.targetKind, "movie")))
    .all()) {
    hsByMovieId.set(row.targetId, row);
  }

  return movieRows.map((m) => {
    const hsRow = hsByMovieId.get(m.id);
    const state: HuntState =
      hsRow?.state ?? (m.hasFile ? (m.hasGerman ? "german" : "non_german") : "missing");
    return {
      id: m.id,
      title: m.title,
      year: m.year,
      posterUrl: m.posterUrl,
      monitored: m.monitored,
      state,
      hasFile: m.hasFile,
      audioLanguages: langNames(m.fileLanguages),
      quality: m.quality,
      verdict: verdictSummary(verdicts.get(`radarr:${m.id}`)),
      pause: hsRow ? moviePause(hsRow) : { paused: false, since: null, until: null, note: null },
      queued: (hsRow?.manualPriority ?? 0) > 0,
      searching: hsRow ? inFlight.has(hsRow.id) : false,
      lastSearchAt: hsRow?.lastSearchAt ?? null,
      nextSearchAt: hsRow?.nextEligibleAt ?? null,
      arrUrl: null,
    };
  });
}

// ============ query parsing / filtering ============

const listQuerySchema = z.object({
  q: z.string().optional(),
  sort: z.enum(LIBRARY_SORTS).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function extractStates(query: unknown): HuntState[] {
  const raw =
    (query as Record<string, unknown>)["state[]"] ?? (query as Record<string, unknown>).state;
  const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return arr
    .map(String)
    .filter((s): s is HuntState => (HUNT_STATES as readonly string[]).includes(s));
}

function countByState<T extends { state: HuntState }>(items: T[]): StateCounts {
  const out = emptyStateCounts();
  for (const it of items) out[it.state] += 1;
  return out;
}

function sortItems<
  T extends {
    title: string;
    year: number | null;
    state: HuntState;
    lastSearchAt: number | null;
    nextSearchAt: number | null;
    germanEpisodes?: number;
    consideredEpisodes?: number;
  },
>(items: T[], sort: LibrarySort | undefined, order: SortOrder | undefined): void {
  const dir = order === "desc" ? -1 : 1;
  const cmp = (a: T, b: T): number => {
    switch (sort) {
      case "year":
        return (a.year ?? 0) - (b.year ?? 0);
      case "state":
        return stateRank(a.state) - stateRank(b.state);
      case "german":
        return (
          germanRatio({
            germanEpisodes: a.germanEpisodes ?? 0,
            consideredEpisodes: a.consideredEpisodes ?? 0,
          }) -
          germanRatio({
            germanEpisodes: b.germanEpisodes ?? 0,
            consideredEpisodes: b.consideredEpisodes ?? 0,
          })
        );
      case "last_search":
        return (a.lastSearchAt ?? 0) - (b.lastSearchAt ?? 0);
      case "next_search":
        return (
          (a.nextSearchAt ?? Number.POSITIVE_INFINITY) -
          (b.nextSearchAt ?? Number.POSITIVE_INFINITY)
        );
      default:
        return a.title.localeCompare(b.title);
    }
  };
  items.sort((a, b) => dir * cmp(a, b) || a.title.localeCompare(b.title));
}

// ============ detail helpers ============

function loadOverride(
  ctx: AppContext,
  source: "sonarr" | "radarr",
  subjectKind: "series" | "movie",
  subjectId: number,
): OverrideInfo | null {
  const row = ctx.db
    .select()
    .from(itemOverrides)
    .where(
      and(
        eq(itemOverrides.source, source),
        eq(itemOverrides.subjectKind, subjectKind),
        eq(itemOverrides.subjectId, subjectId),
        eq(itemOverrides.seasonNumber, -1),
      ),
    )
    .get();
  if (!row) return null;
  return { targetMode: row.targetMode, dubLagDays: row.dubLagDays, note: row.note };
}

function attemptHistory(
  ctx: AppContext,
  source: "sonarr" | "radarr",
  huntStateIds: Set<number>,
): ItemHistoryEntry[] {
  if (huntStateIds.size === 0) return [];
  const rows = ctx.db
    .select()
    .from(searchAttempts)
    .where(eq(searchAttempts.source, source))
    .orderBy(desc(searchAttempts.createdAt))
    .limit(ATTEMPT_SCAN_LIMIT)
    .all();
  const out: ItemHistoryEntry[] = [];
  for (const a of rows) {
    if (!a.targetIds.some((id) => huntStateIds.has(id))) continue;
    out.push({
      at: a.createdAt,
      kind: "search",
      message: `${a.commandName}${a.targetLabel ? `: ${a.targetLabel}` : ""}${a.result ? ` (${a.result})` : ""}`,
      detail: {
        status: a.status,
        trigger: a.trigger,
        estimatedQueries: a.estimatedQueries,
        dryRun: a.dryRun,
      },
    });
  }
  return out;
}

function activityHistory(ctx: AppContext, whereJson: ReturnType<typeof sql>): ItemHistoryEntry[] {
  const rows = ctx.db
    .select()
    .from(activityLog)
    .where(whereJson)
    .orderBy(desc(activityLog.at))
    .limit(HISTORY_LIMIT)
    .all();
  return rows.map((r) => ({
    at: r.at,
    kind:
      r.type === "ai.check"
        ? ("verdict" as const)
        : r.type === "hunt.win"
          ? ("state" as const)
          : ("state" as const),
    message: r.message,
    detail: r.data ?? undefined,
  }));
}

function verdictHistory(
  ctx: AppContext,
  subjectKey: string,
  seasonNumber?: number,
): ItemHistoryEntry[] {
  return ctx.db
    .select()
    .from(aiVerdicts)
    .where(eq(aiVerdicts.subjectKey, subjectKey))
    .orderBy(desc(aiVerdicts.checkedAt))
    .limit(HISTORY_LIMIT)
    .all()
    .flatMap((verdict) => {
      const seasonVerdict =
        seasonNumber == null
          ? undefined
          : verdict.perSeason?.find((entry) => entry.season === seasonNumber);
      if (seasonNumber != null && verdict.perSeason?.length && !seasonVerdict) return [];
      const value = seasonVerdict?.verdict ?? verdict.verdict;
      return [
        {
          at: verdict.checkedAt,
          kind: "verdict" as const,
          message: `Dub oracle${seasonNumber == null ? "" : ` S${String(seasonNumber).padStart(2, "0")}`}: ${value} (${verdict.confidence.toFixed(2)})`,
          detail: {
            verdictId: verdict.id,
            provider: verdict.provider,
            model: verdict.model,
            promptVersion: verdict.promptVersion,
            recheckAfter: verdict.recheckAfter,
            evidence: verdict.evidence,
            note: seasonVerdict?.note,
            superseded: verdict.supersededBy != null,
          },
        },
      ];
    });
}

function mergeHistory(...parts: ItemHistoryEntry[][]): ItemHistoryEntry[] {
  return parts
    .flat()
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_LIMIT);
}

// ============ routes ============

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/library/series", async (request, reply) => {
    const q = parse(reply, listQuerySchema, request.query);
    if (!q.ok) return;
    const states = extractStates(request.query);
    let items = buildSeriesItems(ctx);
    if (q.data.q) {
      const needle = q.data.q.toLowerCase();
      items = items.filter((it) => it.title.toLowerCase().includes(needle));
    }
    const stateFilterCounts = countByState(items);
    if (states.length > 0) items = items.filter((it) => states.includes(it.state));
    sortItems(items, q.data.sort, q.data.order);
    const total = items.length;
    const paged = items.slice(
      pageOffset(q.data.page, q.data.pageSize),
      pageOffset(q.data.page, q.data.pageSize) + q.data.pageSize,
    );
    const response: SeriesListResponse = {
      items: paged,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
      stateFilterCounts,
    };
    return response;
  });

  app.get("/api/library/movies", async (request, reply) => {
    const q = parse(reply, listQuerySchema, request.query);
    if (!q.ok) return;
    const states = extractStates(request.query);
    let items = buildMovieItems(ctx);
    if (q.data.q) {
      const needle = q.data.q.toLowerCase();
      items = items.filter((it) => it.title.toLowerCase().includes(needle));
    }
    const stateFilterCounts = countByState(items);
    if (states.length > 0) items = items.filter((it) => states.includes(it.state));
    sortItems(items, q.data.sort, q.data.order);
    const total = items.length;
    const paged = items.slice(
      pageOffset(q.data.page, q.data.pageSize),
      pageOffset(q.data.page, q.data.pageSize) + q.data.pageSize,
    );
    const response: MovieListResponse = {
      items: paged,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
      stateFilterCounts,
    };
    return response;
  });

  app.get("/api/library/series/:id", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.coerce.number().int() }), request.params);
    if (!p.ok) return;
    const id = p.data.id;
    const summary = buildSeriesItems(ctx).find((it) => it.id === id);
    const seriesRow = ctx.db.select().from(series).where(eq(series.id, id)).get();
    if (!summary || !seriesRow) return notFound(reply, "series not found");

    const verdicts = loadActiveVerdicts(ctx);
    const verdictRow = verdicts.get(`sonarr:${id}`);
    const inFlight = inFlightHuntStateIds(ctx);

    const epRows = ctx.db.select().from(episodes).where(eq(episodes.seriesId, id)).all();
    const hsRows = ctx.db
      .select()
      .from(huntState)
      .where(
        and(
          eq(huntState.source, "sonarr"),
          eq(huntState.targetKind, "episode"),
          eq(huntState.seriesId, id),
        ),
      )
      .all();
    const hsByEpisodeId = new Map<number, HsRow>();
    for (const row of hsRows) hsByEpisodeId.set(row.targetId, row);

    const seasons = new Map<number, SeasonItem>();
    for (const ep of epRows.sort(
      (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    )) {
      const hs = hsByEpisodeId.get(ep.id);
      const state: HuntState =
        hs?.state ?? (ep.hasFile ? (ep.hasGerman ? "german" : "non_german") : "missing");
      let season = seasons.get(ep.seasonNumber);
      if (!season) {
        season = {
          seasonNumber: ep.seasonNumber,
          monitored: false,
          counts: emptyStateCounts(),
          episodes: [],
          hasGermanEvidence: false,
          releasing: false,
          searchCount: 0,
          lastSearchAt: null,
          nextEligibleAt: null,
          history: [],
          verdictNote:
            verdictRow?.perSeason?.find((s) => s.season === ep.seasonNumber)?.note ?? null,
        };
        seasons.set(ep.seasonNumber, season);
      }
      season.monitored = season.monitored || ep.monitored;
      season.hasGermanEvidence = season.hasGermanEvidence || ep.hasGerman;
      season.releasing =
        season.releasing ||
        (seriesRow.status === "continuing" &&
          ep.airDateUtc != null &&
          ep.airDateUtc >= Date.now() - 28 * 86_400_000);
      season.counts[state] += 1;
      const episodeItem: EpisodeItem = {
        id: ep.id,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        absoluteEpisodeNumber: ep.absoluteEpisodeNumber,
        title: ep.title,
        airDateUtc: ep.airDateUtc,
        monitored: ep.monitored,
        state,
        hasFile: ep.hasFile,
        languages: langNames(ep.fileLanguages),
        quality: ep.quality,
        searchCount: hs?.searchCount ?? 0,
        tier: hs?.tier ?? 0,
        lastSearchAt: hs?.lastSearchAt ?? null,
        nextEligibleAt: hs?.nextEligibleAt ?? null,
        queued: (hs?.manualPriority ?? 0) > 0,
        searching: hs ? inFlight.has(hs.id) : false,
      };
      season.episodes.push(episodeItem);
    }

    for (const season of seasons.values()) {
      const seasonHsIds = new Set(
        season.episodes
          .map((episode) => hsByEpisodeId.get(episode.id)?.id)
          .filter((value): value is number => value != null),
      );
      season.history = mergeHistory(
        attemptHistory(ctx, "sonarr", seasonHsIds),
        verdictHistory(ctx, `sonarr:${id}`, season.seasonNumber),
      );
      season.searchCount = season.history.filter((entry) => entry.kind === "search").length;
      season.lastSearchAt =
        season.history
          .filter((entry) => entry.kind === "search")
          .reduce<number | null>(
            (latest, entry) => (latest == null ? entry.at : Math.max(latest, entry.at)),
            null,
          ) ?? null;
      const huntable = season.episodes.filter(
        (episode) =>
          episode.state === "missing" ||
          episode.state === "non_german" ||
          episode.state === "exhausted",
      );
      const nextTimes = huntable
        .map((episode) => episode.nextEligibleAt)
        .filter((value): value is number => value != null);
      season.nextEligibleAt =
        huntable.some((episode) => episode.nextEligibleAt == null) || nextTimes.length === 0
          ? null
          : Math.min(...nextTimes);
    }

    const huntStateIds = new Set(hsRows.map((r) => r.id));
    const history = mergeHistory(
      attemptHistory(ctx, "sonarr", huntStateIds),
      verdictHistory(ctx, `sonarr:${id}`),
      activityHistory(ctx, sql`json_extract(${activityLog.data}, '$.seriesId') = ${id}`),
    );

    const detail: SeriesDetail = {
      ...summary,
      path: seriesRow.path,
      originalLanguage: seriesRow.originalLanguage,
      status: seriesRow.status,
      override: loadOverride(ctx, "sonarr", "series", id),
      seasons: [...seasons.values()].sort((a, b) => a.seasonNumber - b.seasonNumber),
      history,
    };
    return detail;
  });

  app.get("/api/library/movies/:id", async (request, reply) => {
    const p = parse(reply, z.object({ id: z.coerce.number().int() }), request.params);
    if (!p.ok) return;
    const id = p.data.id;
    const summary = buildMovieItems(ctx).find((it) => it.id === id);
    const movieRow = ctx.db.select().from(movies).where(eq(movies.id, id)).get();
    if (!summary || !movieRow) return notFound(reply, "movie not found");
    const hs = ctx.db
      .select()
      .from(huntState)
      .where(
        and(
          eq(huntState.source, "radarr"),
          eq(huntState.targetKind, "movie"),
          eq(huntState.targetId, id),
        ),
      )
      .get();

    const huntStateIds = new Set(hs ? [hs.id] : []);
    const history = mergeHistory(
      attemptHistory(ctx, "radarr", huntStateIds),
      verdictHistory(ctx, `radarr:${id}`),
      activityHistory(
        ctx,
        sql`json_extract(${activityLog.data}, '$.targetId') = ${id} AND json_extract(${activityLog.data}, '$.kind') = 'movie'`,
      ),
    );

    const detail: MovieDetail = {
      ...summary,
      path: movieRow.path,
      originalLanguage: movieRow.originalLanguage,
      status: movieRow.status,
      override: loadOverride(ctx, "radarr", "movie", id),
      searchCount: hs?.searchCount ?? 0,
      tier: hs?.tier ?? 0,
      nextEligibleAt: hs?.nextEligibleAt ?? null,
      history,
    };
    return detail;
  });

  app.get("/api/search", async (request, reply) => {
    const q = parse(
      reply,
      z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(25).default(10) }),
      request.query,
    );
    if (!q.ok) return;
    const like_ = `%${q.data.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const limit = q.data.limit;

    const seriesMatches = ctx.db
      .select({
        id: series.id,
        title: series.title,
        year: series.year,
        posterUrl: series.posterUrl,
      })
      .from(series)
      .where(sql`${series.title} LIKE ${like_} ESCAPE '\\'`)
      .orderBy(series.title)
      .limit(limit)
      .all();
    const seriesIds = seriesMatches.map((s) => s.id);
    const seriesCounts = new Map<number, StateCounts>();
    if (seriesIds.length > 0) {
      for (const row of ctx.db
        .select({ seriesId: huntState.seriesId, state: huntState.state, n: sql<number>`count(*)` })
        .from(huntState)
        .where(
          and(
            eq(huntState.source, "sonarr"),
            eq(huntState.targetKind, "episode"),
            inArray(huntState.seriesId, seriesIds),
          ),
        )
        .groupBy(huntState.seriesId, huntState.state)
        .all()) {
        if (row.seriesId == null) continue;
        let counts = seriesCounts.get(row.seriesId);
        if (!counts) {
          counts = emptyStateCounts();
          seriesCounts.set(row.seriesId, counts);
        }
        counts[row.state as HuntState] += row.n;
      }
    }

    const movieMatches = ctx.db
      .select({
        id: movies.id,
        title: movies.title,
        year: movies.year,
        posterUrl: movies.posterUrl,
        hasFile: movies.hasFile,
        hasGerman: movies.hasGerman,
      })
      .from(movies)
      .where(sql`${movies.title} LIKE ${like_} ESCAPE '\\'`)
      .orderBy(movies.title)
      .limit(limit)
      .all();
    const movieStates = new Map<number, HuntState>();
    if (movieMatches.length > 0) {
      for (const row of ctx.db
        .select({ targetId: huntState.targetId, state: huntState.state })
        .from(huntState)
        .where(
          and(
            eq(huntState.source, "radarr"),
            eq(huntState.targetKind, "movie"),
            inArray(
              huntState.targetId,
              movieMatches.map((m) => m.id),
            ),
          ),
        )
        .all()) {
        movieStates.set(row.targetId, row.state as HuntState);
      }
    }

    const results: SearchResult[] = [
      ...seriesMatches.map((s) => ({
        source: "sonarr" as const,
        kind: "series" as const,
        id: s.id,
        title: s.title,
        year: s.year,
        posterUrl: s.posterUrl,
        state: aggregateSeriesState(seriesCounts.get(s.id) ?? emptyStateCounts()),
      })),
      ...movieMatches.map((m) => ({
        source: "radarr" as const,
        kind: "movie" as const,
        id: m.id,
        title: m.title,
        year: m.year,
        posterUrl: m.posterUrl,
        state:
          movieStates.get(m.id) ??
          (m.hasFile ? (m.hasGerman ? "german" : "non_german") : "missing"),
      })),
    ]
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, limit);

    const response: SearchResponse = { items: results };
    return response;
  });
}
