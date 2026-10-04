import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasGermanAudio, hasKnownLanguageMetadata } from "../../shared/domain.js";
import type { ManualImportCandidate, QueueItem } from "../../shared/fixer-types.js";
import type {
  SonarrClient,
  SonarrCustomFormatRecord,
  SonarrCustomFormatSummary,
  SonarrEpisodeFileRecord,
  SonarrEpisodeRecord,
  SonarrQualityProfileItem,
  SonarrQualityProfileRecord,
  SonarrSeriesRecord,
} from "../arr/sonarr-client.js";
import { compactCandidate, episodeLabel } from "../arr/sonarr-format.js";
import { assessImportMappings } from "./upgrade.js";

type SonarrToolEvent = {
  type: "info" | "warning" | "error" | "pi" | "sonarr";
  itemId?: number;
  message: string;
  details?: unknown;
};

type EmitEvent = (event: SonarrToolEvent) => void;

interface CreateSonarrLookupToolsInput {
  client: SonarrClient;
  queueItem: QueueItem;
  getCandidates: () => ManualImportCandidate[];
  refreshCandidates?: () => Promise<ManualImportCandidate[]>;
  rememberEpisodeIds?: (episodeIds: number[]) => void;
  emit?: EmitEvent;
}

/** Synopses let dialogue confirm an episode by plot; whole-series listings drop them. */
const SYNOPSIS_MAX_CHARS = 300;
const SYNOPSIS_LISTING_LIMIT = 25;

function compactEpisode(episode: SonarrEpisodeRecord) {
  return {
    id: episode.id,
    seriesId: episode.seriesId,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    absoluteEpisodeNumber: episode.absoluteEpisodeNumber,
    sceneSeasonNumber: episode.sceneSeasonNumber,
    sceneEpisodeNumber: episode.sceneEpisodeNumber,
    sceneAbsoluteEpisodeNumber: episode.sceneAbsoluteEpisodeNumber,
    title: episode.title,
    synopsis: episode.overview?.slice(0, SYNOPSIS_MAX_CHARS),
    runtimeMinutes: episode.runtime || undefined,
    airDate: episode.airDate,
    hasFile: episode.hasFile,
    episodeFileId: episode.episodeFileId,
    monitored: episode.monitored,
    label: episodeLabel(episode),
  };
}

function compactSeries(series: SonarrSeriesRecord) {
  return {
    id: series.id,
    title: series.title,
    year: series.year,
    runtimeMinutes: series.runtime || undefined,
    tvdbId: series.tvdbId,
    seriesType: series.seriesType,
    alternateTitles: (series.alternateTitles ?? []).slice(0, 20).map((alt) => ({
      title: alt.title,
      seasonNumber: alt.seasonNumber ?? alt.sceneSeasonNumber,
    })),
  };
}

function valueName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return String(value ?? "");
  }
  const record = value as Record<string, unknown>;
  return String(record.name ?? record.id ?? "");
}

function compactFormat(format: SonarrCustomFormatSummary) {
  return {
    id: format.id,
    name: format.name,
  };
}

function compactEpisodeFile(file?: SonarrEpisodeFileRecord) {
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
    arrLanguageLabels: languages.map(valueName).filter(Boolean),
    arrLabelsKnown: hasKnownLanguageMetadata(languages),
    arrLabelsSayGerman: hasGermanAudio(languages),
    arrMediaInfo: file.mediaInfo
      ? {
          audioLanguages: file.mediaInfo.audioLanguages,
          subtitles: file.mediaInfo.subtitles,
          resolution: file.mediaInfo.resolution,
          runTime: file.mediaInfo.runTime,
        }
      : undefined,
    releaseGroup: file.releaseGroup,
    releaseType: file.releaseType,
    customFormats: (file.customFormats ?? []).map(compactFormat),
    customFormatScore: file.customFormatScore,
    qualityCutoffNotMet: file.qualityCutoffNotMet,
  };
}

function flattenAllowedQualityNames(items: SonarrQualityProfileItem[] = []): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.allowed && item.quality?.name) {
      names.push(item.quality.name);
    }
    names.push(...flattenAllowedQualityNames(item.items));
  }
  return names;
}

function compactQualityProfile(profile: SonarrQualityProfileRecord) {
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

function compactCustomFormat(format: SonarrCustomFormatRecord) {
  return {
    id: format.id,
    name: format.name,
    includeCustomFormatWhenRenaming: format.includeCustomFormatWhenRenaming,
  };
}

function numberSet(values: Array<number | undefined>): Set<number> {
  return new Set(
    values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
}

function episodeNumbers(episode: SonarrEpisodeRecord): number[] {
  return [episode.absoluteEpisodeNumber, episode.sceneAbsoluteEpisodeNumber].flatMap((value) =>
    typeof value === "number" ? [value] : [],
  );
}

function clampWindow(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 4;
  }
  return Math.min(25, Math.max(0, Math.trunc(value)));
}

function truncateEpisodes(episodes: SonarrEpisodeRecord[], limit = 350): SonarrEpisodeRecord[] {
  return episodes.slice(0, limit);
}

async function safeGetTargetEpisodes(client: SonarrClient, queueItem: QueueItem) {
  if (queueItem.episodeIds.length === 0) {
    return [];
  }
  try {
    return await client.getEpisodes({ episodeIds: queueItem.episodeIds });
  } catch {
    return [];
  }
}

export function createSonarrLookupTools({
  client,
  queueItem,
  getCandidates,
  refreshCandidates,
  rememberEpisodeIds,
  emit,
}: CreateSonarrLookupToolsInput) {
  const getQueueContextTool = defineTool({
    name: "sonarr_get_queue_context",
    label: "Get Sonarr Queue Context",
    description:
      "Read the queued series (year, runtime, alternate titles with the season they belong to), the target episodes (titles, runtimes), Sonarr's warning messages, and the manual import candidates.",
    promptSnippet: "Use sonarr_get_queue_context to reread the queue target and Sonarr warning.",
    promptGuidelines: [
      "Use sonarr_get_queue_context when you need to re-check the target episode ids or Sonarr warning.",
    ],
    parameters: Type.Object({}),
    executionMode: "parallel" as const,
    async execute() {
      const [targetEpisodes, series] = await Promise.all([
        safeGetTargetEpisodes(client, queueItem),
        queueItem.seriesId
          ? client.getSeriesById(queueItem.seriesId).catch(() => undefined)
          : undefined,
      ]);
      rememberEpisodeIds?.(targetEpisodes.flatMap((episode) => (episode.id ? [episode.id] : [])));
      const details = {
        series: series ? compactSeries(series) : undefined,
        queueItem: {
          id: queueItem.id,
          title: queueItem.title,
          seriesId: queueItem.seriesId,
          seriesTitle: queueItem.seriesTitle,
          targetEpisodeIds: queueItem.episodeIds,
          targetAbsoluteEpisodeNumbers: queueItem.absoluteEpisodeNumbers,
          seasonEpisode: queueItem.seasonEpisode,
          episodeLabels: queueItem.episodeLabels,
          status: queueItem.status,
          trackedDownloadStatus: queueItem.trackedDownloadStatus,
          trackedDownloadState: queueItem.trackedDownloadState,
          statusMessages: queueItem.statusMessages,
          outputPath: queueItem.outputPath,
          size: queueItem.size,
        },
        targetEpisodes: targetEpisodes.map(compactEpisode),
        candidates: getCandidates().map(compactCandidate),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const findEpisodesTool = defineTool({
    name: "sonarr_find_episodes",
    label: "Find Sonarr Episodes",
    description:
      "Read-only Sonarr episode lookup. With only a seriesId it lists every episode of the series across all seasons (titles, runtimes, air dates, absolute and scene numbers); filter by seasonNumber, titleContains, or absoluteEpisodeNumber. Use it to find which episode a file really is when its own title or content disagrees with Sonarr's mapping.",
    promptSnippet:
      "Use sonarr_find_episodes to search the whole series for the episode a file really is.",
    promptGuidelines: [
      "Search by the episode title found in the file name, embedded title, or subtitles (titleContains) across all seasons, not only the episode Sonarr mapped.",
      "Anthology series keep each story in its own Sonarr season; a release numbered S01 of a later story usually belongs to a later Sonarr season.",
      "Do not guess an episode id when Sonarr can be queried for the series episode mapping.",
    ],
    parameters: Type.Object({
      seriesId: Type.Optional(
        Type.Number({ description: "Series id. Defaults to the queue item series id." }),
      ),
      episodeIds: Type.Optional(
        Type.Array(Type.Number({ description: "Exact Sonarr episode ids to fetch." })),
      ),
      seasonNumber: Type.Optional(
        Type.Number({ description: "Filter to a Sonarr season number." }),
      ),
      absoluteEpisodeNumber: Type.Optional(
        Type.Number({ description: "Find episodes around this anime absolute episode number." }),
      ),
      titleContains: Type.Optional(
        Type.String({ description: "Case-insensitive title text filter." }),
      ),
      window: Type.Optional(
        Type.Number({ description: "Neighbor range around absoluteEpisodeNumber. Defaults to 4." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const seriesId = params.seriesId ?? queueItem.seriesId;
      const exactEpisodeIds = params.episodeIds?.length ? params.episodeIds : undefined;
      let episodes: SonarrEpisodeRecord[];

      if (exactEpisodeIds) {
        episodes = await client.getEpisodes({ episodeIds: exactEpisodeIds });
      } else if (seriesId) {
        episodes = await client.getEpisodes({ seriesId, seasonNumber: params.seasonNumber });
      } else {
        episodes = await safeGetTargetEpisodes(client, queueItem);
      }

      const absoluteEpisodeNumber =
        typeof params.absoluteEpisodeNumber === "number" ? params.absoluteEpisodeNumber : undefined;
      if (absoluteEpisodeNumber !== undefined) {
        const radius = clampWindow(params.window);
        episodes = episodes.filter((episode) =>
          episodeNumbers(episode).some(
            (episodeNumber) => Math.abs(episodeNumber - absoluteEpisodeNumber) <= radius,
          ),
        );
      }

      const titleContains = params.titleContains?.trim().toLowerCase();
      if (titleContains) {
        episodes = episodes.filter((episode) =>
          episode.title?.toLowerCase().includes(titleContains),
        );
      }
      rememberEpisodeIds?.(episodes.flatMap((episode) => (episode.id ? [episode.id] : [])));

      const truncated = episodes.length > 350;
      const details = {
        seriesId,
        filter: params,
        truncated,
        count: episodes.length,
        episodes: truncateEpisodes(episodes).map((episode) => {
          const compact = compactEpisode(episode);
          return episodes.length > SYNOPSIS_LISTING_LIMIT
            ? { ...compact, synopsis: undefined }
            : compact;
        }),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const parseReleaseTool = defineTool({
    name: "sonarr_parse_release",
    label: "Parse Release Name",
    description:
      "Ask Sonarr to parse a release or file name on its own, without grab history: parsed series title and year, season/episode numbers, and which library series and episodes (if any) the name really matches. A download whose name matches no series or another series is suspect.",
    promptSnippet: "Use sonarr_parse_release to see what a release name really refers to.",
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({ description: "Release or file name. Defaults to the queue release title." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const title = params.title?.trim() || queueItem.title;
      const result = await client.parseRelease(title);
      const info = result.parsedEpisodeInfo;
      const details = {
        title,
        parsedSeriesTitle: info?.seriesTitle,
        parsedYear: info?.seriesTitleInfo?.year || undefined,
        seasonNumber: info?.seasonNumber,
        episodeNumbers: info?.episodeNumbers,
        absoluteEpisodeNumbers: info?.absoluteEpisodeNumbers,
        fullSeason: info?.fullSeason,
        matchedLibrarySeries: result.series ? compactSeries(result.series) : null,
        matchedEpisodes: (result.episodes ?? []).map(compactEpisode),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const lookupSeriesTool = defineTool({
    name: "sonarr_lookup_series",
    label: "Look Up Series (TVDB)",
    description:
      "Search TVDB through Sonarr by title or 'tvdb:<id>'. Returns title, year, runtime, ids, and whether the series is in the library. Use it to find out which show a release actually belongs to.",
    promptSnippet: "Use sonarr_lookup_series to identify which show a release belongs to.",
    parameters: Type.Object({
      term: Type.String({ minLength: 1, description: "Search term, e.g. 'Lizzie Borden Story'." }),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const results = await client.lookupSeries(params.term);
      const details = {
        term: params.term,
        results: results.slice(0, 8).map((series) => ({
          ...compactSeries(series),
          alternateTitles: undefined,
          inLibrary: Boolean(series.id),
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  const getCandidatesTool = defineTool({
    name: "sonarr_get_manual_import_candidates",
    label: "Get Manual Import Candidates",
    description:
      "Read the manual import candidates Sonarr exposes for this queue item, including Sonarr's parsed episode ids and rejections.",
    promptSnippet:
      "Use sonarr_get_manual_import_candidates to re-check the importable files Sonarr sees.",
    promptGuidelines: [
      "Use sonarr_get_manual_import_candidates when deciding which physical file path should be imported.",
    ],
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Ask Sonarr for fresh candidates before returning." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const candidates =
        params.refresh && refreshCandidates ? await refreshCandidates() : getCandidates();
      rememberEpisodeIds?.(candidates.flatMap((candidate) => candidate.episodeIds));
      emit?.({
        type: "sonarr",
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
    name: "sonarr_get_upgrade_context",
    label: "Get Upgrade Context",
    description:
      "Read the current episode files (Sonarr's labels and media info), quality profile scoring, custom formats, and an upgradeAssessment (import/skip/blocked/unverified) per candidate against the episodes Sonarr mapped it to. Pass episodeIds to compare against the episodes a file really is.",
    promptSnippet:
      "Use sonarr_get_upgrade_context to compare candidates with the current episode files and the quality profile.",
    promptGuidelines: [
      "Call this before proposing a resolution; pass episodeIds when you remapped a file.",
      "upgradeAssessment compares Sonarr's quality and score labels only. The import preflight refuses files it marks skip or blocked, but it cannot see real resolution or untagged German tracks — check those with inspect_media_files.",
      "Custom-format scores express the user's quality preferences; German audio the library lacks outweighs them.",
    ],
    parameters: Type.Object({
      episodeIds: Type.Optional(
        Type.Array(
          Type.Number({ description: "Exact Sonarr episode ids. Defaults to queue target ids." }),
        ),
      ),
      includeCustomFormatDefinitions: Type.Optional(
        Type.Boolean({
          description:
            "Return all custom format names, not only formats relevant to the target file/candidates/profile.",
        }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const candidatesNow = getCandidates();
      const episodeIds = [
        ...new Set([
          ...(params.episodeIds?.length ? params.episodeIds : queueItem.episodeIds),
          ...candidatesNow.flatMap((candidate) => candidate.episodeIds),
        ]),
      ];
      const [episodes, qualityProfiles, customFormats] = await Promise.all([
        episodeIds.length
          ? client.getEpisodes({ episodeIds, includeSeries: true, includeEpisodeFile: true })
          : safeGetTargetEpisodes(client, queueItem),
        client.getQualityProfiles().catch(() => []),
        client.getCustomFormats().catch(() => []),
      ]);
      rememberEpisodeIds?.(episodes.flatMap((episode) => (episode.id ? [episode.id] : [])));

      const profileIds = numberSet(episodes.map((episode) => episode.series?.qualityProfileId));
      const relevantFormatIds = numberSet([
        ...episodes.flatMap((episode) =>
          (episode.episodeFile?.customFormats ?? []).map((format) => format.id),
        ),
        ...getCandidates().flatMap((candidate) =>
          (candidate.customFormats ?? []).map((format) => {
            if (format && typeof format === "object" && "id" in format) {
              return Number((format as { id?: unknown }).id);
            }
            return undefined;
          }),
        ),
      ]);
      for (const profile of qualityProfiles) {
        if (profile.id && profileIds.has(profile.id)) {
          for (const item of profile.formatItems ?? []) {
            if (typeof item.format === "number") {
              relevantFormatIds.add(item.format);
            }
          }
        }
      }

      const episodesById = new Map(
        episodes.flatMap((episode) => (episode.id === undefined ? [] : [[episode.id, episode]])),
      );
      const profilesById = new Map(
        qualityProfiles.flatMap((profile) =>
          profile.id === undefined ? [] : [[profile.id, profile]],
        ),
      );
      const upgradeAssessment = assessImportMappings({
        imports: candidatesNow.map((candidate) => ({
          candidateId: candidate.id,
          episodeIds: candidate.episodeIds,
        })),
        candidatesById: new Map(candidatesNow.map((candidate) => [candidate.id, candidate])),
        episodesById,
        profilesById,
      }).map(({ candidateId, episodeIds: mappedEpisodeIds, assessment }) => ({
        candidateId,
        relativePath: candidatesNow.find((candidate) => candidate.id === candidateId)?.relativePath,
        episodeIds: mappedEpisodeIds,
        decision: assessment.decision,
        reason: assessment.reason,
      }));

      const details = {
        queueItem: {
          id: queueItem.id,
          title: queueItem.title,
          targetEpisodeIds: queueItem.episodeIds,
          statusMessages: queueItem.statusMessages,
        },
        upgradeAssessment,
        targetEpisodes: episodes.map((episode) => ({
          ...compactEpisode(episode),
          series: episode.series
            ? {
                id: episode.series.id,
                title: episode.series.title,
                qualityProfileId: episode.series.qualityProfileId,
                languageProfileId: episode.series.languageProfileId,
                seriesType: episode.series.seriesType,
              }
            : undefined,
          currentFile: compactEpisodeFile(episode.episodeFile),
        })),
        candidates: getCandidates().map(compactCandidate),
        qualityProfiles: qualityProfiles
          .filter((profile) => profile.id && profileIds.has(profile.id))
          .map(compactQualityProfile),
        customFormats: customFormats
          .filter(
            (format) =>
              params.includeCustomFormatDefinitions ||
              (format.id !== undefined && relevantFormatIds.has(format.id)),
          )
          .map(compactCustomFormat),
      };
      emit?.({
        type: "sonarr",
        itemId: queueItem.id,
        message: `Pi inspected upgrade context for ${episodes.length} episode(s).`,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  return [
    getQueueContextTool,
    parseReleaseTool,
    lookupSeriesTool,
    findEpisodesTool,
    getCandidatesTool,
    getUpgradeContextTool,
  ];
}
