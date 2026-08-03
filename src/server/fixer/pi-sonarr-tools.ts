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
} from "../arr/sonarr-client.js";
import { compactCandidate, episodeLabel } from "../arr/sonarr-format.js";

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
    hasFile: episode.hasFile,
    episodeFileId: episode.episodeFileId,
    monitored: episode.monitored,
    label: episodeLabel(episode),
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
    languages: languages.map(valueName).filter(Boolean),
    languageMetadataPresent: hasKnownLanguageMetadata(languages),
    hasGermanAudio: hasGermanAudio(languages),
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
      "Read the current Sonarr queue target, warning messages, target episode ids, and current manual import candidates.",
    promptSnippet: "Use sonarr_get_queue_context to reread the queue target and Sonarr warning.",
    promptGuidelines: [
      "Use sonarr_get_queue_context when you need to re-check the target episode ids or Sonarr warning.",
    ],
    parameters: Type.Object({}),
    executionMode: "parallel" as const,
    async execute() {
      const targetEpisodes = await safeGetTargetEpisodes(client, queueItem);
      rememberEpisodeIds?.(targetEpisodes.flatMap((episode) => (episode.id ? [episode.id] : [])));
      const details = {
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
      "Read-only Sonarr episode lookup for the queue series. Use this to verify season/episode, absolute anime episode numbers, scene numbers, and titles before proposing an import.",
    promptSnippet:
      "Use sonarr_find_episodes to verify Sonarr episode ids, absolute episode numbers, and titles.",
    promptGuidelines: [
      "Use sonarr_find_episodes before resolving unexpected-episode warnings.",
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
        episodes: truncateEpisodes(episodes).map(compactEpisode),
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
      "Required before every final resolution: read current episode files, explicit German-audio flags, quality profile scoring, and custom formats before deciding whether any candidate is safe to import or should be removed.",
    promptSnippet:
      "Use sonarr_get_upgrade_context when Sonarr mentions custom formats, quality profiles, upgrade rejections, or existing files.",
    promptGuidelines: [
      "Call this for every queue analysis before proposing a resolution, even when the only warning mentions sample detection.",
      "A candidate explicitly lacking German must never replace a current file whose hasGermanAudio field is true.",
      "Compare the candidate languages/custom format score with the existing episode file and profile scoring.",
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
      const episodeIds = params.episodeIds?.length ? params.episodeIds : queueItem.episodeIds;
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

      const details = {
        queueItem: {
          id: queueItem.id,
          title: queueItem.title,
          targetEpisodeIds: queueItem.episodeIds,
          statusMessages: queueItem.statusMessages,
        },
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

  return [getQueueContextTool, findEpisodesTool, getCandidatesTool, getUpgradeContextTool];
}
