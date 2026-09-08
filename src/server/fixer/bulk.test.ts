import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApplyResult,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import { SettingsService } from "../config/settings.js";
import { createDb } from "../db/index.js";
import { EventBus } from "../events/bus.js";
import type { FixerPiRunner, FixerPiRunRequest } from "./ai-port.js";
import { autoRemovalOptionsForResult, FixerBulk, uniqueQueueItemsByDownload } from "./bulk.js";
import { FixerService } from "./service.js";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child() {
    return this;
  },
  level: "silent",
} as unknown as FastifyBaseLogger;

class FakeArrClient {
  queue: QueueItem[] = [];
  candidatesByItem = new Map<number, ManualImportCandidate[]>();
  applyCalls: Array<{ queueItem: QueueItem; proposal: ResolutionProposal }> = [];
  removeCalls: Array<{ queueItemId: number; options: QueueRemovalOptions }> = [];
  async listQueue(): Promise<QueueItem[]> {
    return this.queue;
  }
  async getManualImportCandidates(queueItem: QueueItem): Promise<ManualImportCandidate[]> {
    return this.candidatesByItem.get(queueItem.id) ?? [];
  }
  async applyImportProposal(
    queueItem: QueueItem,
    _candidates: ManualImportCandidate[],
    proposal: ResolutionProposal,
  ): Promise<ApplyResult> {
    this.applyCalls.push({ queueItem, proposal });
    return { ok: true, message: "Started ManualImport.", commandId: 7 };
  }
  async preflightImportProposal(): Promise<ApplyResult> {
    return { ok: true, message: "preflight passed" };
  }
  async removeQueueItem(queueItemId: number, options: QueueRemovalOptions): Promise<ApplyResult> {
    this.removeCalls.push({ queueItemId, options });
    return { ok: true, message: `Removed queue item ${queueItemId}.` };
  }
  async getEpisodes(): Promise<never[]> {
    return [];
  }
  async getQualityProfiles(): Promise<never[]> {
    return [];
  }
  async getCustomFormats(): Promise<never[]> {
    return [];
  }
  async getMovie(movieId: number): Promise<{ id: number }> {
    return { id: movieId };
  }
}

function makeQueueItem(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    service: "sonarr",
    title: `Show.S01E0${id}.720p`,
    seriesId: 5,
    seriesTitle: "Show",
    downloadId: `dl-${id}`,
    status: "warning",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importPending",
    isInProgress: false,
    episodeIds: [100 + id],
    absoluteEpisodeNumbers: [],
    episodeLabels: [`S01E0${id}`],
    seasonEpisode: `S01E0${id}`,
    statusMessages: ["Not an upgrade for existing episode file(s). Quality already met."],
    canAnalyze: true,
    ...over,
  };
}

function makeCandidate(id: string, episodeIds: number[]): ManualImportCandidate {
  return {
    id,
    service: "sonarr",
    path: `/downloads/${id}.mkv`,
    episodeIds,
    absoluteEpisodeNumbers: [],
    episodeLabels: ["S01E01"],
    quality: { quality: { id: 1, name: "HDTV-720p" } },
    qualityLabel: "HDTV-720p",
    languages: [{ id: 4, name: "German" }],
    languageLabels: ["German"],
    rejections: [],
    isLikelySample: false,
    seriesId: 5,
    seriesTitle: "Show",
  };
}

function importProposal(
  candidateId: string,
  episodeIds: number[],
  confidence: number,
): ResolutionProposal {
  return {
    action: "import_candidates",
    confidence,
    selectedCandidateIds: [candidateId],
    selectedImports: [{ candidateId, episodeIds }],
    sampleCandidateIds: [],
    reason: "candidate matches the target episode",
    issueSummary: "quality warning",
    evidence: [],
    warnings: [],
  };
}

function removeProposal(confidence: number, options: QueueRemovalOptions): ResolutionProposal {
  return {
    action: "remove_queue_item",
    confidence,
    selectedCandidateIds: [],
    selectedImports: [],
    sampleCandidateIds: [],
    reason: "existing file is better",
    issueSummary: "non-upgrade",
    evidence: [],
    warnings: [],
    queueRemovalOptions: options,
  };
}

function needsReviewProposal(): ResolutionProposal {
  return {
    action: "needs_review",
    confidence: 0.4,
    selectedCandidateIds: [],
    selectedImports: [],
    sampleCandidateIds: [],
    reason: "ambiguous",
    issueSummary: "ambiguous",
    evidence: [],
    warnings: [],
  };
}

type ProposalToolLike = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    a?: unknown,
    b?: unknown,
    c?: never,
  ) => Promise<unknown>;
};

async function invokeProposalTool(
  req: FixerPiRunRequest,
  proposal: ResolutionProposal,
): Promise<void> {
  const tool = (req.tools as ProposalToolLike[]).find((t) => t.name.startsWith("propose_"));
  if (!tool) {
    throw new Error("proposal tool not found");
  }
  await tool.execute("call_1", proposal, undefined, undefined, undefined as never);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

type RunnerScript = (
  req: FixerPiRunRequest,
) => ResolutionProposal | undefined | Promise<ResolutionProposal | undefined>;

function makeHarness(script: RunnerScript, now = Date.now) {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-fixer-bulk-test-"));
  const { db, sqlite } = createDb(dir, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = new SettingsService(db);
  const bus = new EventBus();
  const sonarr = new FakeArrClient();
  const radarr = new FakeArrClient();
  const calls: FixerPiRunRequest[] = [];
  const runner: FixerPiRunner = async (req) => {
    calls.push(req);
    const proposal = await script(req);
    if (proposal) {
      await invokeProposalTool(req, proposal);
    }
    return { log: [] };
  };
  const svc = new FixerService(db, settings, { sonarr, radarr }, runner, bus, noopLog, { now });
  const bulk = new FixerBulk(svc, settings, noopLog, { now });
  return { db, settings, bus, sonarr, radarr, svc, bulk, calls };
}

describe("Fixer recovery", () => {
  it("honors an auto-apply toggle changed while an analysis is running", async () => {
    let ready: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finish: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = makeHarness(async () => {
      ready?.();
      await blocked;
      return importProposal("candidate_1", [101], 0.99);
    });
    h.settings.update({ fixerAutoApply: true, dryRun: false });
    h.sonarr.queue = [makeQueueItem(1)];
    h.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    await h.bulk.start();
    await started;
    h.settings.update({ fixerAutoApply: false });
    finish?.();
    await h.bulk.wait();
    expect(h.sonarr.applyCalls).toHaveLength(0);
  });

  it("retries failed rechecks with auto-run off", async () => {
    let now = Date.now();
    let fail = false;
    const h = makeHarness(
      () => {
        if (fail) throw new Error("temporary failure");
        return importProposal("candidate_1", [101], 0.99);
      },
      () => now,
    );
    h.sonarr.queue = [makeQueueItem(1)];
    h.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    await h.bulk.start();
    await h.bulk.wait();
    now += 1;
    fail = true;
    h.settings.update({ fixerAutoApply: true, dryRun: false });
    await h.bulk.start({ pendingOnly: true });
    await h.bulk.wait();
    expect((await h.bulk.start({ pendingOnly: true })).total).toBe(0);
    now += 15 * 60_000;
    fail = false;
    expect((await h.bulk.start({ pendingOnly: true })).total).toBe(1);
    await h.bulk.wait();
    expect(h.sonarr.applyCalls).toHaveLength(1);
  });

  it("retries failures after escalating cooldowns", async () => {
    let now = Date.now();
    const h = makeHarness(
      () => {
        throw new Error("temporary failure");
      },
      () => now,
    );
    h.sonarr.queue = [makeQueueItem(1)];
    h.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    await h.bulk.start({ skipAnalyzed: true });
    await h.bulk.wait();
    expect((await h.bulk.start({ skipAnalyzed: true })).total).toBe(0);
    now += 15 * 60_000;
    expect((await h.bulk.start({ skipAnalyzed: true })).total).toBe(1);
    await h.bulk.wait();
    now += 15 * 60_000;
    expect((await h.bulk.start({ skipAnalyzed: true })).total).toBe(0);
    now += 15 * 60_000;
    expect((await h.bulk.start({ skipAnalyzed: true })).total).toBe(1);
    await h.bulk.wait();
  });

  it("pauses the whole queue on a usage limit and resumes after an hour", async () => {
    let now = Date.now();
    let limited = true;
    const h = makeHarness(
      () => {
        if (limited) throw new Error("Codex error: The usage limit has been reached");
        return needsReviewProposal();
      },
      () => now,
    );
    h.settings.update({ fixerParallelism: 1 });
    h.sonarr.queue = [makeQueueItem(1), makeQueueItem(2)];
    for (const item of h.sonarr.queue)
      h.sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    await h.bulk.start({ skipAnalyzed: true });
    await h.bulk.wait();
    expect(h.calls).toHaveLength(1);
    expect(h.bulk.getStatus().pausedUntil).toBe(now + 60 * 60_000);
    await expect(h.svc.analyze("sonarr", 2)).rejects.toThrow("Provider usage limit");
    expect(h.calls).toHaveLength(1);
    expect((await h.bulk.start()).total).toBe(0);
    limited = false;
    now += 60 * 60_000;
    await h.bulk.start({ skipAnalyzed: true });
    await h.bulk.wait();
    expect(h.calls).toHaveLength(3);
  });

  it("rechecks pending proposals, holds low confidence, and never reapplies a success", async () => {
    const h = makeHarness((req) =>
      importProposal(
        `candidate_${req.queueItemId}`,
        [100 + req.queueItemId],
        req.queueItemId === 2 ? 0.5 : 0.99,
      ),
    );
    h.sonarr.queue = [makeQueueItem(1), makeQueueItem(2)];
    for (const item of h.sonarr.queue)
      h.sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    await h.bulk.start();
    await h.bulk.wait();
    h.settings.update({ fixerAutoApply: true, dryRun: false });
    h.sonarr.queue.push(makeQueueItem(3));
    expect((await h.bulk.start({ pendingOnly: true })).total).toBe(1);
    await h.bulk.wait();
    expect(h.calls).toHaveLength(3);
    expect(h.sonarr.applyCalls).toHaveLength(1);
    expect((await h.bulk.start({ pendingOnly: true })).total).toBe(0);
  });

  it("does not apply when fresh analysis changes the proposal or auto-apply is disabled", async () => {
    let fresh = false;
    const h = makeHarness(() =>
      fresh ? needsReviewProposal() : importProposal("candidate_1", [101], 0.99),
    );
    h.sonarr.queue = [makeQueueItem(1)];
    h.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    await h.bulk.start();
    await h.bulk.wait();
    fresh = true;
    h.settings.update({ fixerAutoApply: true, dryRun: false });
    await h.bulk.start({ pendingOnly: true });
    await h.bulk.wait();
    expect(h.sonarr.applyCalls).toHaveLength(0);
    h.settings.update({ fixerAutoApply: false });
    expect((await h.bulk.start({ pendingOnly: true })).total).toBe(0);
  });
});

describe("auto-apply gates", () => {
  it("autoRemovalOptionsForResult enforces the explicit safe options", () => {
    const base = {
      queueItemId: 1,
      candidates: [],
      validation: { ok: true, issues: [] },
      status: "proposal" as const,
      log: [],
    };
    const safe: QueueRemovalOptions = {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: false,
      changeCategory: false,
    };
    expect(
      autoRemovalOptionsForResult({ ...base, proposal: removeProposal(0.96, safe) }, 0.95),
    ).toEqual(safe);
    // below threshold
    expect(
      autoRemovalOptionsForResult({ ...base, proposal: removeProposal(0.94, safe) }, 0.95),
    ).toBeUndefined();
    // options guard: the download must be removed and categories are never changed
    expect(
      autoRemovalOptionsForResult(
        { ...base, proposal: removeProposal(0.99, { ...safe, removeFromClient: false }) },
        0.95,
      ),
    ).toBeUndefined();
    expect(
      autoRemovalOptionsForResult(
        { ...base, proposal: removeProposal(0.99, { ...safe, skipRedownload: true }) },
        0.95,
      ),
    ).toEqual({ ...safe, skipRedownload: true });
    // skipRedownload is only meaningful/safe for an exact release blocklist
    expect(
      autoRemovalOptionsForResult(
        {
          ...base,
          proposal: removeProposal(0.99, {
            ...safe,
            blocklist: false,
            skipRedownload: true,
          }),
        },
        0.95,
      ),
    ).toBeUndefined();
    expect(
      autoRemovalOptionsForResult(
        { ...base, proposal: removeProposal(0.99, { ...safe, changeCategory: true }) },
        0.95,
      ),
    ).toBeUndefined();
  });

  it("uniqueQueueItemsByDownload keeps one representative per downloadId", () => {
    const items = [
      makeQueueItem(1, { downloadId: "dup" }),
      makeQueueItem(2, { downloadId: "dup" }),
      makeQueueItem(3),
      makeQueueItem(4, { downloadId: undefined }),
    ];
    expect(uniqueQueueItemsByDownload(items).map((i) => i.id)).toEqual([1, 3, 4]);
  });

  it("does not dedupe equal download ids across Sonarr and Radarr", () => {
    const items = [
      makeQueueItem(1, { service: "sonarr", downloadId: "shared" }),
      makeQueueItem(2, { service: "radarr", downloadId: "shared" }),
    ];
    expect(uniqueQueueItemsByDownload(items)).toHaveLength(2);
  });
});

describe("FixerBulk", () => {
  it("dedupes rows sharing a downloadId and analyzes one representative", async () => {
    const { sonarr, bulk, calls } = makeHarness(() => needsReviewProposal());
    sonarr.queue = [
      makeQueueItem(1, { downloadId: "dup" }),
      makeQueueItem(2, { downloadId: "dup" }),
      makeQueueItem(3),
    ];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }
    const started = await bulk.start();
    expect(started).toMatchObject({ ok: true, total: 2 });
    await bulk.wait();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.queueItemId).sort()).toEqual([1, 3]);
    const status = bulk.getStatus();
    expect(status).toMatchObject({ running: false, completed: 2, failed: 0 });
  });

  it("bounds concurrency at fixerParallelism", async () => {
    let active = 0;
    let maxActive = 0;
    const { settings, sonarr, bulk, calls } = makeHarness(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return needsReviewProposal();
    });
    settings.update({ fixerParallelism: 2 });
    sonarr.queue = [1, 2, 3, 4, 5].map((id) => makeQueueItem(id));
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }
    await bulk.start();
    await bulk.wait();
    expect(calls).toHaveLength(5);
    expect(maxActive).toBe(2);
  });

  it("filters by issue type", async () => {
    const { sonarr, bulk, calls } = makeHarness(() => needsReviewProposal());
    sonarr.queue = [
      makeQueueItem(1), // quality
      makeQueueItem(2, { statusMessages: ["Sample file detected"] }),
    ];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }
    const started = await bulk.start({ issueTypes: ["sample"] });
    expect(started.total).toBe(1);
    await bulk.wait();
    expect(calls.map((c) => c.queueItemId)).toEqual([2]);
  });

  it("analyzes only the exact targets requested by the UI", async () => {
    const { sonarr, bulk, calls } = makeHarness(() => needsReviewProposal());
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2), makeQueueItem(3)];
    sonarr.candidatesByItem.set(2, [makeCandidate("candidate_2", [102])]);

    const started = await bulk.start({
      targets: [{ service: "sonarr", queueItemId: 2 }],
    });

    expect(started.total).toBe(1);
    await bulk.wait();
    expect(calls.map((call) => `${call.service}:${call.queueItemId}`)).toEqual(["sonarr:2"]);
  });

  it("automatic runs skip downloads that already have an analysis", async () => {
    const { sonarr, bulk, calls } = makeHarness(() => needsReviewProposal());
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);

    await bulk.start();
    await bulk.wait();
    expect(calls).toHaveLength(1);

    const automatic = await bulk.start({ skipAnalyzed: true });
    expect(automatic).toMatchObject({ ok: true, total: 0 });
    expect(calls).toHaveLength(1);

    await bulk.start({ targets: [{ service: "sonarr", queueItemId: 1 }] });
    await bulk.wait();
    expect(calls).toHaveLength(2);
  });

  it("treats an explicit empty target list as no work", async () => {
    const { sonarr, bulk, calls } = makeHarness(() => needsReviewProposal());
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2)];

    const started = await bulk.start({ targets: [] });

    expect(started).toMatchObject({ ok: true, total: 0 });
    expect(calls).toHaveLength(0);
  });

  it("auto-applies a proposal produced by an Analyze selected target", async () => {
    const { settings, sonarr, bulk, svc } = makeHarness((req) =>
      importProposal(`candidate_${req.queueItemId}`, [100 + req.queueItemId], 0.9),
    );
    settings.update({ fixerAutoApply: true, dryRun: false, fixerParallelism: 1 });
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2)];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }

    await bulk.start({ targets: [{ service: "sonarr", queueItemId: 2 }] });
    await bulk.wait();

    expect(sonarr.applyCalls.map((call) => call.queueItem.id)).toEqual([2]);
    expect(svc.listHistory().items[0]).toMatchObject({
      sourceKind: "ai_auto",
      action: "import",
      result: "ok",
    });
  });

  it("auto-imports only at or above fixerAutoImportConfidence (0.8)", async () => {
    const { settings, sonarr, bulk } = makeHarness((req) =>
      importProposal(
        `candidate_${req.queueItemId}`,
        [100 + req.queueItemId],
        req.queueItemId === 1 ? 0.79 : 0.9,
      ),
    );
    settings.update({ fixerAutoApply: true, dryRun: false, fixerParallelism: 1 });
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2)];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }
    await bulk.start();
    await bulk.wait();
    expect(sonarr.applyCalls).toHaveLength(1);
    expect(sonarr.applyCalls[0]?.queueItem.id).toBe(2);
    const status = bulk.getStatus();
    expect(status.autoImported).toBe(1);
  });

  it("frees a worker slot when a completed proposal waits below the auto-apply threshold", async () => {
    let releaseSecond: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const { settings, sonarr, bulk, calls } = makeHarness(async (req) => {
      if (req.queueItemId === 2) {
        markSecondStarted?.();
        await secondGate;
      }
      return importProposal(`candidate_${req.queueItemId}`, [100 + req.queueItemId], 0.5);
    });
    settings.update({ fixerAutoApply: true, dryRun: false, fixerParallelism: 1 });
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2)];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }

    await bulk.start();
    await secondStarted;

    expect(calls.map((call) => call.queueItemId)).toEqual([1, 2]);
    expect(bulk.getStatus()).toMatchObject({
      running: true,
      completed: 1,
      autoImported: 0,
    });
    expect(bulk.getStatus().inFlight.map((item) => item.queueItemId)).toEqual([2]);

    releaseSecond?.();
    await bulk.wait();
    expect(bulk.getStatus()).toMatchObject({ running: false, completed: 2, autoImported: 0 });
  });

  it("auto-removes only with matching explicit options and confidence >= 0.95", async () => {
    const safe: QueueRemovalOptions = {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: false,
      changeCategory: false,
    };
    const byItem: Record<number, ResolutionProposal> = {
      1: removeProposal(0.96, safe),
      2: removeProposal(0.9, safe),
      3: removeProposal(0.99, { ...safe, removeFromClient: false, skipRedownload: true }),
    };
    const { settings, sonarr, bulk, svc } = makeHarness((req) => byItem[req.queueItemId]);
    settings.update({ fixerAutoApply: true, dryRun: false, fixerParallelism: 1 });
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2), makeQueueItem(3)];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }
    await bulk.start();
    await bulk.wait();
    expect(sonarr.removeCalls).toEqual([{ queueItemId: 1, options: safe }]);
    expect(bulk.getStatus().autoRemoved).toBe(1);
    const entries = svc.listHistory().items;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "blocklist",
      sourceKind: "ai_auto",
      dryRun: false,
      result: "ok",
      confidence: 0.96,
    });
  });

  it("dry-run bulk simulates auto-actions: no arr mutations, ai_auto history rows", async () => {
    const { settings, sonarr, bulk, svc } = makeHarness((req) =>
      importProposal(`candidate_${req.queueItemId}`, [100 + req.queueItemId], 0.9),
    );
    settings.update({ fixerAutoApply: true, fixerParallelism: 1 }); // dryRun stays default ON
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    await bulk.start();
    await bulk.wait();
    expect(sonarr.applyCalls).toHaveLength(0);
    expect(sonarr.removeCalls).toHaveLength(0);
    const entries = svc.listHistory().items;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "import",
      sourceKind: "ai_auto",
      dryRun: true,
      result: "simulated",
    });
    expect(bulk.getStatus().autoImported).toBe(1);
  });

  it("does not auto-apply when fixerAutoApply is off", async () => {
    const { settings, sonarr, bulk, svc } = makeHarness((req) =>
      importProposal(`candidate_${req.queueItemId}`, [100 + req.queueItemId], 0.99),
    );
    settings.update({ dryRun: false, fixerParallelism: 1 });
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    await bulk.start();
    await bulk.wait();
    expect(sonarr.applyCalls).toHaveLength(0);
    expect(svc.listHistory().total).toBe(0);
  });

  it("rejects a second start while running and cancels cleanly", async () => {
    const gates: Array<() => void> = [];
    const { settings, sonarr, bulk, calls } = makeHarness(
      (req) =>
        new Promise((resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          gates.push(() => resolve(needsReviewProposal()));
        }),
    );
    settings.update({ fixerParallelism: 1 });
    sonarr.queue = [makeQueueItem(1), makeQueueItem(2), makeQueueItem(3)];
    for (const item of sonarr.queue) {
      sonarr.candidatesByItem.set(item.id, [
        makeCandidate(`candidate_${item.id}`, [100 + item.id]),
      ]);
    }
    const started = await bulk.start();
    expect(started.ok).toBe(true);
    const again = await bulk.start();
    expect(again.ok).toBe(false);

    await vi.waitFor(() => {
      expect(gates.length).toBe(1);
    });
    gates[0]?.(); // finish item 1
    await vi.waitFor(() => {
      expect(gates.length).toBe(2);
    });
    expect(bulk.cancel()).toBe(true); // aborts the in-flight item 2
    await bulk.wait();

    expect(calls).toHaveLength(2); // item 3 never analyzed
    const status = bulk.getStatus();
    expect(status).toMatchObject({
      running: false,
      cancelRequested: true,
      completed: 1,
      failed: 1,
      total: 3,
    });
    expect(bulk.cancel()).toBe(false);
  });
});
