import { describe, expect, it } from "vitest";
import type {
  ApplyResult,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import type { FixerAnalysisEvent, FixerPiRunner, FixerPiRunRequest } from "./ai-port.js";
import { resolveQueueItem } from "./resolver.js";

class FakeArrClient {
  queue: QueueItem[] = [];
  candidatesByItem = new Map<number, ManualImportCandidate[]>();
  async listQueue(): Promise<QueueItem[]> {
    return this.queue;
  }
  async getManualImportCandidates(queueItem: QueueItem): Promise<ManualImportCandidate[]> {
    return this.candidatesByItem.get(queueItem.id) ?? [];
  }
  async applyImportProposal(): Promise<ApplyResult> {
    return { ok: true, message: "applied" };
  }
  async removeQueueItem(queueItemId: number, _options: QueueRemovalOptions): Promise<ApplyResult> {
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

function makeQueueItem(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 11,
    service: "sonarr",
    title: "Show.S01E01.720p",
    seriesId: 5,
    seriesTitle: "Show",
    downloadId: "dl-11",
    status: "warning",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importPending",
    isInProgress: false,
    episodeIds: [101],
    absoluteEpisodeNumbers: [],
    episodeLabels: ["S01E01 Pilot"],
    seasonEpisode: "S01E01",
    statusMessages: ["Not an upgrade for existing episode file(s). Quality already met."],
    canAnalyze: true,
    ...over,
  };
}

function makeCandidate(
  id: string,
  over: Partial<ManualImportCandidate> = {},
): ManualImportCandidate {
  return {
    id,
    service: "sonarr",
    path: `/downloads/${id}.mkv`,
    episodeIds: [101],
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
  over: Partial<ResolutionProposal> = {},
): ResolutionProposal {
  return {
    action: "import_candidates",
    confidence: 0.9,
    selectedCandidateIds: [candidateId],
    selectedImports: [{ candidateId, episodeIds: [101] }],
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

describe("resolveQueueItem", () => {
  it("returns a needs_review fallback without running Pi when there are no candidates", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      return { log: [] };
    };
    const result = await resolveQueueItem({
      queueItem: makeQueueItem(),
      candidates: [],
      client: new FakeArrClient(),
      runner,
    });
    expect(calls).toHaveLength(0);
    expect(result.status).toBe("needs_review");
    expect(result.proposal.confidence).toBe(0);
    expect(result.proposal.reason).toBe("Sonarr returned no manual import candidates.");
    expect(result.validation.ok).toBe(true);
  });

  it("captures exactly one typed proposal through the terminating tool", async () => {
    const events: FixerAnalysisEvent[] = [];
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      req.onEvent?.({ kind: "text", delta: "checking", ts: Date.now() });
      await invokeProposalTool(req, importProposal("candidate_1"));
      return { log: ["checking"] };
    };
    const result = await resolveQueueItem({
      queueItem: makeQueueItem(),
      candidates: [makeCandidate("candidate_1")],
      client: new FakeArrClient(),
      runner,
      onEvent: (event) => events.push(event),
    });

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req?.service).toBe("sonarr");
    expect(req?.toolNames).toContain("propose_sonarr_resolution");
    expect(req?.systemPrompt).toContain(
      "German audio is preferred but not required. When several usable candidates exist, prefer one whose languages include German.",
    );
    expect(req?.prompt).toContain("Call propose_sonarr_resolution now.");
    // lookup tools + proposal tool assembled for the session
    expect(req?.tools).toHaveLength(5);

    expect(result.status).toBe("proposal");
    expect(result.proposal.action).toBe("import_candidates");
    expect(result.proposal.selectedImports).toEqual([
      { candidateId: "candidate_1", episodeIds: [101] },
    ]);
    expect(result.validation.ok).toBe(true);
    expect(result.log).toEqual(["checking"]);
    expect(
      events.some((e) => e.kind === "step" && e.message === "Starting typed Pi analysis."),
    ).toBe(true);
    expect(events.some((e) => e.kind === "text")).toBe(true);
  });

  it("re-prompts once via followUp and still captures the proposal", async () => {
    const runner: FixerPiRunner = async (req) => {
      // first prompt: no tool call; runner honors the followUp contract
      if (req.followUp?.when()) {
        await invokeProposalTool(req, importProposal("candidate_1"));
      }
      return { log: [] };
    };
    const events: FixerAnalysisEvent[] = [];
    const result = await resolveQueueItem({
      queueItem: makeQueueItem(),
      candidates: [makeCandidate("candidate_1")],
      client: new FakeArrClient(),
      runner,
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("proposal");
    expect(
      events.some(
        (e) =>
          e.kind === "step" && e.message === "Pi did not call the proposal tool; retrying once.",
      ),
    ).toBe(true);
  });

  it("falls back to needs_review with confidence 0 when Pi never proposes", async () => {
    let followUpRan = false;
    const runner: FixerPiRunner = async (req) => {
      followUpRan = req.followUp?.when() ?? false;
      return { log: [] };
    };
    const result = await resolveQueueItem({
      queueItem: makeQueueItem(),
      candidates: [makeCandidate("candidate_1")],
      client: new FakeArrClient(),
      runner,
    });
    expect(followUpRan).toBe(true);
    expect(result.status).toBe("needs_review");
    expect(result.proposal.action).toBe("needs_review");
    expect(result.proposal.confidence).toBe(0);
    expect(result.proposal.reason).toBe("Pi did not return a typed proposal.");
  });

  it("marks import proposals failing validation as needs_review", async () => {
    const runner: FixerPiRunner = async (req) => {
      await invokeProposalTool(req, importProposal("candidate_1"));
      return { log: [] };
    };
    const result = await resolveQueueItem({
      queueItem: makeQueueItem(),
      candidates: [makeCandidate("candidate_1", { isLikelySample: true, sampleReason: "tiny" })],
      client: new FakeArrClient(),
      runner,
    });
    expect(result.proposal.action).toBe("import_candidates");
    expect(result.validation.ok).toBe(false);
    expect(result.status).toBe("needs_review");
  });

  it("builds the Radarr prompt/tooling for radarr queue items", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      await invokeProposalTool(req, {
        ...importProposal("candidate_1"),
        selectedImports: [{ candidateId: "candidate_1", episodeIds: [], movieId: 42 }],
      });
      return { log: [] };
    };
    const result = await resolveQueueItem({
      queueItem: makeQueueItem({
        id: 21,
        service: "radarr",
        movieId: 42,
        movieTitle: "Movie",
        movieYear: 2020,
        episodeIds: [],
        episodeLabels: [],
        seasonEpisode: undefined,
      }),
      candidates: [
        makeCandidate("candidate_1", {
          service: "radarr",
          movieId: 42,
          movieTitle: "Movie",
          episodeIds: [],
          episodeLabels: [],
          seriesId: undefined,
        }),
      ],
      client: new FakeArrClient(),
      runner,
    });
    expect(calls[0]?.toolNames).toContain("propose_radarr_resolution");
    expect(calls[0]?.prompt).toContain("Call propose_radarr_resolution now.");
    expect(result.status).toBe("proposal");
    expect(result.proposal.selectedImports[0]?.movieId).toBe(42);
  });

  it("skips the runner entirely when the signal is already aborted", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      return { log: [] };
    };
    const controller = new AbortController();
    controller.abort();
    const result = await resolveQueueItem({
      queueItem: makeQueueItem(),
      candidates: [makeCandidate("candidate_1")],
      client: new FakeArrClient(),
      runner,
      signal: controller.signal,
    });
    expect(calls).toHaveLength(0);
    expect(result.status).toBe("needs_review");
    expect(result.proposal.confidence).toBe(0);
  });
});
