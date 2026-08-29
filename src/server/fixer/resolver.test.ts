import { describe, expect, it } from "vitest";
import type {
  ApplyResult,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import type { RadarrMovieRecord } from "../arr/radarr-client.js";
import type { SonarrEpisodeRecord } from "../arr/sonarr-client.js";
import type { FixerAnalysisEvent, FixerPiRunner, FixerPiRunRequest } from "./ai-port.js";
import {
  realDevilsRejectsCandidate,
  realDevilsRejectsMovie,
  realDevilsRejectsQueueItem,
  realHouseDragonExistingEpisode,
  realHouseDragonGermanUpgradeCandidate,
  realHouseDragonGermanUpgradeQueueItem,
  realMentalistCandidate,
  realMentalistExistingEpisode,
  realMentalistQueueItem,
} from "./real-world-fixtures.js";
import { resolveQueueItem } from "./resolver.js";

class FakeArrClient {
  queue: QueueItem[] = [];
  candidatesByItem = new Map<number, ManualImportCandidate[]>();
  episodes: SonarrEpisodeRecord[] = [];
  moviesById = new Map<number, RadarrMovieRecord>();
  async listQueue(): Promise<QueueItem[]> {
    return this.queue;
  }
  async getManualImportCandidates(queueItem: QueueItem): Promise<ManualImportCandidate[]> {
    return this.candidatesByItem.get(queueItem.id) ?? [];
  }
  async applyImportProposal(): Promise<ApplyResult> {
    return { ok: true, message: "applied" };
  }
  async preflightImportProposal(): Promise<ApplyResult> {
    return { ok: true, message: "preflight passed" };
  }
  async removeQueueItem(queueItemId: number, _options: QueueRemovalOptions): Promise<ApplyResult> {
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
  async getMovie(movieId: number): Promise<RadarrMovieRecord> {
    return this.moviesById.get(movieId) ?? { id: movieId };
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

async function invokeLookupTool(req: FixerPiRunRequest, name: string): Promise<void> {
  const tool = (req.tools as ProposalToolLike[]).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} not found`);
  await tool.execute("lookup_1", {}, undefined, undefined, undefined as never);
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
    expect(req?.systemPrompt).toContain(
      "Always call sonarr_get_upgrade_context before the proposal tool, for every queue item.",
    );
    expect(req?.systemPrompt).toContain(
      "do not import it and do not use needs_review. Use remove_queue_item",
    );
    expect(req?.prompt).toContain("Call propose_sonarr_resolution now.");
    expect(req?.prompt).toContain(
      "languageMetadataPresent=true and hasGermanAudio=false while the mapped current file has hasGermanAudio=true",
    );
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

  it("treats an exact year-season TBA match and future air date as advisory", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      await invokeLookupTool(req, "sonarr_get_upgrade_context");
      await invokeProposalTool(
        req,
        importProposal("candidate_tba", {
          selectedImports: [{ candidateId: "candidate_tba", episodeIds: [88255] }],
          reason: "The full-size German S2026E135 file exactly maps to the queued TBA episode.",
          issueSummary: "Sonarr reports only an advisory TBA/future-air-date warning.",
        }),
      );
      return { log: [] };
    };

    const result = await resolveQueueItem({
      queueItem: makeQueueItem({
        id: 135,
        title: "Das.perfekte.Dinner.S2026E135.GERMAN.1080p.WEB.H264",
        seriesId: 77,
        seriesTitle: "Das perfekte Dinner",
        episodeIds: [88255],
        episodeLabels: ["S2026E135 TBA"],
        seasonEpisode: "S2026E135",
        statusMessages: ["Episode has a TBA title and a future air date."],
      }),
      candidates: [
        makeCandidate("candidate_tba", {
          path: "/downloads/Das.perfekte.Dinner.S2026E135.GERMAN.1080p.WEB.H264.mkv",
          episodeIds: [88255],
          episodeLabels: ["S2026E135 TBA"],
          qualityLabel: "WEBDL-1080p",
          seriesId: 77,
          seriesTitle: "Das perfekte Dinner",
          rejections: ["Episode has a TBA title and a future air date."],
          size: 2_000_000_000,
        }),
      ],
      client: new FakeArrClient(),
      runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toContain(
      "A TBA episode title and a future air date are advisory, not blocking",
    );
    expect(calls[0]?.systemPrompt).toContain(
      "Do not apply the TBA exception to a sample, Blu-ray disc structure chunk, conflicting episode identity, wrong-series candidate, or a candidate that fails the normal language or quality safety rules.",
    );
    expect(calls[0]?.prompt).toContain("A future air date alone is not blocking.");
    expect(result.status).toBe("proposal");
    expect(result.proposal.action).toBe("import_candidates");
    expect(result.proposal.selectedImports).toEqual([
      { candidateId: "candidate_tba", episodeIds: [88255] },
    ]);
    expect(result.validation.ok).toBe(true);
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

  it("promotes a sole feature-sized Radarr file past an advisory sample warning", async () => {
    const runner: FixerPiRunner = async (req) => {
      await invokeProposalTool(req, {
        action: "needs_review",
        confidence: 0.88,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        reason: "Radarr could not determine whether this is a sample.",
        issueSummary: "Sample detection was inconclusive.",
        evidence: [],
        warnings: ["Verify the feature manually."],
      });
      return { log: [] };
    };
    const client = new FakeArrClient();
    client.moviesById.set(42, { id: 42, hasFile: false });
    const result = await resolveQueueItem({
      queueItem: makeQueueItem({
        service: "radarr",
        movieId: 42,
        movieTitle: "Feature",
        episodeIds: [],
        episodeLabels: [],
        statusMessages: ["Unable to determine if file is a sample"],
      }),
      candidates: [
        makeCandidate("candidate_1", {
          service: "radarr",
          movieId: 42,
          movieTitle: "Feature",
          seriesId: undefined,
          episodeIds: [],
          episodeLabels: [],
          size: 7_000_000_000,
          rejections: ["Unable to determine if file is a sample"],
        }),
      ],
      client,
      runner,
    });

    expect(result.status).toBe("proposal");
    expect(result.proposal).toMatchObject({
      action: "import_candidates",
      confidence: 0.97,
      selectedImports: [{ candidateId: "candidate_1", movieId: 42 }],
    });
    expect(result.validation.ok).toBe(true);
  });

  it("does not promote a sample-only review when Radarr already has a movie file", async () => {
    const runner: FixerPiRunner = async (req) => {
      await invokeProposalTool(req, {
        action: "needs_review",
        confidence: 0.88,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        reason: "Radarr could not determine whether this is a sample.",
        issueSummary: "Sample detection was inconclusive.",
        evidence: [],
        warnings: [],
      });
      return { log: [] };
    };
    const client = new FakeArrClient();
    client.moviesById.set(42, { id: 42, hasFile: true });

    const result = await resolveQueueItem({
      queueItem: makeQueueItem({
        service: "radarr",
        movieId: 42,
        episodeIds: [],
        episodeLabels: [],
      }),
      candidates: [
        makeCandidate("candidate_1", {
          service: "radarr",
          movieId: 42,
          seriesId: undefined,
          episodeIds: [],
          episodeLabels: [],
          size: 7_000_000_000,
          rejections: ["Unable to determine if file is a sample"],
        }),
      ],
      client,
      runner,
    });

    expect(result.proposal.action).toBe("needs_review");
  });

  it("replays the real Devil's Rejects Radarr decision", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      await invokeLookupTool(req, "radarr_get_upgrade_context");
      await invokeProposalTool(req, {
        action: "remove_queue_item",
        confidence: 0.97,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        reason: "Do not import this English-only candidate over the existing German/DL file.",
        issueSummary:
          "The sample warning is not credible for this feature-sized file, but the language downgrade is blocking.",
        evidence: ["Candidate is English-only; existing library file is German and English."],
        warnings: [],
        queueRemovalOptions: {
          removeFromClient: true,
          blocklist: true,
          skipRedownload: true,
          changeCategory: false,
        },
      });
      return { log: [] };
    };
    const client = new FakeArrClient();
    client.moviesById.set(5_454, realDevilsRejectsMovie());
    const result = await resolveQueueItem({
      queueItem: realDevilsRejectsQueueItem(),
      candidates: [realDevilsRejectsCandidate()],
      client,
      runner,
    });
    expect(calls[0]?.toolNames).toContain("propose_radarr_resolution");
    expect(calls[0]?.prompt).toContain("Call propose_radarr_resolution now.");
    expect(calls[0]?.systemPrompt).toContain(
      "Always call radarr_get_upgrade_context before the proposal tool, for every queue item.",
    );
    expect(calls[0]?.prompt).toContain(
      "languageMetadataPresent=true and hasGermanAudio=false while the current movie file has hasGermanAudio=true",
    );
    expect(calls[0]?.prompt).toContain("The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL.mkv");
    expect(calls[0]?.prompt).toContain("No active Dub Oracle verdict is available for this movie.");
    expect(calls[0]?.prompt).toContain("even if it is higher quality");
    expect(calls[0]?.prompt).toContain("do not start a replacement search");
    expect(result.status).toBe("proposal");
    expect(result.proposal).toMatchObject({
      action: "remove_queue_item",
      confidence: 0.97,
      queueRemovalOptions: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: true,
        changeCategory: false,
      },
    });
  });

  it("replays the real Mentalist Sonarr decision", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      await invokeLookupTool(req, "sonarr_get_upgrade_context");
      await invokeProposalTool(req, {
        action: "remove_queue_item",
        confidence: 0.99,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        reason: "Do not import this English-only release over the existing German episode.",
        issueSummary:
          "The candidate score is 57 versus the existing file's 11050 and it would downgrade German audio.",
        evidence: ["Candidate is English-only; existing S01E23 has German audio."],
        warnings: [],
        queueRemovalOptions: {
          removeFromClient: true,
          blocklist: true,
          skipRedownload: true,
          changeCategory: false,
        },
      });
      return { log: [] };
    };
    const client = new FakeArrClient();
    client.episodes = [realMentalistExistingEpisode()];

    const result = await resolveQueueItem({
      queueItem: realMentalistQueueItem(),
      candidates: [realMentalistCandidate()],
      client,
      runner,
    });

    expect(calls[0]?.prompt).toContain("Red John's Footsteps");
    expect(calls[0]?.prompt).toContain('"customFormatScore": 57');
    expect(result.proposal).toMatchObject({
      action: "remove_queue_item",
      confidence: 0.99,
      queueRemovalOptions: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: true,
        changeCategory: false,
      },
    });
  });

  it("treats the captured House of the Dragon case as an intentional German-audio upgrade", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      await invokeLookupTool(req, "sonarr_get_upgrade_context");
      await invokeProposalTool(req, {
        action: "import_candidates",
        confidence: 0.99,
        selectedCandidateIds: ["candidate_1"],
        selectedImports: [{ candidateId: "candidate_1", episodeIds: [86_875] }],
        sampleCandidateIds: [],
        reason: "Import the exact German-audio upgrade for S03E06.",
        issueSummary:
          "The German candidate scores 11700 over the English-only current file at 407.",
        evidence: ["Exact episode mapping, allowed 1080p quality, and German audio."],
        warnings: [],
      });
      return { log: [] };
    };
    const client = new FakeArrClient();
    client.episodes = [realHouseDragonExistingEpisode()];

    const result = await resolveQueueItem({
      queueItem: realHouseDragonGermanUpgradeQueueItem(),
      candidates: [realHouseDragonGermanUpgradeCandidate()],
      client,
      runner,
    });

    expect(calls[0]?.prompt).toContain("Not a quality revision upgrade");
    expect(calls[0]?.prompt).toContain("adds German audio to a current file without German");
    expect(calls[0]?.systemPrompt).toContain("intended German-audio upgrade");
    expect(result.proposal).toMatchObject({
      action: "import_candidates",
      confidence: 0.99,
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [86_875] }],
    });
    expect(result.validation.ok).toBe(true);
  });

  it("gives the model active Dub Oracle evidence for the synthetic no-live-queue case", async () => {
    const calls: FixerPiRunRequest[] = [];
    const runner: FixerPiRunner = async (req) => {
      calls.push(req);
      await invokeProposalTool(req, {
        action: "remove_queue_item",
        confidence: 0.98,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        reason: "A verified German dub exists, so reject this English-only release.",
        issueSummary: "English-only release while German dub is obtainable",
        evidence: ["Dub Oracle reports German audio for season 1."],
        warnings: [],
        queueRemovalOptions: {
          removeFromClient: true,
          blocklist: true,
          skipRedownload: false,
          changeCategory: false,
        },
      });
      return { log: [] };
    };

    await resolveQueueItem({
      // No current fixer queue item also has an active Oracle verdict, so this
      // policy-only combination intentionally remains synthetic.
      queueItem: makeQueueItem(),
      candidates: [
        makeCandidate("candidate_1", {
          languages: [{ id: 1, name: "English" }],
          languageLabels: ["English"],
        }),
      ],
      dubVerdict: {
        verdict: "exists",
        confidence: 0.98,
        germanTitle: "Die Serie",
        perSeason: [{ season: 1, verdict: "exists", note: "German release available" }],
        evidence: ["Verified German home-video release."],
        expectedAvailability: null,
        checkedAt: 1_000,
        recheckAfter: 2_000,
      },
      client: new FakeArrClient(),
      runner,
    });

    expect(calls[0]?.prompt).toContain('"verdict": "exists"');
    expect(calls[0]?.prompt).toContain('"season": 1');
    expect(calls[0]?.prompt).toContain("even if it is higher quality");
    expect(calls[0]?.prompt).toContain("blocklist: true, skipRedownload: false");
    expect(calls[0]?.systemPrompt).toContain(
      "Dub Oracle context is separate research about whether a German dub exists.",
    );
  });

  it.each([
    ["exists", 0.6, "does not pass the sourced-evidence threshold"],
    ["announced", 0.95, "is planned but not available"],
    ["unlikely", 0.95, "is not known to exist"],
    ["unknown", 0.95, "could not be established"],
  ] as const)(
    "does not describe a %s Oracle verdict at confidence %s as an automatic block",
    async (verdict, confidence, evidence) => {
      const calls: FixerPiRunRequest[] = [];
      const runner: FixerPiRunner = async (req) => {
        calls.push(req);
        await invokeProposalTool(req, importProposal("candidate_1"));
        return { log: [] };
      };

      await resolveQueueItem({
        queueItem: makeQueueItem(),
        candidates: [makeCandidate("candidate_1")],
        dubVerdict: {
          verdict,
          confidence,
          germanTitle: null,
          perSeason: [{ season: 1, verdict }],
          evidence: [evidence],
          expectedAvailability: verdict === "announced" ? 2_000 : null,
          checkedAt: 1_000,
          recheckAfter: 3_000,
        },
        client: new FakeArrClient(),
        runner,
      });

      expect(calls[0]?.prompt).toContain(`"verdict": "${verdict}"`);
      expect(calls[0]?.prompt).toContain(evidence);
      expect(calls[0]?.prompt).toContain(
        "not above 0.6 confidence, not exists for the target season",
      );
    },
  );

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
