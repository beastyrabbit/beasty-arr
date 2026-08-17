import type { FastifyBaseLogger } from "fastify";
import type {
  AnalysisResult,
  MediaService,
  QueueRemovalOptions,
} from "../../shared/fixer-types.js";
import type { SettingsService } from "../config/settings.js";
import type {
  FixerActionOpts,
  FixerApplyOutcome,
  FixerQueueItem,
  FixerQueueSnapshot,
  FixerRunOutcome,
} from "./service.js";

// ============ auto-apply gates (ported from sonarr_fixer renderer utils/candidates.ts + App.tsx) ============

export function shouldAutoImportResult(
  result: AnalysisResult,
  autoImportConfidence: number,
): boolean {
  return (
    result.proposal.action === "import_candidates" &&
    result.validation.ok &&
    result.proposal.confidence >= autoImportConfidence
  );
}

function canAutoApplyRemovalOptions(options: QueueRemovalOptions): boolean {
  return (
    options.removeFromClient &&
    !options.changeCategory &&
    // skipRedownload only has defined Sonarr/Radarr semantics when the
    // release is also marked failed/blocklisted.
    (!options.skipRedownload || options.blocklist)
  );
}

export function autoRemovalOptionsForResult(
  result: AnalysisResult,
  autoRemoveConfidence: number,
): QueueRemovalOptions | undefined {
  if (
    result.proposal.action === "remove_queue_item" &&
    result.validation.ok &&
    result.proposal.queueRemovalOptions &&
    canAutoApplyRemovalOptions(result.proposal.queueRemovalOptions) &&
    result.proposal.confidence >= autoRemoveConfidence
  ) {
    return result.proposal.queueRemovalOptions;
  }
  return undefined;
}

/** Ported from sonarr_fixer renderer utils/queue.ts: one representative per download. */
export function uniqueQueueItemsByDownload<
  T extends { service?: MediaService; downloadId?: string },
>(items: T[]): T[] {
  const seenDownloadIds = new Set<string>();
  return items.filter((item) => {
    if (!item.downloadId) {
      return true;
    }
    const key = `${item.service ?? "unknown"}:${item.downloadId}`;
    if (seenDownloadIds.has(key)) {
      return false;
    }
    seenDownloadIds.add(key);
    return true;
  });
}

// ============ bulk runner ============

/** Structural port of FixerService — the orchestrator passes the service itself. */
export interface FixerBulkServicePort {
  refreshQueue(): Promise<FixerQueueSnapshot>;
  hasAnalysis(item: FixerQueueItem): boolean;
  analyzeAndWait(service: MediaService, queueItemId: number): Promise<FixerRunOutcome>;
  apply(
    analysisId: string,
    candidateIds?: string[],
    opts?: FixerActionOpts,
  ): Promise<FixerApplyOutcome>;
  removeQueueItem(
    service: MediaService,
    queueItemId: number,
    options?: QueueRemovalOptions,
    opts?: FixerActionOpts,
  ): Promise<FixerApplyOutcome>;
  cancel(service: MediaService, queueItemId: number): boolean;
}

export type FixerBulkStatus = {
  running: boolean;
  cancelRequested: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  issueTypes: string[] | null;
  autoApply: boolean;
  total: number;
  completed: number;
  failed: number;
  autoImported: number;
  autoRemoved: number;
  inFlight: Array<{ service: MediaService; queueItemId: number; title: string }>;
};

function clampParallelism(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(10, Math.max(1, Math.round(value)));
}

export class FixerBulk {
  private status: FixerBulkStatus = FixerBulk.idleStatus();
  private readonly inFlight = new Map<
    string,
    { service: MediaService; queueItemId: number; title: string }
  >();
  private donePromise: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly service: FixerBulkServicePort,
    private readonly settings: SettingsService,
    private readonly log: FastifyBaseLogger,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private static idleStatus(): FixerBulkStatus {
    return {
      running: false,
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
      issueTypes: null,
      autoApply: false,
      total: 0,
      completed: 0,
      failed: 0,
      autoImported: 0,
      autoRemoved: 0,
      inFlight: [],
    };
  }

  getStatus(): FixerBulkStatus {
    return { ...this.status, inFlight: [...this.inFlight.values()] };
  }

  /** Resolves when the current run finishes (tests / graceful shutdown). */
  async wait(): Promise<void> {
    await this.donePromise;
  }

  /**
   * 202-style: refreshes the queue, picks matching analyzable items (one
   * representative per downloadId) and runs the worker pool in the background.
   */
  async start(
    input: {
      issueTypes?: string[];
      targets?: Array<{ service: MediaService; queueItemId: number }>;
      skipAnalyzed?: boolean;
    } = {},
  ): Promise<{
    ok: boolean;
    total: number;
    message?: string;
  }> {
    if (this.status.running) {
      return { ok: false, total: 0, message: "A bulk analysis is already running." };
    }
    const settings = this.settings.get();
    this.status = {
      ...FixerBulk.idleStatus(),
      running: true,
      startedAt: this.now(),
      issueTypes: input.issueTypes?.length ? [...input.issueTypes] : null,
      autoApply: settings.fixerAutoApply,
    };
    this.inFlight.clear();

    let items: FixerQueueItem[];
    try {
      const snapshot = await this.service.refreshQueue();
      const issueTypeSet = input.issueTypes?.length ? new Set(input.issueTypes) : null;
      const targetSet = input.targets
        ? new Set(input.targets.map((target) => `${target.service}:${target.queueItemId}`))
        : null;
      items = uniqueQueueItemsByDownload(
        snapshot.items.filter(
          (item) =>
            item.canAnalyze &&
            (!input.skipAnalyzed || !this.service.hasAnalysis(item)) &&
            (!issueTypeSet || issueTypeSet.has(item.issueType)) &&
            (!targetSet || targetSet.has(`${item.service}:${item.id}`)),
        ),
      );
    } catch (error) {
      this.status = { ...this.status, running: false, finishedAt: this.now() };
      return {
        ok: false,
        total: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.status.total = items.length;
    if (items.length === 0) {
      this.status = { ...this.status, running: false, finishedAt: this.now() };
      return { ok: true, total: 0 };
    }

    this.donePromise = this.runWorkers(items, clampParallelism(settings.fixerParallelism)).catch(
      (error) => {
        this.log.error({ err: error }, "fixer bulk run crashed");
      },
    );
    return { ok: true, total: items.length };
  }

  cancel(): boolean {
    if (!this.status.running) {
      return false;
    }
    this.status.cancelRequested = true;
    for (const entry of this.inFlight.values()) {
      this.service.cancel(entry.service, entry.queueItemId);
    }
    return true;
  }

  private async runWorkers(items: FixerQueueItem[], parallelism: number): Promise<void> {
    let nextIndex = 0;
    const next = () => {
      const index = nextIndex;
      nextIndex += 1;
      return index;
    };
    const workerCount = Math.min(parallelism, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => this.worker(items, next)));
    this.status = { ...this.status, running: false, finishedAt: this.now() };
    this.inFlight.clear();
    // Give the GUI a fresh queue after auto-applies/removals (also emits fixer.queue.changed).
    try {
      await this.service.refreshQueue();
    } catch (error) {
      this.log.warn({ err: error }, "fixer bulk final queue refresh failed");
    }
  }

  private async worker(items: FixerQueueItem[], next: () => number): Promise<void> {
    while (!this.status.cancelRequested) {
      const index = next();
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (!item) {
        return;
      }
      const key = `${item.service}:${item.id}`;
      this.inFlight.set(key, {
        service: item.service,
        queueItemId: item.id,
        title: item.title,
      });
      try {
        const outcome = await this.service.analyzeAndWait(item.service, item.id);
        if (outcome.status === "completed" && outcome.result) {
          this.status.completed += 1;
          if (this.status.autoApply) {
            await this.autoApplyOutcome(item, outcome, outcome.result);
          }
        } else {
          this.status.failed += 1;
        }
      } catch (error) {
        this.status.failed += 1;
        this.log.warn(
          { err: error, service: item.service, queueItemId: item.id },
          "fixer bulk analysis failed",
        );
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Ported from sonarr_fixer App.tsx applyAutoResult. The dry-run gate lives in
   * FixerService.apply/removeQueueItem: with dryRun on, these record simulated
   * fixer_history rows and never touch the arr.
   */
  private async autoApplyOutcome(
    item: FixerQueueItem,
    outcome: FixerRunOutcome,
    result: AnalysisResult,
  ): Promise<void> {
    const settings = this.settings.get();
    if (shouldAutoImportResult(result, settings.fixerAutoImportConfidence)) {
      const applied = await this.service.apply(
        outcome.analysisId,
        result.proposal.selectedCandidateIds,
        { sourceKind: "ai_auto" },
      );
      if (applied.ok) {
        this.status.autoImported += 1;
      } else {
        this.status.failed += 1;
        this.log.warn(
          { service: item.service, queueItemId: item.id, message: applied.message },
          "fixer bulk auto-import failed",
        );
      }
      return;
    }
    const options = autoRemovalOptionsForResult(result, settings.fixerAutoRemoveConfidence);
    if (options) {
      const removed = await this.service.removeQueueItem(item.service, item.id, options, {
        sourceKind: "ai_auto",
        analysisId: outcome.analysisId,
        confidence: result.proposal.confidence,
      });
      if (removed.ok) {
        this.status.autoRemoved += 1;
      } else {
        this.status.failed += 1;
        this.log.warn(
          { service: item.service, queueItemId: item.id, message: removed.message },
          "fixer bulk auto-removal failed",
        );
      }
    }
  }
}
