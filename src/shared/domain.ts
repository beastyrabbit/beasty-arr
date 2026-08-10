/** Canonical item hunt states. Derived from arr mirror data — never latched. */
export const HUNT_STATES = [
  "unreleased",
  "missing",
  "non_german",
  "german",
  "ai_paused",
  "exhausted",
  "profile_blocked",
  "unmonitored",
  "ignored",
] as const;
export type HuntState = (typeof HUNT_STATES)[number];

export const ARR_SOURCES = ["sonarr", "radarr"] as const;
export type ArrSource = (typeof ARR_SOURCES)[number];

export const TARGET_KINDS = ["episode", "movie"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const TARGET_MODES = ["german", "original_ok", "ignore"] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export const AI_VERDICTS = ["exists", "announced", "unlikely", "unknown"] as const;
export type AiVerdictValue = (typeof AI_VERDICTS)[number];

/** Season-scoped oracle result stored inside a series verdict. */
export type AiSeasonVerdict = {
  season: number;
  verdict: AiVerdictValue;
  confidence?: number;
  note?: string;
  evidence?: string[];
  expectedAvailability?: number | null;
  recheckAfter?: number;
};

export const SEARCH_TRIGGERS = ["scheduled", "forced", "retry"] as const;
export type SearchTrigger = (typeof SEARCH_TRIGGERS)[number];

// Sonarr/Radarr language ids (verified against a live Sonarr v4 /api/v3/language:
// German=4, English=1; id 26 is Arabic — do NOT use it for German).
export const LANGUAGE_ID_GERMAN = 4;
export const LANGUAGE_ID_ENGLISH = 1;

export type FileLanguage = { id: number; name: string };

const UNKNOWN_LANGUAGE_NAMES = new Set([
  "",
  "unknown",
  "undetermined",
  "unidentified",
  "none",
  "n/a",
]);

/** Whether ARR supplied a concrete language rather than its id=0 Unknown sentinel. */
export function hasKnownLanguageMetadata(
  languages: readonly unknown[] | null | undefined,
): boolean {
  if (!languages) return false;
  return languages.some((language) => {
    if (typeof language === "string") {
      return !UNKNOWN_LANGUAGE_NAMES.has(language.trim().toLowerCase());
    }
    if (!language || typeof language !== "object") return false;
    const record = language as Record<string, unknown>;
    const id = Number(record.id);
    const name = String(record.name ?? "")
      .trim()
      .toLowerCase();
    return (Number.isFinite(id) && id > 0) || !UNKNOWN_LANGUAGE_NAMES.has(name);
  });
}

export function hasGermanAudio(languages: readonly unknown[] | null | undefined): boolean {
  if (!languages) return false;
  return languages.some((language) => {
    if (typeof language === "string") {
      const name = language.trim().toLowerCase();
      return name === "german" || name === "deutsch";
    }
    if (!language || typeof language !== "object") return false;
    const record = language as Record<string, unknown>;
    const name = String(record.name ?? "")
      .trim()
      .toLowerCase();
    return Number(record.id) === LANGUAGE_ID_GERMAN || name === "german" || name === "deutsch";
  });
}

/** Backoff ladder (ms) indexed by tier; capped at the last entry. */
export const BACKOFF_LADDER_MS = [
  12 * 60 * 60 * 1000, // 12h
  24 * 60 * 60 * 1000, // 1d
  3 * 24 * 60 * 60 * 1000, // 3d
  7 * 24 * 60 * 60 * 1000, // 7d
  14 * 24 * 60 * 60 * 1000, // 14d
  30 * 24 * 60 * 60 * 1000, // 30d
  60 * 24 * 60 * 60 * 1000, // 60d
  90 * 24 * 60 * 60 * 1000, // 90d
] as const;

/** Tier at (and beyond) which an item counts as exhausted. */
export const EXHAUSTED_TIER = 6;

export function backoffForTier(tier: number): number {
  const idx = Math.min(Math.max(tier, 0), BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[idx];
}
