import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { ResolutionProposal } from "../../shared/fixer-types.js";
import { createProposalTool } from "./pi-proposal-tool.js";

describe("createProposalTool", () => {
  it("restricts candidate ids through the TypeBox schema", () => {
    const tool = createProposalTool(["candidate_1", "candidate_2"], () => undefined);
    const valid = {
      action: "import_candidates",
      confidence: 0.9,
      selectedCandidateIds: ["candidate_1"],
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [101] }],
      sampleCandidateIds: ["candidate_2"],
      reason: "candidate_1 is the episode; candidate_2 is sample",
      issueSummary: "Sonarr warning was caused by the sample file.",
      evidence: ["candidate_1 has the target episode id."],
      warnings: [],
    };
    const invalid = { ...valid, selectedCandidateIds: ["candidate_3"] };
    const invalidMapping = {
      ...valid,
      selectedImports: [{ candidateId: "candidate_3", episodeIds: [101] }],
    };

    expect(Value.Check(tool.parameters, valid)).toBe(true);
    expect(Value.Check(tool.parameters, invalid)).toBe(false);
    expect(Value.Check(tool.parameters, invalidMapping)).toBe(false);
  });

  it("captures a normalized terminating proposal", async () => {
    let captured: ResolutionProposal | undefined;
    const tool = createProposalTool(["candidate_1"], (proposal) => {
      captured = proposal;
    });

    const result = await tool.execute(
      "call_1",
      {
        action: "import_candidates",
        confidence: 2,
        selectedCandidateIds: ["candidate_1"],
        selectedImports: [{ candidateId: "candidate_1", episodeIds: [101] }],
        sampleCandidateIds: [],
        reason: "correct file",
        issueSummary: "Sonarr warning does not block candidate_1.",
        evidence: ["candidate_1 has usable metadata."],
        warnings: [],
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.terminate).toBe(true);
    expect(captured?.confidence).toBe(1);
  });

  it("captures queue removal options for AI-guided blocklist/search decisions", async () => {
    let captured: ResolutionProposal | undefined;
    const tool = createProposalTool(["candidate_1"], (proposal) => {
      captured = proposal;
    });

    await tool.execute(
      "call_1",
      {
        action: "remove_queue_item",
        confidence: 0.94,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        queueRemovalOptions: {
          removeFromClient: true,
          blocklist: true,
          skipRedownload: false,
          changeCategory: false,
        },
        reason: "Candidate parses as the wrong series, so Sonarr should search for a replacement.",
        issueSummary: "The visible release is not useful for this library.",
        evidence: ["Candidate file maps to a different series than the queue target."],
        warnings: [],
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(captured?.queueRemovalOptions).toEqual({
      removeFromClient: true,
      blocklist: true,
      skipRedownload: false,
      changeCategory: false,
    });
  });

  it("captures plain removal options for existing-file-is-better decisions", async () => {
    let captured: ResolutionProposal | undefined;
    const tool = createProposalTool(["candidate_1"], (proposal) => {
      captured = proposal;
    });

    await tool.execute(
      "call_1",
      {
        action: "remove_queue_item",
        confidence: 0.98,
        selectedCandidateIds: [],
        selectedImports: [],
        sampleCandidateIds: [],
        queueRemovalOptions: {
          removeFromClient: true,
          blocklist: false,
          skipRedownload: false,
          changeCategory: false,
        },
        reason: "The existing episode file already has a better custom format score.",
        issueSummary: "Sonarr rejected the candidate as a non-upgrade.",
        evidence: ["Existing score 12905 is above candidate score 10012."],
        warnings: [],
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(captured?.queueRemovalOptions).toEqual({
      removeFromClient: true,
      blocklist: false,
      skipRedownload: false,
      changeCategory: false,
    });
  });

  it("uses a movie id mapping for Radarr proposals", () => {
    const tool = createProposalTool(["candidate_1"], () => undefined, "radarr");
    const valid = {
      action: "import_candidates",
      confidence: 0.95,
      selectedCandidateIds: ["candidate_1"],
      selectedImports: [{ candidateId: "candidate_1", movieId: 42 }],
      sampleCandidateIds: [],
      reason: "The file matches the queued movie.",
      issueSummary: "Radarr could not import it automatically.",
      evidence: ["Movie id 42 matches."],
      warnings: [],
    };

    expect(tool.name).toBe("propose_radarr_resolution");
    expect(Value.Check(tool.parameters, valid)).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        ...valid,
        selectedImports: [{ candidateId: "candidate_1", episodeIds: [] }],
      }),
    ).toBe(false);
  });
});
