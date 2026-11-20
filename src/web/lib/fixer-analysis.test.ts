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

function blockEvent(
  second: number,
  message: string,
  kind: "text" | "thinking" = "text",
  itemId = 1,
): ResolverEvent {
  return {
    type: "pi",
    message,
    itemId,
    timestamp: new Date(Date.UTC(2026, 10, 20, 12, 0, second)).toISOString(),
    details: { kind },
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

  it("preserves distinct persisted events that share the first live event's millisecond", () => {
    const saved = [event(2, "load"), event(2, "inspect"), event(3, "pi")];
    const live = [event(2, "inspect"), event(3, "pi"), event(4, "proposal")];
    expect(analysisEvents(saved, live).map((e) => e.message)).toEqual([
      "load",
      "inspect",
      "pi",
      "proposal",
    ]);
  });

  it("trims overlapping coalesced text deltas after refetch instead of duplicating them", () => {
    const saved = [event(1, "start"), blockEvent(2, "Hello world")];
    const live = [blockEvent(3, " world"), blockEvent(4, "!")];
    expect(analysisEvents(saved, live).map((e) => e.message)).toEqual(["start", "Hello world!"]);

    const exactTail = [blockEvent(3, " world")];
    expect(analysisEvents(saved, exactTail).map((e) => e.message)).toEqual([
      "start",
      "Hello world",
    ]);
  });

  it("keeps an earlier text block intact when a later text block follows another step", () => {
    const saved = [blockEvent(1, "Hello"), event(2, "tool")];
    const live = [blockEvent(3, "Hello again")];
    expect(analysisEvents(saved, live).map((e) => e.message)).toEqual([
      "Hello",
      "tool",
      "Hello again",
    ]);
  });

  it("shows the saved events alone before anything streamed", () => {
    const saved = [event(1, "load")];
    expect(analysisEvents(saved, [])).toBe(saved);
  });
});

describe("withUniqueKeys", () => {
  it("keeps keys unique without colliding against literal #N suffixes", () => {
    const keyed = withUniqueKeys(["a", "a", "a#2", "b"]);
    expect(keyed.map((entry) => entry.value)).toEqual(["a", "a", "a#2", "b"]);
    expect(new Set(keyed.map((entry) => entry.key)).size).toBe(4);
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
