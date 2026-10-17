import { hasGermanAudio, hasKnownLanguageMetadata } from "../../shared/domain.js";
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

/** The quality revision when it is more than a plain v1, so "v2"/PROPER/REPACK is visible. */
function qualityRevision(quality: unknown): { version: number; isRepack?: true } | undefined {
  const revision = (quality as { revision?: { version?: unknown; isRepack?: unknown } } | undefined)
    ?.revision;
  const version = Number(revision?.version);
  const isRepack = revision?.isRepack === true;
  const laterVersion = version > 1;
  if (!laterVersion && !isRepack) return undefined;
  return { version: Number.isFinite(version) ? version : 1, ...(isRepack ? { isRepack } : {}) };
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
    seriesType: candidate.seriesType,
    seasonNumber: candidate.seasonNumber,
    movieId: candidate.movieId,
    movieTitle: candidate.movieTitle,
    movieYear: candidate.movieYear,
    episodeIds: candidate.episodeIds,
    absoluteEpisodeNumbers: candidate.absoluteEpisodeNumbers,
    episodeLabels: candidate.episodeLabels,
    quality: candidate.qualityLabel,
    qualityRevision: qualityRevision(candidate.quality),
    // Parsed from the release name by the arr; the inspected streams are authoritative.
    arrLanguageLabels: candidate.languageLabels,
    arrLabelsKnown: hasKnownLanguageMetadata(candidate.languages),
    arrLabelsSayGerman: hasGermanAudio(candidate.languages),
    releaseGroup: candidate.releaseGroup,
    customFormats: candidate.customFormatLabels ?? [],
    customFormatScore: candidate.customFormatScore,
    rejections: candidate.rejections,
    isLikelySample: candidate.isLikelySample,
    sampleReason: candidate.sampleReason,
  };
}
