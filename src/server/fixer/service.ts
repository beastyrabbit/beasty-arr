import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { nanoid } from "nanoid";
import { autoApplyBlockReason, isProviderUsageLimit } from "../../shared/fixer-policy.js";
import type {
  AnalysisResult,
  FixerDubVerdictContext,
  ManualImportCandidate,
  MediaService,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
  ValidationResult,
} from "../../shared/fixer-types.js";
import { canLoadManualImportCandidates } from "../arr/sonarr-client.js";
import type { SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import { aiVerdicts, fixerAnalyses, fixerHistory } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import { isAiVerdictValue } from "../hunt/state.js";
import type { FixerAnalysisEvent, FixerPiRunner } from "./ai-port.js";
import { toResolverEvent } from "./events-map.js";
import {
  type FixerHistoryAction,
  type FixerHistoryPage,
  type FixerHistorySourceKind,
  listFixerHistory,
  recordFixerHistory,
} from "./history.js";
import {
  type FixerClientPort,
  fallbackProposal,
  type RadarrFixerClientPort,
  resolveQueueItem,
  type SonarrFixerClientPort,
} from "./resolver.js";
import { normalizeProposal, validateProposalForImport } from "./validation.js";

// Ported from sonarr_fixer renderer constants.ts.
export const manualRemovalOptions: QueueRemovalOptions = {
  removeFromClient: true,
  blocklist: false,
  skipRedownload: false,
  changeCategory: false,
};

export const ignoreRemovalOptions: QueueRemovalOptions = {
  removeFromClient: false,
  blocklist: false,
  skipRedownload: true,
  changeCategory: false,
};

const MAX_PERSISTED_EVENTS = 500;
const SEASON_EPISODE_PATTERN = /\bS(\d{1,4})E/i;

function targetSeasonNumber(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
): number | undefined {
  const candidateSeasons = new Set(
    candidates.flatMap((candidate) =>
      candidate.seasonNumber === undefined ? [] : [candidate.seasonNumber],
    ),
  );
  if (candidateSeasons.size === 1) {
    return candidateSeasons.values().next().value;
  }
  if (candidateSeasons.size > 1) {
    return undefined;
  }
  const label = queueItem.seasonEpisode ?? queueItem.episodeLabels[0];
  const parsed = label?.match(SEASON_EPISODE_PATTERN)?.[1];
  return parsed === undefined ? undefined : Number(parsed);
}

// ============ queue view helpers (ported from sonarr_fixer renderer utils/queue.ts) ============

export function queueItemTitle(item: QueueItem): string {
  return item.movieTitle ?? item.seriesTitle ?? item.title;
}

export function queueItemLabel(item: QueueItem): string {
  const title = queueItemTitle(item);
  const detail =
    item.service === "radarr"
      ? item.movieYear
        ? `(${item.movieYear})`
        : ""
      : (item.seasonEpisode ?? "");
  return detail ? `${title} ${detail}` : title;
}

export function queueIssueText(item: QueueItem): string {
  return (
    item.statusMessages[1] ??
    item.statusMessages[0] ??
    item.trackedDownloadStatus ??
    item.status ??
    "-"
  );
}

export function queueIssueType(item: QueueItem): string {
  const text = queueIssueText(item).toLowerCase();
  if (text.includes("movie")) {
    return "movie match";
  }
  if (text.includes("unexpected") && text.includes("episode")) {
    return "unexpected episode";
  }
  if (text.includes("sample")) {
    return "sample";
  }
  if (text.includes("quality")) {
    return "quality";
  }
  if (text.includes("language")) {
    return "language";
  }
  if (text.includes("series")) {
    return "series match";
  }
  if (text.includes("file") && (text.includes("missing") || text.includes("exist"))) {
    return "missing file";
  }
  if (text.includes("rejected") || text.includes("rejection")) {
    return "rejected";
  }
  if (text.includes("manual import")) {
    return "manual import";
  }
  return item.trackedDownloadStatus ?? item.status ?? "queue";
}

// ============ types ============

export type FixerQueueItem = QueueItem & { issueType: string };

export type FixerQueueSnapshot = {
  fetchedAt: number;
  items: FixerQueueItem[];
  errors: Partial<Record<MediaService, string>>;
};

export type FixerClients = {
  sonarr: SonarrFixerClientPort | null;
  radarr: RadarrFixerClientPort | null;
};

export type FixerAnalysisRow = typeof fixerAnalyses.$inferSelect;

export type FixerRunOutcome = {
  analysisId: string;
  status: "completed" | "failed" | "cancelled";
  result?: AnalysisResult;
  error?: string;
};

export type FixerApplyOutcome = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  commandId?: number;
  historyId?: number;
};

export type FixerActionOpts = {
  sourceKind?: FixerHistorySourceKind;
  analysisId?: string;
  confidence?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serviceName(service: MediaService): string {
  return service === "radarr" ? "Radarr" : "Sonarr";
}

function itemKey(service: MediaService, queueItemId: number): string {
  return `${service}:${queueItemId}`;
}

/** Ported from sonarr_fixer ipc.ts: analysis result when candidates cannot load. */
function candidateLoadFailure(queueItem: QueueItem, error: unknown): AnalysisResult {
  const message = `Could not load ${serviceName(queueItem.service)} manual import candidates: ${errorMessage(error)}`;
  return {
    queueItemId: queueItem.id,
    candidates: [],
    proposal: fallbackProposal(message),
    validation: { ok: true, issues: [] },
    status: "needs_review",
    log: [message],
  };
}

function resultStatus(proposal: ResolutionProposal, validation: ValidationResult) {
  return proposal.action === "needs_review" || !validation.ok ? "needs_review" : "proposal";
}

export class FixerService {
  private queueCache: FixerQueueSnapshot | null = null;
  private readonly activeByItem = new Map<
    string,
    { controller: AbortController; analysisId: string }
  >();
  private readonly running = new Map<string, Promise<FixerRunOutcome>>();
  private readonly now: () => number;
  private readonly makeId: () => string;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly clients: FixerClients,
    private readonly runner: FixerPiRunner,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    opts: { now?: () => number; makeId?: () => string } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.makeId = opts.makeId ?? (() => nanoid());
    // A process restart cannot preserve the in-memory runner/controller that
    // owns a running row. Fail those orphaned rows immediately so the UI does
    // not display an analysis as "running" forever after a reload or crash.
    this.db
      .update(fixerAnalyses)
      .set({
        status: "failed",
        completedAt: this.now(),
        error: "Analysis was interrupted by an application restart.",
      })
      .where(eq(fixerAnalyses.status, "running"))
      .run();
  }

  // ============ queue ============

  async refreshQueue(): Promise<FixerQueueSnapshot> {
    const items: FixerQueueItem[] = [];
    const errors: Partial<Record<MediaService, string>> = {};
    await Promise.all(
      (["sonarr", "radarr"] as const).map(async (service) => {
        const client = this.clients[service];
        if (!client) {
          return;
        }
        try {
          for (const item of await client.listQueue()) {
            items.push({ ...item, issueType: queueIssueType(item) });
          }
        } catch (error) {
          errors[service] = errorMessage(error);
          this.log.warn({ err: error, service }, "fixer queue refresh failed");
        }
      }),
    );
    items.sort((a, b) => a.service.localeCompare(b.service) || a.id - b.id);
    this.queueCache = { fetchedAt: this.now(), items, errors };
    this.emitQueueChanged();
    return this.queueCache;
  }

  async getQueue(): Promise<FixerQueueSnapshot> {
    return this.queueCache ?? (await this.refreshQueue());
  }

  private emitQueueChanged(): void {
    const snapshot = this.queueCache;
    if (snapshot) {
      this.bus.emit("fixer.queue.changed", {
        fetchedAt: snapshot.fetchedAt,
        count: snapshot.items.length,
        errors: snapshot.errors,
      });
    }
  }

  private dropFromQueueCache(service: MediaService, queueItemId: number): void {
    if (!this.queueCache) {
      return;
    }
    const removed = this.queueCache.items.find(
      (item) => item.service === service && item.id === queueItemId,
    );
    const items = this.queueCache.items.filter((item) => {
      if (item.service !== service) return true;
      if (item.id === queueItemId) return false;
      return !removed?.downloadId || item.downloadId !== removed.downloadId;
    });
    if (items.length !== this.queueCache.items.length) {
      this.queueCache = { ...this.queueCache, items };
      this.emitQueueChanged();
    }
  }

  /** Latest saved analysis for this download, even if its queue ID changed. */
  analysisForItem(
    item: Pick<QueueItem, "id" | "service" | "downloadId">,
  ): FixerAnalysisRow | undefined {
    const identity = item.downloadId
      ? eq(fixerAnalyses.downloadId, item.downloadId)
      : eq(fixerAnalyses.queueItemId, item.id);
    return this.db
      .select()
      .from(fixerAnalyses)
      .where(and(eq(fixerAnalyses.service, item.service), identity))
      .orderBy(desc(fixerAnalyses.createdAt))
      .get();
  }

  latestApply(analysisId: string) {
    return this.db
      .select()
      .from(fixerHistory)
      .where(eq(fixerHistory.analysisId, analysisId))
      .orderBy(desc(fixerHistory.at), desc(fixerHistory.id))
      .get();
  }

  providerRetryAt(): number | null {
    const rows = this.db
      .select({ error: fixerAnalyses.error, completedAt: fixerAnalyses.completedAt })
      .from(fixerAnalyses)
      .where(
        and(
          eq(fixerAnalyses.status, "failed"),
          gt(fixerAnalyses.completedAt, this.now() - 60 * 60_000),
        ),
      )
      .orderBy(desc(fixerAnalyses.createdAt))
      .all();
    const failure = rows.find((row) => isProviderUsageLimit(row.error ?? ""));
    const retryAt = failure?.completedAt ? failure.completedAt + 60 * 60_000 : 0;
    return retryAt > this.now() ? retryAt : null;
  }

  retryAt(item: FixerQueueItem): number | null {
    const identity = item.downloadId
      ? eq(fixerAnalyses.downloadId, item.downloadId)
      : eq(fixerAnalyses.queueItemId, item.id);
    const rows = this.db
      .select({
        id: fixerAnalyses.id,
        status: fixerAnalyses.status,
        createdAt: fixerAnalyses.createdAt,
        completedAt: fixerAnalyses.completedAt,
      })
      .from(fixerAnalyses)
      .where(and(eq(fixerAnalyses.service, item.service), identity))
      .orderBy(desc(fixerAnalyses.createdAt))
      .all();
    let failures = 0;
    let lastAttempt = 0;
    for (const row of rows) {
      const applied = this.latestApply(row.id);
      if (row.status !== "failed" && applied?.result !== "error") break;
      failures += 1;
      lastAttempt = Math.max(lastAttempt, row.completedAt ?? row.createdAt, applied?.at ?? 0);
    }
    const retryAt =
      lastAttempt + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(failures - 1, 5));
    return failures > 0 && retryAt > this.now() ? retryAt : null;
  }

  shouldProcess(item: FixerQueueItem, pendingOnly = false): boolean {
    if (this.providerRetryAt() || this.retryAt(item)) return false;
    let row = this.analysisForItem(item);
    if (!row) return !pendingOnly;
    if (row.status === "failed") {
      if (!pendingOnly) return true;
      const identity = item.downloadId
        ? eq(fixerAnalyses.downloadId, item.downloadId)
        : eq(fixerAnalyses.queueItemId, item.id);
      row = this.db
        .select()
        .from(fixerAnalyses)
        .where(
          and(
            eq(fixerAnalyses.service, item.service),
            identity,
            eq(fixerAnalyses.status, "completed"),
          ),
        )
        .orderBy(desc(fixerAnalyses.createdAt))
        .get();
      if (!row) return false;
    }
    if (
      row.status !== "completed" ||
      !row.proposal ||
      !this.settings.get().fixerAutoApply ||
      this.settings.get().dryRun
    )
      return false;
    if (this.latestApply(row.id)?.result === "ok") return false;
    return (
      autoApplyBlockReason(
        row.proposal as unknown as ResolutionProposal,
        row.validation as unknown as ValidationResult | null,
        this.settings.get(),
      ) === null
    );
  }

  private requireClient(service: MediaService): FixerClientPort {
    const client = this.clients[service];
    if (!client) {
      throw new Error(`${serviceName(service)} is not configured.`);
    }
    return client;
  }

  private async findQueueItem(
    service: MediaService,
    queueItemId: number,
  ): Promise<FixerQueueItem | undefined> {
    const find = () =>
      this.queueCache?.items.find((item) => item.service === service && item.id === queueItemId);
    if (!this.queueCache) {
      await this.refreshQueue();
    }
    let item = find();
    if (!item) {
      await this.refreshQueue();
      item = find();
    }
    return item;
  }

  private async requireQueueItem(
    service: MediaService,
    queueItemId: number,
  ): Promise<FixerQueueItem> {
    const item = await this.findQueueItem(service, queueItemId);
    if (!item) {
      throw new Error(
        `Queue item ${queueItemId} was not found in the ${serviceName(service)} queue. Refresh the queue.`,
      );
    }
    return item;
  }

  private async currentQueueItem(
    service: MediaService,
    queueItemId: number,
    downloadId?: string | null,
  ): Promise<FixerQueueItem | undefined> {
    const snapshot = await this.refreshQueue();
    if (snapshot.errors[service])
      throw new Error(`Cannot verify current queue: ${snapshot.errors[service]}`);
    return snapshot.items.find(
      (item) =>
        item.service === service &&
        (downloadId ? item.downloadId === downloadId : item.id === queueItemId),
    );
  }

  private activeDubVerdict(
    queueItem: QueueItem,
    candidates: ManualImportCandidate[],
  ): FixerDubVerdictContext | undefined {
    const subjectId = queueItem.service === "sonarr" ? queueItem.seriesId : queueItem.movieId;
    if (subjectId == null) {
      return undefined;
    }
    const row = this.db
      .select()
      .from(aiVerdicts)
      .where(
        and(
          eq(aiVerdicts.subjectKey, `${queueItem.service}:${subjectId}`),
          isNull(aiVerdicts.supersededBy),
          gt(aiVerdicts.recheckAfter, this.now()),
        ),
      )
      .orderBy(desc(aiVerdicts.checkedAt))
      .get();
    if (!row) {
      return undefined;
    }
    const perSeason =
      row.perSeason?.flatMap((entry) =>
        isAiVerdictValue(entry.verdict)
          ? [{ season: entry.season, verdict: entry.verdict, note: entry.note }]
          : [],
      ) ?? null;
    const targetSeason =
      queueItem.service === "sonarr" ? targetSeasonNumber(queueItem, candidates) : undefined;
    const seasonVerdict = perSeason?.length
      ? perSeason.find((entry) => entry.season === targetSeason)
      : undefined;
    if (queueItem.service === "sonarr" && perSeason?.length && !seasonVerdict) {
      return undefined;
    }
    return {
      verdict: seasonVerdict?.verdict ?? row.verdict,
      confidence: row.confidence,
      germanTitle: row.germanTitle,
      perSeason: seasonVerdict ? [seasonVerdict] : perSeason,
      evidence: row.evidence,
      expectedAvailability: row.expectedAvailability,
      checkedAt: row.checkedAt,
      recheckAfter: row.recheckAfter,
    };
  }

  // ============ analysis ============

  /** 202-style: creates the analysis row and starts the run without awaiting it. */
  async analyze(service: MediaService, queueItemId: number): Promise<{ analysisId: string }> {
    const client = this.requireClient(service);
    const queueItem = await this.requireQueueItem(service, queueItemId);
    const key = itemKey(service, queueItemId);
    this.activeByItem.get(key)?.controller.abort();

    const controller = new AbortController();
    const analysisId = this.makeId();
    this.activeByItem.set(key, { controller, analysisId });
    this.db
      .insert(fixerAnalyses)
      .values({
        id: analysisId,
        createdAt: this.now(),
        service,
        queueItemId,
        downloadId: queueItem.downloadId ?? null,
        itemLabel: queueItemLabel(queueItem),
        status: "running",
        events: [],
      })
      .run();

    const promise = this.runAnalysis(analysisId, client, queueItem, controller).finally(() => {
      this.running.delete(analysisId);
      const active = this.activeByItem.get(key);
      if (active?.analysisId === analysisId) {
        this.activeByItem.delete(key);
      }
    });
    this.running.set(analysisId, promise);
    return { analysisId };
  }

  /** Resolves once the analysis run settles (running promise or persisted row). */
  async waitForAnalysis(analysisId: string): Promise<FixerRunOutcome> {
    const promise = this.running.get(analysisId);
    if (promise) {
      return promise;
    }
    const row = this.getAnalysis(analysisId);
    if (!row) {
      throw new Error(`Unknown analysis ${analysisId}.`);
    }
    return this.outcomeFromRow(row);
  }

  async analyzeAndWait(service: MediaService, queueItemId: number): Promise<FixerRunOutcome> {
    const { analysisId } = await this.analyze(service, queueItemId);
    return this.waitForAnalysis(analysisId);
  }

  getAnalysis(analysisId: string): FixerAnalysisRow | undefined {
    return this.db.select().from(fixerAnalyses).where(eq(fixerAnalyses.id, analysisId)).get();
  }

  cancel(service: MediaService, queueItemId: number): boolean {
    const active = this.activeByItem.get(itemKey(service, queueItemId));
    if (!active) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  async wait(): Promise<void> {
    await Promise.allSettled(this.running.values());
  }

  cancelAll(): number {
    let count = 0;
    for (const active of this.activeByItem.values()) {
      active.controller.abort();
      count += 1;
    }
    return count;
  }

  private outcomeFromRow(row: FixerAnalysisRow): FixerRunOutcome {
    const status =
      row.status === "completed"
        ? "completed"
        : row.status === "cancelled"
          ? "cancelled"
          : "failed";
    let result: AnalysisResult | undefined;
    if (row.proposal) {
      const proposal = row.proposal as unknown as ResolutionProposal;
      const validation = (row.validation ?? {
        ok: true,
        issues: [],
      }) as unknown as ValidationResult;
      result = {
        queueItemId: row.queueItemId,
        candidates: (row.candidates ?? []) as ManualImportCandidate[],
        proposal,
        validation,
        status: resultStatus(proposal, validation),
        log: [],
      };
    }
    return {
      analysisId: row.id,
      status,
      ...(result ? { result } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private async runAnalysis(
    analysisId: string,
    client: FixerClientPort,
    queueItem: FixerQueueItem,
    controller: AbortController,
  ): Promise<FixerRunOutcome> {
    const { service } = queueItem;
    const events: FixerAnalysisEvent[] = [];
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      persistTimer = undefined;
      this.db
        .update(fixerAnalyses)
        .set({ events: [...events] })
        .where(eq(fixerAnalyses.id, analysisId))
        .run();
    };
    const record = (event: FixerAnalysisEvent) => {
      events.push(event);
      if (events.length > MAX_PERSISTED_EVENTS) {
        events.shift();
      }
      persistTimer ??= setTimeout(persist, 250);
      // SSE payload uses the GUI-facing ResolverEvent shape (api-types contract);
      // the persisted rows keep the richer internal FixerAnalysisEvent.
      this.bus.emit("fixer.analysis.progress", {
        analysisId,
        service,
        queueItemId: queueItem.id,
        event: toResolverEvent(event),
      });
    };
    const step = (
      level: "info" | "warning" | "error",
      source: "fixer" | "pi" | "sonarr" | "radarr",
      message: string,
    ) => record({ kind: "step", level, source, message, itemId: queueItem.id, ts: this.now() });
    const finish = (
      status: "completed" | "failed" | "cancelled",
      result?: AnalysisResult,
      error?: string,
    ): FixerRunOutcome => {
      clearTimeout(persistTimer);
      this.db
        .update(fixerAnalyses)
        .set({
          status,
          completedAt: this.now(),
          events: [...events],
          proposal: result ? (result.proposal as unknown as Record<string, unknown>) : null,
          validation: result ? (result.validation as unknown as Record<string, unknown>) : null,
          candidates: result ? (result.candidates as unknown[]) : null,
          error: error ?? null,
        })
        .where(eq(fixerAnalyses.id, analysisId))
        .run();
      this.bus.emit("fixer.analysis.completed", {
        analysisId,
        service,
        queueItemId: queueItem.id,
        status,
        ...(result
          ? {
              result: {
                proposal: result.proposal,
                validation: result.validation,
                status: result.status,
              },
            }
          : {}),
        ...(error ? { error } : {}),
      });
      return {
        analysisId,
        status,
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
      };
    };

    try {
      if (!canLoadManualImportCandidates(queueItem)) {
        step("info", "fixer", "Skipping analysis for an in-progress or non-actionable download.");
        return finish(
          "completed",
          candidateLoadFailure(
            queueItem,
            new Error("Download is still in progress or is not ready for manual import."),
          ),
        );
      }

      step("info", "fixer", "Loading manual import candidates.");
      let candidates: ManualImportCandidate[];
      try {
        candidates = await client.getManualImportCandidates(queueItem);
      } catch (error) {
        step("error", "fixer", `Could not load manual import candidates: ${errorMessage(error)}`);
        return finish("completed", candidateLoadFailure(queueItem, error));
      }
      step("info", "fixer", `Loaded ${candidates.length} manual import candidates.`);

      const result = await resolveQueueItem({
        queueItem,
        candidates,
        dubVerdict: this.activeDubVerdict(queueItem, candidates),
        client,
        runner: this.runner,
        signal: controller.signal,
        onEvent: record,
      });

      if (controller.signal.aborted) {
        return finish("cancelled", undefined, "Analysis was cancelled.");
      }

      step(
        result.validation.ok ? "info" : "warning",
        "pi",
        `Pi proposal: ${result.proposal.action} (${Math.round(result.proposal.confidence * 100)}%).`,
      );
      return finish("completed", result);
    } catch (error) {
      if (controller.signal.aborted) {
        return finish("cancelled", undefined, "Analysis was cancelled.");
      }
      const message = errorMessage(error);
      this.log.warn({ err: error, analysisId }, "fixer analysis failed");
      step("error", "fixer", `Analysis failed: ${message}`);
      return finish("failed", undefined, message);
    }
  }

  // ============ mutations (server-side dry-run gate) ============

  private applyRemovalProposal(
    row: FixerAnalysisRow,
    proposal: ResolutionProposal,
    analysisId: string,
    opts: FixerActionOpts,
  ): Promise<FixerApplyOutcome> {
    if (!proposal.queueRemovalOptions) {
      return Promise.resolve({
        ok: false,
        dryRun: false,
        message: "Removal proposal has no queue removal options.",
      });
    }
    return this.removeQueueItem(row.service, row.queueItemId, proposal.queueRemovalOptions, {
      sourceKind: opts.sourceKind ?? "ai_user",
      analysisId,
      confidence: opts.confidence ?? proposal.confidence,
    });
  }

  async apply(
    analysisId: string,
    candidateIds?: string[],
    opts: FixerActionOpts = {},
  ): Promise<FixerApplyOutcome> {
    let outcome: FixerApplyOutcome;
    try {
      outcome = await this.applyProposal(analysisId, candidateIds, opts);
    } catch (error) {
      outcome = { ok: false, dryRun: this.settings.get().dryRun, message: errorMessage(error) };
    }
    const row = this.getAnalysis(analysisId);
    if (!outcome.ok && !outcome.historyId && row) {
      outcome.historyId = recordFixerHistory(this.db, {
        at: this.now(),
        service: row.service,
        itemLabel: row.itemLabel,
        action: row.proposal?.action === "remove_queue_item" ? "remove" : "import",
        sourceKind: opts.sourceKind ?? "ai_user",
        analysisId,
        dryRun: outcome.dryRun,
        result: "error",
        detail: { message: outcome.message },
      });
    }
    this.emitQueueChanged();
    return outcome;
  }

  private async applyProposal(
    analysisId: string,
    candidateIds?: string[],
    opts: FixerActionOpts = {},
  ): Promise<FixerApplyOutcome> {
    const row = this.getAnalysis(analysisId);
    if (!row) {
      return { ok: false, dryRun: false, message: `Unknown analysis ${analysisId}.` };
    }
    if (row.status !== "completed" || !row.proposal) {
      return {
        ok: false,
        dryRun: false,
        message: `Analysis ${analysisId} has no completed proposal to apply.`,
      };
    }
    const proposal = normalizeProposal(row.proposal as unknown as ResolutionProposal);
    if (proposal.action === "remove_queue_item") {
      return this.applyRemovalProposal(row, proposal, analysisId, opts);
    }
    const candidates = (row.candidates ?? []) as ManualImportCandidate[];
    let effective = proposal;
    if (candidateIds) {
      const subset = new Set(candidateIds);
      effective = {
        ...proposal,
        selectedCandidateIds: proposal.selectedCandidateIds.filter((id) => subset.has(id)),
        selectedImports: proposal.selectedImports.filter((si) => subset.has(si.candidateId)),
      };
      if (effective.selectedCandidateIds.length === 0) {
        return { ok: false, dryRun: false, message: "No proposed candidates selected." };
      }
    }
    if (effective.action !== "import_candidates") {
      return {
        ok: false,
        dryRun: false,
        message: `Proposal action ${effective.action} is not an import.`,
      };
    }

    let client: FixerClientPort;
    let queueItem: FixerQueueItem;
    try {
      client = this.requireClient(row.service);
      const current = await this.currentQueueItem(row.service, row.queueItemId, row.downloadId);
      if (!current) throw new Error("Download is no longer in the queue. Refresh before applying.");
      if (this.autoApplyDisabled(opts)) throw new Error("Auto-apply was disabled; no change made.");
      queueItem = current;
    } catch (error) {
      return { ok: false, dryRun: false, message: errorMessage(error) };
    }

    // The resolver may use sonarr_find_episodes to map anime/scene-numbered files
    // to valid episode ids that are not present in Sonarr's initially parsed
    // manual-import candidates. Treat those selected ids as structurally valid
    // here; the Sonarr client's live preflight reloads the full series and is
    // the authority that verifies the ids actually exist before any command.
    const selectedSonarrEpisodeIds =
      row.service === "sonarr"
        ? effective.selectedImports.flatMap((selectedImport) => selectedImport.episodeIds)
        : [];
    const validation = validateProposalForImport(
      candidates,
      effective,
      queueItem,
      selectedSonarrEpisodeIds,
    );
    if (!validation.ok) {
      return {
        ok: false,
        dryRun: false,
        message: validation.issues.map((issue) => issue.message).join(" "),
      };
    }

    const sourceKind = opts.sourceKind ?? "ai_user";
    const base = {
      service: row.service,
      itemLabel: row.itemLabel,
      action: "import" as FixerHistoryAction,
      sourceKind,
      confidence: opts.confidence ?? effective.confidence,
      analysisId,
    };
    if (this.settings.get().dryRun) {
      try {
        const preflight = await client.preflightImportProposal(queueItem, candidates, effective);
        if (!preflight.ok) {
          return { ok: false, dryRun: true, message: preflight.message };
        }
      } catch (error) {
        return {
          ok: false,
          dryRun: true,
          message: `Dry-run preflight failed: ${errorMessage(error)}`,
        };
      }
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: true,
        result: "simulated",
        detail: {
          wouldHave: {
            action: "import_candidates",
            queueItemId: row.queueItemId,
            candidateIds: effective.selectedCandidateIds,
            selectedImports: effective.selectedImports,
          },
        },
      });
      return {
        ok: true,
        dryRun: true,
        historyId,
        message: `Dry-run: would import ${effective.selectedCandidateIds.length} candidate(s) for ${row.itemLabel}.`,
      };
    }

    try {
      const started = await client.applyImportProposal(
        queueItem,
        candidates,
        effective,
        () => !this.settings.get().dryRun && !this.autoApplyDisabled(opts),
      );
      const result =
        started.ok && client.verifyImportApplied
          ? await client.verifyImportApplied(queueItem, started)
          : started;
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: false,
        result: result.ok ? "ok" : "error",
        detail: {
          message: result.message,
          candidateIds: effective.selectedCandidateIds,
          ...(result.commandId === undefined ? {} : { commandId: result.commandId }),
        },
      });
      if (result.ok) {
        this.dropFromQueueCache(row.service, row.queueItemId);
        if (client.verifyImportApplied) {
          await this.refreshQueue();
        }
      }
      return {
        ok: result.ok,
        dryRun: false,
        historyId,
        message: result.message,
        ...(result.commandId === undefined ? {} : { commandId: result.commandId }),
      };
    } catch (error) {
      const message = errorMessage(error);
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: false,
        result: "error",
        detail: { message },
      });
      return { ok: false, dryRun: false, historyId, message };
    }
  }

  async removeQueueItem(
    service: MediaService,
    queueItemId: number,
    options: QueueRemovalOptions = manualRemovalOptions,
    opts: FixerActionOpts = {},
  ): Promise<FixerApplyOutcome> {
    const action: FixerHistoryAction = options.blocklist ? "blocklist" : "remove";
    const outcome = await this.removal(service, queueItemId, options, action, opts);
    this.emitQueueChanged();
    return outcome;
  }

  async ignoreQueueItem(
    service: MediaService,
    queueItemId: number,
    opts: FixerActionOpts = {},
  ): Promise<FixerApplyOutcome> {
    return this.removal(service, queueItemId, ignoreRemovalOptions, "ignore", opts);
  }

  private async removal(
    service: MediaService,
    queueItemId: number,
    options: QueueRemovalOptions,
    action: FixerHistoryAction,
    opts: FixerActionOpts,
  ): Promise<FixerApplyOutcome> {
    let client: FixerClientPort;
    try {
      client = this.requireClient(service);
    } catch (error) {
      return { ok: false, dryRun: false, message: errorMessage(error) };
    }
    const analysis = opts.analysisId ? this.getAnalysis(opts.analysisId) : undefined;
    if (opts.analysisId && (!analysis || analysis.service !== service)) {
      return { ok: false, dryRun: false, message: "Removal analysis does not match the service." };
    }
    const queueItem = await this.findQueueItem(service, queueItemId);
    const downloadId = analysis?.downloadId ?? queueItem?.downloadId;
    const itemLabel =
      analysis?.itemLabel ?? (queueItem ? queueItemLabel(queueItem) : `Queue item ${queueItemId}`);
    const base = {
      service,
      itemLabel,
      action,
      sourceKind: opts.sourceKind ?? "user",
      ...(opts.confidence === undefined ? {} : { confidence: opts.confidence }),
      ...(opts.analysisId === undefined ? {} : { analysisId: opts.analysisId }),
    };

    if (this.settings.get().dryRun) {
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: true,
        result: "simulated",
        detail: { wouldHave: { action, queueItemId, options } },
      });
      return {
        ok: true,
        dryRun: true,
        historyId,
        message: `Dry-run: would ${action} ${itemLabel}.`,
      };
    }

    try {
      const current = await this.currentQueueItem(service, queueItemId, downloadId);
      if (!current && !downloadId && !queueItem)
        throw new Error("Queue item could not be identified. Refresh before removing.");
      let result = {
        ok: true,
        message: "Download is no longer in the queue. Removal options were not sent.",
      };
      if (current) {
        if (this.settings.get().dryRun)
          throw new Error("Dry-run was enabled before removal; no change made.");
        if (this.autoApplyDisabled(opts))
          throw new Error("Auto-apply was disabled; no change made.");
        result = await this.removeCurrentItem(client, current, options);
      }
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: false,
        result: result.ok ? "ok" : "error",
        detail: { message: result.message, options },
      });
      if (result.ok) {
        this.dropFromQueueCache(service, current?.id ?? queueItemId);
      }
      return { ok: result.ok, dryRun: false, historyId, message: result.message };
    } catch (error) {
      const message = errorMessage(error);
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: false,
        result: "error",
        detail: { message, options },
      });
      return { ok: false, dryRun: false, historyId, message };
    }
  }

  // ============ history ============

  private autoApplyDisabled(opts: FixerActionOpts): boolean {
    return opts.sourceKind === "ai_auto" && !this.settings.get().fixerAutoApply;
  }

  private async removeCurrentItem(
    client: FixerClientPort,
    current: FixerQueueItem,
    options: QueueRemovalOptions,
  ) {
    let result: { ok: boolean; message: string };
    try {
      result = await client.removeQueueItem(current.id, options);
    } catch (error) {
      result = { ok: false, message: errorMessage(error) };
    }
    if (!result.ok && result.message.includes("404")) {
      if (!(await this.currentQueueItem(current.service, current.id, current.downloadId))) {
        return {
          ok: true,
          message:
            "Download disappeared from the queue after a 404. Removal options could not be confirmed.",
        };
      }
    }
    return result;
  }

  listHistory(opts: { page?: number; pageSize?: number } = {}): FixerHistoryPage {
    return listFixerHistory(this.db, opts);
  }
}
