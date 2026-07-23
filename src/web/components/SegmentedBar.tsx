import type { StateCounts } from "../../shared/api-types.js";
import type { HuntState } from "../../shared/domain.js";
import { computeSegments } from "../lib/ribbon.js";
import { STATE_META } from "../lib/states.js";
import { cn } from "../lib/utils.js";

export type SegmentedBarScale = "hero" | "row" | "season";

const HEIGHTS: Record<SegmentedBarScale, number> = { hero: 16, row: 4, season: 6 };

/**
 * "The ribbon" — hand-rolled SVG segmented state bar. Fixed segment order,
 * state palette colors, hairline gaps. Hero scale is full-width/labeled via
 * the separate legend; row scale is a fixed 96x4 inline chip.
 */
export function SegmentedBar({
  counts,
  scale = "row",
  className,
  onSegmentClick,
  title,
}: {
  counts: Partial<StateCounts>;
  scale?: SegmentedBarScale;
  className?: string;
  onSegmentClick?: (state: HuntState) => void;
  title?: string;
}) {
  const segments = computeSegments(counts);
  const height = HEIGHTS[scale];
  const fixedWidth = scale === "row" ? 96 : undefined;
  const gap = 0.35; // in viewBox percent units

  return (
    <svg
      viewBox="0 0 100 1"
      preserveAspectRatio="none"
      className={cn("block overflow-visible", className)}
      style={{ height, width: fixedWidth ?? "100%" }}
      role="img"
      aria-label={title ?? "state breakdown"}
    >
      {segments.length === 0 ? (
        <rect x="0" y="0" width="100" height="1" fill="#1a1d24" />
      ) : (
        segments.map((seg) => {
          const w = Math.max(seg.pct - gap, 0.2);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: the RibbonLegend provides the accessible click path
            <rect
              key={seg.state}
              x={seg.offset}
              y="0"
              width={w}
              height="1"
              fill={STATE_META[seg.state].color}
              className={onSegmentClick ? "cursor-pointer" : undefined}
              onClick={onSegmentClick ? () => onSegmentClick(seg.state) : undefined}
            >
              <title>{`${STATE_META[seg.state].label}: ${seg.count}`}</title>
            </rect>
          );
        })
      )}
    </svg>
  );
}

/** Clickable legend tiles for the hero ribbon (deep-links into filtered library). */
export function RibbonLegend({
  counts,
  onSelect,
  className,
}: {
  counts: Partial<StateCounts>;
  onSelect?: (state: HuntState) => void;
  className?: string;
}) {
  const segments = computeSegments(counts);
  return (
    <div className={cn("flex flex-wrap gap-x-4 gap-y-1.5", className)}>
      {segments.map((seg) => (
        <button
          key={seg.state}
          type="button"
          onClick={onSelect ? () => onSelect(seg.state) : undefined}
          className="group flex items-center gap-1.5 text-left"
        >
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ background: STATE_META[seg.state].color }}
          />
          <span className="microlabel group-hover:text-ink transition-colors">
            {STATE_META[seg.state].label}
          </span>
          <span className="font-mono text-[11px] text-ink">{seg.count}</span>
        </button>
      ))}
    </div>
  );
}
