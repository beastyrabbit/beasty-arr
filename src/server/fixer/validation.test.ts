import { describe, expect, it } from "vitest";
import type {
  ManualImportCandidate,
  QueueItem,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import { resolveImportEpisodeIds, validateProposalForImport } from "./validation.js";

function candidate(overrides: Partial<ManualImportCandidate> = {}): ManualImportCandidate {
  return {
    id: "candidate_1",
    service: "sonarr",
    path: "/downloads/show/episode.mkv",
    episodeIds: [101],
    absoluteEpisodeNumbers: [1],
    episodeLabels: ["S01E01 - Pilot"],
    quality: { quality: { name: "WEBDL-1080p" } },
    qualityLabel: "WEBDL-1080p",
    languages: [{ id: 1, name: "English" }],
    languageLabels: ["English"],
    rejections: [],
    isLikelySample: false,
    ...overrides,
  };
}

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    service: "sonarr",
    title: "Queue item",
    episodeIds: [101],
    absoluteEpisodeNumbers: [1],
    episodeLabels: ["S01E01 - Pilot"],
    statusMessages: [],
    canAnalyze: true,
    ...overrides,
  };
}

const importProposal: ResolutionProposal = {
  action: "import_candidates",
  confidence: 0.91,
  selectedCandidateIds: ["candidate_1"],
  selectedImports: [
    { candidateId: "candidate_1", episodeIds: [101], reason: "AI selected this mapping." },
  ],
  sampleCandidateIds: [],
  reason: "Looks correct.",
  issueSummary: "Sonarr complained about a manual import warning.",
  evidence: ["candidate_1 matches the target episode."],
  warnings: [],
};

describe("validateProposalForImport", () => {
  it("accepts a complete non-sample import candidate", () => {
    const result = validateProposalForImport([candidate({ seriesId: 12 })], importProposal);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("blocks likely samples", () => {
    const result = validateProposalForImport(
      [candidate({ seriesId: 12, isLikelySample: true, sampleReason: "filename contains sample" })],
      importProposal,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("sample"))).toBe(true);
  });

  it("blocks duplicate episode ids across selected candidates", () => {
    const result = validateProposalForImport(
      [
        candidate({ id: "candidate_1", seriesId: 12, episodeIds: [101] }),
        candidate({ id: "candidate_2", seriesId: 12, episodeIds: [101] }),
      ],
      {
        ...importProposal,
        selectedCandidateIds: ["candidate_1", "candidate_2"],
        selectedImports: [
          { candidateId: "candidate_1", episodeIds: [101] },
          { candidateId: "candidate_2", episodeIds: [101] },
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("more than once"))).toBe(true);
  });

  it("blocks imports without an explicit Pi episode mapping", () => {
    const result = validateProposalForImport([candidate({ seriesId: 12 })], {
      ...importProposal,
      selectedImports: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("explicit"))).toBe(true);
  });

  it("allows Pi to import a file as queue target ids even when Sonarr parsed the candidate differently", () => {
    const selected = candidate({
      seriesId: 12,
      path: "/downloads/Hunter.x.Hunter.E100.Auf.x.der.Jagd.x.verfolgt/Hunter x Hunter (2011) - S02E42 - 100 - Tracking x And x Pursuit.mkv",
      episodeIds: [40083],
      absoluteEpisodeNumbers: [104],
      episodeLabels: ["S02E42 - Some Other Sonarr Mapping"],
    });
    const target = queueItem({
      episodeIds: [40079],
      absoluteEpisodeNumbers: [100],
      episodeLabels: ["S02E38 - Tracking x And x Pursuit"],
      seasonEpisode: "S02E38",
      statusMessages: [
        "Episode 2x42 was unexpected considering the Hunter.x.Hunter.E100 folder name",
      ],
    });
    const proposal: ResolutionProposal = {
      ...importProposal,
      selectedImports: [
        {
          candidateId: "candidate_1",
          episodeIds: [40079],
          reason: "Pi verified E100 maps to the queue target episode id.",
        },
      ],
    };

    const result = validateProposalForImport([selected], proposal, target);
    expect(result.ok).toBe(true);
    expect(resolveImportEpisodeIds(proposal, "candidate_1")).toEqual([40079]);
  });

  it("blocks episode ids that were not present in queue, candidates, or lookup context", () => {
    const result = validateProposalForImport([candidate({ seriesId: 12 })], {
      ...importProposal,
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [9999] }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("not present"))).toBe(true);
  });

  it("does not block non-import actions", () => {
    const result = validateProposalForImport([], {
      ...importProposal,
      action: "needs_review",
      selectedCandidateIds: [],
      selectedImports: [],
    });
    expect(result.ok).toBe(true);
  });

  it("validates Radarr imports against an explicit movie id", () => {
    const radarrCandidate = candidate({
      service: "radarr",
      seriesId: 42,
      seriesTitle: "Arrival",
      movieId: 42,
      movieTitle: "Arrival",
      movieYear: 2016,
      episodeIds: [42],
      episodeLabels: ["Arrival (2016)"],
    });
    const result = validateProposalForImport(
      [radarrCandidate],
      {
        ...importProposal,
        selectedImports: [{ candidateId: "candidate_1", episodeIds: [], movieId: 42 }],
      },
      queueItem({
        service: "radarr",
        movieId: 42,
        movieTitle: "Arrival",
        movieYear: 2016,
        episodeIds: [42],
        episodeLabels: ["Arrival (2016)"],
      }),
    );

    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("blocks multiple Radarr feature files for one queue item", () => {
    const first = candidate({
      service: "radarr",
      seriesId: 42,
      movieId: 42,
      episodeIds: [42],
    });
    const second = { ...first, id: "candidate_2", path: "/downloads/show/second.mkv" };
    const result = validateProposalForImport(
      [first, second],
      {
        ...importProposal,
        selectedCandidateIds: ["candidate_1", "candidate_2"],
        selectedImports: [
          { candidateId: "candidate_1", episodeIds: [], movieId: 42 },
          { candidateId: "candidate_2", episodeIds: [], movieId: 42 },
        ],
      },
      queueItem({ service: "radarr", movieId: 42, episodeIds: [42] }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("one feature file"))).toBe(true);
  });
});
