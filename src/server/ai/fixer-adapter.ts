import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FixerAnalysisEvent, FixerPiRunner } from "../fixer/ai-port.js";
import type { PiRunner, PiSessionEvent } from "./providers.js";

function mapEvent(event: PiSessionEvent, itemId: number): FixerAnalysisEvent {
  const ts = Date.now();
  const data = (event.data ?? {}) as { name?: string; args?: unknown; isError?: boolean };
  if (event.type === "tool_start") {
    return {
      kind: "tool-call",
      phase: "start",
      toolName: data.name ?? "?",
      ts,
      itemId,
      args: data.args,
    };
  }
  if (event.type === "tool_end") {
    return {
      kind: "tool-call",
      phase: "end",
      toolName: data.name ?? "?",
      ts,
      itemId,
      isError: data.isError,
    };
  }
  if (event.type === "text_delta") {
    return { kind: "text", delta: event.message, ts, itemId };
  }
  return { kind: "step", level: "info", source: "pi", message: event.message, ts, itemId };
}

/**
 * Bridges the fixer's runner port onto the shared PiRunner. The PiRunner
 * already re-prompts once when the terminating proposal tool was not called,
 * so the fixer's own followUp retry is intentionally not forwarded.
 */
export function createFixerRunner(piRunner: PiRunner): FixerPiRunner {
  return async (request) => {
    const terminatingTool =
      request.service === "radarr" ? "propose_radarr_resolution" : "propose_sonarr_resolution";
    const result = await piRunner({
      system: request.systemPrompt,
      prompt: request.prompt,
      tools: request.tools as ToolDefinition[],
      terminatingTool,
      signal: request.signal,
      onEvent: (event) => request.onEvent?.(mapEvent(event, request.queueItemId)),
    });
    return { log: result.text ? [result.text] : [] };
  };
}
