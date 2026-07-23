import { describe, expect, it } from "vitest";
import { HUNT_STATES } from "../../shared/domain.js";
import { RIBBON_ORDER, STATE_META, stateMeta } from "./states.js";

describe("state palette", () => {
  it("covers every canonical hunt state plus the presentation overlays", () => {
    for (const state of HUNT_STATES) {
      expect(STATE_META[state]).toBeDefined();
    }
    expect(STATE_META.user_paused).toBeDefined();
    expect(STATE_META.searching).toBeDefined();
  });

  it("maps the design-spec badge labels and colors", () => {
    expect(stateMeta("german")).toEqual({ label: "GERMAN", color: "#34d399" });
    expect(stateMeta("non_german")).toEqual({ label: "OTHER AUDIO", color: "#fbbf24" });
    expect(stateMeta("missing")).toEqual({ label: "MISSING", color: "#fb7185" });
    expect(stateMeta("ai_paused")).toEqual({ label: "NO DUB · AI", color: "#a78bfa" });
    expect(stateMeta("user_paused")).toEqual({ label: "PAUSED", color: "#94a3b8" });
    expect(stateMeta("unreleased")).toEqual({ label: "UNRELEASED", color: "#7dd3fc" });
    expect(stateMeta("exhausted").label).toBe("EXHAUSTED");
    expect(stateMeta("profile_blocked").label).toBe("PROFILE BLOCKED");
    expect(stateMeta("searching").color).toBe("#22d3ee");
  });

  it("ribbon order contains every hunt state exactly once, german first", () => {
    expect([...RIBBON_ORDER].sort()).toEqual([...HUNT_STATES].sort());
    expect(RIBBON_ORDER[0]).toBe("german");
  });
});
