import type { ResolverEvent } from "../../shared/fixer-types.js";
import type { FixerAnalysisEvent } from "./ai-port.js";

function stepEventType(ev: Extract<FixerAnalysisEvent, { kind: "step" }>): ResolverEvent["type"] {
  if (ev.source === "pi" || ev.source === "sonarr" || ev.source === "radarr") return ev.source;
  if (ev.level === "warning") return "warning";
  if (ev.level === "error") return "error";
  return "info";
}

function eventSeqFields(ev: FixerAnalysisEvent): Pick<ResolverEvent, "seq" | "lastSeq"> {
  const fields: Pick<ResolverEvent, "seq" | "lastSeq"> = {};
  if (ev.seq !== undefined) fields.seq = ev.seq;
  if ((ev.kind === "text" || ev.kind === "thinking") && ev.lastSeq !== undefined) {
    fields.lastSeq = ev.lastSeq;
  }
  return fields;
}

/**
 * Internal FixerAnalysisEvent → the ResolverEvent shape the GUI renders.
 * Used both for the live SSE stream and when serving persisted analyses.
 */
export function toResolverEvent(ev: FixerAnalysisEvent): ResolverEvent {
  const timestamp = new Date(ev.ts).toISOString();
  const seqFields = eventSeqFields(ev);
  if (ev.kind === "step") {
    return {
      type: stepEventType(ev),
      message: ev.message,
      timestamp,
      itemId: ev.itemId,
      ...seqFields,
      details: ev.details,
    };
  }
  if (ev.kind === "tool-call") {
    return {
      type: "pi",
      message: `${ev.phase === "start" ? "→" : "←"} ${ev.toolName}${ev.isError ? " (error)" : ""}`,
      timestamp,
      itemId: ev.itemId,
      ...seqFields,
      details: {
        toolName: ev.toolName,
        phase: ev.phase,
        args: ev.args,
        result: ev.result,
        isError: ev.isError,
      },
    };
  }
  return {
    type: "pi",
    message: ev.delta,
    timestamp,
    itemId: ev.itemId,
    ...seqFields,
    details: { kind: ev.kind },
  };
}
