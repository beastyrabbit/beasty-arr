import type { HuntState } from "../../shared/domain.js";

/**
 * The one state palette driving every badge, filter chip, and ribbon segment.
 * `user_paused` and `searching` are presentation-only overlays on top of the
 * canonical HuntState enum.
 */
export type BadgeState = HuntState | "user_paused" | "searching";

export type StateMeta = {
  label: string;
  /** Hex color from the Funkhaus state palette. */
  color: string;
};

export const STATE_META: Record<BadgeState, StateMeta> = {
  german: { label: "GERMAN", color: "#34d399" },
  non_german: { label: "OTHER AUDIO", color: "#fbbf24" },
  missing: { label: "MISSING", color: "#fb7185" },
  ai_paused: { label: "NO DUB · AI", color: "#a78bfa" },
  user_paused: { label: "PAUSED", color: "#94a3b8" },
  unreleased: { label: "UNRELEASED", color: "#7dd3fc" },
  exhausted: { label: "EXHAUSTED", color: "#f97316" },
  profile_blocked: { label: "PROFILE BLOCKED", color: "#ef4444" },
  unmonitored: { label: "UNMONITORED", color: "#5c6370" },
  ignored: { label: "IGNORED", color: "#5c6370" },
  searching: { label: "SEARCHING", color: "#22d3ee" },
};

/** Fixed segment order for every SegmentedBar scale (hero / row / season). */
export const RIBBON_ORDER: readonly HuntState[] = [
  "german",
  "non_german",
  "missing",
  "exhausted",
  "profile_blocked",
  "ai_paused",
  "unreleased",
  "unmonitored",
  "ignored",
];

/** States offered as library filter chips (all canonical states). */
export const FILTER_STATES: readonly HuntState[] = RIBBON_ORDER;

export function stateMeta(state: BadgeState): StateMeta {
  return STATE_META[state];
}
