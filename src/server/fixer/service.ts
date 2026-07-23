import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { nanoid } from "nanoid";
import type {
  AnalysisResult,
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
import { fixerAnalyses } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import type { FixerAnalysisEvent, FixerPiRunner } from "./ai-port.js";
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
    const items = this.queueCache.items.filter(
      (item) => !(item.service === service && item.id === queueItemId),
    );
    if (items.length !== this.queueCache.items.length) {
      this.queueCache = { ...this.queueCache, items };
      this.emitQueueChanged();
    }
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
    const record = (event: FixerAnalysisEvent) => {
      events.push(event);
      if (events.length > MAX_PERSISTED_EVENTS) {
        events.shift();
      }
      this.db
        .update(fixerAnalyses)
        .set({ events: [...events] })
        .where(eq(fixerAnalyses.id, analysisId))
        .run();
      this.bus.emit("fixer.analysis.progress", {
        analysisId,
        service,
        queueItemId: queueItem.id,
        event,
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

  async apply(
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
      queueItem = await this.requireQueueItem(row.service, row.queueItemId);
    } catch (error) {
      return { ok: false, dryRun: false, message: errorMessage(error) };
    }

    const validation = validateProposalForImport(candidates, effective, queueItem);
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
      const result = await client.applyImportProposal(queueItem, candidates, effective);
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
    return this.removal(service, queueItemId, options, action, opts);
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
    const queueItem = await this.findQueueItem(service, queueItemId);
    const itemLabel = queueItem ? queueItemLabel(queueItem) : `Queue item ${queueItemId}`;
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
      const result = await client.removeQueueItem(queueItemId, options);
      const historyId = recordFixerHistory(this.db, {
        ...base,
        at: this.now(),
        dryRun: false,
        result: result.ok ? "ok" : "error",
        detail: { message: result.message, options },
      });
      if (result.ok) {
        this.dropFromQueueCache(service, queueItemId);
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

  listHistory(opts: { page?: number; pageSize?: number } = {}): FixerHistoryPage {
    return listFixerHistory(this.db, opts);
  }
}
