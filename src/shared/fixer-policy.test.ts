import { describe, expect, it } from "vitest";
import { autoApplyThreshold, isProviderUsageLimit } from "./fixer-policy.js";
import type { ResolutionProposal } from "./fixer-types.js";

const gates = { fixerAutoImportConfidence: 0.8, fixerAutoRemoveConfidence: 0.95 };

function removal(skipRedownload: boolean): ResolutionProposal {
  return {
    action: "remove_queue_item",
    confidence: 0.9,
    selectedCandidateIds: [],
    selectedImports: [],
    sampleCandidateIds: [],
    reason: "",
    issueSummary: "",
    evidence: [],
    warnings: [],
    queueRemovalOptions: {
      removeFromClient: true,
      blocklist: true,
      skipRedownload,
      changeCategory: false,
    },
  };
}

describe("fixer policy", () => {
  it("treats the AI provider's limits as usage limits, but not an arr's own HTTP 429", () => {
    expect(isProviderUsageLimit("Codex error: The usage limit has been reached")).toBe(true);
    expect(isProviderUsageLimit("429 Too Many Requests")).toBe(true);
    expect(isProviderUsageLimit("Sonarr 429 Too Many Requests: /api/v3/episode")).toBe(false);
    expect(isProviderUsageLimit("Radarr 429 Too Many Requests: /api/v3/movie")).toBe(false);
  });

  it("gates removals at the removal confidence unless they are verified non-upgrades", () => {
    const valid = { ok: true, issues: [] };
    const safe = { ...valid, safeNonUpgradeRemoval: true };
    expect(autoApplyThreshold(removal(true), valid, gates)).toBe(0.95);
    expect(autoApplyThreshold(removal(true), safe, gates)).toBe(0.8);
    // A new search is never part of the non-upgrade exception.
    expect(autoApplyThreshold(removal(false), safe, gates)).toBe(0.95);
    expect(autoApplyThreshold({ ...removal(true), action: "import_candidates" }, null, gates)).toBe(
      0.8,
    );
  });
});
