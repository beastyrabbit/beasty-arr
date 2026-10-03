import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FixerAnalysisEvent, FixerPiRunner } from "../fixer/ai-port.js";
import type { PiRunner, PiSessionEvent, PiSessionResult } from "./providers.js";

function mapEvent(event: PiSessionEvent, itemId: number): FixerAnalysisEvent {
  const ts = Date.now();
  const data = (event.data ?? {}) as {
    name?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
  };
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
      args: data.args,
      result: data.result,
    };
  }
  if (event.type === "text_delta") {
    return { kind: "text", delta: event.message, ts, itemId };
  }
  if (event.type === "thinking_delta") {
    return { kind: "thinking", delta: event.message, ts, itemId };
  }
  return { kind: "step", level: "info", source: "pi", message: event.message, ts, itemId };
}

function fmtTokens(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
}

function runSummary(result: PiSessionResult, itemId: number): FixerAnalysisEvent {
  const { input, output, cost } = result.usage;
  const toolCalls = result.toolCalls.length;
  return {
    kind: "step",
    level: "info",
    source: "pi",
    message:
      `Pi run finished: model ${result.model} (${result.provider}), ` +
      `${fmtTokens(input)} in / ${fmtTokens(output)} out tokens, ` +
      `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}, ${toolCalls} tool calls.`,
    ts: Date.now(),
    itemId,
    details: { provider: result.provider, model: result.model, usage: result.usage, toolCalls },
  };
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
    // The resolver only reads `log`; the summary step lands the run's model and
    // usage in the persisted analysis events for auditing.
    request.onEvent?.(runSummary(result, request.queueItemId));
    return {
      log: result.text ? [result.text] : [],
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      text: result.text,
    };
  };
}
