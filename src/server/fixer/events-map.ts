import type { ResolverEvent } from "../../shared/fixer-types.js";
import type { FixerAnalysisEvent } from "./ai-port.js";

/**
 * Internal FixerAnalysisEvent → the ResolverEvent shape the GUI renders.
 * Used both for the live SSE stream and when serving persisted analyses.
 */
export function toResolverEvent(ev: FixerAnalysisEvent): ResolverEvent {
  const timestamp = new Date(ev.ts).toISOString();
  if (ev.kind === "step") {
    const type: ResolverEvent["type"] =
      ev.source === "pi" || ev.source === "sonarr" || ev.source === "radarr"
        ? ev.source
        : ev.level === "warning"
          ? "warning"
          : ev.level === "error"
            ? "error"
            : "info";
    return { type, message: ev.message, timestamp, itemId: ev.itemId, details: ev.details };
  }
  if (ev.kind === "tool-call") {
    return {
      type: "pi",
      message: `${ev.phase === "start" ? "→" : "←"} ${ev.toolName}${ev.isError ? " (error)" : ""}`,
      timestamp,
      itemId: ev.itemId,
    };
  }
  return { type: "pi", message: ev.delta, timestamp, itemId: ev.itemId };
}
