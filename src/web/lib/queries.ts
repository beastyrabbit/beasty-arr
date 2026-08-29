import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  ActivityQuery,
  ActivityResponse,
  AiBulkStatusResponse,
  AiModelsResponse,
  AiStatusResponse,
  AttemptsQuery,
  AttemptsResponse,
  BudgetLedgerQuery,
  BudgetLedgerResponse,
  BudgetResponse,
  BudgetSettingsResponse,
  BudgetSettingsUpdate,
  CodexLoginStartResponse,
  CodexLoginStatusResponse,
  ConfigResponse,
  ConfigUpdateRequest,
  CycleResponse,
  DashboardSummary,
  DryRunToggleRequest,
  DryRunToggleResponse,
  EngineActionResponse,
  FixerAnalysisDto,
  FixerAnalyzeResponse,
  FixerApplyRequest,
  FixerApplyResponse,
  FixerBulkStartRequest,
  FixerBulkStatusResponse,
  FixerHistoryResponse,
  FixerIgnoreResponse,
  FixerQueueResponse,
  FixerRemoveRequest,
  FixerRemoveResponse,
  ForceRequest,
  ForceResponse,
  HuntPausedResponse,
  HuntQueueResponse,
  HuntStatusResponse,
  ItemSubjectKind,
  LibraryQuery,
  MissingEpisodesQuery,
  MissingEpisodesResponse,
  MissingForceResponse,
  MovieDetail,
  MovieListResponse,
  OkResponse,
  OverrideRequest,
  OverrideResponse,
  PageQuery,
  PauseRequest,
  PauseResponse,
  ResumeRequest,
  ResumeResponse,
  SearchResponse,
  SeriesDetail,
  SeriesListResponse,
  StatsHistoryResponse,
  SystemActionResponse,
  TestConnectionRequest,
  TestConnectionResponse,
  VerdictsQuery,
  VerdictsResponse,
  WinsResponse,
} from "../../shared/api-types.js";
import { isDryRunResult } from "../../shared/api-types.js";
import type { ArrSource } from "../../shared/domain.js";
import { ApiError, api } from "./api.js";
import { sse } from "./events.js";

// ============ query keys ============

export const keys = {
  dashboard: ["dashboard", "summary"] as const,
  wins: ["dashboard", "wins"] as const,
  stats: (days: number) => ["stats", "history", days] as const,
  budget: ["budget"] as const,
  budgetLedger: (q: BudgetLedgerQuery) => ["budget", "ledger", q] as const,
  series: (q: LibraryQuery) => ["library", "series", "list", q] as const,
  movies: (q: LibraryQuery) => ["library", "movies", "list", q] as const,
  missing: (q: MissingEpisodesQuery) => ["missing", q] as const,
  seriesDetail: (id: number) => ["library", "series", "detail", id] as const,
  movieDetail: (id: number) => ["library", "movies", "detail", id] as const,
  search: (q: string) => ["search", q] as const,
  huntStatus: ["hunt", "status"] as const,
  huntQueue: ["hunt", "queue"] as const,
  huntPaused: ["hunt", "paused"] as const,
  attempts: (q: AttemptsQuery) => ["attempts", q] as const,
  activity: (q: ActivityQuery) => ["activity", q] as const,
  verdicts: (q: VerdictsQuery) => ["verdicts", q] as const,
  aiStatus: ["ai", "status"] as const,
  aiBulk: ["ai", "bulk"] as const,
  aiModels: ["ai", "models"] as const,
  codexLogin: (id: string) => ["ai", "codex-login", id] as const,
  fixerQueue: ["fixer", "queue"] as const,
  fixerAnalysis: (id: string) => ["fixer", "analysis", id] as const,
  fixerBulk: ["fixer", "bulk"] as const,
  fixerHistory: (q: PageQuery) => ["fixer", "history", q] as const,
  config: ["config"] as const,
};

// ============ SSE → cache wiring ============

/**
 * Targeted setQueryData patches for high-frequency events, invalidations for
 * the rest. Called once at startup; also invalidates everything active after
 * an SSE reconnect (possible event gap).
 */
export function wireSseToQueryClient(qc: QueryClient): void {
  sse.onReconnect(() => {
    qc.invalidateQueries();
  });
  sse.onEvent((event) => {
    switch (event.type) {
      case "budget.updated": {
        const indexers = event.payload.indexers;
        if (indexers) {
          qc.setQueryData<BudgetResponse>(keys.budget, (old) =>
            old ? { ...old, indexers, refreshedAt: event.ts } : old,
          );
        } else {
          qc.invalidateQueries({ queryKey: keys.budget });
        }
        break;
      }
      case "item.updated": {
        const p = event.payload;
        if (p.kind === "movie") {
          qc.setQueryData<MovieDetail>(keys.movieDetail(p.id), (old) =>
            old ? { ...old, state: p.state } : old,
          );
        } else if (p.seriesId != null) {
          qc.invalidateQueries({ queryKey: keys.seriesDetail(p.seriesId) });
        }
        qc.invalidateQueries({
          queryKey: ["library", p.kind === "movie" ? "movies" : "series", "list"],
        });
        qc.invalidateQueries({ queryKey: keys.dashboard });
        qc.invalidateQueries({ queryKey: ["missing"] });
        break;
      }
      case "queue.updated":
        qc.invalidateQueries({ queryKey: keys.huntQueue });
        qc.invalidateQueries({ queryKey: keys.huntPaused });
        qc.invalidateQueries({ queryKey: ["missing"] });
        break;
      case "hunt.batch.started":
      case "hunt.search.started":
      case "hunt.search.result":
        qc.invalidateQueries({ queryKey: keys.huntStatus });
        qc.invalidateQueries({ queryKey: ["attempts"] });
        qc.invalidateQueries({ queryKey: ["library"] });
        break;
      case "hunt.win":
        qc.invalidateQueries({ queryKey: keys.wins });
        qc.invalidateQueries({ queryKey: keys.dashboard });
        break;
      case "ai.check.started":
      case "ai.check.completed":
        qc.invalidateQueries({ queryKey: ["verdicts"] });
        qc.invalidateQueries({ queryKey: keys.aiStatus });
        qc.invalidateQueries({ queryKey: keys.aiBulk });
        qc.invalidateQueries({ queryKey: ["library"] });
        break;
      case "fixer.queue.changed":
        qc.invalidateQueries({ queryKey: keys.fixerQueue });
        break;
      case "fixer.analysis.completed":
        qc.invalidateQueries({ queryKey: keys.fixerAnalysis(event.payload.analysisId) });
        qc.invalidateQueries({ queryKey: keys.fixerQueue });
        qc.invalidateQueries({ queryKey: ["fixer", "history"] });
        qc.invalidateQueries({ queryKey: keys.fixerBulk });
        break;
      case "system.dryrun.changed": {
        const dryRun = event.payload.dryRun;
        qc.setQueryData<ConfigResponse>(keys.config, (old) =>
          old ? { ...old, settings: { ...old.settings, dryRun } } : old,
        );
        qc.invalidateQueries({ queryKey: keys.huntStatus });
        qc.invalidateQueries({ queryKey: keys.dashboard });
        break;
      }
      default:
        break;
    }
  });
}

// ============ shared mutation helpers ============

export function toastError(err: unknown): void {
  const message =
    err instanceof ApiError ? err.message : err instanceof Error ? err.message : "request failed";
  toast.error(message);
}

/** Success toast that surfaces the dry-run "wouldHave" simulation clearly. */
export function toastMaybeDryRun(result: unknown, liveMessage: string): void {
  if (isDryRunResult(result)) {
    toast(`DRY RUN — ${result.wouldHave}`, { icon: "◌" });
  } else if (
    result !== null &&
    typeof result === "object" &&
    "ok" in result &&
    result.ok === false &&
    "message" in result &&
    typeof result.message === "string"
  ) {
    toast.error(result.message);
  } else {
    toast.success(liveMessage);
  }
}

// ============ dashboard ============

export function useDashboardSummary() {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: () => api.get<DashboardSummary>("/api/dashboard/summary"),
    refetchInterval: 60_000,
  });
}

export function useWins(limit = 20) {
  return useQuery({
    queryKey: keys.wins,
    queryFn: () => api.get<WinsResponse>("/api/dashboard/wins", { limit }),
  });
}

export function useStatsHistory(days = 30) {
  return useQuery({
    queryKey: keys.stats(days),
    queryFn: () => api.get<StatsHistoryResponse>("/api/stats/history", { days }),
    staleTime: 300_000,
  });
}

// ============ budget ============

export function useBudget() {
  return useQuery({
    queryKey: keys.budget,
    queryFn: () => api.get<BudgetResponse>("/api/budget"),
    refetchInterval: 120_000,
  });
}

export function useBudgetLedger(query: BudgetLedgerQuery) {
  return useQuery({
    queryKey: keys.budgetLedger(query),
    queryFn: () =>
      api.get<BudgetLedgerResponse>("/api/budget/ledger", {
        page: query.page,
        pageSize: query.pageSize,
        indexerId: query.indexerId,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useUpdateBudgetSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: BudgetSettingsUpdate) =>
      api.put<BudgetSettingsResponse>("/api/budget/settings", patch),
    onSuccess: () => {
      toast.success("Budget settings saved");
      qc.invalidateQueries({ queryKey: keys.budget });
      qc.invalidateQueries({ queryKey: keys.config });
    },
    onError: toastError,
  });
}

// ============ library ============

function libraryParams(q: LibraryQuery) {
  return {
    q: q.q,
    "state[]": q.states,
    sort: q.sort,
    order: q.order,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export function useSeriesList(query: LibraryQuery, enabled = true) {
  return useQuery({
    queryKey: keys.series(query),
    queryFn: () => api.get<SeriesListResponse>("/api/library/series", libraryParams(query)),
    placeholderData: (prev) => prev,
    enabled,
  });
}

export function useMovieList(query: LibraryQuery, enabled = true) {
  return useQuery({
    queryKey: keys.movies(query),
    queryFn: () => api.get<MovieListResponse>("/api/library/movies", libraryParams(query)),
    placeholderData: (prev) => prev,
    enabled,
  });
}

export function useSeriesDetail(id: number, live = false, enabled = true) {
  return useQuery({
    queryKey: keys.seriesDetail(id),
    queryFn: () => api.get<SeriesDetail>(`/api/library/series/${id}`),
    refetchInterval: live ? 2_000 : false,
    enabled,
  });
}

export function useMovieDetail(id: number, live = false, enabled = true) {
  return useQuery({
    queryKey: keys.movieDetail(id),
    queryFn: () => api.get<MovieDetail>(`/api/library/movies/${id}`),
    refetchInterval: live ? 2_000 : false,
    enabled,
  });
}

export function useTypeahead(q: string) {
  return useQuery({
    queryKey: keys.search(q),
    queryFn: () => api.get<SearchResponse>("/api/search", { q }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// ============ missing media ============

export function useMissingEpisodes(query: MissingEpisodesQuery) {
  return useQuery({
    queryKey: keys.missing(query),
    queryFn: () =>
      api.get<MissingEpisodesResponse>("/api/missing/episodes", {
        q: query.q,
        year: query.year,
        minimumAgeDays: query.minimumAgeDays,
        maximumManualAttempts: query.maximumManualAttempts,
        gap: query.gap,
        page: query.page,
        pageSize: query.pageSize,
      }),
    placeholderData: (previous) => previous,
  });
}

export function useForceMissing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (episodeIds: number[]) =>
      api.post<MissingForceResponse>("/api/missing/force", { episodeIds }),
    onSuccess: (result) => {
      if (isDryRunResult(result)) toastMaybeDryRun(result, "");
      else
        toast.success(
          `Searching ${result.accepted} missing episode${result.accepted === 1 ? "" : "s"}`,
        );
      qc.invalidateQueries({ queryKey: ["missing"] });
      qc.invalidateQueries({ queryKey: keys.huntStatus });
    },
    onError: toastError,
  });
}

// ============ item actions ============

export type ItemRef = { source: ArrSource; kind: ItemSubjectKind; id: number };

function itemPath(ref: ItemRef, action: string): string {
  return `/api/items/${ref.source}/${ref.kind}/${ref.id}/${action}`;
}

function invalidateItem(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: ["library"] });
  qc.invalidateQueries({ queryKey: keys.huntQueue });
  qc.invalidateQueries({ queryKey: keys.huntPaused });
  qc.invalidateQueries({ queryKey: keys.dashboard });
}

export function useForceSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, body }: { ref: ItemRef; body?: ForceRequest }) =>
      api.post<ForceResponse>(itemPath(ref, "force"), body ?? {}),
    onSuccess: (result) => {
      if (isDryRunResult(result)) toastMaybeDryRun(result, "");
      else toast.success("Forced search started");
      invalidateItem(qc);
    },
    onError: toastError,
  });
}

export function usePauseItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, body }: { ref: ItemRef; body: PauseRequest }) =>
      api.post<PauseResponse>(itemPath(ref, "pause"), body),
    onSuccess: () => {
      toast.success("Paused");
      invalidateItem(qc);
    },
    onError: toastError,
  });
}

export function useResumeItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, body }: { ref: ItemRef; body?: ResumeRequest }) =>
      api.post<ResumeResponse>(itemPath(ref, "resume"), body ?? {}),
    onSuccess: (result) => {
      toastMaybeDryRun(result, "Resumed");
      invalidateItem(qc);
    },
    onError: toastError,
  });
}

export function useOverrideItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, body }: { ref: ItemRef; body: OverrideRequest }) =>
      api.put<OverrideResponse>(`/api/items/${ref.source}/${ref.kind}/${ref.id}/override`, body),
    onSuccess: () => {
      toast.success("Override saved");
      invalidateItem(qc);
    },
    onError: toastError,
  });
}

// ============ hunt ============

export function useHuntStatus() {
  return useQuery({
    queryKey: keys.huntStatus,
    queryFn: () => api.get<HuntStatusResponse>("/api/hunt/status"),
    refetchInterval: 30_000,
  });
}

export function useHuntQueue() {
  return useQuery({
    queryKey: keys.huntQueue,
    queryFn: () => api.get<HuntQueueResponse>("/api/hunt/queue"),
    refetchInterval: 60_000,
  });
}

export function useHuntPaused() {
  return useQuery({
    queryKey: keys.huntPaused,
    queryFn: () => api.get<HuntPausedResponse>("/api/hunt/paused"),
  });
}

export function useQueueBump() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<OkResponse>(`/api/hunt/queue/${id}/bump`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.huntQueue }),
    onError: toastError,
  });
}

export function useQueueRemove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<OkResponse>(`/api/hunt/queue/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.huntQueue }),
    onError: toastError,
  });
}

export function useEngineAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "pause" | "resume" | "cycle") =>
      api.post<EngineActionResponse | CycleResponse>(`/api/engine/${action}`),
    onSuccess: (_r, action) => {
      toast.success(
        action === "cycle"
          ? "Cycle triggered"
          : action === "pause"
            ? "Engine paused"
            : "Engine resumed",
      );
      qc.invalidateQueries({ queryKey: keys.huntStatus });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
    onError: toastError,
  });
}

export function useSetDryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: DryRunToggleRequest) =>
      api.post<DryRunToggleResponse>("/api/system/dry-run", request),
    onSuccess: (r) => {
      toast.success(r.dryRun ? "Dry-run enabled" : "LIVE MODE — commands will reach the arrs");
      qc.invalidateQueries();
    },
    onError: toastError,
  });
}

export function useSystemAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "resync" | "reset-hunt-state" | "clear-verdicts") =>
      api.post<SystemActionResponse>(`/api/system/${action}`),
    onSuccess: (result) => {
      toastMaybeDryRun(result, "Done");
      qc.invalidateQueries();
    },
    onError: toastError,
  });
}

// ============ attempts / activity / verdicts ============

export function useAttempts(query: AttemptsQuery) {
  return useQuery({
    queryKey: keys.attempts(query),
    queryFn: () =>
      api.get<AttemptsResponse>("/api/attempts", {
        page: query.page,
        pageSize: query.pageSize,
        source: query.source,
        trigger: query.trigger,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useActivity(query: ActivityQuery) {
  return useQuery({
    queryKey: keys.activity(query),
    queryFn: () =>
      api.get<ActivityResponse>("/api/activity", {
        page: query.page,
        pageSize: query.pageSize,
        type: query.type,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useVerdicts(query: VerdictsQuery) {
  return useQuery({
    queryKey: keys.verdicts(query),
    queryFn: () =>
      api.get<VerdictsResponse>("/api/verdicts", {
        page: query.page,
        pageSize: query.pageSize,
        verdict: query.verdict,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useInvalidateVerdict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<OkResponse>(`/api/verdicts/${id}/invalidate?recheck=true`),
    onSuccess: () => {
      toast.success("Verdict invalidated — re-check queued");
      qc.invalidateQueries({ queryKey: ["verdicts"] });
      qc.invalidateQueries({ queryKey: ["library"] });
    },
    onError: toastError,
  });
}

export function useRecheckSubject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subjectKey: string) => api.post<OkResponse>("/api/ai/recheck", { subjectKey }),
    onSuccess: () => {
      toast.success("AI check started");
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["verdicts"] });
    },
    onError: toastError,
  });
}

// ============ ai ============

export function useAiStatus() {
  return useQuery({
    queryKey: keys.aiStatus,
    queryFn: () => api.get<AiStatusResponse>("/api/ai/status"),
    refetchInterval: 120_000,
  });
}

export function useAiBulkStatus() {
  return useQuery({
    queryKey: keys.aiBulk,
    queryFn: () => api.get<AiBulkStatusResponse>("/api/ai/bulk/status"),
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : 30_000),
  });
}

export function useAiBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, limit }: { action: "start" | "cancel"; limit?: number }) =>
      api.post<OkResponse>(`/api/ai/bulk/${action}`, limit ? { limit } : undefined),
    onSuccess: (_data, variables) => {
      toast.success(
        variables.action === "start"
          ? variables.limit
            ? `AI validation batch started (${variables.limit} titles)`
            : "AI bulk started"
          : "AI bulk cancellation requested",
      );
      qc.invalidateQueries({ queryKey: keys.aiBulk });
      qc.invalidateQueries({ queryKey: keys.aiStatus });
    },
    onError: toastError,
  });
}

export function useAiModels() {
  return useQuery({
    queryKey: keys.aiModels,
    queryFn: () => api.get<AiModelsResponse>("/api/ai/models"),
    staleTime: 5 * 60_000,
  });
}

export function useCodexLoginStart() {
  return useMutation({
    mutationFn: () => api.post<CodexLoginStartResponse>("/api/ai/codex-login/start"),
    onError: toastError,
  });
}

export function useCodexLoginStatus(id: string | null) {
  return useQuery({
    queryKey: keys.codexLogin(id ?? "none"),
    queryFn: () => api.get<CodexLoginStatusResponse>(`/api/ai/codex-login/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "authenticating" ? 2_000 : false;
    },
  });
}

// ============ fixer ============

export function useFixerQueue() {
  return useQuery({
    queryKey: keys.fixerQueue,
    queryFn: () => api.get<FixerQueueResponse>("/api/fixer/queue"),
  });
}

export function useFixerRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<FixerQueueResponse>("/api/fixer/queue/refresh"),
    onSuccess: (data) => qc.setQueryData(keys.fixerQueue, data),
    onError: toastError,
  });
}

export function useFixerAnalyze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, id }: { service: ArrSource; id: number }) =>
      api.post<FixerAnalyzeResponse>(`/api/fixer/items/${service}/${id}/analyze`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.fixerQueue }),
    onError: toastError,
  });
}

export function useFixerCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, id }: { service: ArrSource; id: number }) =>
      api.post<OkResponse>(`/api/fixer/items/${service}/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.fixerQueue }),
    onError: toastError,
  });
}

export function useFixerAnalysis(id: string | null) {
  return useQuery({
    queryKey: keys.fixerAnalysis(id ?? "none"),
    queryFn: () => api.get<FixerAnalysisDto>(`/api/fixer/analyses/${id}`),
    enabled: id !== null,
  });
}

export function useFixerApply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ analysisId, body }: { analysisId: string; body: FixerApplyRequest }) =>
      api.post<FixerApplyResponse>(`/api/fixer/analyses/${analysisId}/apply`, body),
    onSuccess: (result) => {
      toastMaybeDryRun(result, "Proposal applied");
      qc.invalidateQueries({ queryKey: keys.fixerQueue });
      qc.invalidateQueries({ queryKey: ["fixer", "history"] });
    },
    onError: toastError,
  });
}

export function useFixerRemove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      service,
      id,
      body,
    }: {
      service: ArrSource;
      id: number;
      body?: FixerRemoveRequest;
    }) => api.post<FixerRemoveResponse>(`/api/fixer/items/${service}/${id}/remove`, body ?? {}),
    onSuccess: (result) => {
      toastMaybeDryRun(result, "Removed from queue");
      qc.invalidateQueries({ queryKey: keys.fixerQueue });
      qc.invalidateQueries({ queryKey: ["fixer", "history"] });
    },
    onError: toastError,
  });
}

export function useFixerIgnore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, id }: { service: ArrSource; id: number }) =>
      api.post<FixerIgnoreResponse>(`/api/fixer/items/${service}/${id}/ignore`),
    onSuccess: (result) => {
      toastMaybeDryRun(result, "Ignored");
      qc.invalidateQueries({ queryKey: keys.fixerQueue });
    },
    onError: toastError,
  });
}

export function useFixerBulkStatus() {
  return useQuery({
    queryKey: keys.fixerBulk,
    queryFn: () => api.get<FixerBulkStatusResponse>("/api/fixer/bulk/status"),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 30_000),
  });
}

export function useFixerBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: "start" | "cancel"; body?: FixerBulkStartRequest }) =>
      api.post<OkResponse>(`/api/fixer/bulk/${action}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.fixerBulk }),
    onError: toastError,
  });
}

export function useFixerHistory(query: PageQuery) {
  return useQuery({
    queryKey: keys.fixerHistory(query),
    queryFn: () =>
      api.get<FixerHistoryResponse>("/api/fixer/history", {
        page: query.page,
        pageSize: query.pageSize,
      }),
    placeholderData: (prev) => prev,
  });
}

// ============ config ============

export function useConfig() {
  return useQuery({
    queryKey: keys.config,
    queryFn: () => api.get<ConfigResponse>("/api/config"),
    staleTime: 60_000,
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ConfigUpdateRequest) => api.put<ConfigResponse>("/api/config", patch),
    onSuccess: (data) => {
      toast.success("Settings saved");
      qc.setQueryData(keys.config, data);
      qc.invalidateQueries({ queryKey: keys.huntStatus });
      qc.invalidateQueries({ queryKey: keys.huntQueue });
      qc.invalidateQueries({ queryKey: keys.budget });
    },
    onError: toastError,
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (body: TestConnectionRequest) =>
      api.post<TestConnectionResponse>("/api/config/test-connection", body),
    onError: toastError,
  });
}
