import { autoApplyBlockReason, autoApplyThreshold } from "../../shared/fixer-policy.js";
import type {
  ResolutionProposal,
  ResolverEvent,
  ValidationResult,
} from "../../shared/fixer-types.js";

type ConfidenceGates = { fixerAutoImportConfidence: number; fixerAutoRemoveConfidence: number };

/**
 * The saved events of a running analysis followed by the live ones. The saved
 * list is refetched while events stream, so it overlaps the stream: keep it
 * only up to the first event this view received live.
 */
export function analysisEvents(
  persisted: ResolverEvent[],
  streamed: ResolverEvent[],
): ResolverEvent[] {
  const firstLive = streamed[0]?.timestamp;
  if (firstLive === undefined) return persisted;
  return [...persisted.filter((event) => event.timestamp < firstLive), ...streamed];
}

/** Stable React keys for a list of texts that may repeat ("text", "text#2"). */
export function withUniqueKeys(values: string[]): Array<{ key: string; value: string }> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = (seen.get(value) ?? 0) + 1;
    seen.set(value, count);
    return { key: count === 1 ? value : `${value}#${count}`, value };
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
