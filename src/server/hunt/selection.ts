import type { ArrSource, TargetKind } from "../../shared/domain.js";

/**
 * Pure selection logic for the hunt engine: priority scoring, missing:upgrade
 * interleave, and grouping ordered candidates into arr search commands.
 * No DB, no clock — the engine feeds fully-resolved candidates in.
 */

export type CandidateBucket = "missing" | "upgrade";

export type HuntCandidate = {
  huntStateId: number;
  source: ArrSource;
  kind: TargetKind;
  /** episodeId / movieId in the arr. */
  targetId: number;
  seriesId: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** Series title (episodes) or movie title. */
  title: string;
  year: number | null;
  anime: boolean;
  score: number;
  bucket: CandidateBucket;
  searchCount: number;
  manualPriority: number;
};

export type PlannedCommandName = "SeasonSearch" | "EpisodeSearch" | "MoviesSearch";

export type PlannedCommand = {
  source: ArrSource;
  kind: "tv" | "movie";
  name: PlannedCommandName;
  payload: { name: string } & Record<string, unknown>;
  /** Search operations for budget estimates; anime season searches fan out per episode. */
  searchOps: number;
  anime: boolean;
  label: string;
  covered: HuntCandidate[];
};

export const SEASON_SEARCH_MIN_EPISODES = 3;
export const EPISODE_SEARCH_MAX_IDS = 5;
export const MOVIES_SEARCH_MAX_IDS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ScoreInput = {
  announcedDue: boolean;
  existsVerdict: boolean;
  /** Days since air/digital/physical release; null = unknown → no recency boost. */
  daysSinceRelease: number | null;
  tier: number;
  searchCount: number;
};

/** Plan formula: 400·announced-due + 300·exists + 2·max(0,365−days) − 50·tier − 5·count. */
export function priorityScore(input: ScoreInput): number {
  const days = input.daysSinceRelease === null ? null : Math.max(0, input.daysSinceRelease);
  const recency = days === null ? 0 : Math.max(0, 365 - days);
  return (
    (input.announcedDue ? 400 : 0) +
    (input.existsVerdict ? 300 : 0) +
    2 * recency -
    50 * input.tier -
    5 * input.searchCount
  );
}

export function parseRatio(ratio: string): { missing: number; upgrade: number } {
  const match = /^(\d+):(\d+)$/.exec(ratio.trim());
  if (!match) return { missing: 1, upgrade: 2 };
  const missing = Number(match[1]);
  const upgrade = Number(match[2]);
  if (missing < 1 && upgrade < 1) return { missing: 1, upgrade: 2 };
  return { missing, upgrade };
}

/** Interleave two score-sorted buckets missing:upgrade per ratio; drains leftovers. */
export function interleaveByRatio<T>(
  missing: T[],
  upgrade: T[],
  ratio: { missing: number; upgrade: number },
): T[] {
  const out: T[] = [];
  let mi = 0;
  let ui = 0;
  while (mi < missing.length || ui < upgrade.length) {
    const before = out.length;
    for (let k = 0; k < ratio.missing && mi < missing.length; k++) out.push(missing[mi++]);
    for (let k = 0; k < ratio.upgrade && ui < upgrade.length; k++) out.push(upgrade[ui++]);
    if (out.length === before) {
      // Degenerate ratio (e.g. "0:1" with only missing left): drain the rest.
      while (mi < missing.length) out.push(missing[mi++]);
      while (ui < upgrade.length) out.push(upgrade[ui++]);
    }
  }
  return out;
}

/**
 * Dub-lag gate: after a (non-German) import, the FIRST upgrade search waits
 * `dubLagDays`. Returns the epoch-ms the item unblocks, or null when not gated
 * (no import mirrored, or already searched since this import).
 */
export function firstUpgradeBlockedUntil(args: {
  fileImportedAt: number | null;
  lastSearchAt: number | null;
  dubLagDays: number;
}): number | null {
  if (args.fileImportedAt == null) return null;
  if (args.lastSearchAt != null && args.lastSearchAt > args.fileImportedAt) return null;
  return args.fileImportedAt + args.dubLagDays * DAY_MS;
}

export function seasonCode(seasonNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}`;
}

export function episodeCode(seasonNumber: number, episodeNumber: number | null): string {
  const season = seasonCode(seasonNumber);
  if (episodeNumber === null) return season;
  return `${season}E${String(episodeNumber).padStart(2, "0")}`;
}

export function candidateLabel(candidate: HuntCandidate): string {
  if (candidate.kind === "movie") {
    return candidate.year != null ? `${candidate.title} (${candidate.year})` : candidate.title;
  }
  return `${candidate.title} ${episodeCode(candidate.seasonNumber ?? 0, candidate.episodeNumber)}`;
}

function batchLabel(batch: HuntCandidate[]): string {
  const first = candidateLabel(batch[0]);
  return batch.length > 1 ? `${first} +${batch.length - 1}` : first;
}

function removeAll(list: HuntCandidate[], batch: HuntCandidate[]): void {
  const ids = new Set(batch.map((c) => c.huntStateId));
  for (let i = list.length - 1; i >= 0; i--) {
    if (ids.has(list[i].huntStateId)) list.splice(i, 1);
  }
}

/**
 * Group an ordered candidate list into arr commands, preserving priority order
 * of the heads. Rules: >=3 selected episodes sharing series+season → one
 * SeasonSearch (searchOps=1, best budget value); anime uses single-episode
 * searches because Sonarr fans anime season searches out internally. Other episodes of the same
 * series merge into an EpisodeSearch (<=5 ids); movies batch into MoviesSearch
 * (<=3 ids). Seasons that will form their own SeasonSearch are never split
 * into an EpisodeSearch.
 */
export function groupCommands(ordered: HuntCandidate[]): PlannedCommand[] {
  const remaining = [...ordered];
  const commands: PlannedCommand[] = [];
  while (remaining.length > 0) {
    const head = remaining[0];
    if (head.kind === "movie") {
      const batch = remaining
        .filter((c) => c.kind === "movie" && c.source === head.source)
        .slice(0, MOVIES_SEARCH_MAX_IDS);
      removeAll(remaining, batch);
      commands.push({
        source: head.source,
        kind: "movie",
        name: "MoviesSearch",
        payload: { name: "MoviesSearch", movieIds: batch.map((c) => c.targetId) },
        searchOps: batch.length,
        anime: false,
        label: batchLabel(batch),
        covered: batch,
      });
      continue;
    }
    const seriesCands = remaining.filter(
      (c) => c.kind === "episode" && c.source === head.source && c.seriesId === head.seriesId,
    );
    const seasonOf = (c: HuntCandidate) => c.seasonNumber ?? -1;
    const seasonCounts = new Map<number, number>();
    for (const c of seriesCands) {
      seasonCounts.set(seasonOf(c), (seasonCounts.get(seasonOf(c)) ?? 0) + 1);
    }
    const headSeason = seasonOf(head);
    if (!head.anime && (seasonCounts.get(headSeason) ?? 0) >= SEASON_SEARCH_MIN_EPISODES) {
      const batch = seriesCands.filter((c) => seasonOf(c) === headSeason);
      removeAll(remaining, batch);
      commands.push({
        source: head.source,
        kind: "tv",
        name: "SeasonSearch",
        payload: { name: "SeasonSearch", seriesId: head.seriesId, seasonNumber: headSeason },
        searchOps: batch.some((c) => c.anime) ? batch.length : 1,
        anime: batch.some((c) => c.anime),
        label: `${head.title} ${seasonCode(headSeason)}`,
        covered: batch,
      });
      continue;
    }
    const batch = seriesCands
      .filter((c) => c.anime || (seasonCounts.get(seasonOf(c)) ?? 0) < SEASON_SEARCH_MIN_EPISODES)
      .slice(0, head.anime ? 1 : EPISODE_SEARCH_MAX_IDS);
    removeAll(remaining, batch);
    commands.push({
      source: head.source,
      kind: "tv",
      name: "EpisodeSearch",
      payload: { name: "EpisodeSearch", episodeIds: batch.map((c) => c.targetId) },
      searchOps: batch.length,
      anime: batch.some((c) => c.anime),
      label: batchLabel(batch),
      covered: batch,
    });
  }
  return commands;
}
