import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import type { SonarrEpisodeRecord } from "./sonarr-client.js";

export function episodeLabel(episode: SonarrEpisodeRecord): string {
  const season =
    typeof episode.seasonNumber === "number"
      ? `S${String(episode.seasonNumber).padStart(2, "0")}`
      : "";
  const number =
    typeof episode.episodeNumber === "number"
      ? `E${String(episode.episodeNumber).padStart(2, "0")}`
      : episode.absoluteEpisodeNumber
        ? `A${episode.absoluteEpisodeNumber}`
        : "";
  const prefix = [season, number].filter(Boolean).join("");
  return (
    [prefix, episode.title].filter(Boolean).join(" - ") || `Episode ${episode.id ?? "unknown"}`
  );
}

export function compactCandidate(candidate: ManualImportCandidate) {
  return {
    id: candidate.id,
    service: candidate.service,
    path: candidate.path,
    relativePath: candidate.relativePath,
    folderName: candidate.folderName,
    name: candidate.name,
    size: candidate.size,
    seriesId: candidate.seriesId,
    seriesTitle: candidate.seriesTitle,
    seasonNumber: candidate.seasonNumber,
    movieId: candidate.movieId,
    movieTitle: candidate.movieTitle,
    movieYear: candidate.movieYear,
    episodeIds: candidate.episodeIds,
    absoluteEpisodeNumbers: candidate.absoluteEpisodeNumbers,
    episodeLabels: candidate.episodeLabels,
    quality: candidate.qualityLabel,
    languages: candidate.languageLabels,
    releaseGroup: candidate.releaseGroup,
    customFormats: candidate.customFormatLabels ?? [],
    customFormatScore: candidate.customFormatScore,
    rejections: candidate.rejections,
    isLikelySample: candidate.isLikelySample,
    sampleReason: candidate.sampleReason,
  };
}
