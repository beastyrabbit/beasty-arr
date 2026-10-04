import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import type { SonarrEpisodeRecord } from "./sonarr-client.js";

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function usefulTitle(title: string | undefined): string | null {
  if (!title) return null;
  const normalized = normalizeTitle(title);
  const tokens = normalized.split(" ").filter(Boolean);
  if (normalized.length < 8 || (tokens.length < 2 && normalized.length < 12)) return null;
  return normalized;
}

export function animeTitleConflict(
  candidate: ManualImportCandidate,
  selectedEpisode: SonarrEpisodeRecord,
  seriesEpisodes: SonarrEpisodeRecord[],
): string | null {
  const candidateText = normalizeTitle(
    [candidate.name, candidate.relativePath, candidate.path].filter(Boolean).join(" "),
  );
  const selectedTitle = usefulTitle(selectedEpisode.title);
  if (!candidateText || !selectedTitle || candidateText.includes(selectedTitle)) return null;
  // Every file name carries the series name, so an episode titled exactly like
  // the series (Re:Zero has one) is no evidence of a different episode.
  const seriesTitle = normalizeTitle(candidate.seriesTitle ?? "");

  const conflicting = seriesEpisodes.find((episode) => {
    if (episode.id === selectedEpisode.id) return false;
    const title = usefulTitle(episode.title);
    if (title === null || title === seriesTitle) return false;
    return candidateText.includes(title);
  });
  if (!conflicting?.title) return null;
  return `Anime title mismatch: candidate ${candidate.id} names “${conflicting.title}” but was selected for “${selectedEpisode.title}”.`;
}
