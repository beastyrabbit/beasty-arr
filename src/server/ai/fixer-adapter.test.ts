import { describe, expect, it, vi } from "vitest";
import type { FixerAnalysisEvent, FixerPiRunRequest } from "../fixer/ai-port.js";
import { createFixerRunner } from "./fixer-adapter.js";
import type { PiRunner, PiSessionRequest } from "./providers.js";

function request(over: Partial<FixerPiRunRequest> = {}): FixerPiRunRequest {
  return {
    service: "radarr",
    queueItemId: 42,
    systemPrompt: "system",
    prompt: "prompt",
    tools: [],
    toolNames: [],
    ...over,
  };
}

describe("createFixerRunner", () => {
  it("passes the exact prompts, abort signal, tools, and terminating tool", async () => {
    const calls: PiSessionRequest[] = [];
    const piRunner: PiRunner = async (req) => {
      calls.push(req);
      return {
        provider: "codex",
        model: "test",
        text: " final reasoning ",
        toolCalls: [],
        terminated: true,
        usage: { input: 1, output: 1, cost: 0 },
      };
    };
    const controller = new AbortController();
    const tools = [{ name: "read_only_tool" }];

    const result = await createFixerRunner(piRunner)(request({ signal: controller.signal, tools }));

    expect(calls[0]).toMatchObject({
      system: "system",
      prompt: "prompt",
      terminatingTool: "propose_radarr_resolution",
      signal: controller.signal,
      tools,
    });
    expect(result.log).toEqual([" final reasoning "]);
  });

  it("maps provider text and tool events into persisted fixer events", async () => {
    const events: FixerAnalysisEvent[] = [];
    const piRunner: PiRunner = async (req) => {
      req.onEvent?.({ type: "text_delta", message: "reasoning" });
      req.onEvent?.({
        type: "tool_start",
        message: "start",
        data: { name: "radarr_get_upgrade_context", args: { movieId: 5 } },
      });
      req.onEvent?.({
        type: "tool_end",
        message: "end",
        data: { name: "radarr_get_upgrade_context", isError: false },
      });
      req.onEvent?.({ type: "provider_retry", message: "retrying" });
      return {
        provider: "codex",
        model: "test",
        text: "",
        toolCalls: [],
        terminated: true,
        usage: { input: 1, output: 1, cost: 0 },
      };
    };

    await createFixerRunner(piRunner)(request({ onEvent: (event) => events.push(event) }));

    expect(events).toEqual([
      expect.objectContaining({ kind: "text", delta: "reasoning", itemId: 42 }),
      expect.objectContaining({
        kind: "tool-call",
        phase: "start",
        toolName: "radarr_get_upgrade_context",
        args: { movieId: 5 },
        itemId: 42,
      }),
      expect.objectContaining({
        kind: "tool-call",
        phase: "end",
        toolName: "radarr_get_upgrade_context",
        isError: false,
        itemId: 42,
      }),
      expect.objectContaining({ kind: "step", source: "pi", message: "retrying", itemId: 42 }),
    ]);
  });

  it("selects the Sonarr terminating tool", async () => {
    const piRunner = vi.fn(async (req: PiSessionRequest) => ({
      provider: "codex" as const,
      model: "test",
      text: "",
      toolCalls: [],
      terminated: true,
      usage: { input: 0, output: 0, cost: 0 },
      request: req,
    }));

    await createFixerRunner(piRunner)(request({ service: "sonarr" }));

    expect(piRunner.mock.calls[0]?.[0].terminatingTool).toBe("propose_sonarr_resolution");
  });
});
