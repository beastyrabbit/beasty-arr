import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApplyResult,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import type { SonarrEpisodeRecord } from "../arr/sonarr-client.js";
import { SettingsService } from "../config/settings.js";
import { createDb } from "../db/index.js";
import { aiVerdicts, fixerAnalyses } from "../db/schema.js";
import { type AppEvent, EventBus } from "../events/bus.js";
import type { FixerAnalysisEvent, FixerPiRunner, FixerPiRunRequest } from "./ai-port.js";
import {
  realOnePieceAbsoluteEpisode,
  realOnePieceCandidate,
  realOnePieceQueueItem,
} from "./real-world-fixtures.js";
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
  preflightResult: ApplyResult = { ok: true, message: "preflight passed" };
  verifyImportApplied?: (queueItem: QueueItem, result: ApplyResult) => Promise<ApplyResult>;
  episodes: SonarrEpisodeRecord[] = [];
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
  async preflightImportProposal(): Promise<ApplyResult> {
    return this.preflightResult;
  }
  async removeQueueItem(queueItemId: number, options: QueueRemovalOptions): Promise<ApplyResult> {
    this.removeCalls.push({ queueItemId, options });
    return { ok: true, message: `Removed queue item ${queueItemId}.` };
  }
  async getEpisodes(): Promise<SonarrEpisodeRecord[]> {
    return this.episodes;
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
    languages: [{ id: 4, name: "German" }],
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
  it("fails orphaned running analyses when a new service instance starts", () => {
    const { db, settings, sonarr, radarr, runnerCtl, bus } = makeHarness();
    db.insert(fixerAnalyses)
      .values({
        id: "orphaned-analysis",
        createdAt: 1_000,
        service: "radarr",
        queueItemId: 99,
        itemLabel: "Orphaned Movie",
        status: "running",
        events: [],
      })
      .run();

    new FixerService(db, settings, { sonarr, radarr }, runnerCtl.runner, bus, noopLog, {
      now: () => 2_000,
    });

    expect(
      db.select().from(fixerAnalyses).where(eq(fixerAnalyses.id, "orphaned-analysis")).get(),
    ).toMatchObject({
      status: "failed",
      completedAt: 2_000,
      error: "Analysis was interrupted by an application restart.",
    });
  });

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

  it("injects the latest active Dub Oracle verdict for the queue subject", async () => {
    const { db, svc, sonarr, runnerCtl } = makeHarness();
    const now = Date.now();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    db.insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:5",
        title: "Show",
        verdict: "unknown",
        confidence: 0.7,
        evidence: ["Older inconclusive evidence."],
        provider: "test",
        model: "test",
        promptVersion: "test",
        checkedAt: now - 1_000,
        recheckAfter: now + 86_400_000,
      })
      .run();
    db.insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:5",
        title: "Show",
        verdict: "exists",
        confidence: 0.98,
        germanTitle: "Die Serie",
        perSeason: [{ season: 1, verdict: "exists", note: "German dub verified" }],
        evidence: ["Verified German release."],
        expectedAvailability: null,
        provider: "test",
        model: "test",
        promptVersion: "test",
        checkedAt: now,
        recheckAfter: now + 86_400_000,
      })
      .run();
    runnerCtl.setScript((req) => {
      expect(req.prompt).toContain('"germanTitle": "Die Serie"');
      expect(req.prompt).toContain('"perSeason"');
      expect(req.prompt).toContain('"verdict": "exists"');
      expect(req.prompt).not.toContain("Older inconclusive evidence.");
      return importProposal("candidate_1", [101]);
    });

    const outcome = await svc.analyzeAndWait("sonarr", 1);

    expect(outcome.status).toBe("completed");
    expect(runnerCtl.calls).toHaveLength(1);
  });

  it("does not fall back to a global series verdict for an unassessed season", async () => {
    const { db, svc, sonarr, runnerCtl } = makeHarness();
    const now = Date.now();
    sonarr.queue = [
      makeQueueItem(1, {
        title: "Show.S21E01.1080p",
        seasonEpisode: "S21E01",
        episodeLabels: ["S21E01"],
      }),
    ];
    sonarr.candidatesByItem.set(1, [
      makeCandidate("candidate_1", [101], {
        seasonNumber: 21,
        languages: [{ id: 1, name: "English" }],
        languageLabels: ["English"],
      }),
    ]);
    db.insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:5",
        title: "Show",
        verdict: "exists",
        confidence: 0.98,
        perSeason: [{ season: 1, verdict: "exists", note: "Only season 1 was verified" }],
        evidence: ["A German dub exists for season 1."],
        provider: "test",
        model: "test",
        promptVersion: "test",
        checkedAt: now,
        recheckAfter: now + 86_400_000,
      })
      .run();
    runnerCtl.setScript((req) => {
      expect(req.prompt).toContain("No active Dub Oracle verdict is available for this series.");
      expect(req.prompt).not.toContain("Only season 1 was verified");
      return importProposal("candidate_1", [101]);
    });

    const outcome = await svc.analyzeAndWait("sonarr", 1);

    expect(outcome.status).toBe("completed");
    expect(runnerCtl.calls).toHaveLength(1);
  });

  it("does not inject a superseded Dub Oracle verdict", async () => {
    const { db, svc, sonarr, runnerCtl } = makeHarness();
    const now = Date.now();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    db.insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:5",
        title: "Show",
        verdict: "exists",
        confidence: 0.98,
        evidence: ["Superseded German evidence."],
        provider: "test",
        model: "test",
        promptVersion: "test",
        checkedAt: now,
        recheckAfter: now + 86_400_000,
        supersededBy: 123,
      })
      .run();
    runnerCtl.setScript((req) => {
      expect(req.prompt).toContain("No active Dub Oracle verdict is available for this series.");
      expect(req.prompt).not.toContain("Superseded German evidence.");
      return importProposal("candidate_1", [101]);
    });

    const outcome = await svc.analyzeAndWait("sonarr", 1);

    expect(outcome.status).toBe("completed");
    expect(runnerCtl.calls).toHaveLength(1);
  });

  it("does not inject an expired Dub Oracle verdict", async () => {
    const { db, svc, sonarr, runnerCtl } = makeHarness();
    const now = Date.now();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    db.insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:5",
        title: "Show",
        verdict: "exists",
        confidence: 0.98,
        evidence: ["Old evidence."],
        provider: "test",
        model: "test",
        promptVersion: "test",
        checkedAt: now - 2_000,
        recheckAfter: now - 1_000,
      })
      .run();
    runnerCtl.setScript((req) => {
      expect(req.prompt).toContain("No active Dub Oracle verdict is available for this series.");
      expect(req.prompt).not.toContain("Old evidence.");
      return importProposal("candidate_1", [101]);
    });

    const outcome = await svc.analyzeAndWait("sonarr", 1);

    expect(outcome.status).toBe("completed");
    expect(runnerCtl.calls).toHaveLength(1);
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

  it("blocks a real anime pack whose verified mapping omits the queued target", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [realOnePieceQueueItem()];
    harness.sonarr.candidatesByItem.set(realOnePieceQueueItem().id, [realOnePieceCandidate()]);
    harness.sonarr.episodes = [realOnePieceAbsoluteEpisode()];
    harness.runnerCtl.setScript(async (req) => {
      const findEpisodes = (req.tools as ProposalToolLike[]).find(
        (tool) => tool.name === "sonarr_find_episodes",
      );
      if (!findEpisodes) throw new Error("sonarr_find_episodes tool not found");
      await findEpisodes.execute(
        "lookup_1",
        { seriesId: 77, absoluteEpisodeNumber: 78, window: 0 },
        undefined,
        undefined,
        undefined as never,
      );
      return importProposal("candidate_9", [4_951]);
    });

    const outcome = await harness.svc.analyzeAndWait("sonarr", realOnePieceQueueItem().id);
    expect(outcome.result?.status).toBe("needs_review");
    expect(outcome.result?.validation.ok).toBe(false);

    const result = await harness.svc.apply(outcome.analysisId);
    expect(result).toMatchObject({ ok: false, dryRun: false });
    expect(result.message).toContain("queued target episode");
    expect(harness.sonarr.applyCalls).toHaveLength(0);
  });

  it("reports a blocked language preflight instead of simulating an impossible import", async () => {
    const { svc, sonarr, analysisId } = await analyzedHarness();
    sonarr.preflightResult = {
      ok: false,
      message: "Blocked language downgrade: the existing file has German audio.",
    };

    const result = await svc.apply(analysisId);

    expect(result).toEqual({
      ok: false,
      dryRun: true,
      message: "Blocked language downgrade: the existing file has German audio.",
    });
    expect(sonarr.applyCalls).toHaveLength(0);
    expect(svc.listHistory().total).toBe(0);
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

  it("records success only after Arr confirms completion and refreshes the queue", async () => {
    const { svc, sonarr, settings, analysisId } = await analyzedHarness();
    settings.update({ dryRun: false });
    sonarr.verifyImportApplied = async (queueItem, result) => {
      sonarr.queue = sonarr.queue.filter((item) => item.downloadId !== queueItem.downloadId);
      return { ...result, message: "Sonarr completed the import." };
    };

    const result = await svc.apply(analysisId);

    expect(result).toMatchObject({ ok: true, message: "Sonarr completed the import." });
    expect((await svc.getQueue()).items).toHaveLength(0);
    expect(svc.listHistory().items[0]?.result).toBe("ok");
  });

  it("keeps the queue item visible when Arr cannot verify the import", async () => {
    const { svc, sonarr, settings, analysisId } = await analyzedHarness();
    settings.update({ dryRun: false });
    sonarr.verifyImportApplied = async (_queueItem, result) => ({
      ...result,
      ok: false,
      message: "ManualImport failed.",
    });

    const result = await svc.apply(analysisId);

    expect(result).toMatchObject({ ok: false, message: "ManualImport failed." });
    expect((await svc.getQueue()).items).toHaveLength(1);
    expect(svc.listHistory().items[0]?.result).toBe("error");
  });

  it("drops every cached queue row belonging to the applied season-pack download", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [
      makeQueueItem(1, { downloadId: "season-pack" }),
      makeQueueItem(2, { downloadId: "season-pack", episodeIds: [102] }),
      makeQueueItem(3, { downloadId: "other-download", episodeIds: [103] }),
    ];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101]));
    const outcome = await harness.svc.analyzeAndWait("sonarr", 1);
    harness.settings.update({ dryRun: false });

    const result = await harness.svc.apply(outcome.analysisId);

    expect(result.ok).toBe(true);
    expect((await harness.svc.getQueue()).items.map((item) => item.id)).toEqual([3]);
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

  it("applies a removal proposal with its exact options and analysis metadata", async () => {
    const options: QueueRemovalOptions = {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: true,
      changeCategory: false,
    };
    const { svc, sonarr, settings, analysisId } = await analyzedHarness({
      action: "remove_queue_item",
      confidence: 0.97,
      selectedCandidateIds: [],
      selectedImports: [],
      queueRemovalOptions: options,
    });
    settings.update({ dryRun: false });

    const result = await svc.apply(analysisId);

    expect(result).toMatchObject({ ok: true, dryRun: false });
    expect(sonarr.applyCalls).toHaveLength(0);
    expect(sonarr.removeCalls).toEqual([{ queueItemId: 1, options }]);
    const entry = svc.listHistory().items[0];
    expect(entry).toMatchObject({
      action: "blocklist",
      sourceKind: "ai_user",
      analysisId,
      confidence: 0.97,
    });
    expect(entry?.detail).toMatchObject({ options });
  });

  it("simulates a removal proposal with its exact options", async () => {
    const options: QueueRemovalOptions = {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: true,
      changeCategory: false,
    };
    const { svc, sonarr, analysisId } = await analyzedHarness({
      action: "remove_queue_item",
      selectedCandidateIds: [],
      selectedImports: [],
      queueRemovalOptions: options,
    });

    const result = await svc.apply(analysisId);

    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(sonarr.removeCalls).toHaveLength(0);
    const entry = svc.listHistory().items[0];
    expect(entry).toMatchObject({ sourceKind: "ai_user", analysisId });
    expect(entry?.detail).toMatchObject({
      wouldHave: { action: "blocklist", queueItemId: 1, options },
    });
  });

  it("refuses a removal proposal without explicit removal options", async () => {
    const { svc, sonarr, analysisId } = await analyzedHarness({
      action: "remove_queue_item",
      selectedCandidateIds: [],
      selectedImports: [],
      queueRemovalOptions: undefined,
    });

    const result = await svc.apply(analysisId);

    expect(result).toMatchObject({ ok: false, dryRun: false });
    expect(result.message).toContain("no queue removal options");
    expect(sonarr.removeCalls).toHaveLength(0);
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

it("coalesces a large stream and flushes the final event and result", async () => {
  const { db, svc, sonarr, runnerCtl } = makeHarness();
  sonarr.queue = [makeQueueItem(1)];
  sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
  runnerCtl.setScript((req) => {
    for (let i = 0; i < 1000; i++)
      req.onEvent?.({ kind: "text", delta: String(i), ts: Date.now() });
    return importProposal("candidate_1", [101]);
  });
  const updates = vi.spyOn(db, "update");
  const outcome = await svc.analyzeAndWait("sonarr", 1);
  expect(outcome.status).toBe("completed");
  expect(updates.mock.calls.length).toBeLessThan(10);
  const row = db.select().from(fixerAnalyses).get();
  expect(row?.status).toBe("completed");
  expect(row?.events?.length).toBe(500);
  expect(JSON.stringify(row?.events)).toContain("analysis text");
});
