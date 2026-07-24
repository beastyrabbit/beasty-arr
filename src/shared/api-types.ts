// Canonical API DTO contract (plan: "Canonical API surface").
// The server routes implement exactly these shapes; the web client consumes them.

import type {
  AiVerdictValue,
  ArrSource,
  HuntState,
  SearchTrigger,
  TargetKind,
  TargetMode,
} from "./domain.js";
import type {
  ManualImportCandidate,
  PiModelCatalog,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
  ResolverEvent,
  ValidationResult,
} from "./fixer-types.js";

// ============ generic envelopes ============

export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };
export type PageQuery = { page?: number; pageSize?: number };

export type OkResponse = { ok: true };
export type ApiErrorBody = { error: string; detail?: string };

/** Mutating endpoints in dry-run mode return this instead of performing the action. */
export type DryRunResult = { dryRun: true; wouldHave: string };
export type MaybeDryRun<T> = T | DryRunResult;

export function isDryRunResult(value: unknown): value is DryRunResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { dryRun?: unknown }).dryRun === true &&
    typeof (value as { wouldHave?: unknown }).wouldHave === "string"
  );
}

// ============ auth ============

export type LoginRequest = { apiKey: string };
export type LoginResponse = OkResponse;
export type AuthMeResponse = { via: "apiKey" | "session" | null };

// ============ status (homepage widget) ============

export type AiStatusValue = "configured" | "unauthenticated" | "error" | "off";

export type StatusResponse = {
  missingGerman: number;
  otherAudio: number;
  /** 0..100, one decimal. */
  germanPct: number;
  huntsToday: number;
  /** Max trailing24h/cap across limited indexers, 0..100. */
  budgetUsedPct: number;
  fixerPending: number;
  aiStatus: AiStatusValue;
};

// ============ dashboard ============

export type StateCounts = Record<HuntState, number>;
export type EngineState = "running" | "paused";
export type ArrHealthValue = "up" | "down" | "unknown";

export type DashboardSummary = {
  dryRun: boolean;
  engine: { state: EngineState; nextTickAt: number | null; lastTickAt: number | null };
  counts: { total: StateCounts; sonarr: StateCounts; radarr: StateCounts };
  /** german / (total − unreleased − ai_paused − unmonitored − ignored), 0..100. */
  germanPct: number;
  /** Secondary metric counting ai_paused as done, 0..100. */
  germanPctWithAiDone: number;
  /** Percentage-point change vs 7 days ago; null until history exists. */
  deltaWeekPct: number | null;
  huntsToday: number;
  arrHealth: { sonarr: ArrHealthValue; radarr: ArrHealthValue; prowlarr: ArrHealthValue };
  fixer: { pending: number; analyzing: number; proposals: number; errors: number };
  ai: {
    status: AiStatusValue;
    checksToday: number;
    capPerDay: number;
    verdictCounts: Record<AiVerdictValue, number>;
  };
};

export type WinItem = {
  id: number;
  at: number;
  source: ArrSource;
  kind: TargetKind;
  targetId: number;
  seriesId?: number | null;
  title: string;
  /** e.g. "S02E04 · Der Anschlag" or "2019 · BluRay-1080p". */
  label: string;
  quality?: string | null;
  languages?: string[];
};

export type WinsQuery = { since?: number; limit?: number };
export type WinsResponse = { items: WinItem[] };

export type StatsHistoryQuery = { days?: number };
export type StatsHistoryPoint = {
  /** YYYY-MM-DD */
  date: string;
  german: number;
  nonGerman: number;
  missing: number;
  unreleased: number;
  aiPaused: number;
  exhausted: number;
  germanPct: number;
  searchesRun: number;
  queriesSpent: number;
};
export type StatsHistoryResponse = { days: number; points: StatsHistoryPoint[] };

// ============ budget ============

export type IndexerBudget = {
  id: number;
  name: string;
  enabled: boolean;
  /** Daily query cap; null = unlimited. */
  cap: number | null;
  grabLimit: number | null;
  trailing24h: number;
  /** Our attributed hunt share of trailing24h. */
  huntShare: number;
  /** Observed minus hunt attribution (floored at 0). */
  organicShare: number;
  forecastNextHorizon: number;
  target: number | null;
  huntRatePerHour: number | null;
  canHuntNow: boolean;
  inBackoff: boolean;
  excluded: boolean;
};

export type BudgetSettings = {
  budgetSafetyPct: number;
  budgetHorizonHours: number;
  budgetTrickleMinPerHour: number;
  budgetPacingHorizonHours: number;
  budgetBurstMaxDivisor: number;
  excludeIndexerIds: number[];
};

export type BudgetResponse = {
  indexers: IndexerBudget[];
  settings: BudgetSettings;
  refreshedAt: number | null;
};

export type BudgetLedgerQuery = PageQuery & { indexerId?: number };
export type BudgetLedgerEntry = {
  indexerId: number;
  indexerName: string;
  /** Epoch hour (UTC). */
  hourUtc: number;
  observedQueries: number;
  observedGrabs: number;
  huntQueries: number;
  organicQueries: number;
};
export type BudgetLedgerResponse = Paged<BudgetLedgerEntry>;

export type BudgetSettingsUpdate = Partial<BudgetSettings>;
export type BudgetSettingsResponse = BudgetSettings;

// ============ library ============

export const LIBRARY_SORTS = [
  "title",
  "year",
  "state",
  "german",
  "last_search",
  "next_search",
] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];
export type SortOrder = "asc" | "desc";

export type LibraryQuery = PageQuery & {
  q?: string;
  states?: HuntState[];
  sort?: LibrarySort;
  order?: SortOrder;
};

export type AiVerdictSummary = {
  id: number;
  verdict: AiVerdictValue;
  confidence: number;
  checkedAt: number;
  recheckAfter: number;
  evidence: string[];
  germanTitle?: string | null;
};

export type PauseInfo = {
  paused: boolean;
  since: number | null;
  until: number | null;
  note: string | null;
};

export type SeriesListItem = {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  seriesType: string | null;
  monitored: boolean;
  /** Aggregate state for the badge (worst-first precedence). */
  state: HuntState;
  /** Episode state breakdown for the mini-ribbon. */
  episodeCounts: StateCounts;
  germanEpisodes: number;
  /** Episodes counting toward the German quota (excludes unreleased/unmonitored/ignored). */
  consideredEpisodes: number;
  verdict: AiVerdictSummary | null;
  pause: PauseInfo;
  /** Transient: a search command for this item is in flight. */
  searching: boolean;
  lastSearchAt: number | null;
  nextSearchAt: number | null;
  /** Deep link into Sonarr. */
  arrUrl: string | null;
};
export type SeriesListResponse = Paged<SeriesListItem> & { stateFilterCounts: StateCounts };

export type MovieListItem = {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  monitored: boolean;
  state: HuntState;
  hasFile: boolean;
  audioLanguages: string[];
  quality: string | null;
  verdict: AiVerdictSummary | null;
  pause: PauseInfo;
  searching: boolean;
  lastSearchAt: number | null;
  nextSearchAt: number | null;
  arrUrl: string | null;
};
export type MovieListResponse = Paged<MovieListItem> & { stateFilterCounts: StateCounts };

export type EpisodeItem = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number | null;
  title: string | null;
  airDateUtc: number | null;
  monitored: boolean;
  state: HuntState;
  hasFile: boolean;
  languages: string[];
  quality: string | null;
  searchCount: number;
  tier: number;
  lastSearchAt: number | null;
  nextEligibleAt: number | null;
  searching: boolean;
};

export type SeasonItem = {
  seasonNumber: number;
  monitored: boolean;
  counts: StateCounts;
  episodes: EpisodeItem[];
  /** Per-season AI verdict note when the oracle answered per season. */
  verdictNote?: string | null;
};

export type ItemHistoryEntry = {
  at: number;
  kind: "search" | "grab" | "import" | "state" | "pause" | "resume" | "verdict" | "override";
  message: string;
  detail?: Record<string, unknown>;
};

export type OverrideInfo = {
  targetMode: TargetMode | null;
  dubLagDays: number | null;
  note: string | null;
};

export type SeriesDetail = SeriesListItem & {
  path: string | null;
  originalLanguage: string | null;
  status: string | null;
  override: OverrideInfo | null;
  seasons: SeasonItem[];
  history: ItemHistoryEntry[];
};

export type MovieDetail = MovieListItem & {
  path: string | null;
  originalLanguage: string | null;
  status: string | null;
  override: OverrideInfo | null;
  searchCount: number;
  tier: number;
  nextEligibleAt: number | null;
  history: ItemHistoryEntry[];
};

// ============ search (typeahead) ============

export type SearchQuery = { q: string; limit?: number };
export type SearchResult = {
  source: ArrSource;
  kind: "series" | "movie";
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  state: HuntState;
};
export type SearchResponse = { items: SearchResult[] };

// ============ item actions ============

/** Path segment `:kind` of /api/items/:source/:kind/:id. */
export const ITEM_SUBJECT_KINDS = ["series", "movie", "episode"] as const;
export type ItemSubjectKind = (typeof ITEM_SUBJECT_KINDS)[number];

export type ForceScope = { seasonNumber?: number; episodeIds?: number[] };
export type ForceRequest = { scope?: ForceScope; withAiRecheck?: boolean };
export type ForceResponse = MaybeDryRun<{ queuePosition: number }>;

export type PauseRequest = {
  /** Epoch ms; omit/null = indefinite. */
  until?: number | null;
  note?: string;
};
export type PauseResponse = OkResponse;

export type ResumeRequest = {
  /** Also enqueue a forced search right away. */
  force?: boolean;
  /** Required to resume an ai_paused item ("Override AI & resume"). */
  overrideAi?: boolean;
};
export type ResumeResponse = MaybeDryRun<OkResponse & { queuePosition?: number }>;

export type OverrideRequest = {
  targetMode: TargetMode | null;
  dubLagDays?: number | null;
  note?: string | null;
};
export type OverrideResponse = OkResponse;

// ============ hunt ============

export type NowHunting = {
  attemptId: number;
  source: ArrSource;
  commandName: string;
  label: string;
  startedAt: number;
  status: string;
  dryRun: boolean;
};

export type HuntStatusResponse = {
  engine: EngineState;
  dryRun: boolean;
  nextTickAt: number | null;
  lastTickAt: number | null;
  current: NowHunting | null;
  queueGate: {
    threshold: number;
    sonarr: { size: number; open: boolean };
    radarr: { size: number; open: boolean };
  };
  arrHealth: { sonarr: ArrHealthValue; radarr: ArrHealthValue; prowlarr: ArrHealthValue };
};

export type HuntQueueItem = {
  id: number;
  position: number;
  source: ArrSource;
  kind: ItemSubjectKind;
  targetId: number;
  title: string;
  /** e.g. "Season 2" / "S02E04" / "Whole series". */
  scopeLabel: string;
  reason: SearchTrigger;
  estimatedQueries: number | null;
};
export type HuntQueueResponse = { items: HuntQueueItem[] };

export type PausedItem = {
  source: ArrSource;
  kind: ItemSubjectKind;
  targetId: number;
  title: string;
  label: string;
  since: number | null;
  until: number | null;
  note: string | null;
};

export type AiDormantItem = {
  source: ArrSource;
  kind: ItemSubjectKind;
  targetId: number;
  title: string;
  verdictId: number;
  verdict: AiVerdictValue;
  confidence: number;
  evidence: string[];
  wakeAt: number;
};

export type HuntPausedResponse = { userPaused: PausedItem[]; aiDormant: AiDormantItem[] };

export type EngineActionResponse = { ok: true; engine: EngineState };
export type CycleResponse = MaybeDryRun<{ ok: true; started: boolean }>;

export type DryRunToggleRequest = { enabled: boolean };
export type DryRunToggleResponse = { dryRun: boolean };

// ============ attempts / activity / verdicts ============

export const ATTEMPT_STATUSES = [
  "dispatched",
  "queued",
  "started",
  "completed",
  "failed",
  "timeout",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type AttemptResult = "grabbed" | "no_grab" | "error";

export type SearchAttemptDto = {
  id: number;
  createdAt: number;
  source: ArrSource;
  commandName: string;
  targetLabel: string | null;
  trigger: SearchTrigger;
  estimatedQueries: number;
  status: AttemptStatus;
  result: AttemptResult | null;
  dryRun: boolean;
  completedAt: number | null;
};
export type AttemptsQuery = PageQuery & { source?: ArrSource; trigger?: SearchTrigger };
export type AttemptsResponse = Paged<SearchAttemptDto>;

export const ACTIVITY_TYPES = [
  "hunt.search",
  "hunt.win",
  "sync",
  "ai.check",
  "budget",
  "fixer",
  "system",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type ActivityEntry = {
  id: number;
  at: number;
  level: "info" | "warn" | "error";
  type: ActivityType;
  message: string;
  data: Record<string, unknown> | null;
};
export type ActivityQuery = PageQuery & { type?: ActivityType };
export type ActivityResponse = Paged<ActivityEntry>;

export type AiVerdictDto = {
  id: number;
  subjectKind: "series" | "movie";
  /** 'sonarr:123' | 'radarr:456' */
  subjectKey: string;
  title: string;
  year: number | null;
  verdict: AiVerdictValue;
  confidence: number;
  germanTitle: string | null;
  perSeason: { season: number; verdict: string; note?: string }[] | null;
  evidence: string[];
  expectedAvailability: number | null;
  provider: string;
  model: string;
  promptVersion: string;
  checkedAt: number;
  recheckAfter: number;
  superseded: boolean;
};
export type VerdictsQuery = PageQuery & { verdict?: AiVerdictValue };
export type VerdictsResponse = Paged<AiVerdictDto>;

// ============ ai ============

export type AiStatusResponse = {
  provider: "codex" | "aibox" | "off";
  model: string;
  status: AiStatusValue;
  detail: string | null;
  checksToday: number;
  capPerDay: number;
};

export type AiModelsResponse = PiModelCatalog;

export type CodexLoginStartResponse = { id: string };
export type CodexLoginState = "pending" | "authenticating" | "authenticated" | "failed" | "expired";
export type CodexLoginStatusResponse = {
  id: string;
  status: CodexLoginState;
  verificationUri: string | null;
  userCode: string | null;
  error: string | null;
};

// ============ fixer ============

export type FixerAnalysisState =
  | "queued"
  | "analyzing"
  | "proposal"
  | "needs_review"
  | "error"
  | "applied"
  | "cancelled";

export type FixerQueueItemDto = QueueItem & {
  /** Coarse grouping key for the left-pane sections, e.g. "Import blocked". */
  issueType: string;
  analysisId: string | null;
  analysisState: FixerAnalysisState | null;
  confidence: number | null;
};
export type FixerQueueResponse = { items: FixerQueueItemDto[]; fetchedAt: number | null };

export type FixerAnalyzeResponse = { analysisId: string };

export type FixerAnalysisDto = {
  id: string;
  createdAt: number;
  service: ArrSource;
  queueItemId: number;
  downloadId: string | null;
  itemLabel: string;
  status: "running" | "completed" | "failed" | "cancelled";
  proposal: ResolutionProposal | null;
  validation: ValidationResult | null;
  candidates: ManualImportCandidate[] | null;
  events: ResolverEvent[];
  error: string | null;
  completedAt: number | null;
};

export type FixerApplyRequest = { candidateIds: string[] };
export type FixerApplyResponse = MaybeDryRun<{ ok: boolean; message: string; commandId?: number }>;

export type FixerRemoveRequest = Partial<QueueRemovalOptions>;
export type FixerRemoveResponse = MaybeDryRun<OkResponse>;
export type FixerIgnoreResponse = MaybeDryRun<OkResponse>;

export type FixerBulkStartRequest = { services?: ArrSource[]; queueItemIds?: number[] };
export type FixerBulkStatusResponse = {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
  activeItemIds: number[];
  autoApply: boolean;
};

export type FixerHistoryEntry = {
  id: number;
  at: number;
  service: ArrSource;
  itemLabel: string;
  action: "import" | "ignore" | "remove" | "blocklist";
  sourceKind: "ai_auto" | "ai_user" | "user";
  confidence: number | null;
  analysisId: string | null;
  dryRun: boolean;
  result: "ok" | "error" | "simulated";
  detail: Record<string, unknown> | null;
  /** Proposal snapshot for the expandable row. */
  proposal?: ResolutionProposal | null;
};
export type FixerHistoryResponse = Paged<FixerHistoryEntry>;

// ============ config ============

export type ConnectionKind = "sonarr" | "radarr" | "prowlarr";
export type ConnectionInfo = {
  url: string | null;
  /** Key is env-only and never returned — presence flag only. */
  keyPresent: boolean;
  lastSyncAt: number | null;
};

export type HuntSettingsDto = {
  huntTickMinutes: number;
  maxCommandsPerCycle: number;
  queueGateThreshold: number;
  missingToUpgradeRatio: string;
  huntSpecials: boolean;
  dubLagDaysDefault: number;
  acceptedOriginalLanguages: string[];
};

export type AiSettingsDto = {
  aiProvider: "codex" | "aibox" | "off";
  aiModel: string;
  aiMaxChecksPerDay: number;
  aiPauseConfidence: number;
  aiMinSearchesBeforeCheck: number;
  aiMinAgeMonths: number;
};

export type FixerSettingsDto = {
  fixerAutoImportConfidence: number;
  fixerAutoRemoveConfidence: number;
  fixerParallelism: number;
  fixerAutoApply: boolean;
};

export type AppSettingsDto = { dryRun: boolean } & HuntSettingsDto &
  BudgetSettings &
  AiSettingsDto &
  FixerSettingsDto;

export type ConfigResponse = {
  version: string;
  connections: Record<ConnectionKind, ConnectionInfo>;
  settings: AppSettingsDto;
  /**
   * Ready-to-paste arr Webhook connection URL paths (webhook-only capability
   * token — safe to appear in arr configs, useless for general API access).
   */
  webhookPaths?: { sonarr: string; radarr: string };
};

/** dryRun is NOT settable here — use POST /api/system/dry-run (typed confirm). */
export type ConfigUpdateRequest = Partial<Omit<AppSettingsDto, "dryRun">>;
export type ConfigUpdateResponse = ConfigResponse;

export type TestConnectionRequest = { service: ConnectionKind };
export type TestConnectionResponse = {
  ok: boolean;
  service: ConnectionKind;
  message: string;
  version?: string;
};

// ============ system (danger zone) ============

export type SystemActionResponse = MaybeDryRun<OkResponse & { detail?: string }>;
// POST /api/system/resync            — full reconcile now
// POST /api/system/reset-hunt-state  — zero tiers/counters, re-derive states
// POST /api/system/clear-verdicts    — supersede all AI verdicts

// ============ SSE (mirrors src/server/events/bus.ts) ============

export const APP_EVENT_TYPES = [
  "hunt.batch.started",
  "hunt.search.started",
  "hunt.search.result",
  "hunt.win",
  "item.updated",
  "queue.updated",
  "budget.updated",
  "ai.check.started",
  "ai.check.completed",
  "fixer.queue.changed",
  "fixer.analysis.progress",
  "fixer.analysis.completed",
  "system.dryrun.changed",
  "system.status",
] as const;
export type AppEventType = (typeof APP_EVENT_TYPES)[number];

export type AppEventPayloads = {
  "hunt.batch.started": { at: number; candidates: number };
  "hunt.search.started": {
    attemptId: number;
    source: ArrSource;
    commandName: string;
    label: string;
    dryRun: boolean;
  };
  "hunt.search.result": {
    attemptId: number;
    status: AttemptStatus;
    result: AttemptResult | null;
    label?: string;
  };
  "hunt.win": WinItem;
  "item.updated": {
    source: ArrSource;
    kind: TargetKind;
    id: number;
    seriesId?: number | null;
    state: HuntState;
  };
  "queue.updated": { reason?: string };
  "budget.updated": { indexers?: IndexerBudget[]; attemptId?: number };
  "ai.check.started": { subjectKey: string; title: string };
  "ai.check.completed": {
    subjectKey: string;
    title: string;
    verdict: AiVerdictValue;
    confidence: number;
  };
  "fixer.queue.changed": { pending?: number };
  "fixer.analysis.progress": { analysisId: string; queueItemId: number; event: ResolverEvent };
  "fixer.analysis.completed": {
    analysisId: string;
    queueItemId: number;
    status: FixerAnalysisDto["status"];
    confidence?: number | null;
  };
  "system.dryrun.changed": { dryRun: boolean };
  "system.status": { message?: string } & Record<string, unknown>;
};

/** Typed SSE envelope: `data:` carries the whole envelope as JSON, `event:` = type. */
export type AppEventEnvelope<T extends AppEventType = AppEventType> = {
  id: number;
  type: T;
  ts: number;
  payload: AppEventPayloads[T];
};

/** Discriminated union over all event types. */
export type AnyServerEvent = { [T in AppEventType]: AppEventEnvelope<T> }[AppEventType];
