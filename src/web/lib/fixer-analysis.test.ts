import { describe, expect, it } from "vitest";
import type {
  ResolutionProposal,
  ResolverEvent,
  ValidationResult,
} from "../../shared/fixer-types.js";
import { analysisEvents, proposalVerdict, withUniqueKeys } from "./fixer-analysis.js";

const gates = { fixerAutoImportConfidence: 0.8, fixerAutoRemoveConfidence: 0.95 };
const ok: ValidationResult = { ok: true, issues: [] };
const blocklistOnly = {
  removeFromClient: true,
  blocklist: true,
  skipRedownload: true,
  changeCategory: false,
};

function proposal(over: Partial<ResolutionProposal>): ResolutionProposal {
  return {
    action: "import_candidates",
    confidence: 0.9,
    selectedCandidateIds: [],
    selectedImports: [],
    sampleCandidateIds: [],
    reason: "",
    issueSummary: "",
    evidence: [],
    warnings: [],
    ...over,
  };
}

function event(second: number, message: string): ResolverEvent {
  return {
    type: "info",
    message,
    timestamp: new Date(Date.UTC(2026, 10, 20, 12, 0, second)).toISOString(),
  };
}

describe("analysisEvents", () => {
  it("drops refetched saved events the live stream already shows", () => {
    const saved = [event(1, "load"), event(2, "inspect"), event(3, "pi")];
    const live = [event(2, "inspect"), event(3, "pi"), event(4, "proposal")];
    expect(analysisEvents(saved, live).map((e) => e.message)).toEqual([
      "load",
      "inspect",
      "pi",
      "proposal",
    ]);
  });

  it("shows the saved events alone before anything streamed", () => {
    const saved = [event(1, "load")];
    expect(analysisEvents(saved, [])).toBe(saved);
  });
});

describe("withUniqueKeys", () => {
  it("keeps keys unique when texts repeat", () => {
    expect(withUniqueKeys(["a", "b", "a", "a"])).toEqual([
      { key: "a", value: "a" },
      { key: "b", value: "b" },
      { key: "a#2", value: "a" },
      { key: "a#3", value: "a" },
    ]);
  });
});

describe("proposalVerdict", () => {
  it("checks validation before calling a removal automatic", () => {
    const removal = proposal({
      action: "remove_queue_item",
      confidence: 0.99,
      queueRemovalOptions: blocklistOnly,
    });
    expect(proposalVerdict(removal, { ok: false, issues: [] }, gates, false).label).toBe(
      "Blocked by validation",
    );
    expect(proposalVerdict(removal, ok, gates, false).label).toBe("Would auto-remove");
    expect(proposalVerdict(removal, ok, gates, true).label).toBe("Would auto-remove (dry-run)");
  });

  it("uses the import gate for a verified non-upgrade removal, like auto-apply", () => {
    const removal = proposal({
      action: "remove_queue_item",
      confidence: 0.85,
      queueRemovalOptions: blocklistOnly,
    });
    expect(proposalVerdict(removal, ok, gates, false).label).toBe(
      "Below auto threshold — review removal",
    );
    expect(
      proposalVerdict(removal, { ...ok, safeNonUpgradeRemoval: true }, gates, false).label,
    ).toBe("Would auto-remove");
  });

  it("waits for review when the removal options need a person", () => {
    const removal = proposal({
      action: "remove_queue_item",
      confidence: 0.99,
      queueRemovalOptions: { ...blocklistOnly, blocklist: false },
    });
    expect(proposalVerdict(removal, ok, gates, false).label).toBe("Removal needs your review");
  });

  it("keeps the import verdicts", () => {
    expect(proposalVerdict(proposal({ confidence: 0.85 }), ok, gates, false).label).toBe(
      "Would auto-import",
    );
    expect(proposalVerdict(proposal({ confidence: 0.5 }), ok, gates, false).label).toBe(
      "Below auto threshold — review",
    );
    expect(
      proposalVerdict(
        proposal({ action: "needs_review", reviewReasons: ["held"] }),
        ok,
        gates,
        false,
      ).label,
    ).toBe("Held by the fixer's checks — review");
  });
});
