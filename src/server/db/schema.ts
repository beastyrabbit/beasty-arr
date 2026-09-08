import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  AiSeasonVerdict,
  AiVerdictValue,
  ArrSource,
  FileLanguage,
  HuntState,
  TargetKind,
  TargetMode,
} from "../../shared/domain.js";

// ============ mirror (rebuildable from the arrs) ============

export const series = sqliteTable("series", {
  id: integer("id").primaryKey(), // Sonarr seriesId
  title: text("title").notNull(),
  titleSlug: text("title_slug"),
  tvdbId: integer("tvdb_id"),
  imdbId: text("imdb_id"),
  year: integer("year"),
  status: text("status"), // continuing|ended|upcoming
  seriesType: text("series_type"), // standard|anime|daily
  originalLanguage: text("original_language"),
  monitored: integer("monitored", { mode: "boolean" }).notNull(),
  qualityProfileId: integer("quality_profile_id"),
  tags: text("tags", { mode: "json" }).$type<number[]>(),
  posterUrl: text("poster_url"),
  path: text("path"),
  lastSyncedAt: integer("last_synced_at").notNull(),
});

export const episodes = sqliteTable(
  "episodes",
  {
    id: integer("id").primaryKey(), // Sonarr episodeId
    seriesId: integer("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    seasonNumber: integer("season_number").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    absoluteEpisodeNumber: integer("absolute_episode_number"),
    title: text("title"),
    airDateUtc: integer("air_date_utc"), // NULL = TBA
    monitored: integer("monitored", { mode: "boolean" }).notNull(), // effective (episode AND series)
    hasFile: integer("has_file", { mode: "boolean" }).notNull(),
    episodeFileId: integer("episode_file_id"),
    fileLanguages: text("file_languages", { mode: "json" }).$type<FileLanguage[]>(),
    hasGerman: integer("has_german", { mode: "boolean" }).notNull().default(false),
    quality: text("quality"),
    qualityCutoffNotMet: integer("quality_cutoff_not_met", { mode: "boolean" }),
    languageCutoffNotMet: integer("language_cutoff_not_met", { mode: "boolean" }),
    customFormatScore: integer("custom_format_score"),
    fileImportedAt: integer("file_imported_at"), // from history; drives dub-lag delay
    lastSyncedAt: integer("last_synced_at").notNull(),
  },
  (t) => [
    index("idx_episodes_series_season").on(t.seriesId, t.seasonNumber),
    index("idx_episodes_german").on(t.hasGerman, t.hasFile),
  ],
);

export const movies = sqliteTable(
  "movies",
  {
    id: integer("id").primaryKey(), // Radarr movieId
    title: text("title").notNull(),
    titleSlug: text("title_slug"),
    tmdbId: integer("tmdb_id"),
    imdbId: text("imdb_id"),
    year: integer("year"),
    status: text("status"), // announced|inCinemas|released
    isAvailable: integer("is_available", { mode: "boolean" }),
    digitalRelease: integer("digital_release"),
    physicalRelease: integer("physical_release"),
    originalLanguage: text("original_language"),
    monitored: integer("monitored", { mode: "boolean" }).notNull(),
    hasFile: integer("has_file", { mode: "boolean" }).notNull(),
    movieFileId: integer("movie_file_id"),
    fileLanguages: text("file_languages", { mode: "json" }).$type<FileLanguage[]>(),
    hasGerman: integer("has_german", { mode: "boolean" }).notNull().default(false),
    quality: text("quality"),
    qualityCutoffNotMet: integer("quality_cutoff_not_met", { mode: "boolean" }),
    customFormatScore: integer("custom_format_score"),
    fileImportedAt: integer("file_imported_at"),
    qualityProfileId: integer("quality_profile_id"),
    tags: text("tags", { mode: "json" }).$type<number[]>(),
    posterUrl: text("poster_url"),
    path: text("path"),
    lastSyncedAt: integer("last_synced_at").notNull(),
  },
  (t) => [index("idx_movies_german").on(t.hasGerman, t.hasFile)],
);

export const qualityProfiles = sqliteTable(
  "quality_profiles",
  {
    source: text("source").$type<ArrSource>().notNull(),
    id: integer("id").notNull(),
    name: text("name"),
    upgradeAllowed: integer("upgrade_allowed", { mode: "boolean" }),
    cutoffFormatScore: integer("cutoff_format_score"),
    minFormatScore: integer("min_format_score"),
    raw: text("raw", { mode: "json" }).$type<Record<string, unknown>>(),
    lastSyncedAt: integer("last_synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.id] })],
);

// ============ hunt state (survives mirror refresh) ============

export const huntState = sqliteTable(
  "hunt_state",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").$type<ArrSource>().notNull(),
    targetKind: text("target_kind").$type<TargetKind>().notNull(),
    targetId: integer("target_id").notNull(), // episodeId / movieId
    seriesId: integer("series_id"), // denorm for grouping (sonarr only)
    seasonNumber: integer("season_number"),
    state: text("state").$type<HuntState>().notNull(),
    stateChangedAt: integer("state_changed_at").notNull(),
    searchCount: integer("search_count").notNull().default(0),
    tier: integer("tier").notNull().default(0), // backoff ladder index
    lastSearchAt: integer("last_search_at"),
    nextEligibleAt: integer("next_eligible_at"), // NULL = eligible now
    awaitingImportSince: integer("awaiting_import_since"), // grab seen, import pending
    awaitingImportDownloadId: text("awaiting_import_download_id"),
    manualPriority: integer("manual_priority").notNull().default(0), // >0 = jumped queue
    userPaused: integer("user_paused", { mode: "boolean" }).notNull().default(false),
    userPausedAt: integer("user_paused_at"),
    userPausedUntil: integer("user_paused_until"),
    userPausedNote: text("user_paused_note"),
    aiVerdictId: integer("ai_verdict_id"),
  },
  (t) => [
    uniqueIndex("uniq_hunt_target").on(t.source, t.targetKind, t.targetId),
    index("idx_hunt_eligible").on(t.state, t.nextEligibleAt),
    index("idx_hunt_series").on(t.seriesId, t.seasonNumber),
  ],
);

export const itemOverrides = sqliteTable(
  "item_overrides",
  {
    source: text("source").$type<ArrSource>().notNull(),
    subjectKind: text("subject_kind").notNull(), // 'series'|'season'|'movie'
    subjectId: integer("subject_id").notNull(), // seriesId/movieId
    seasonNumber: integer("season_number").notNull().default(-1), // -1 = not season-scoped
    targetMode: text("target_mode").$type<TargetMode>(),
    dubLagDays: integer("dub_lag_days"),
    note: text("note"),
  },
  (t) => [primaryKey({ columns: [t.source, t.subjectKind, t.subjectId, t.seasonNumber] })],
);

// ============ search log ============

export const searchAttempts = sqliteTable(
  "search_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at").notNull(),
    source: text("source").$type<ArrSource>().notNull(),
    commandName: text("command_name").notNull(), // EpisodeSearch|SeasonSearch|SeriesSearch|MoviesSearch
    arrCommandId: integer("arr_command_id"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    targetIds: text("target_ids", { mode: "json" }).$type<number[]>().notNull(), // hunt_state ids
    targetLabel: text("target_label"), // denorm "Series S02" for history after deletes
    trigger: text("trigger").notNull().default("scheduled"), // scheduled|forced|missing|retry
    estimatedQueries: integer("estimated_queries").notNull(),
    status: text("status").notNull(), // dispatched|queued|started|completed|failed|timeout|interrupted
    result: text("result"), // grabbed|no_grab|error
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    completedAt: integer("completed_at"),
  },
  (t) => [index("idx_attempts_created").on(t.createdAt)],
);

// ============ budget ledger ============

/** Indexed membership for title history; migration triggers maintain the JSON mirror. */
export const searchAttemptTargets = sqliteTable(
  "search_attempt_targets",
  {
    attemptId: integer("attempt_id")
      .notNull()
      .references(() => searchAttempts.id, { onDelete: "cascade" }),
    huntStateId: integer("hunt_state_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.huntStateId] }),
    index("idx_attempt_targets_hunt_state").on(t.huntStateId),
  ],
);

export const indexers = sqliteTable("indexers", {
  id: integer("id").primaryKey(), // Prowlarr indexer id
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  priority: integer("priority").notNull().default(25),
  queryLimit: integer("query_limit"), // NULL = unlimited
  grabLimit: integer("grab_limit"),
  supportsTv: integer("supports_tv", { mode: "boolean" }).notNull().default(true),
  supportsMovies: integer("supports_movies", { mode: "boolean" }).notNull().default(true),
  inBackoff: integer("in_backoff", { mode: "boolean" }).notNull().default(false),
  lastSyncedAt: integer("last_synced_at").notNull(),
});

export const indexerSnapshots = sqliteTable(
  "indexer_snapshots",
  {
    indexerId: integer("indexer_id").notNull(),
    takenAt: integer("taken_at").notNull(),
    queriesTotal: integer("queries_total").notNull(), // cumulative numberOfQueries (+rss+auth)
    grabsTotal: integer("grabs_total").notNull(),
  },
  (t) => [primaryKey({ columns: [t.indexerId, t.takenAt] })],
);

export const budgetBuckets = sqliteTable(
  "budget_buckets",
  {
    indexerId: integer("indexer_id").notNull(),
    hourUtc: integer("hour_utc").notNull(), // epoch hour
    observedQueries: integer("observed_queries").notNull().default(0),
    observedGrabs: integer("observed_grabs").notNull().default(0),
    huntQueries: integer("hunt_queries").notNull().default(0), // our attributed share
    huntSonarrQueries: integer("hunt_sonarr_queries").notNull().default(0),
    huntRadarrQueries: integer("hunt_radarr_queries").notNull().default(0),
    sonarrQueries: integer("sonarr_queries").notNull().default(0),
    radarrQueries: integer("radarr_queries").notNull().default(0),
    otherQueries: integer("other_queries").notNull().default(0),
    sourceQueries: text("source_queries", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
  },
  (t) => [primaryKey({ columns: [t.indexerId, t.hourUtc] })],
);

export const pendingSelfEstimates = sqliteTable("pending_self_estimates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  indexerId: integer("indexer_id").notNull(),
  at: integer("at").notNull(),
  queries: integer("queries").notNull(),
  attemptId: integer("attempt_id"),
  reconciledAt: integer("reconciled_at"),
  observedIds: text("observed_ids", { mode: "json" }).$type<number[]>().notNull().default([]),
});

// ============ AI verdicts ============

export const aiVerdicts = sqliteTable(
  "ai_verdicts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectKind: text("subject_kind").notNull(), // 'series'|'movie'
    subjectKey: text("subject_key").notNull(), // 'sonarr:123' | 'radarr:456'
    title: text("title").notNull(),
    year: integer("year"),
    externalIds: text("external_ids", { mode: "json" }).$type<{
      tvdbId?: number;
      tmdbId?: number;
      imdbId?: string;
    }>(),
    verdict: text("verdict").$type<AiVerdictValue>().notNull(),
    confidence: real("confidence").notNull(),
    germanTitle: text("german_title"),
    perSeason: text("per_season", { mode: "json" }).$type<AiSeasonVerdict[]>(),
    evidence: text("evidence", { mode: "json" }).$type<string[]>().notNull(),
    expectedAvailability: integer("expected_availability"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    checkedAt: integer("checked_at").notNull(),
    recheckAfter: integer("recheck_after").notNull(),
    supersededBy: integer("superseded_by"),
  },
  (t) => [index("idx_verdicts_subject").on(t.subjectKey, t.checkedAt)],
);

/** Durable quota/cooldown ledger. Every paid oracle invocation gets one row. */
export const aiCheckAttempts = sqliteTable(
  "ai_check_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectKey: text("subject_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(), // running|succeeded|failed|cancelled
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    error: text("error"),
  },
  (t) => [
    index("idx_ai_attempts_started").on(t.startedAt),
    index("idx_ai_attempts_subject").on(t.subjectKey, t.startedAt),
  ],
);

// ============ fixer ============

export const fixerAnalyses = sqliteTable(
  "fixer_analyses",
  {
    id: text("id").primaryKey(), // nanoid
    createdAt: integer("created_at").notNull(),
    service: text("service").$type<ArrSource>().notNull(),
    queueItemId: integer("queue_item_id").notNull(),
    downloadId: text("download_id"),
    itemLabel: text("item_label").notNull(),
    status: text("status").notNull(), // running|completed|failed|cancelled
    proposal: text("proposal", { mode: "json" }).$type<Record<string, unknown>>(),
    validation: text("validation", { mode: "json" }).$type<Record<string, unknown>>(),
    candidates: text("candidates", { mode: "json" }).$type<unknown[]>(),
    events: text("events", { mode: "json" }).$type<unknown[]>(),
    error: text("error"),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("idx_fixer_analyses_created").on(t.createdAt),
    index("idx_fixer_analyses_download").on(t.service, t.downloadId, t.createdAt),
    index("idx_fixer_analyses_queue_item").on(t.service, t.queueItemId, t.createdAt),
  ],
);

export const fixerHistory = sqliteTable(
  "fixer_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    service: text("service").$type<ArrSource>().notNull(),
    itemLabel: text("item_label").notNull(),
    action: text("action").notNull(), // import|ignore|remove|blocklist
    sourceKind: text("source_kind").notNull(), // ai_auto|ai_user|user
    confidence: real("confidence"),
    analysisId: text("analysis_id"),
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    result: text("result").notNull(), // ok|error|simulated
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    index("idx_fixer_history_at").on(t.at),
    index("idx_fixer_history_analysis").on(t.analysisId, t.at, t.id),
  ],
);

// ============ ops ============

export const manualRequests = sqliteTable("manual_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: integer("created_at").notNull(),
  subject: text("subject").notNull(), // 'sonarr:series:12', 'radarr:movie:9', 'sonarr:episode:881'
  withAiRecheck: integer("with_ai_recheck", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("pending"), // pending|running|done
  completedAt: integer("completed_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

/** Machine-readable evidence imported from licensed/open dub catalogs. */
export const dubCatalogEvidence = sqliteTable("dub_catalog_evidence", {
  subjectKey: text("subject_key").primaryKey(),
  source: text("source").notNull(),
  sourceId: text("source_id").notNull(),
  url: text("url").notNull(),
  checkedAt: integer("checked_at").notNull(),
});

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(), // sonarr.lastHistoryId, radarr.lastHistoryId, ...
  value: text("value").notNull(),
});

export const statsDaily = sqliteTable(
  "stats_daily",
  {
    date: text("date").notNull(), // YYYY-MM-DD
    source: text("source").$type<ArrSource>().notNull(),
    german: integer("german").notNull().default(0),
    nonGerman: integer("non_german").notNull().default(0),
    missing: integer("missing").notNull().default(0),
    unreleased: integer("unreleased").notNull().default(0),
    aiPaused: integer("ai_paused").notNull().default(0),
    exhausted: integer("exhausted").notNull().default(0),
    searchesRun: integer("searches_run").notNull().default(0),
    queriesSpent: integer("queries_spent").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.date, t.source] })],
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    level: text("level").notNull(), // info|warn|error
    type: text("type").notNull(), // hunt.search|hunt.win|sync|ai.check|budget|fixer|system
    message: text("message").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("idx_activity_at").on(t.at)],
);
