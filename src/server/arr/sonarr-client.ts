import type {
  ApplyResult,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
  SonarrSystemStatus,
} from "../../shared/fixer-types.js";
import {
  normalizeProposal,
  resolveImportEpisodeIds,
  validateProposalForImport,
} from "../fixer/validation.js";
import { type ArrClientOptions, arrFetch } from "./http-util.js";
import { detectLikelySample } from "./sample.js";
import { episodeLabel } from "./sonarr-format.js";

export class SonarrRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SonarrRequestError";
  }
}

export type ArrPaged<T> = {
  page?: number;
  pageSize?: number;
  totalRecords?: number;
  records?: T[];
};

/** Minimal wanted/missing + wanted/cutoff record — the engine only counts ids. */
export type ArrWantedRecord = { id?: number };

export type ArrQueueStats = { totalRecords: number };

export type ArrCommandBody = { name: string } & Record<string, unknown>;

export type ArrCommandResource = {
  id?: number;
  name?: string;
  commandName?: string;
  status?: string; // queued|started|completed|failed|aborted
  result?: string;
  queued?: string;
  started?: string;
  ended?: string;
  message?: string;
};

export type ArrImage = { coverType?: string; url?: string; remoteUrl?: string };

export function posterUrlFromImages(images: ArrImage[] | undefined): string | undefined {
  const poster = images?.find((image) => image.coverType === "poster");
  return poster?.remoteUrl ?? poster?.url ?? undefined;
}

export type SonarrHistoryRecord = {
  id: number;
  episodeId?: number;
  seriesId?: number;
  sourceTitle?: string;
  languages?: unknown[];
  quality?: unknown;
  date?: string;
  downloadId?: string;
  eventType?: string; // grabbed|downloadFolderImported|episodeFileDeleted|...
  data?: Record<string, unknown>;
};

type SonarrQueueRecord = {
  id: number;
  title?: string;
  size?: number;
  sizeLeft?: number;
  sizeleft?: number;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  outputPath?: string;
  downloadId?: string;
  added?: string;
  seriesId?: number;
  series?: {
    id?: number;
    title?: string;
  };
  episode?: SonarrEpisodeRecord;
  episodes?: SonarrEpisodeRecord[];
  statusMessages?: Array<{ title?: string; messages?: string[] }>;
  errorMessage?: string;
};

export type SonarrEpisodeRecord = {
  id?: number;
  seriesId?: number;
  title?: string;
  airDateUtc?: string;
  episodeFileId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  sceneAbsoluteEpisodeNumber?: number;
  sceneEpisodeNumber?: number;
  sceneSeasonNumber?: number;
  hasFile?: boolean;
  monitored?: boolean;
  episodeFile?: SonarrEpisodeFileRecord;
  series?: SonarrSeriesRecord;
};

export type SonarrSeriesRecord = {
  id?: number;
  title?: string;
  qualityProfileId?: number;
  languageProfileId?: number;
  seriesType?: string;
  path?: string;
};

/** Full series resource from GET /api/v3/series (mirror sync). */
export type SonarrSeriesResource = {
  id?: number;
  title?: string;
  tvdbId?: number;
  imdbId?: string;
  year?: number;
  status?: string; // continuing|ended|upcoming
  seriesType?: string; // standard|anime|daily
  originalLanguage?: { id?: number; name?: string };
  monitored?: boolean;
  qualityProfileId?: number;
  tags?: number[];
  path?: string;
  added?: string;
  images?: ArrImage[];
  seasons?: Array<{ seasonNumber?: number; monitored?: boolean }>;
};

export type SonarrEpisodeFileRecord = {
  id?: number;
  seriesId?: number;
  seasonNumber?: number;
  relativePath?: string;
  path?: string;
  size?: number;
  dateAdded?: string;
  sceneName?: string;
  releaseGroup?: string;
  languages?: unknown[];
  quality?: unknown;
  customFormats?: SonarrCustomFormatSummary[];
  customFormatScore?: number;
  indexerFlags?: number;
  releaseType?: string;
  qualityCutoffNotMet?: boolean;
  languageCutoffNotMet?: boolean;
};

export type SonarrCustomFormatSummary = {
  id?: number;
  name?: string;
};

export type SonarrQualityProfileFormatItem = {
  format?: number;
  name?: string;
  score?: number;
};

export type SonarrQualityProfileItem = {
  id?: number;
  name?: string;
  quality?: { id?: number; name?: string; source?: string; resolution?: number };
  items?: SonarrQualityProfileItem[];
  allowed?: boolean;
};

export type SonarrQualityProfileRecord = {
  id?: number;
  name?: string;
  upgradeAllowed?: boolean;
  cutoff?: number;
  items?: SonarrQualityProfileItem[];
  minFormatScore?: number;
  cutoffFormatScore?: number;
  minUpgradeFormatScore?: number;
  formatItems?: SonarrQualityProfileFormatItem[];
};

export type SonarrCustomFormatRecord = {
  id?: number;
  name?: string;
  includeCustomFormatWhenRenaming?: boolean;
  specifications?: unknown[];
};

type SonarrManualImportRecord = {
  path?: string;
  relativePath?: string;
  folderName?: string;
  name?: string;
  size?: number;
  series?: { id?: number; title?: string };
  seasonNumber?: number;
  episodes?: SonarrEpisodeRecord[];
  quality?: unknown;
  languages?: unknown[];
  releaseGroup?: string;
  customFormats?: SonarrCustomFormatSummary[];
  customFormatScore?: number;
  indexerFlags?: number;
  releaseType?: string;
  rejections?: Array<string | { reason?: string; message?: string }>;
  downloadId?: string;
};

type ManualImportCommandFile = {
  path: string;
  folderName?: string;
  seriesId: number;
  episodeIds: number[];
  quality: unknown;
  languages: unknown[];
  releaseGroup?: string;
  indexerFlags?: number;
  releaseType?: string;
  downloadId?: string;
};

function joinUrl(baseUrl: string, path: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

function appendQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      urlParams.set(key, String(value));
    }
  }
  const query = urlParams.toString();
  return query ? `${path}?${query}` : path;
}

function qualityLabel(quality: unknown): string | undefined {
  if (!quality || typeof quality !== "object") {
    return undefined;
  }
  const record = quality as Record<string, unknown>;
  const nested = record.quality;
  if (nested && typeof nested === "object" && "name" in nested) {
    return String((nested as { name?: unknown }).name ?? "");
  }
  if ("name" in record) {
    return String(record.name ?? "");
  }
  return undefined;
}

function languageLabel(language: unknown): string {
  if (!language || typeof language !== "object") {
    return String(language);
  }
  const record = language as Record<string, unknown>;
  return String(record.name ?? record.language?.toString() ?? JSON.stringify(language));
}

function customFormatLabel(format: SonarrCustomFormatSummary): string {
  return String(format.name ?? format.id ?? "");
}

function rejectionLabel(rejection: string | { reason?: string; message?: string }): string {
  if (typeof rejection === "string") {
    return rejection;
  }
  return rejection.reason ?? rejection.message ?? JSON.stringify(rejection);
}

function normalizedQueueValue(value?: string): string {
  return (value ?? "").replace(/[\s_-]+/g, "").toLowerCase();
}

function numericQueueValue(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function queueSizeLeft(item: { sizeLeft?: number; sizeleft?: number }): number | undefined {
  return numericQueueValue(item.sizeLeft ?? item.sizeleft);
}

export function isInProgressQueueItem(
  item: Pick<QueueItem, "status" | "trackedDownloadState" | "isInProgress">,
): boolean {
  if (item.isInProgress !== undefined) {
    return item.isInProgress;
  }

  const status = normalizedQueueValue(item.status);
  const state = normalizedQueueValue(item.trackedDownloadState);
  return (
    state === "downloading" ||
    state === "importing" ||
    status === "queued" ||
    status === "paused" ||
    status === "downloading" ||
    status === "delay" ||
    status === "downloadclientunavailable" ||
    status === "fallback"
  );
}

function isInProgressQueueRecord(record: SonarrQueueRecord): boolean {
  const sizeLeft = queueSizeLeft(record);
  return isInProgressQueueItem(record) || (typeof sizeLeft === "number" && sizeLeft > 0);
}

export function canLoadManualImportCandidates(
  item: Pick<
    QueueItem,
    "downloadId" | "status" | "trackedDownloadStatus" | "trackedDownloadState" | "isInProgress"
  >,
): boolean {
  if (!item.downloadId || isInProgressQueueItem(item)) {
    return false;
  }

  const status = normalizedQueueValue(item.status);
  const trackedDownloadStatus = normalizedQueueValue(item.trackedDownloadStatus);
  const trackedDownloadState = normalizedQueueValue(item.trackedDownloadState);
  const hasWarning = status === "warning" || trackedDownloadStatus === "warning";
  const isCompletedForImport =
    status === "completed" ||
    status === "warning" ||
    trackedDownloadState === "importblocked" ||
    trackedDownloadState === "importpending";

  return hasWarning && isCompletedForImport;
}

function normalizeQueueRecord(record: SonarrQueueRecord): QueueItem {
  const episodes = record.episodes?.length
    ? record.episodes
    : record.episode
      ? [record.episode]
      : [];
  const episodeIds: number[] = [];
  const absoluteEpisodeNumbers: number[] = [];
  for (const episode of episodes) {
    if (typeof episode.id === "number") {
      episodeIds.push(episode.id);
    }
    if (typeof episode.absoluteEpisodeNumber === "number") {
      absoluteEpisodeNumbers.push(episode.absoluteEpisodeNumber);
    }
  }
  const episodeLabels = episodes.map(episodeLabel);
  const seasonEpisodeParts: string[] = [];
  for (const episode of episodes) {
    if (typeof episode.seasonNumber === "number" && typeof episode.episodeNumber === "number") {
      seasonEpisodeParts.push(
        `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`,
      );
    }
  }
  const seasonEpisode = seasonEpisodeParts.join(", ");
  const statusMessages: string[] = [];
  for (const message of record.statusMessages ?? []) {
    if (message.title) {
      statusMessages.push(message.title);
    }
    for (const statusMessage of message.messages ?? []) {
      if (statusMessage) {
        statusMessages.push(statusMessage);
      }
    }
  }
  if (record.errorMessage) {
    statusMessages.push(record.errorMessage);
  }

  const trackedDownloadStatus = record.trackedDownloadStatus;
  const status = record.status;
  const isInProgress = isInProgressQueueRecord(record);
  const canAnalyze = canLoadManualImportCandidates({
    downloadId: record.downloadId,
    status,
    trackedDownloadStatus,
    trackedDownloadState: record.trackedDownloadState,
    isInProgress,
  });

  return {
    id: record.id,
    service: "sonarr",
    title: record.title ?? record.series?.title ?? `Queue item ${record.id}`,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    downloadId: record.downloadId,
    status,
    trackedDownloadStatus,
    trackedDownloadState: record.trackedDownloadState,
    isInProgress,
    size: record.size,
    outputPath: record.outputPath,
    episodeIds,
    absoluteEpisodeNumbers,
    episodeLabels,
    seasonEpisode: seasonEpisode || undefined,
    statusMessages,
    canAnalyze,
    addedAt: record.added,
  };
}

function normalizeManualImportRecord(
  record: SonarrManualImportRecord,
  index: number,
): ManualImportCandidate {
  const episodes = record.episodes ?? [];
  const episodeIds: number[] = [];
  const absoluteEpisodeNumbers: number[] = [];
  for (const episode of episodes) {
    if (typeof episode.id === "number") {
      episodeIds.push(episode.id);
    }
    if (typeof episode.absoluteEpisodeNumber === "number") {
      absoluteEpisodeNumbers.push(episode.absoluteEpisodeNumber);
    }
  }
  const sample = detectLikelySample({
    path: record.path,
    relativePath: record.relativePath,
    name: record.name,
    size: record.size,
  });

  return {
    id: `candidate_${index + 1}`,
    service: "sonarr",
    path: record.path ?? "",
    relativePath: record.relativePath,
    folderName: record.folderName,
    name: record.name,
    size: record.size,
    seriesId: record.series?.id,
    seriesTitle: record.series?.title,
    seasonNumber: record.seasonNumber,
    episodeIds,
    absoluteEpisodeNumbers,
    episodeLabels: episodes.map(episodeLabel),
    quality: record.quality,
    qualityLabel: qualityLabel(record.quality),
    languages: record.languages ?? [],
    languageLabels: (record.languages ?? []).map(languageLabel),
    releaseGroup: record.releaseGroup,
    customFormats: record.customFormats ?? [],
    customFormatLabels: (record.customFormats ?? []).map(customFormatLabel).filter(Boolean),
    customFormatScore: record.customFormatScore,
    indexerFlags: record.indexerFlags,
    releaseType: record.releaseType,
    rejections: (record.rejections ?? []).map(rejectionLabel),
    downloadId: record.downloadId,
    ...sample,
  };
}

function normalizeManualImportRecords(
  records: SonarrManualImportRecord[],
): ManualImportCandidate[] {
  const candidates: ManualImportCandidate[] = [];
  for (const [index, record] of records.entries()) {
    const candidate = normalizeManualImportRecord(record, index);
    if (candidate.path) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export class SonarrClient {
  constructor(private readonly options: ArrClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await arrFetch(
      joinUrl(this.options.baseUrl, path),
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.options.apiKey,
          ...(init.headers ?? {}),
        },
      },
      this.options,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SonarrRequestError(
        `Sonarr ${response.status} ${response.statusText}: ${text || path}`,
        response.status,
        response.statusText,
        text,
        path,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  async getSystemStatus(): Promise<SonarrSystemStatus> {
    return this.request<SonarrSystemStatus>("/api/v3/system/status");
  }

  async getSeries(): Promise<SonarrSeriesResource[]> {
    return this.request<SonarrSeriesResource[]>("/api/v3/series");
  }

  async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFileRecord[]> {
    return this.request<SonarrEpisodeFileRecord[]>(
      appendQuery("/api/v3/episodefile", { seriesId }),
    );
  }

  async getQualityProfiles(): Promise<SonarrQualityProfileRecord[]> {
    return this.request<SonarrQualityProfileRecord[]>("/api/v3/qualityprofile");
  }

  async getCustomFormats(): Promise<SonarrCustomFormatRecord[]> {
    return this.request<SonarrCustomFormatRecord[]>("/api/v3/customformat");
  }

  async getHistoryPage({
    page = 1,
    pageSize = 100,
    sortKey = "date",
    sortDirection = "descending",
  }: {
    page?: number;
    pageSize?: number;
    sortKey?: string;
    sortDirection?: "ascending" | "descending";
  } = {}): Promise<ArrPaged<SonarrHistoryRecord>> {
    return this.request<ArrPaged<SonarrHistoryRecord>>(
      appendQuery("/api/v3/history", { page, pageSize, sortKey, sortDirection }),
    );
  }

  async getQueueStats(): Promise<ArrQueueStats> {
    const response = await this.request<ArrPaged<unknown>>(
      appendQuery("/api/v3/queue", { page: 1, pageSize: 1 }),
    );
    return { totalRecords: response?.totalRecords ?? 0 };
  }

  /** EpisodeSearch/SeasonSearch/SeriesSearch payloads etc. */
  async sendCommand(body: ArrCommandBody): Promise<ArrCommandResource> {
    return this.request<ArrCommandResource>("/api/v3/command", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getCommand(id: number): Promise<ArrCommandResource> {
    return this.request<ArrCommandResource>(`/api/v3/command/${id}`);
  }

  async getWantedMissing({
    page = 1,
    pageSize = 1,
  }: {
    page?: number;
    pageSize?: number;
  } = {}): Promise<ArrPaged<ArrWantedRecord>> {
    return this.request<ArrPaged<ArrWantedRecord>>(
      appendQuery("/api/v3/wanted/missing", { page, pageSize }),
    );
  }

  async getWantedCutoff({
    page = 1,
    pageSize = 1,
  }: {
    page?: number;
    pageSize?: number;
  } = {}): Promise<ArrPaged<ArrWantedRecord>> {
    return this.request<ArrPaged<ArrWantedRecord>>(
      appendQuery("/api/v3/wanted/cutoff", { page, pageSize }),
    );
  }

  async getEpisodes({
    seriesId,
    seasonNumber,
    episodeIds,
    includeSeries = false,
    includeEpisodeFile = false,
  }: {
    seriesId?: number;
    seasonNumber?: number;
    episodeIds?: number[];
    includeSeries?: boolean;
    includeEpisodeFile?: boolean;
  }): Promise<SonarrEpisodeRecord[]> {
    const params = new URLSearchParams();
    if (seriesId !== undefined) {
      params.set("seriesId", String(seriesId));
    }
    if (seasonNumber !== undefined) {
      params.set("seasonNumber", String(seasonNumber));
    }
    for (const episodeId of episodeIds ?? []) {
      params.append("episodeIds", String(episodeId));
    }
    params.set("includeSeries", String(includeSeries));
    params.set("includeEpisodeFile", String(includeEpisodeFile));
    return this.request<SonarrEpisodeRecord[]>(`/api/v3/episode?${params.toString()}`);
  }

  async listQueue(): Promise<QueueItem[]> {
    const response = await this.request<ArrPaged<SonarrQueueRecord>>(
      appendQuery("/api/v3/queue", {
        page: 1,
        pageSize: 500,
        sortKey: "timeleft",
        sortDirection: "ascending",
        includeUnknownSeriesItems: true,
        includeSeries: true,
        includeEpisode: true,
      }),
    );
    return (response.records ?? [])
      .map(normalizeQueueRecord)
      .filter((queueItem) => !queueItem.isInProgress);
  }

  async getManualImportCandidates(queueItem: QueueItem): Promise<ManualImportCandidate[]> {
    if (!canLoadManualImportCandidates(queueItem)) {
      return [];
    }
    const downloadId = queueItem.downloadId;
    if (!downloadId) {
      return [];
    }

    const loadFromFolder = async (): Promise<ManualImportCandidate[]> => {
      const path = appendQuery("/api/v3/manualimport", {
        folder: queueItem.outputPath,
        downloadId,
        filterExistingFiles: false,
      });
      const records = await this.request<SonarrManualImportRecord[]>(path);
      return normalizeManualImportRecords(records);
    };

    try {
      const records = await this.request<SonarrManualImportRecord[]>(
        appendQuery("/api/v3/manualimport", {
          downloadId,
          filterExistingFiles: false,
        }),
      );
      const candidates = normalizeManualImportRecords(records);
      if (candidates.length === 0 && queueItem.outputPath) {
        return loadFromFolder();
      }
      return candidates;
    } catch (error) {
      if (!(error instanceof SonarrRequestError) || ![404, 405].includes(error.status)) {
        throw error;
      }
      if (!queueItem.outputPath) {
        throw error;
      }
      return loadFromFolder();
    }
  }

  private async getKnownEpisodeIds(
    queueItem: QueueItem,
    candidates: ManualImportCandidate[],
  ): Promise<number[]> {
    const ids = new Set<number>([
      ...queueItem.episodeIds,
      ...candidates.flatMap((candidate) => candidate.episodeIds),
    ]);
    if (queueItem.seriesId) {
      try {
        for (const episode of await this.getEpisodes({ seriesId: queueItem.seriesId })) {
          if (typeof episode.id === "number") {
            ids.add(episode.id);
          }
        }
      } catch {
        // Validation can still use the queue and candidate ids if the wider series lookup fails.
      }
    }
    return [...ids];
  }

  async applyImportProposal(
    queueItem: QueueItem,
    candidates: ManualImportCandidate[],
    proposal: ResolutionProposal,
  ): Promise<ApplyResult> {
    const normalizedProposal = normalizeProposal(proposal);
    const knownEpisodeIds = await this.getKnownEpisodeIds(queueItem, candidates);
    const validation = validateProposalForImport(
      candidates,
      normalizedProposal,
      queueItem,
      knownEpisodeIds,
    );
    if (!validation.ok) {
      return {
        ok: false,
        message: validation.issues.map((issue) => issue.message).join(" "),
      };
    }

    if (normalizedProposal.action !== "import_candidates") {
      return {
        ok: false,
        message: `Proposal action ${normalizedProposal.action} is not an import.`,
      };
    }

    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const languageDowngrades = await this.findGermanAudioDowngrades(normalizedProposal, byId);
    if (languageDowngrades.length > 0) {
      return { ok: false, message: languageDowngrades.join(" ") };
    }

    const files: ManualImportCommandFile[] = normalizedProposal.selectedCandidateIds.map(
      (candidateId) => {
        const candidate = byId.get(candidateId);
        if (!candidate) {
          throw new Error(`Unknown candidate id ${candidateId}`);
        }

        if (!candidate.seriesId || !candidate.quality || candidate.languages.length === 0) {
          throw new Error(`Candidate ${candidateId} is missing Sonarr import fields.`);
        }

        return {
          path: candidate.path,
          folderName: candidate.folderName,
          seriesId: candidate.seriesId,
          episodeIds: resolveImportEpisodeIds(normalizedProposal, candidateId),
          quality: candidate.quality,
          languages: candidate.languages,
          releaseGroup: candidate.releaseGroup,
          indexerFlags: candidate.indexerFlags,
          releaseType: candidate.releaseType,
          downloadId: candidate.downloadId ?? queueItem.downloadId,
        };
      },
    );

    const command = await this.request<{ id?: number }>("/api/v3/command", {
      method: "POST",
      body: JSON.stringify({
        name: "ManualImport",
        files,
        importMode: "auto",
        priority: "high",
      }),
    });

    return {
      ok: true,
      commandId: command.id,
      message: command.id
        ? `Started Sonarr ManualImport command ${command.id}.`
        : "Started Sonarr ManualImport.",
    };
  }

  private async findGermanAudioDowngrades(
    proposal: ResolutionProposal,
    candidatesById: Map<string, ManualImportCandidate>,
  ): Promise<string[]> {
    const hasGerman = (labels: string[]) =>
      labels.some((label) => label.trim().toLowerCase() === "german");
    const nonGermanImports = proposal.selectedImports.filter((selectedImport) => {
      const candidate = candidatesById.get(selectedImport.candidateId);
      return candidate !== undefined && !hasGerman(candidate.languageLabels);
    });
    const episodeIds = [
      ...new Set(nonGermanImports.flatMap((selectedImport) => selectedImport.episodeIds)),
    ];
    if (episodeIds.length === 0) {
      return [];
    }
    let episodes: SonarrEpisodeRecord[];
    try {
      episodes = await this.getEpisodes({ episodeIds, includeEpisodeFile: true });
    } catch {
      // If Sonarr is unreachable the ManualImport command below would fail as well.
      return [];
    }
    const germanFilesByEpisodeId = new Map<number, string>();
    for (const episode of episodes) {
      const fileLanguages = (episode.episodeFile?.languages ?? []).map(languageLabel);
      if (episode.id !== undefined && hasGerman(fileLanguages)) {
        germanFilesByEpisodeId.set(
          episode.id,
          episode.episodeFile?.relativePath ?? episode.episodeFile?.path ?? `episode ${episode.id}`,
        );
      }
    }
    return nonGermanImports.flatMap((selectedImport) => {
      const affected = selectedImport.episodeIds.filter((episodeId) =>
        germanFilesByEpisodeId.has(episodeId),
      );
      if (affected.length === 0) {
        return [];
      }
      const existing = affected
        .map((episodeId) => germanFilesByEpisodeId.get(episodeId))
        .join(", ");
      return [
        `Blocked language downgrade: candidate ${selectedImport.candidateId} has no German language but would replace German-audio file(s) ${existing}. Import manually in Sonarr if the replacement is intended.`,
      ];
    });
  }

  async removeQueueItem(queueItemId: number, options: QueueRemovalOptions): Promise<ApplyResult> {
    await this.request<void>(
      appendQuery(`/api/v3/queue/${queueItemId}`, {
        removeFromClient: options.removeFromClient,
        blocklist: options.blocklist,
        skipRedownload: options.skipRedownload,
        changeCategory: options.changeCategory,
      }),
      { method: "DELETE" },
    );
    return { ok: true, message: `Removed queue item ${queueItemId}.` };
  }
}
