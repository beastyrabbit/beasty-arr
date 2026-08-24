// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AiVerdictSummary } from "../../shared/api-types.js";
import { DubVerdictSummary } from "./DubVerdictSummary.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function verdict(overrides: Partial<AiVerdictSummary> = {}): AiVerdictSummary {
  return {
    id: 1,
    verdict: "exists",
    confidence: 0.98,
    germanTitle: null,
    evidence: ["Verified source"],
    expectedAvailability: null,
    checkedAt: Date.now(),
    recheckAfter: Date.now() + 365 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function render(value: AiVerdictSummary): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DubVerdictSummary verdict={value} />));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DubVerdictSummary", () => {
  it.each([
    ["exists", "Yes — German dub exists", "Keep in the hunt"],
    ["announced", "Planned — date not confirmed", "Hold briefly"],
    ["unlikely", "No German dub found", "Long hold"],
    ["unknown", "Not confirmed", "Keep the normal hunt state"],
  ] as const)("renders the %s verdict as an operational answer", (state, answer, action) => {
    render(verdict({ verdict: state }));

    expect(container.textContent).toContain(answer);
    expect(container.textContent).toContain(action);
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("does not present mixed season coverage as a series-wide yes", () => {
    render(
      verdict({
        verdict: "exists",
        perSeason: [
          { season: 1, verdict: "exists" },
          { season: 2, verdict: "unlikely" },
        ],
      }),
    );
    expect(container.textContent).toContain("Mixed — see individual seasons");
    expect(container.textContent).not.toContain("Yes — German dub exists");
  });
});
