import { describe, expect, it } from "vitest";
import { toResolverEvent } from "./events-map.js";

const ts = Date.UTC(2026, 9, 3, 12, 0, 0);

describe("toResolverEvent", () => {
  it("keeps tool-call messages and exposes args, result, and error state as details", () => {
    expect(
      toResolverEvent({
        kind: "tool-call",
        phase: "end",
        toolName: "sonarr_get_episodes",
        ts,
        itemId: 3,
        isError: true,
        args: { seriesId: 5 },
        result: "boom",
      }),
    ).toEqual({
      type: "pi",
      message: "← sonarr_get_episodes (error)",
      timestamp: "2026-10-03T12:00:00.000Z",
      itemId: 3,
      details: {
        toolName: "sonarr_get_episodes",
        phase: "end",
        args: { seriesId: 5 },
        result: "boom",
        isError: true,
      },
    });
    expect(
      toResolverEvent({ kind: "tool-call", phase: "start", toolName: "t", ts, args: { a: 1 } }),
    ).toMatchObject({ message: "→ t", details: { phase: "start", args: { a: 1 } } });
  });

  it("tags text and thinking blocks with their kind", () => {
    expect(toResolverEvent({ kind: "thinking", delta: "hmm", ts, itemId: 1 })).toEqual({
      type: "pi",
      message: "hmm",
      timestamp: "2026-10-03T12:00:00.000Z",
      itemId: 1,
      details: { kind: "thinking" },
    });
    expect(toResolverEvent({ kind: "text", delta: "answer", ts })).toMatchObject({
      type: "pi",
      message: "answer",
      details: { kind: "text" },
    });
  });

  it("passes step details through", () => {
    expect(
      toResolverEvent({
        kind: "step",
        level: "info",
        source: "pi",
        message: "Pi run finished",
        ts,
        details: { model: "gpt-x" },
      }),
    ).toMatchObject({ type: "pi", details: { model: "gpt-x" } });
  });
});
