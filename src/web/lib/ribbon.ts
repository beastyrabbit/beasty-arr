import type { StateCounts } from "../../shared/api-types.js";
import type { HuntState } from "../../shared/domain.js";
import { RIBBON_ORDER } from "./states.js";

export type RibbonSegment = {
  state: HuntState;
  count: number;
  /** Percent of total width, 0..100 (after minimum-width adjustment). */
  pct: number;
  /** Left offset in percent, 0..100. */
  offset: number;
};

/**
 * Pure segment math for the SegmentedBar. Segments appear in RIBBON_ORDER,
 * zero counts are dropped, widths are proportional but every visible segment
 * gets at least `minPct` (shaved proportionally from the larger ones) so tiny
 * slivers stay clickable/visible. Total always sums to 100.
 */
export function computeSegments(counts: Partial<StateCounts>, minPct = 1.25): RibbonSegment[] {
  const present = RIBBON_ORDER.map((state) => ({ state, count: counts[state] ?? 0 })).filter(
    (s) => s.count > 0,
  );
  const total = present.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return [];

  let pcts = present.map((s) => (s.count / total) * 100);
  if (present.length * minPct < 100) {
    // Lift small segments to minPct, then renormalize the rest to fill 100.
    const small = pcts.map((p) => p < minPct);
    const smallTotal = small.filter(Boolean).length * minPct;
    const largeTotal = pcts.reduce((sum, p, i) => (small[i] ? sum : sum + p), 0);
    const scale = largeTotal > 0 ? (100 - smallTotal) / largeTotal : 0;
    pcts = pcts.map((p, i) => (small[i] ? minPct : p * scale));
  }

  let offset = 0;
  return present.map((s, i) => {
    const seg: RibbonSegment = { state: s.state, count: s.count, pct: pcts[i], offset };
    offset += pcts[i];
    return seg;
  });
}
