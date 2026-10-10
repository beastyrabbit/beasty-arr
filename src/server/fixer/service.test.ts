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
import type { ImportVerificationOptions } from "../arr/import-verification.js";
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
import { fakeProber } from "./test-prober.js";

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
  verifyImportApplied?: (
    queueItem: QueueItem,
    result: ApplyResult,
    options?: ImportVerificationOptions,
  ) => Promise<ApplyResult>;
  episodes: SonarrEpisodeRecord[] = [];
  /** Like the real clients: in-progress rows only when asked for. */
  async listQueue(options: { includeInProgress?: boolean } = {}): Promise<QueueItem[]> {
    return options.includeInProgress
      ? this.queue
      : this.queue.filter((item) => item.isInProgress !== true);
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
    identity: {
      verdict: "confirmed",
      actualWork: "the queued episode",
      evidence: ["Subtitle dialogue matches the episode."],
    },
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
  const svc = new FixerService(db, settings, { sonarr, radarr }, runnerCtl.runner, bus, noopLog, {
    prober: fakeProber(),
  });
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

  it("checks a Radarr download against the movie it was grabbed for, not the queue's re-mapping", async () => {
    // 2026-10-08: Mary (2024, movie 11075) was grabbed, but Radarr's queue named
    // Maria (2024, movie 11094), so two correct releases were blocklisted.
    const { svc, radarr, runnerCtl, db } = makeHarness();
    radarr.queue = [
      makeQueueItem(2, {
        service: "radarr",
        title: "Maria.2024.German.DL.EAC3.1080p.NF.WEB.H264-ZeroTwo",
        movieId: 11094,
        movieTitle: "Maria",
        movieYear: 2024,
        episodeIds: [11094],
        statusMessages: [
          "Movie [Maria (2024)][tt22893404, 1038263] was not found in the grabbed release",
        ],
      }),
    ];
    radarr.candidatesByItem.set(2, [
      makeCandidate("candidate_1", [], { service: "radarr", movieId: 11094 }),
    ]);
    const grabbedFor: string[] = [];
    Object.assign(radarr, {
      getGrabbedMovieId: async (downloadId: string) => {
        grabbedFor.push(downloadId);
        return 11075;
      },
      getMovie: async (movieId: number) => ({ id: movieId, title: "Maria", year: 2024 }),
    });

    const { analysisId } = await svc.analyze("radarr", 2);
    await svc.waitForAnalysis(analysisId);

    expect(grabbedFor).toEqual(["dl-2"]);
    const prompt = runnerCtl.calls[0]?.prompt ?? "";
    expect(prompt).toContain('"movieId": 11075');
    expect(prompt).toContain(
      "Radarr's queue maps this download to Maria (movie 11094), but it was grabbed for Maria (2024) (movie 11075); the grabbed movie is the target.",
    );
    expect(
      db.select().from(fixerAnalyses).where(eq(fixerAnalyses.id, analysisId)).get()
        ?.targetEpisodeIds,
    ).toEqual([11075]);
  });

  it("checks a Sonarr download against the series it was grabbed for when the queue names a namesake", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = [
      makeQueueItem(1, {
        title: "Monster.S01E01.German.1080p",
        seriesId: 5,
        seriesTitle: "Monster",
      }),
    ];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    sonarr.episodes = [
      {
        id: 301,
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Herbstliche Rosen",
        series: { id: 77, title: "Monster", seriesType: "anime" },
      },
    ];
    Object.assign(sonarr, {
      getGrabbedEpisodes: async () => ({ seriesId: 77, episodeIds: [301] }),
    });

    const { analysisId } = await svc.analyze("sonarr", 1);
    await svc.waitForAnalysis(analysisId);

    const prompt = runnerCtl.calls[0]?.prompt ?? "";
    expect(prompt).toContain('"seriesId": 77');
    expect(prompt).toContain('"seriesType": "anime"');
    expect(prompt).toContain(
      "Sonarr's queue maps this download to Monster (series 5), but it was grabbed for Monster (series 77); the grabbed episodes are the target.",
    );
    expect(svc.getAnalysis(analysisId)?.targetEpisodeIds).toEqual([301]);
  });

  it("keeps Sonarr's episode mapping when the grab names the same series", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    Object.assign(sonarr, {
      getGrabbedEpisodes: async () => ({ seriesId: 5, episodeIds: [999] }),
    });

    const { analysisId } = await svc.analyze("sonarr", 1);
    await svc.waitForAnalysis(analysisId);

    expect(runnerCtl.calls[0]?.prompt).not.toContain("but it was grabbed for");
    expect(svc.getAnalysis(analysisId)?.targetEpisodeIds).toEqual([101]);
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
    // File inspection runs before the AI; abort only once the first run reached the AI.
    await vi.waitFor(() => expect(runnerCtl.calls).toHaveLength(1));
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

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      message: "Blocked language downgrade: the existing file has German audio.",
    });
    expect(sonarr.applyCalls).toHaveLength(0);
    expect(svc.listHistory().items[0]).toMatchObject({ result: "error", analysisId });
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

  it("refuses a second apply of the same download while the first one runs", async () => {
    const { svc, sonarr, settings, analysisId } = await analyzedHarness();
    settings.update({ dryRun: false });
    let finish: () => void = () => undefined;
    sonarr.verifyImportApplied = (_queueItem, result) =>
      new Promise((resolve) => {
        finish = () => resolve(result);
      });

    const first = svc.apply(analysisId);
    await vi.waitFor(() => expect(sonarr.applyCalls).toHaveLength(1));
    const second = await svc.apply(analysisId);
    finish();

    expect(second).toMatchObject({ ok: false, busy: true });
    expect((await first).ok).toBe(true);
    expect(sonarr.applyCalls).toHaveLength(1);
    expect(svc.listHistory().items).toHaveLength(1);
  });

  it("refuses removing another queue row of a download whose import is running", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [
      makeQueueItem(1, { downloadId: "season-pack" }),
      makeQueueItem(2, { downloadId: "season-pack", episodeIds: [102] }),
    ];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101]));
    const { analysisId } = await harness.svc.analyzeAndWait("sonarr", 1);
    harness.settings.update({ dryRun: false });
    let finish: () => void = () => undefined;
    harness.sonarr.verifyImportApplied = (_queueItem, result) =>
      new Promise((resolve) => {
        finish = () => resolve(result);
      });

    const applying = harness.svc.apply(analysisId);
    await vi.waitFor(() => expect(harness.sonarr.applyCalls).toHaveLength(1));
    const removal = await harness.svc.removeQueueItem("sonarr", 2);
    finish();

    expect(removal).toMatchObject({ ok: false, busy: true });
    expect(harness.sonarr.removeCalls).toHaveLength(0);
    expect((await applying).ok).toBe(true);
  });

  it("finds a running apply from a cold cache through an in-progress sibling row", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [
      makeQueueItem(1, { downloadId: "season-pack" }),
      makeQueueItem(2, { downloadId: "season-pack", episodeIds: [102] }),
    ];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101]));
    const { analysisId } = await harness.svc.analyzeAndWait("sonarr", 1);
    harness.settings.update({ dryRun: false });
    let finish: () => void = () => undefined;
    harness.sonarr.verifyImportApplied = (_queueItem, result) =>
      new Promise((resolve) => {
        finish = () => resolve(result);
      });

    const applying = harness.svc.apply(analysisId);
    await vi.waitFor(() => expect(harness.sonarr.applyCalls).toHaveLength(1));
    // Sonarr now reports the sibling as importing, and the cache is gone.
    harness.sonarr.queue[1] = { ...(harness.sonarr.queue[1] as QueueItem), isInProgress: true };
    (harness.svc as unknown as { queueCache: null }).queueCache = null;
    const removal = await harness.svc.removeQueueItem("sonarr", 2);
    finish();

    expect(removal).toMatchObject({ ok: false, busy: true });
    expect(harness.sonarr.removeCalls).toHaveLength(0);
    await applying;
  });

  it("refuses a removal whose download cannot be identified", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(2, { downloadId: "season-pack" })];
    harness.settings.update({ dryRun: false });
    const listQueue = harness.sonarr.listQueue.bind(harness.sonarr);
    harness.sonarr.listQueue = vi
      .fn<typeof listQueue>()
      .mockRejectedValueOnce(new Error("Sonarr 503"))
      .mockImplementation(listQueue);

    const removal = await harness.svc.removeQueueItem("sonarr", 2);

    expect(removal.ok).toBe(false);
    expect(removal.message).toContain("Cannot identify the download");
    expect(harness.sonarr.removeCalls).toHaveLength(0);
  });

  it("previews a dry-run removal without reading the arr queue", async () => {
    const harness = makeHarness();
    const listQueue = vi.fn().mockRejectedValue(new Error("Sonarr 503"));
    harness.sonarr.listQueue = listQueue;

    const removal = await harness.svc.removeQueueItem("sonarr", 2);

    expect(removal).toMatchObject({ ok: true, dryRun: true });
    expect(harness.sonarr.removeCalls).toHaveLength(0);
  });

  it("drains a running apply on shutdown and stops its verification", async () => {
    const { svc, sonarr, settings, analysisId } = await analyzedHarness();
    settings.update({ dryRun: false });
    let signal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    sonarr.verifyImportApplied = (_queueItem, result, options) => {
      signal = options?.signal;
      return new Promise((resolve) => {
        finish = () => resolve({ ...result, ok: false, message: "stopped" });
      });
    };

    const applying = svc.apply(analysisId);
    await vi.waitFor(() => expect(signal).toBeDefined());
    svc.cancelAll();
    expect(signal?.aborted).toBe(true);
    let drained = false;
    const draining = svc.wait().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await draining;

    expect((await applying).ok).toBe(false);
    expect(svc.listHistory().items[0]?.result).toBe("error");
  });

  it("gives import verification the live dry-run gate for leftover cleanup", async () => {
    const { svc, sonarr, settings, analysisId } = await analyzedHarness();
    settings.update({ dryRun: false });
    let gate: (() => boolean) | undefined;
    sonarr.verifyImportApplied = async (_queueItem, result, options) => {
      gate = options?.mayMutate;
      return result;
    };

    await svc.apply(analysisId);

    expect(gate?.()).toBe(true);
    settings.update({ dryRun: true });
    expect(gate?.()).toBe(false);
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
    expect(harness.svc.listHistory().items[0]).toMatchObject({
      result: "error",
      analysisId: outcome.analysisId,
    });
  });

  it("refuses to import from an analysis saved before file inspection existed", async () => {
    const { db, svc, sonarr, settings, analysisId } = await analyzedHarness();
    const row = db.select().from(fixerAnalyses).where(eq(fixerAnalyses.id, analysisId)).get();
    if (!row?.proposal) throw new Error("analysis row missing");
    const { identity: _identity, ...legacy } = row.proposal as unknown as ResolutionProposal;
    db.update(fixerAnalyses)
      .set({ proposal: legacy as unknown as Record<string, unknown> })
      .where(eq(fixerAnalyses.id, analysisId))
      .run();
    settings.update({ dryRun: false });

    const result = await svc.apply(analysisId);

    expect(result).toMatchObject({
      ok: false,
      message: "This analysis predates file inspection. Reanalyze before importing.",
    });
    expect(sonarr.applyCalls).toHaveLength(0);
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
  it("never records removal success when the download became in-progress", async () => {
    const { svc, sonarr, settings } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    await svc.refreshQueue();
    settings.update({ dryRun: false });
    vi.spyOn(sonarr, "listQueue").mockResolvedValue([makeQueueItem(1, { isInProgress: true })]);
    const outcome = await svc.removeQueueItem("sonarr", 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("still in progress");
    expect(sonarr.listQueue).toHaveBeenCalledWith({ includeInProgress: true });
    expect(sonarr.removeCalls).toHaveLength(0);
    expect(svc.listHistory().items[0]?.result).toBe("error");
  });
  it("resolves the current queue ID by download before removing", async () => {
    const { svc, sonarr, settings } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    await svc.refreshQueue();
    sonarr.queue = [
      makeQueueItem(9, { downloadId: "dl-1" }),
      makeQueueItem(1, { downloadId: "different" }),
    ];
    settings.update({ dryRun: false });
    expect((await svc.removeQueueItem("sonarr", 1)).ok).toBe(true);
    expect(sonarr.removeCalls.map((call) => call.queueItemId)).toEqual([9]);
    expect((await svc.getQueue()).items.some((item) => item.downloadId === "dl-1")).toBe(false);
  });

  it.each([true, false])(
    "reconciles a 404 and only succeeds if the download disappeared: %s",
    async (disappeared) => {
      const { svc, sonarr, settings } = makeHarness();
      sonarr.queue = [makeQueueItem(1)];
      settings.update({ dryRun: false });
      vi.spyOn(sonarr, "removeQueueItem").mockImplementation(async () => {
        if (disappeared) sonarr.queue = [];
        throw new Error("Sonarr 404 Not Found");
      });
      const outcome = await svc.removeQueueItem("sonarr", 1);
      expect(outcome.ok).toBe(disappeared);
      expect(svc.listHistory().items[0]?.result).toBe(disappeared ? "ok" : "error");
    },
  );

  it("does not treat an unavailable queue as proof that a 404 item disappeared", async () => {
    const { svc, sonarr, settings } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    settings.update({ dryRun: false });
    vi.spyOn(sonarr, "removeQueueItem").mockImplementation(async () => {
      vi.spyOn(sonarr, "listQueue").mockRejectedValue(new Error("offline"));
      throw new Error("Sonarr 404 Not Found");
    });
    const outcome = await svc.removeQueueItem("sonarr", 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Cannot verify current queue");
  });

  it("does not remove when dry-run is enabled during queue refresh", async () => {
    const { svc, sonarr, settings } = makeHarness();
    sonarr.queue = [makeQueueItem(1)];
    await svc.refreshQueue();
    settings.update({ dryRun: false });
    vi.spyOn(sonarr, "listQueue").mockImplementation(async () => {
      settings.update({ dryRun: true });
      return sonarr.queue;
    });
    expect((await svc.removeQueueItem("sonarr", 1)).ok).toBe(false);
    expect(sonarr.removeCalls).toHaveLength(0);
  });

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
    settings.update({ dryRun: false, fixerAutoApply: true });
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
  // The 1000 deltas (plus the runner's trailing text) merge into one text block.
  const textBlocks = ((row?.events ?? []) as FixerAnalysisEvent[]).filter((e) => e.kind === "text");
  expect(textBlocks).toHaveLength(1);
  expect(JSON.stringify(row?.events)).toContain("analysis text");
});

describe("FixerService persisted analysis trace", () => {
  type DeltaEvent = Extract<FixerAnalysisEvent, { kind: "text" | "thinking" }>;
  const persistedEvents = (harness: ReturnType<typeof makeHarness>) =>
    (harness.db.select().from(fixerAnalyses).get()?.events ?? []) as FixerAnalysisEvent[];

  it("coalesces text and thinking deltas per block but streams every delta over SSE", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(1)];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript((req) => {
      const emit = (event: FixerAnalysisEvent) => req.onEvent?.(event);
      emit({ kind: "thinking", delta: "check ", ts: 1, itemId: 1 });
      emit({ kind: "thinking", delta: "episodes", ts: 2, itemId: 1 });
      emit({ kind: "text", delta: "Looking ", ts: 3, itemId: 1 });
      emit({ kind: "text", delta: "up.", ts: 4, itemId: 1 });
      emit({ kind: "tool-call", phase: "start", toolName: "t", ts: 5, itemId: 1, args: { a: 1 } });
      emit({
        kind: "tool-call",
        phase: "end",
        toolName: "t",
        ts: 6,
        itemId: 1,
        args: { a: 1 },
        result: "found",
      });
      emit({ kind: "text", delta: "Done", ts: 7, itemId: 1 });
      return importProposal("candidate_1", [101]);
    });

    await harness.svc.analyzeAndWait("sonarr", 1);

    const piEvents = persistedEvents(harness).filter((e) => e.kind !== "step");
    expect(piEvents).toEqual([
      { kind: "thinking", delta: "check episodes", ts: 1, itemId: 1 },
      { kind: "text", delta: "Looking up.", ts: 3, itemId: 1 },
      expect.objectContaining({ kind: "tool-call", phase: "start", args: { a: 1 } }),
      expect.objectContaining({ kind: "tool-call", phase: "end", result: "found" }),
      // The fake runner's trailing "analysis text" (no itemId) is a separate block.
      { kind: "text", delta: "Done", ts: 7, itemId: 1 },
      expect.objectContaining({ kind: "text", delta: "analysis text" }),
    ]);
    const streamedDeltas = harness.busEvents.filter(
      (e) =>
        e.type === "fixer.analysis.progress" &&
        ["text", "thinking"].includes(
          ((e.payload as { event: { details?: { kind?: string } } }).event.details?.kind ??
            "") as string,
        ),
    );
    expect(streamedDeltas).toHaveLength(6);
  });

  it("caps a merged block at 20000 chars with a single truncation marker", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(1)];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript((req) => {
      for (let i = 0; i < 30; i++) {
        req.onEvent?.({ kind: "thinking", delta: "y".repeat(1_000), ts: i, itemId: 1 });
      }
      return importProposal("candidate_1", [101]);
    });

    await harness.svc.analyzeAndWait("sonarr", 1);

    const thinking = persistedEvents(harness).filter((e): e is DeltaEvent => e.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe(`${"y".repeat(20_000)} …[truncated]`);
  });

  it("keeps ~40 tool calls and shrinks the largest results to fit the size budget", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(1)];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript((req) => {
      for (let i = 0; i < 80; i++) {
        req.onEvent?.({ kind: "tool-call", phase: "start", toolName: `t${i}`, ts: i, itemId: 1 });
        req.onEvent?.({
          kind: "tool-call",
          phase: "end",
          toolName: `t${i}`,
          ts: i,
          itemId: 1,
          // Two large results; the rest are small.
          result: i < 78 ? `small ${i}` : "z".repeat(300_000),
        });
      }
      return importProposal("candidate_1", [101]);
    });

    await harness.svc.analyzeAndWait("sonarr", 1);

    const events = persistedEvents(harness);
    expect(JSON.stringify(events).length).toBeLessThanOrEqual(400_000);
    const ends = events.filter(
      (e): e is Extract<FixerAnalysisEvent, { kind: "tool-call" }> =>
        e.kind === "tool-call" && e.phase === "end",
    );
    expect(ends).toHaveLength(80);
    expect(ends[0]?.result).toBe("small 0");
    const shrunk = ends.filter((e) => String(e.result).includes("…[truncated"));
    expect(shrunk.length).toBeGreaterThanOrEqual(1);
    expect(String(shrunk[0]?.result)).toMatch(/^z{1000}…\[truncated \d+ chars/);
    const messages = events.flatMap((e) => (e.kind === "step" ? [e.message] : []));
    expect(messages).toContain("Loading manual import candidates.");
  });
});

describe("FixerService season packs", () => {
  function packRows() {
    return [1, 2, 3].map((id) =>
      makeQueueItem(id, {
        downloadId: "pack",
        title: "Show.S01.1080p.WEB-DL",
        statusMessages: ["Found matching series via grab history"],
      }),
    );
  }

  it("analyzes the whole download and applies against every queued episode, whatever row Sonarr lists first", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = packRows();
    harness.sonarr.candidatesByItem.set(3, [
      makeCandidate("candidate_1", [101]),
      makeCandidate("candidate_2", [102]),
      makeCandidate("candidate_3", [103]),
    ]);
    harness.runnerCtl.setScript(() =>
      importProposal("candidate_3", [103], {
        selectedCandidateIds: ["candidate_2", "candidate_3"],
        selectedImports: [
          { candidateId: "candidate_2", episodeIds: [102] },
          { candidateId: "candidate_3", episodeIds: [103] },
        ],
      }),
    );

    const outcome = await harness.svc.analyzeAndWait("sonarr", 3);
    expect(outcome.result?.status).toBe("proposal");
    expect(harness.runnerCtl.calls[0]?.prompt).toContain(
      '"targetEpisodeIds": [\n    101,\n    102,\n    103\n  ]',
    );
    expect(harness.svc.getAnalysis(outcome.analysisId)?.targetEpisodeIds).toEqual([101, 102, 103]);
    expect(harness.svc.getAnalysis(outcome.analysisId)?.itemLabel).toBe(
      "Show S01E01, S01E02, S01E03",
    );

    // Sonarr now lists a sibling row first; the old lookup would have made
    // S01E01 the only "queued target" and refused the import.
    harness.sonarr.queue = packRows();
    harness.settings.update({ dryRun: false });
    const result = await harness.svc.apply(outcome.analysisId);

    expect(result.ok).toBe(true);
    expect(harness.sonarr.applyCalls[0]?.queueItem.episodeIds).toEqual([101, 102, 103]);
    expect(harness.sonarr.applyCalls[0]?.queueItem.queueItemIds).toEqual([1, 2, 3]);
    expect((await harness.svc.getQueue()).items).toHaveLength(0);
  });

  it("applies against the recorded target set even when Sonarr exposes new sibling rows later", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = packRows();
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101]));
    const outcome = await harness.svc.analyzeAndWait("sonarr", 1);

    harness.sonarr.queue = [
      ...packRows(),
      makeQueueItem(4, { downloadId: "pack", episodeIds: [104], seasonEpisode: "S01E04" }),
    ];
    harness.settings.update({ dryRun: false });
    const result = await harness.svc.apply(outcome.analysisId);

    expect(result.ok).toBe(true);
    expect(harness.sonarr.applyCalls[0]?.queueItem.episodeIds).toEqual([101, 102, 103]);
    expect(harness.sonarr.applyCalls[0]?.queueItem.queueItemIds).toEqual([1, 2, 3, 4]);
  });

  it("still refuses a pack whose selection covers none of the queued episodes", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = packRows();
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_9", [999])]);
    harness.runnerCtl.setScript(() => importProposal("candidate_9", [999]));

    const outcome = await harness.svc.analyzeAndWait("sonarr", 1);

    expect(outcome.result?.status).toBe("needs_review");
    expect(outcome.result?.validation.issues.map((issue) => issue.message).join(" ")).toContain(
      "queued target episode",
    );
  });

  it("marks a proposal needs_review when the arr preflight refuses it during analysis", async () => {
    const harness = makeHarness();
    harness.sonarr.queue = [makeQueueItem(1)];
    harness.sonarr.candidatesByItem.set(1, [makeCandidate("candidate_1", [101])]);
    harness.sonarr.preflightResult = {
      ok: false,
      message: "Blocked non-upgrade: candidate_1 would not improve the library.",
    };
    harness.runnerCtl.setScript(() => importProposal("candidate_1", [101]));

    const outcome = await harness.svc.analyzeAndWait("sonarr", 1);

    expect(outcome.result?.status).toBe("needs_review");
    expect(outcome.result?.validation.ok).toBe(false);
    expect(outcome.result?.validation.issues.at(-1)?.message).toContain("Blocked non-upgrade");
    expect(harness.svc.shouldProcess({ ...makeQueueItem(1), issueType: "quality" })).toBe(false);
  });

  it("locks one analysis per download and cancels it through any sibling row", async () => {
    const { svc, sonarr, runnerCtl } = makeHarness();
    sonarr.queue = packRows();
    sonarr.candidatesByItem.set(3, [makeCandidate("candidate_3", [103])]);
    sonarr.candidatesByItem.set(1, [makeCandidate("candidate_3", [103])]);
    runnerCtl.setScript(
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );

    const first = await svc.analyze("sonarr", 3);
    const second = await svc.analyze("sonarr", 1);
    expect((await svc.waitForAnalysis(first.analysisId)).status).toBe("cancelled");
    expect(svc.cancel("sonarr", 2)).toBe(true);
    expect((await svc.waitForAnalysis(second.analysisId)).status).toBe("cancelled");
  });
});
