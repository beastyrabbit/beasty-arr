// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATE_META } from "../lib/states.js";
import { SegmentedBar } from "./SegmentedBar.js";
import { StateBadge } from "./StateBadge.js";

// React 19 act() environment flag.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SegmentedBar", () => {
  it("renders one rect per non-zero state in palette colors", () => {
    render(<SegmentedBar counts={{ german: 6, missing: 3, ai_paused: 1 }} scale="row" />);
    const rects = container.querySelectorAll("rect");
    expect(rects).toHaveLength(3);
    expect(rects[0].getAttribute("fill")).toBe(STATE_META.german.color);
    expect(rects[1].getAttribute("fill")).toBe(STATE_META.missing.color);
    expect(rects[2].getAttribute("fill")).toBe(STATE_META.ai_paused.color);
  });

  it("renders a neutral track when everything is zero", () => {
    render(<SegmentedBar counts={{}} />);
    const rects = container.querySelectorAll("rect");
    expect(rects).toHaveLength(1);
    expect(rects[0].getAttribute("fill")).toBe("#1a1d24");
  });

  it("fires onSegmentClick with the segment state", () => {
    const onClick = vi.fn();
    render(<SegmentedBar counts={{ german: 1, missing: 1 }} onSegmentClick={onClick} />);
    const rects = container.querySelectorAll("rect");
    act(() => {
      rects[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledWith("missing");
  });
});

describe("StateBadge", () => {
  it("shows the mapped label and state color", () => {
    render(<StateBadge state="non_german" />);
    expect(container.textContent).toContain("OTHER AUDIO");
    const badge = container.querySelector("span");
    expect(badge?.style.color).toBeTruthy();
  });

  it("adds the pulsing searching overlay dot", () => {
    render(<StateBadge state="missing" searching />);
    expect(container.querySelector(".search-pulse")).not.toBeNull();
  });
});
