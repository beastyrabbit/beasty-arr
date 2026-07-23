import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApplyResult,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import { SettingsService } from "../config/settings.js";
import { createDb } from "../db/index.js";
import { type AppEvent, EventBus } from "../events/bus.js";
import type { FixerAnalysisEvent, FixerPiRunner, FixerPiRunRequest } from "./ai-port.js";
import {
  FixerService,
  ignoreRemovalOptions,
  manualRemovalOptions,
  queueIssueType,
} from "./service.js";

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
  failCandidates = false;
  applyCalls: Array<{ queueItem: QueueItem; proposal: ResolutionProposal }> = [];
  removeCalls: Array<{ queueItemId: number; options: QueueRemovalOptions }> = [];
  async listQueue(): Promise<QueueItem[]> {
    return this.queue;
  }
  async getManualImportCandidates(queueItem: QueueItem): Promise<ManualImportCandidate[]> {
    if (this.failCandidates) {
      throw new Error("candidate load boom");
    }
    return this.candidatesByItem.get(queueItem.id) ?? [];
  }
  async applyImportProposal(
    queueItem: QueueItem,
    _candidates: ManualImportCandidate[],
    proposal: ResolutionProposal,
  ): Promise<ApplyResult> {
    this.applyCalls.push({ queueItem, proposal });
    return { ok: true, message: "Started ManualImport command 7.", commandId: 7 };
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

function makeCandidate(
  id: string,
  episodeIds: number[],
  over: Partial<ManualImportCandidate> = {},
): ManualImportCandidate {
  return {
    id,
    service: "sonarr",
    path: `/downloads/${id}.mkv`,
    episodeIds,
    absoluteEpisodeNumbers: [],
    episodeLabels: ["S01E01"],
    quality: { quality: { id: 1, name: "HDTV-720p" } },
    qualityLabel: "HDTV-720p",
    languages: [{ id: 26, name: "German" }],
    languageLabels: ["German"],
    rejections: [],
    isLikelySample: false,
    seriesId: 5,
    seriesTitle: "Show",
    ...over,
  };
}

function importProposal(
  candidateId: string,
  episodeIds: number[],
  over: Partial<ResolutionProposal> = {},
): ResolutionProposal {
  return {
    action: "import_candidates",
    confidence: 0.9,
    selectedCandidateIds: [candidateId],
    selectedImports: [{ candidateId, episodeIds }],
    sampleCandidateIds: [],
    reason: "candidate matches the target episode",
    issueSummary: "quality warning",
    evidence: [],
    warnings: [],
    ...over,
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

type RunnerScript = (
  req: FixerPiRunRequest,
) => ResolutionProposal | undefined | Promise<ResolutionProposal | undefined>;

function makeRunner() {
  const calls: FixerPiRunRequest[] = [];
  let script: RunnerScript = () => undefined;
  const runner: FixerPiRunner = async (req) => {
    calls.push(req);
    const proposal = await script(req);
    if (proposal) {
      await invokeProposalTool(req, proposal);
    }
    req.onEvent?.({ kind: "text", delta: "analysis text", ts: Date.now() });
    return { log: ["analysis text"] };
  };
  return {
    runner,
    calls,
    setScript(next: RunnerScript) {
      script = next;
    },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-fixer-test-"));
  const { db, sqlite } = createDb(dir, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = new SettingsService(db);
  const bus = new EventBus();
  const busEvents: AppEvent[] = [];
  bus.subscribe((event) => busEvents.push(event));
  const sonarr = new FakeArrClient();
  const radarr = new FakeArrClient();
  const runnerCtl = makeRunner();
  const svc = new FixerService(db, settings, { sonarr, radarr }, runnerCtl.runner, bus, noopLog);
  return { db, settings, bus, busEvents, sonarr, radarr, runnerCtl, svc };
}

describe("FixerService queue", () => {
  it("merges both services, tags issue types, and emits fixer.queue.changed", async () => {
    const { svc, sonarr, radarr, busEvents } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    radarr.queue = [
      makeQueueItem(2, {
        service: "radarr",
        movieId: 42,
        movieTitle: "Movie",
        movieYear: 2020,
        episodeIds: [],
        statusMessages: ["Unable to import: movie mismatch"],
      }),
    ];
    const snapshot = await svc.refreshQueue();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.map((i) => `${i.service}:${i.issueType}`)).toEqual([
      "radarr:movie match",
      "sonarr:quality",
    ]);
    expect(busEvents.filter((e) => e.type === "fixer.queue.changed")).toHaveLength(1);
  });

  it("keeps the working service when the other one fails", async () => {
    const { svc, sonarr, radarr } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    radarr.listQueue = async () => {
      throw new Error("radarr down");
    };
    const snapshot = await svc.refreshQueue();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.errors.radarr).toBe("radarr down");
  });

  it("classifies issue types from status messages", () => {
    expect(
      queueIssueType(
        makeQueueItem(1, { statusMessages: ["Found matching series via grab history"] }),
      ),
    ).toBe("series match");
    expect(queueIssueType(makeQueueItem(1, { statusMessages: ["Sample file detected"] }))).toBe(
      "sample",
    );
  });
});

describe("FixerService analyze lifecycle", () => {
  it("runs an analysis to completion, persisting proposal, validation, candidates, and events", async () => {
    const { svc, sonarr, runnerCtl, busEvents } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    runnerCtl.setScript(() => importProposal("candidate_1", [101]));

    const { analysisId } = await svc.analyze("sonarr", 1);
    const row0 = svc.getAnalysis(analysisId);
    expect(row0?.status).toBe("running");

    const outcome = await svc.waitForAnalysis(analysisId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.status).toBe("proposal");

    const row = svc.getAnalysis(analysisId);
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).toBeTypeOf("number");
    const rowProposal = row?.proposal as ResolutionProposal | undefined;
    expect(rowProposal?.action).toBe("import_candidates");
    const rowValidation = row?.validation as { ok: boolean } | undefined;
    expect(rowValidation?.ok).toBe(true);
    expect(row?.candidates).toHaveLength(1);
    const events = (row?.events ?? []) as FixerAnalysisEvent[];
    const messages = events
      .filter((e): e is Extract<FixerAnalysisEvent, { kind: "step" }> => e.kind === "step")
      .map((e) => e.message);
    expect(messages).toContain("Loading manual import candidates.");
    expect(messages).toContain("Loaded 1 manual import candidates.");
    expect(messages).toContain("Starting typed Pi analysis.");
    expect(messages).toContain("Pi proposal: import_candidates (90%).");
    expect(events.some((e) => e.kind === "text")).toBe(true);

    const progress = busEvents.filter((e) => e.type === "fixer.analysis.progress");
    expect(progress.length).toBe(events.length);
    expect(
      progress.every((e) => (e.payload as { analysisId: string }).analysisId === analysisId),
    ).toBe(true);
    const completed = busEvents.filter((e) => e.type === "fixer.analysis.completed");
    expect(completed).toHaveLength(1);
    const completedPayload = completed[0]?.payload as { status: string } | undefined;
    expect(completedPayload?.status).toBe("completed");
  });

  it("completes with a candidate-load-failure result for non-actionable downloads", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = [
      makeQueueItem(1, { status: "completed", trackedDownloadStatus: "ok", canAnalyze: false }),
    ];
    const outcome = await svc.analyzeAndWait("sonarr", 1);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.status).toBe("needs_review");
    expect(outcome.result?.proposal.reason).toContain(
      "Download is still in progress or is not ready for manual import.",
    );
    expect(runnerCtl.calls).toHaveLength(0);
  });

  it("completes with needs_review when candidates cannot be loaded", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.failCandidates = true;
    const outcome = await svc.analyzeAndWait("sonarr", 1);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.proposal.reason).toContain("candidate load boom");
    expect(outcome.result?.validation.ok).toBe(true);
    expect(runnerCtl.calls).toHaveLength(0);
  });

  it("cancel aborts a running analysis and persists status cancelled", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    runnerCtl.setScript(
      (req) =>
        new Promise((_resolve, reject) => {
          if (req.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const { analysisId } = await svc.analyze("sonarr", 1);
    expect(svc.cancel("sonarr", 1)).toBe(true);
    const outcome = await svc.waitForAnalysis(analysisId);
    expect(outcome.status).toBe("cancelled");
    expect(svc.getAnalysis(analysisId)?.status).toBe("cancelled");
    expect(svc.cancel("sonarr", 1)).toBe(false);
  });

  it("a new analysis for the same item aborts the prior one", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    let call = 0;
    runnerCtl.setScript((req) => {
      call += 1;
      if (call === 1) {
        return new Promise((_resolve, reject) => {
          if (req.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return importProposal("candidate_1", [101]);
    });
    const first = await svc.analyze("sonarr", 1);
    const second = await svc.analyze("sonarr", 1);
    expect(second.analysisId).not.toBe(first.analysisId);
    const [firstOutcome, secondOutcome] = await Promise.all([
      svc.waitForAnalysis(first.analysisId),
      svc.waitForAnalysis(second.analysisId),
    ]);
    expect(firstOutcome.status).toBe("cancelled");
    expect(secondOutcome.status).toBe("completed");
  });
});

describe("FixerService apply", () => {
  async function analyzedHarness(proposalOver: Partial<ResolutionProposal> = {}) {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(1)];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101], proposalOver));
    const outcome = await harness.svc.analyzeAndWait("sonarr", 1);
    expect(outcome.status).toBe("completed");
    return { ...harness, analysisId: outcome.analysisId };
  }

  it("simulates in dry-run: no arr call, history row with wouldHave detail", async () => {
    const { svc, sonarr, analysisId } = await analyzedHarness();
    const result = await svc.apply(analysisId, ["candidate_1"]);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(sonarr.applyCalls).toHaveLength(0);
    const history = svc.listHistory();
    expect(history.total).toBe(1);
    const entry = history.items[0];
    expect(entry?.action).toBe("import");
    expect(entry?.dryRun).toBe(true);
    expect(entry?.result).toBe("simulated");
    expect(entry?.sourceKind).toBe("ai_user");
    expect(entry?.analysisId).toBe(analysisId);
    const detail = entry?.detail as { wouldHave: { candidateIds: string[] } } | undefined;
    expect(detail?.wouldHave.candidateIds).toEqual(["candidate_1"]);
  });

  it("applies live when dry-run is off, records history, and drops the queue row", async () => {
    const { svc, sonarr, settings, analysisId } = await analyzedHarness();
    settings.update({ dryRun: false });
    const result = await svc.apply(analysisId);
    expect(result).toMatchObject({ ok: true, dryRun: false, commandId: 7 });
    expect(sonarr.applyCalls).toHaveLength(1);
    expect(sonarr.applyCalls[0]?.proposal.selectedCandidateIds).toEqual(["candidate_1"]);
    const entry = svc.listHistory().items[0];
    expect(entry?.result).toBe("ok");
    expect(entry?.dryRun).toBe(false);
    const queue = await svc.getQueue();
    expect(queue.items).toHaveLength(0);
  });

  it("re-validates at apply time and blocks invalid proposals without touching the arr", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(1)];
    harness.sonarr.candidatesByItem.set(1, [
      makeCandidate("candidate_1", [101], { isLikelySample: true, sampleReason: "tiny file" }),
    ]);
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101]));
    const outcome = await harness.svc.analyzeAndWait("sonarr", 1);
    harness.settings.update({ dryRun: false });
    const result = await harness.svc.apply(outcome.analysisId);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("flagged as a sample");
    expect(harness.sonarr.applyCalls).toHaveLength(0);
    expect(harness.svc.listHistory().total).toBe(0);
  });

  it("rejects a candidate subset that selects nothing from the proposal", async () => {
    const { svc, sonarr, analysisId } = await analyzedHarness();
    const result = await svc.apply(analysisId, ["candidate_9"]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No proposed candidates selected.");
    expect(sonarr.applyCalls).toHaveLength(0);
  });

  it("refuses to apply non-import proposals", async () => {
    const { svc, analysisId } = await analyzedHarness({
      action: "needs_review",
      selectedCandidateIds: [],
      selectedImports: [],
    });
    const result = await svc.apply(analysisId);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("is not an import");
  });
});

describe("FixerService remove/ignore", () => {
  it("simulates removal in dry-run with a history entry", async () => {
    const { svc, sonarr } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    const result = await svc.removeQueueItem("sonarr", 1);
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(sonarr.removeCalls).toHaveLength(0);
    const entry = svc.listHistory().items[0];
    expect(entry?.action).toBe("remove");
    expect(entry?.result).toBe("simulated");
    const detail = entry?.detail as { wouldHave: { options: QueueRemovalOptions } } | undefined;
    expect(detail?.wouldHave.options).toEqual(manualRemovalOptions);
  });

  it("removes live with the exact options and logs blocklist actions distinctly", async () => {
    const { svc, sonarr, settings } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    settings.update({ dryRun: false });
    const options: QueueRemovalOptions = {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: false,
      changeCategory: false,
    };
    const result = await svc.removeQueueItem("sonarr", 1, options, {
      sourceKind: "ai_auto",
      confidence: 0.97,
    });
    expect(result.ok).toBe(true);
    expect(sonarr.removeCalls).toEqual([{ queueItemId: 1, options }]);
    const entry = svc.listHistory().items[0];
    expect(entry?.action).toBe("blocklist");
    expect(entry?.sourceKind).toBe("ai_auto");
    expect(entry?.confidence).toBe(0.97);
  });

  it("ignore uses the ported ignore options (leave download, stop tracking)", async () => {
    const { svc, sonarr, settings } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    settings.update({ dryRun: false });
    const result = await svc.ignoreQueueItem("sonarr", 1);
    expect(result.ok).toBe(true);
    expect(sonarr.removeCalls[0]?.options).toEqual(ignoreRemovalOptions);
    expect(ignoreRemovalOptions).toEqual({
      removeFromClient: false,
      blocklist: false,
      skipRedownload: true,
      changeCategory: false,
    });
    expect(svc.listHistory().items[0]?.action).toBe("ignore");
  });
});

describe("FixerService history", () => {
  it("pages history newest-first", async () => {
    const { svc, sonarr } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    await svc.removeQueueItem("sonarr", 1);
    await svc.ignoreQueueItem("sonarr", 1);
    await svc.removeQueueItem("sonarr", 1);
    const page1 = svc.listHistory({ page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    const page2 = svc.listHistory({ page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0]?.id).toBeGreaterThan(page2.items[0]?.id ?? 0);
  });
});
