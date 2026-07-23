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

export const SEARCH_TRIGGERS = ["scheduled", "forced", "retry"] as const;
export type SearchTrigger = (typeof SEARCH_TRIGGERS)[number];

/** Sonarr/Radarr language ids we care about. */
export const LANGUAGE_ID_GERMAN = 26;
export const LANGUAGE_ID_ENGLISH = 1;

export type FileLanguage = { id: number; name: string };

export function hasGermanAudio(languages: FileLanguage[] | null | undefined): boolean {
  if (!languages) return false;
  return languages.some((l) => l.id === LANGUAGE_ID_GERMAN || l.name.toLowerCase() === "german");
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
