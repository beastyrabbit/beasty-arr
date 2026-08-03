import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasGermanAudio, hasKnownLanguageMetadata } from "../../shared/domain.js";
import type { ManualImportCandidate, QueueItem, ResolverEvent } from "../../shared/fixer-types.js";
import type {
  RadarrClient,
  RadarrCustomFormatRecord,
  RadarrMovieFileRecord,
  RadarrMovieRecord,
  RadarrQualityProfileItem,
  RadarrQualityProfileRecord,
} from "../arr/radarr-client.js";
import { compactCandidate } from "../arr/sonarr-format.js";

type EmitEvent = (event: Omit<ResolverEvent, "timestamp">) => void;

interface CreateRadarrLookupToolsInput {
  client: RadarrClient;
  queueItem: QueueItem;
  getCandidates: () => ManualImportCandidate[];
  refreshCandidates?: () => Promise<ManualImportCandidate[]>;
  emit?: EmitEvent;
}

function valueName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return String(value ?? "");
  }
  const record = value as Record<string, unknown>;
  return String(record.name ?? record.id ?? "");
}

function compactMovieFile(file?: RadarrMovieFileRecord) {
  if (!file) {
    return undefined;
  }
  const languages = file.languages ?? [];
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    size: file.size,
    quality: valueName(
      (file.quality as { quality?: unknown } | undefined)?.quality ?? file.quality,
    ),
    languages: languages.map(valueName).filter(Boolean),
    languageMetadataPresent: hasKnownLanguageMetadata(languages),
    hasGermanAudio: hasGermanAudio(languages),
    releaseGroup: file.releaseGroup,
    edition: file.edition,
    customFormats: (file.customFormats ?? []).map((format) => ({
      id: format.id,
      name: format.name,
    })),
    customFormatScore: file.customFormatScore,
    qualityCutoffNotMet: file.qualityCutoffNotMet,
  };
}

function compactMovie(movie: RadarrMovieRecord) {
  return {
    id: movie.id,
    title: movie.title,
    originalTitle: movie.originalTitle,
    year: movie.year,
    tmdbId: movie.tmdbId,
    imdbId: movie.imdbId,
    path: movie.path,
    qualityProfileId: movie.qualityProfileId,
    hasFile: movie.hasFile,
    movieFileId: movie.movieFileId,
    monitored: movie.monitored,
    currentFile: compactMovieFile(movie.movieFile),
  };
}

function flattenAllowedQualityNames(items: RadarrQualityProfileItem[] = []): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.allowed && item.quality?.name) {
      names.push(item.quality.name);
    }
    names.push(...flattenAllowedQualityNames(item.items));
  }
  return names;
}

function compactQualityProfile(profile: RadarrQualityProfileRecord) {
  return {
    id: profile.id,
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: profile.cutoff,
    minFormatScore: profile.minFormatScore,
    cutoffFormatScore: profile.cutoffFormatScore,
    minUpgradeFormatScore: profile.minUpgradeFormatScore,
    allowedQualities: flattenAllowedQualityNames(profile.items),
    formatItems: (profile.formatItems ?? []).map((item) => ({
      format: item.format,
      name: item.name,
      score: item.score,
    })),
  };
}

function compactCustomFormat(format: RadarrCustomFormatRecord) {
  return {
    id: format.id,
    name: format.name,
    includeCustomFormatWhenRenaming: format.includeCustomFormatWhenRenaming,
  };
}

async function safeGetMovie(client: RadarrClient, movieId?: number) {
  if (!movieId) {
    return undefined;
  }
  try {
    return await client.getMovie(movieId);
  } catch {
    return undefined;
  }
}

export function createRadarrLookupTools({
  client,
  queueItem,
  getCandidates,
  refreshCandidates,
  emit,
}: CreateRadarrLookupToolsInput) {
  const getQueueContextTool = defineTool({
    name: "radarr_get_queue_context",
    label: "Get Radarr Queue Context",
    description:
      "Read the current Radarr queue target, warning messages, target movie id, and manual import candidates.",
    promptSnippet: "Use radarr_get_queue_context to reread the queue target and Radarr warning.",
    parameters: Type.Object({}),
    executionMode: "parallel" as const,
    async execute() {
      const movie = await safeGetMovie(client, queueItem.movieId);
      const details = {
        queueItem: {
          id: queueItem.id,
          title: queueItem.title,
          movieId: queueItem.movieId,
          movieTitle: queueItem.movieTitle,
          movieYear: queueItem.movieYear,
          status: queueItem.status,
          trackedDownloadStatus: queueItem.trackedDownloadStatus,
          trackedDownloadState: queueItem.trackedDownloadState,
          statusMessages: queueItem.statusMessages,
          outputPath: queueItem.outputPath,
          size: queueItem.size,
        },
        movie: movie ? compactMovie(movie) : undefined,
        candidates: getCandidates().map(compactCandidate),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const getMovieTool = defineTool({
    name: "radarr_get_movie",
    label: "Get Radarr Movie",
    description:
      "Read the Radarr movie record for the queue target, including title identifiers and the current movie file.",
    promptSnippet: "Use radarr_get_movie to verify the exact target movie and current file.",
    parameters: Type.Object({
      movieId: Type.Optional(
        Type.Integer({ minimum: 1, description: "Movie id. Defaults to the queue movie id." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const movieId = params.movieId ?? queueItem.movieId;
      const movie = movieId ? await client.getMovie(movieId) : undefined;
      const details = movie ? compactMovie(movie) : { movieId, found: false };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const getCandidatesTool = defineTool({
    name: "radarr_get_manual_import_candidates",
    label: "Get Radarr Manual Import Candidates",
    description:
      "Read the files Radarr exposes for this queue item, including parsed movie ids and import rejections.",
    promptSnippet:
      "Use radarr_get_manual_import_candidates to re-check the importable files Radarr sees.",
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Ask Radarr for fresh candidates before returning." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const candidates =
        params.refresh && refreshCandidates ? await refreshCandidates() : getCandidates();
      emit?.({
        type: "radarr",
        itemId: queueItem.id,
        message: `Pi inspected ${candidates.length} manual import candidates.`,
      });
      const details = {
        count: candidates.length,
        candidates: candidates.map(compactCandidate),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const getUpgradeContextTool = defineTool({
    name: "radarr_get_upgrade_context",
    label: "Get Radarr Upgrade Context",
    description:
      "Required before every final resolution: read the current movie file, explicit German-audio flags, quality profile scoring, and custom formats before deciding whether a candidate is safe to import or should be removed.",
    promptSnippet:
      "Always use radarr_get_upgrade_context before proposing a final resolution, including sample-only warnings.",
    promptGuidelines: [
      "Call this for every queue analysis before proposing a resolution, even when the only warning mentions sample detection.",
      "A candidate explicitly lacking German must never replace a current file whose hasGermanAudio field is true.",
      "Compare candidate and current-file language, quality, and custom-format score before deciding.",
    ],
    parameters: Type.Object({
      includeCustomFormatDefinitions: Type.Optional(
        Type.Boolean({ description: "Return every custom format definition." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const [movie, qualityProfiles, customFormats] = await Promise.all([
        safeGetMovie(client, queueItem.movieId),
        client.getQualityProfiles().catch(() => []),
        client.getCustomFormats().catch(() => []),
      ]);
      const relevantFormatIds = new Set<number>();
      for (const format of movie?.movieFile?.customFormats ?? []) {
        if (format.id) {
          relevantFormatIds.add(format.id);
        }
      }
      for (const candidate of getCandidates()) {
        for (const format of candidate.customFormats ?? []) {
          if (format && typeof format === "object" && "id" in format) {
            const id = Number((format as { id?: unknown }).id);
            if (Number.isFinite(id)) {
              relevantFormatIds.add(id);
            }
          }
        }
      }
      const profile = qualityProfiles.find((item) => item.id === movie?.qualityProfileId);
      for (const item of profile?.formatItems ?? []) {
        if (item.format) {
          relevantFormatIds.add(item.format);
        }
      }
      const details = {
        queueItem: {
          id: queueItem.id,
          title: queueItem.title,
          movieId: queueItem.movieId,
          statusMessages: queueItem.statusMessages,
        },
        movie: movie ? compactMovie(movie) : undefined,
        candidates: getCandidates().map(compactCandidate),
        qualityProfile: profile ? compactQualityProfile(profile) : undefined,
        customFormats: customFormats
          .filter(
            (format) =>
              params.includeCustomFormatDefinitions ||
              (format.id !== undefined && relevantFormatIds.has(format.id)),
          )
          .map(compactCustomFormat),
      };
      emit?.({
        type: "radarr",
        itemId: queueItem.id,
        message: "Pi inspected Radarr upgrade context.",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  return [getQueueContextTool, getMovieTool, getCandidatesTool, getUpgradeContextTool];
}
