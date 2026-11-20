import { autoApplyBlockReason, autoApplyThreshold } from "../../shared/fixer-policy.js";
import type {
  ResolutionProposal,
  ResolverEvent,
  ValidationResult,
} from "../../shared/fixer-types.js";

type ConfidenceGates = { fixerAutoImportConfidence: number; fixerAutoRemoveConfidence: number };

/**
 * The saved events of a running analysis followed by newer live SSE events.
 * FixerService assigns a monotonic `seq` to every event and records `lastSeq`
 * on coalesced text/thinking blocks (even past the 20k truncation cap), so we
 * drop only live events already included in the saved list without guessing
 * from timestamps or text overlap.
 */
export function analysisEvents(
  persisted: ResolverEvent[],
  streamed: ResolverEvent[],
): ResolverEvent[] {
  if (streamed.length === 0) return persisted;
  if (persisted.length === 0) return streamed;
  const persistedMaxSeq = persisted.reduce(
    (max, event) => Math.max(max, event.lastSeq ?? event.seq ?? 0),
    0,
  );
  if (persistedMaxSeq > 0 && streamed.every((event) => event.seq !== undefined)) {
    return [...persisted, ...streamed.filter((event) => (event.seq ?? 0) > persistedMaxSeq)];
  }
  const firstLive = streamed[0]?.timestamp;
  return firstLive === undefined
    ? persisted
    : [...persisted.filter((event) => event.timestamp < firstLive), ...streamed];
}

/** Collision-free stable React keys for a list of texts that may repeat. */
export function withUniqueKeys(values: string[]): Array<{ key: string; value: string }> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = (seen.get(value) ?? 0) + 1;
    seen.set(value, count);
    return { key: JSON.stringify([value, count]), value };
  });
}

export type VerdictTone = "german" | "missing" | "non_german";

/** The banner over a saved proposal: what auto-apply would do with it, or why it waits. */
export function proposalVerdict(
  proposal: ResolutionProposal,
  validation: ValidationResult | null,
  settings: ConfidenceGates,
  dryRun: boolean,
): { label: string; tone: VerdictTone } {
  const validationOk = validation?.ok ?? true;
  if (!validationOk) return { label: "Blocked by validation", tone: "missing" };
  if (proposal.action === "remove_queue_item") {
    const blocked = autoApplyBlockReason(
      proposal,
      validation ?? { ok: true, issues: [] },
      settings,
    );
    if (!blocked)
      return {
        label: dryRun ? "Would auto-remove (dry-run)" : "Would auto-remove",
        tone: "missing",
      };
    if (proposal.confidence < autoApplyThreshold(proposal, validation, settings))
      return { label: "Below auto threshold — review removal", tone: "non_german" };
    return { label: "Removal needs your review", tone: "non_german" };
  }
  if (
    proposal.action === "import_candidates" &&
    proposal.confidence >= autoApplyThreshold(proposal, validation, settings)
  ) {
    return { label: dryRun ? "Would auto-import (dry-run)" : "Would auto-import", tone: "german" };
  }
  if (proposal.reviewReasons?.length) {
    return { label: "Held by the fixer's checks — review", tone: "missing" };
  }
  if (proposal.action === "needs_review") {
    return { label: "The AI asks for your review", tone: "non_german" };
  }
  return { label: "Below auto threshold — review", tone: "non_german" };
}
