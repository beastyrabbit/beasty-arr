import {
  AI_VERDICTS,
  type AiVerdictValue,
  EXHAUSTED_TIER,
  type FileLanguage,
  type HuntState,
  hasGermanAudio,
  type TargetKind,
  type TargetMode,
} from "../../shared/domain.js";

/**
 * Pure hunt-state derivation. Recomputed on every sync from arr mirror data —
 * never latched, so a deleted file automatically regresses german → missing.
 *
 * NOTE: `exhausted` is NEVER returned here. It is tier-driven (tier >=
 * EXHAUSTED_TIER) and applied by the hunt engine on top of missing/non_german.
 * Sync preserves an existing `exhausted` via reconcileDerivedState().
 */

export type DeriveProfileInput = {
  upgradeAllowed: boolean | null;
  cutoffFormatScore: number | null;
};

export type DeriveOverrideInput = {
  targetMode: TargetMode | null;
};

export type DeriveVerdictInput = {
  verdict: AiVerdictValue;
  confidence: number;
  /** Epoch ms after which the verdict must be re-checked. */
  recheckAfter: number;
};

export type DeriveStateInput = {
  kind: TargetKind;
  /** Effective monitored flag (episode AND series for Sonarr). */
  monitored: boolean;
  hasFile: boolean;
  hasGerman: boolean;
  /** Episode air date (epoch ms); null/undefined = TBA. */
  airDateUtc?: number | null;
  /** Radarr availability (minimumAvailability already applied by Radarr). */
  isAvailable?: boolean | null;
  /** Arr status string (movies: tba|announced|inCinemas|released|deleted). */
  status?: string | null;
  fileLanguages: FileLanguage[] | null;
  qualityCutoffNotMet: boolean | null;
  /** Sonarr only; Radarr has no language cutoff — pass null for movies. */
  languageCutoffNotMet: boolean | null;
  customFormatScore: number | null;
  profile: DeriveProfileInput | null;
  override: DeriveOverrideInput | null;
  verdict: DeriveVerdictInput | null;
  /** Precomputed pause horizon (see aiPausedUntilFor); falls back to verdict.recheckAfter. */
  aiPausedUntil?: number | null;
  /** settings.aiPauseConfidence; defaults to 0.7. */
  aiPauseConfidence?: number;
  originalLanguage?: string | null;
  /** settings.acceptedOriginalLanguages — original-audio languages that count as done. */
  acceptedOriginalLanguages: string[];
  now: number;
};

/** Minimum ai_paused duration; the actual horizon is max(checkedAt + this, recheckAfter). */
export const AI_PAUSE_MIN_MS = 180 * 24 * 60 * 60 * 1000;
export const DEFAULT_AI_PAUSE_CONFIDENCE = 0.7;

/** Pause horizon for an `unlikely` verdict: max(180d after check, recheckAfter). */
export function aiPausedUntilFor(verdict: { checkedAt: number; recheckAfter: number }): number {
  return Math.max(verdict.checkedAt + AI_PAUSE_MIN_MS, verdict.recheckAfter);
}

/** German-original (or user-accepted original language) titles are done once a file exists. */
export function originalLanguageAccepted(
  originalLanguage: string | null | undefined,
  acceptedOriginalLanguages: string[],
): boolean {
  const lang = originalLanguage?.trim().toLowerCase();
  if (!lang) return false;
  if (lang === "german" || lang === "deutsch") return true;
  return acceptedOriginalLanguages.some((l) => l.trim().toLowerCase() === lang);
}

export function isUnreleased(input: DeriveStateInput): boolean {
  // A file on disk trumps release metadata (early leaks, manual imports).
  if (input.hasFile) return false;
  if (input.kind === "episode") {
    return input.airDateUtc == null || input.airDateUtc > input.now;
  }
  if (input.isAvailable != null) return input.isAvailable === false;
  // No availability info mirrored: fall back to the status string.
  return input.status === "tba" || input.status === "announced" || input.status === "inCinemas";
}

/** The "done" condition: file present and German (or acceptably-original) audio. */
export function germanSatisfied(input: DeriveStateInput): boolean {
  if (!input.hasFile) return false;
  if (input.hasGerman || hasGermanAudio(input.fileLanguages)) return true;
  if (input.override?.targetMode === "original_ok") return true;
  return originalLanguageAccepted(input.originalLanguage, input.acceptedOriginalLanguages);
}

/**
 * The arr will never grab an upgrade for this file: either upgrades are off,
 * or every cutoff (quality, language, custom-format score) is already met.
 * Searched never — surfaced loudly as a profile misconfiguration instead.
 */
export function profileBlocked(input: DeriveStateInput): boolean {
  if (!input.hasFile) return false;
  if (input.profile?.upgradeAllowed === false) return true;
  // Radarr has no language cutoff; require an explicit `false` from Sonarr.
  const languageCutoffMet = input.kind === "movie" ? true : input.languageCutoffNotMet === false;
  return (
    input.qualityCutoffNotMet === false &&
    languageCutoffMet &&
    input.customFormatScore != null &&
    input.profile?.cutoffFormatScore != null &&
    input.customFormatScore >= input.profile.cutoffFormatScore
  );
}

/** Active `unlikely` verdict at/above the pause-confidence threshold, inside its horizon. */
export function aiPauseActive(input: DeriveStateInput): boolean {
  const verdict = input.verdict;
  if (verdict?.verdict !== "unlikely") return false;
  const threshold = input.aiPauseConfidence ?? DEFAULT_AI_PAUSE_CONFIDENCE;
  if (verdict.confidence < threshold) return false;
  const until = input.aiPausedUntil ?? verdict.recheckAfter;
  return input.now < until;
}

export function deriveState(input: DeriveStateInput): HuntState {
  if (isUnreleased(input)) return "unreleased";
  if (!input.monitored) return "unmonitored";
  if (input.override?.targetMode === "ignore") return "ignored";
  if (germanSatisfied(input)) return "german";
  if (profileBlocked(input)) return "profile_blocked";
  if (aiPauseActive(input)) return "ai_paused";
  if (!input.hasFile) return "missing";
  return "non_german";
}

/**
 * Reconciliation rule for stored rows: `exhausted` is applied by the hunt
 * engine (tier-driven), so a re-derive must not flap it back to
 * missing/non_german while the tier still warrants exhaustion. Any other
 * derived state (german, unreleased, ...) wins.
 */
export function reconcileDerivedState(
  existing: { state: HuntState; tier: number },
  derived: HuntState,
): HuntState {
  if (
    existing.state === "exhausted" &&
    existing.tier >= EXHAUSTED_TIER &&
    (derived === "missing" || derived === "non_german")
  ) {
    return "exhausted";
  }
  return derived;
}

export function isAiVerdictValue(value: string): value is AiVerdictValue {
  return (AI_VERDICTS as readonly string[]).includes(value);
}
