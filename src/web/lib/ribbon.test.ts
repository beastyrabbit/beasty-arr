import { describe, expect, it } from "vitest";
import { computeSegments } from "./ribbon.js";
import { RIBBON_ORDER } from "./states.js";

describe("computeSegments", () => {
  it("returns empty for zero counts", () => {
    expect(computeSegments({})).toEqual([]);
    expect(computeSegments({ german: 0, missing: 0 })).toEqual([]);
  });

  it("drops zero-count states and keeps fixed ribbon order", () => {
    const segs = computeSegments({ missing: 5, german: 10, unreleased: 0, ai_paused: 2 });
    expect(segs.map((s) => s.state)).toEqual(["german", "missing", "ai_paused"]);
    const orderIdx = segs.map((s) => RIBBON_ORDER.indexOf(s.state));
    expect([...orderIdx].sort((a, b) => a - b)).toEqual(orderIdx);
  });

  it("widths are proportional and sum to 100", () => {
    const segs = computeSegments({ german: 75, non_german: 25 });
    expect(segs).toHaveLength(2);
    expect(segs[0].pct).toBeCloseTo(75, 5);
    expect(segs[1].pct).toBeCloseTo(25, 5);
    expect(segs.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 5);
  });

  it("offsets are cumulative", () => {
    const segs = computeSegments({ german: 50, missing: 30, unreleased: 20 });
    expect(segs[0].offset).toBe(0);
    expect(segs[1].offset).toBeCloseTo(50, 5);
    expect(segs[2].offset).toBeCloseTo(80, 5);
  });

  it("enforces the minimum visible width on tiny slivers", () => {
    const segs = computeSegments({ german: 998, missing: 1, non_german: 1 }, 1.5);
    const missing = segs.find((s) => s.state === "missing");
    const nonGerman = segs.find((s) => s.state === "non_german");
    expect(missing?.pct).toBeCloseTo(1.5, 5);
    expect(nonGerman?.pct).toBeCloseTo(1.5, 5);
    expect(segs.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 5);
  });

  it("keeps plain proportions when every segment clears the minimum", () => {
    const segs = computeSegments({ german: 40, missing: 60 }, 1.5);
    expect(segs.find((s) => s.state === "german")?.pct).toBeCloseTo(40, 5);
    expect(segs.find((s) => s.state === "missing")?.pct).toBeCloseTo(60, 5);
  });
});
