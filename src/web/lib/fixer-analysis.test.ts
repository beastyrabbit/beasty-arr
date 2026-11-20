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

function event(second: number, message: string, seq?: number): ResolverEvent {
  return {
    type: "info",
    message,
    timestamp: new Date(Date.UTC(2026, 10, 20, 12, 0, second)).toISOString(),
    ...(seq === undefined ? {} : { seq }),
  };
}

function blockEvent(
  second: number,
  message: string,
  opts: { kind?: "text" | "thinking"; itemId?: number; seq?: number; lastSeq?: number } = {},
): ResolverEvent {
  return {
    type: "pi",
    message,
    itemId: opts.itemId ?? 1,
    timestamp: new Date(Date.UTC(2026, 10, 20, 12, 0, second)).toISOString(),
    ...(opts.seq === undefined ? {} : { seq: opts.seq }),
    ...(opts.lastSeq === undefined ? {} : { lastSeq: opts.lastSeq }),
    details: { kind: opts.kind ?? "text" },
  };
}

describe("analysisEvents", () => {
  it("drops refetched saved events the live stream already shows", () => {
    const saved = [event(1, "load", 1), event(2, "inspect", 2), event(3, "pi", 3)];
    const live = [event(2, "inspect", 2), event(3, "pi", 3), event(4, "proposal", 4)];
    expect(analysisEvents(saved, live).map((e) => e.message)).toEqual([
      "load",
      "inspect",
      "pi",
      "proposal",
    ]);
  });

  it("preserves distinct persisted events that share the first live event's millisecond", () => {
    const saved = [event(2, "load", 1), event(2, "inspect", 2), event(3, "pi", 3)];
    const live = [event(2, "inspect", 2), event(3, "pi", 3), event(4, "proposal", 4)];
    expect(analysisEvents(saved, live).map((e) => e.message)).toEqual([
      "load",
      "inspect",
      "pi",
      "proposal",
    ]);
  });

  it("reconciles coalesced blocks by lastSeq without duplicating truncated blocks or dropping coincidental text", () => {
    // Truncated 20k persisted block followed by a tool call: streamed tail + same tool must not duplicate.
    const savedTruncated = [
      blockEvent(1, "long text …[truncated]", { seq: 1, lastSeq: 500 }),
      event(2, "→ sonarr_find_episodes", 501),
    ];
    const liveTruncated = [
      blockEvent(1, "tail delta", { seq: 500 }),
      event(2, "→ sonarr_find_episodes", 501),
      event(3, "← sonarr_find_episodes", 502),
    ];
    expect(analysisEvents(savedTruncated, liveTruncated).map((e) => e.message)).toEqual([
      "long text …[truncated]",
      "→ sonarr_find_episodes",
      "← sonarr_find_episodes",
    ]);

    // Coincidental text ("Hello" + genuinely new "o") must not be discarded as overlap.
    const savedHello = [blockEvent(1, "Hello", { seq: 1, lastSeq: 1 })];
    const liveO = [blockEvent(2, "o", { seq: 2 })];
    expect(analysisEvents(savedHello, liveO).map((e) => e.message)).toEqual(["Hello", "o"]);

    // Overlapping coalesced delta (" world" already merged into saved block) is dropped; only "!" appends.
    const savedWorld = [blockEvent(1, "Hello world", { seq: 1, lastSeq: 2 })];
    const liveWorld = [blockEvent(2, " world", { seq: 2 }), blockEvent(3, "!", { seq: 3 })];
    expect(analysisEvents(savedWorld, liveWorld).map((e) => e.message)).toEqual([
      "Hello world",
      "!",
    ]);
  });

  it("shows the saved events alone before anything streamed", () => {
    const saved = [event(1, "load", 1)];
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
