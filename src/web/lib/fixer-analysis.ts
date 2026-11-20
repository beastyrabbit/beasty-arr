import { autoApplyBlockReason, autoApplyThreshold } from "../../shared/fixer-policy.js";
import type {
  ResolutionProposal,
  ResolverEvent,
  ValidationResult,
} from "../../shared/fixer-types.js";

type ConfidenceGates = { fixerAutoImportConfidence: number; fixerAutoRemoveConfidence: number };

function blockKind(event: ResolverEvent): "text" | "thinking" | undefined {
  const kind = (event.details as { kind?: unknown } | undefined)?.kind;
  return kind === "text" || kind === "thinking" ? kind : undefined;
}

function toolMeta(event: ResolverEvent): { toolName?: string; phase?: string } {
  const details = event.details as { toolName?: unknown; phase?: unknown } | undefined;
  return {
    toolName: typeof details?.toolName === "string" ? details.toolName : undefined,
    phase: typeof details?.phase === "string" ? details.phase : undefined,
  };
}

function coalesceBlocks(events: ResolverEvent[]): ResolverEvent[] {
  const merged: ResolverEvent[] = [];
  for (const event of events) {
    const kind = blockKind(event);
    const last = merged.at(-1);
    if (kind && last && blockKind(last) === kind && last.itemId === event.itemId) {
      merged[merged.length - 1] = { ...last, message: last.message + event.message };
    } else {
      merged.push(event);
    }
  }
  return merged;
}

function sameDiscreteEvent(a: ResolverEvent, b: ResolverEvent): boolean {
  if (
    a.type !== b.type ||
    a.timestamp !== b.timestamp ||
    a.message !== b.message ||
    a.itemId !== b.itemId
  ) {
    return false;
  }
  const ta = toolMeta(a);
  const tb = toolMeta(b);
  return ta.toolName === tb.toolName && ta.phase === tb.phase;
}

/** Longest suffix of `saved` that equals a prefix of `live`. */
function suffixPrefixOverlap(saved: string, live: string): number {
  const max = Math.min(saved.length, live.length);
  for (let len = max; len > 0; len -= 1) {
    if (saved.endsWith(live.slice(0, len))) return len;
  }
  return 0;
}

function mergeAlignedBlock(
  saved: ResolverEvent,
  live: ResolverEvent,
  isBoundary: boolean,
  savedHasMore: boolean,
  liveHasMore: boolean,
  nextSavedTimestamp: string | undefined,
): ResolverEvent | undefined {
  const kind = blockKind(saved);
  if (!kind || kind !== blockKind(live) || saved.itemId !== live.itemId) return undefined;
  if (isBoundary) {
    if (saved.timestamp > live.timestamp) return undefined;
    if (savedHasMore) {
      if (nextSavedTimestamp !== undefined && nextSavedTimestamp < live.timestamp) return undefined;
      return saved.message.endsWith(live.message) ? saved : undefined;
    }
    const overlap = suffixPrefixOverlap(saved.message, live.message);
    if (overlap === 0) return undefined;
    return { ...saved, message: saved.message + live.message.slice(overlap) };
  }
  if (saved.timestamp !== live.timestamp) return undefined;
  if (savedHasMore && liveHasMore) {
    return saved.message === live.message ? saved : undefined;
  }
  if (live.message.startsWith(saved.message)) return { ...saved, message: live.message };
  if (saved.message.startsWith(live.message)) return saved;
  return undefined;
}

function alignAt(
  saved: ResolverEvent[],
  live: ResolverEvent[],
  start: number,
): ResolverEvent[] | undefined {
  const overlapLen = Math.min(saved.length - start, live.length);
  const merged: ResolverEvent[] = [];
  for (let k = 0; k < overlapLen; k += 1) {
    const s = saved[start + k];
    const l = live[k];
    if (!s || !l) return undefined;
    if (blockKind(s) || blockKind(l)) {
      const combined = mergeAlignedBlock(
        s,
        l,
        k === 0,
        start + k + 1 < saved.length,
        k + 1 < live.length,
        saved[start + k + 1]?.timestamp,
      );
      if (!combined) return undefined;
      merged.push(combined);
    } else if (sameDiscreteEvent(s, l)) {
      merged.push(l);
    } else {
      return undefined;
    }
  }
  const tail =
    saved.length - start > live.length ? saved.slice(start + live.length) : live.slice(overlapLen);
  return [...saved.slice(0, start), ...merged, ...tail];
}

/**
 * The saved events of a running analysis reconciled with the live SSE stream.
 * Reconciles by event and coalesced text/thinking block identity instead of
 * timestamp cutoffs, so refetched coalesced blocks do not duplicate streamed
 * suffix deltas and distinct events sharing a millisecond are preserved.
 */
export function analysisEvents(
  persisted: ResolverEvent[],
  streamed: ResolverEvent[],
): ResolverEvent[] {
  if (streamed.length === 0) return persisted;
  if (persisted.length === 0) return streamed;
  const saved = coalesceBlocks(persisted);
  const live = coalesceBlocks(streamed);
  for (let start = 0; start < saved.length; start += 1) {
    const aligned = alignAt(saved, live, start);
    if (aligned) return aligned;
  }
  return [...saved, ...live];
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
