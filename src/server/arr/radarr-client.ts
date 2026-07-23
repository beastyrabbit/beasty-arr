import type {
  ApplyResult,
  ArrSystemStatus,
  ManualImportCandidate,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import {
  normalizeProposal,
  resolveImportMovieId,
  validateProposalForImport,
} from "../fixer/validation.js";
import { type ArrClientOptions, arrFetch } from "./http-util.js";
import { detectLikelySample } from "./sample.js";
import {
  type ArrCommandBody,
  type ArrCommandResource,
  type ArrImage,
  type ArrPaged,
  type ArrQueueStats,
  type ArrWantedRecord,
  canLoadManualImportCandidates,
  isInProgressQueueItem,
} from "./sonarr-client.js";

export class RadarrRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "RadarrRequestError";
  }
}

export type RadarrCustomFormatSummary = {
  id?: number;
  name?: string;
};

export type RadarrMovieFileRecord = {
  id?: number;
  movieId?: number;
  relativePath?: string;
  path?: string;
  size?: number;
  dateAdded?: string;
  sceneName?: string;
  releaseGroup?: string;
  edition?: string;
  languages?: unknown[];
  quality?: unknown;
  customFormats?: RadarrCustomFormatSummary[];
  customFormatScore?: number;
  indexerFlags?: number;
  qualityCutoffNotMet?: boolean;
};

export type RadarrMovieRecord = {
  id?: number;
  title?: string;
  originalTitle?: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
  path?: string;
  qualityProfileId?: number;
  hasFile?: boolean;
  movieFileId?: number;
  monitored?: boolean;
  movieFile?: RadarrMovieFileRecord;
  // Mirror-sync fields (GET /api/v3/movie):
  status?: string; // announced|inCinemas|released
  isAvailable?: boolean;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  originalLanguage?: { id?: number; name?: string };
  tags?: number[];
  images?: ArrImage[];
  added?: string;
};

export type RadarrHistoryRecord = {
  id: number;
  movieId?: number;
  sourceTitle?: string;
  languages?: unknown[];
  quality?: unknown;
  date?: string;
  downloadId?: string;
  eventType?: string; // grabbed|downloadFolderImported|movieFileDeleted|...
  data?: Record<string, unknown>;
};

export type RadarrQualityProfileItem = {
  id?: number;
  name?: string;
  quality?: { id?: number; name?: string; source?: string; resolution?: number };
  items?: RadarrQualityProfileItem[];
  allowed?: boolean;
};

export type RadarrQualityProfileRecord = {
  id?: number;
  name?: string;
  upgradeAllowed?: boolean;
  cutoff?: number;
  items?: RadarrQualityProfileItem[];
  minFormatScore?: number;
  cutoffFormatScore?: number;
  minUpgradeFormatScore?: number;
  formatItems?: Array<{ format?: number; name?: string; score?: number }>;
};

export type RadarrCustomFormatRecord = {
  id?: number;
  name?: string;
  includeCustomFormatWhenRenaming?: boolean;
  specifications?: unknown[];
};

type RadarrQueueRecord = {
  id: number;
  movieId?: number;
  movie?: RadarrMovieRecord;
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
  statusMessages?: Array<{ title?: string; messages?: string[] }>;
  errorMessage?: string;
};

type RadarrManualImportRecord = {
  path?: string;
  relativePath?: string;
  folderName?: string;
  name?: string;
  size?: number;
  movie?: RadarrMovieRecord;
  quality?: unknown;
  languages?: unknown[];
  releaseGroup?: string;
  customFormats?: RadarrCustomFormatSummary[];
  customFormatScore?: number;
  indexerFlags?: number;
  rejections?: Array<string | { reason?: string; message?: string }>;
  downloadId?: string;
};

type ManualImportCommandFile = {
  path: string;
  folderName?: string;
  movieId: number;
  quality: unknown;
  languages: unknown[];
  releaseGroup?: string;
  indexerFlags?: number;
  downloadId?: string;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
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

function valueName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return String(value ?? "");
  }
  const record = value as Record<string, unknown>;
  return String(record.name ?? record.id ?? "");
}

function qualityLabel(quality: unknown): string | undefined {
  if (!quality || typeof quality !== "object") {
    return undefined;
  }
  const record = quality as Record<string, unknown>;
  return valueName(record.quality ?? quality) || undefined;
}

function rejectionLabel(rejection: string | { reason?: string; message?: string }): string {
  return typeof rejection === "string"
    ? rejection
    : (rejection.reason ?? rejection.message ?? JSON.stringify(rejection));
}

function isInProgressQueueRecord(record: RadarrQueueRecord): boolean {
  const sizeLeft = Number(record.sizeLeft ?? record.sizeleft);
  return isInProgressQueueItem(record) || (Number.isFinite(sizeLeft) && sizeLeft > 0);
}

function movieLabel(movie?: RadarrMovieRecord): string {
  if (!movie) {
    return "Unknown movie";
  }
  return [movie.title, movie.year ? `(${movie.year})` : undefined].filter(Boolean).join(" ");
}

function normalizeQueueRecord(record: RadarrQueueRecord): QueueItem {
  const movieId = record.movieId ?? record.movie?.id;
  const statusMessages: string[] = [];
  for (const message of record.statusMessages ?? []) {
    if (message.title) {
      statusMessages.push(message.title);
    }
    statusMessages.push(...(message.messages ?? []).filter(Boolean));
  }
  if (record.errorMessage) {
    statusMessages.push(record.errorMessage);
  }
  const isInProgress = isInProgressQueueRecord(record);
  const queueItem: QueueItem = {
    id: record.id,
    service: "radarr",
    title: record.title ?? movieLabel(record.movie) ?? `Queue item ${record.id}`,
    seriesId: movieId,
    seriesTitle: record.movie?.title,
    movieId,
    movieTitle: record.movie?.title,
    movieYear: record.movie?.year,
    downloadId: record.downloadId,
    status: record.status,
    trackedDownloadStatus: record.trackedDownloadStatus,
    trackedDownloadState: record.trackedDownloadState,
    isInProgress,
    size: record.size,
    outputPath: record.outputPath,
    episodeIds: movieId ? [movieId] : [],
    absoluteEpisodeNumbers: [],
    episodeLabels: record.movie ? [movieLabel(record.movie)] : [],
    seasonEpisode: record.movie?.year ? String(record.movie.year) : undefined,
    statusMessages,
    canAnalyze: false,
    addedAt: record.added,
  };
  queueItem.canAnalyze = canLoadManualImportCandidates(queueItem);
  return queueItem;
}

function normalizeManualImportRecord(
  record: RadarrManualImportRecord,
  index: number,
): ManualImportCandidate {
  const movieId = record.movie?.id;
  const sample = detectLikelySample({
    path: record.path,
    relativePath: record.relativePath,
    name: record.name,
    size: record.size,
  });
  return {
    id: `candidate_${index + 1}`,
    service: "radarr",
    path: record.path ?? "",
    relativePath: record.relativePath,
    folderName: record.folderName,
    name: record.name,
    size: record.size,
    seriesId: movieId,
    seriesTitle: record.movie?.title,
    movieId,
    movieTitle: record.movie?.title,
    movieYear: record.movie?.year,
    episodeIds: movieId ? [movieId] : [],
    absoluteEpisodeNumbers: [],
    episodeLabels: record.movie ? [movieLabel(record.movie)] : [],
    quality: record.quality,
    qualityLabel: qualityLabel(record.quality),
    languages: record.languages ?? [],
    languageLabels: (record.languages ?? []).map(valueName).filter(Boolean),
    releaseGroup: record.releaseGroup,
    customFormats: record.customFormats ?? [],
    customFormatLabels: (record.customFormats ?? []).map(valueName).filter(Boolean),
    customFormatScore: record.customFormatScore,
    indexerFlags: record.indexerFlags,
    rejections: (record.rejections ?? []).map(rejectionLabel),
    downloadId: record.downloadId,
    ...sample,
  };
}

function normalizeManualImportRecords(
  records: RadarrManualImportRecord[],
): ManualImportCandidate[] {
  return records.map(normalizeManualImportRecord).filter((candidate) => candidate.path.length > 0);
}

export class RadarrClient {
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
      throw new RadarrRequestError(
        `Radarr ${response.status} ${response.statusText}: ${text || path}`,
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
    return text.trim() ? (JSON.parse(text) as T) : (undefined as T);
  }

  async getSystemStatus(): Promise<ArrSystemStatus> {
    return this.request<ArrSystemStatus>("/api/v3/system/status");
  }

  async getMovies(): Promise<RadarrMovieRecord[]> {
    return this.request<RadarrMovieRecord[]>("/api/v3/movie");
  }

  async getMovie(movieId: number): Promise<RadarrMovieRecord> {
    return this.request<RadarrMovieRecord>(`/api/v3/movie/${movieId}`);
  }

  async getQualityProfiles(): Promise<RadarrQualityProfileRecord[]> {
    return this.request<RadarrQualityProfileRecord[]>("/api/v3/qualityprofile");
  }

  async getCustomFormats(): Promise<RadarrCustomFormatRecord[]> {
    return this.request<RadarrCustomFormatRecord[]>("/api/v3/customformat");
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
  } = {}): Promise<ArrPaged<RadarrHistoryRecord>> {
    return this.request<ArrPaged<RadarrHistoryRecord>>(
      appendQuery("/api/v3/history", { page, pageSize, sortKey, sortDirection }),
    );
  }

  async getQueueStats(): Promise<ArrQueueStats> {
    const response = await this.request<ArrPaged<unknown>>(
      appendQuery("/api/v3/queue", { page: 1, pageSize: 1 }),
    );
    return { totalRecords: response?.totalRecords ?? 0 };
  }

  /** MoviesSearch payloads etc. */
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

  async listQueue(): Promise<QueueItem[]> {
    const response = await this.request<ArrPaged<RadarrQueueRecord>>(
      appendQuery("/api/v3/queue", {
        page: 1,
        pageSize: 500,
        sortKey: "timeleft",
        sortDirection: "ascending",
        includeUnknownMovieItems: true,
        includeMovie: true,
      }),
    );
    return (response.records ?? [])
      .map(normalizeQueueRecord)
      .filter((queueItem) => !queueItem.isInProgress);
  }

  async getManualImportCandidates(queueItem: QueueItem): Promise<ManualImportCandidate[]> {
    if (!canLoadManualImportCandidates(queueItem) || !queueItem.downloadId) {
      return [];
    }
    const params = {
      downloadId: queueItem.downloadId,
      filterExistingFiles: false,
    };
    const loadFromFolder = async () =>
      normalizeManualImportRecords(
        await this.request<RadarrManualImportRecord[]>(
          appendQuery("/api/v3/manualimport", { folder: queueItem.outputPath, ...params }),
        ),
      );
    try {
      const candidates = normalizeManualImportRecords(
        await this.request<RadarrManualImportRecord[]>(appendQuery("/api/v3/manualimport", params)),
      );
      return candidates.length === 0 && queueItem.outputPath ? loadFromFolder() : candidates;
    } catch (error) {
      if (
        !(error instanceof RadarrRequestError) ||
        ![404, 405].includes(error.status) ||
        !queueItem.outputPath
      ) {
        throw error;
      }
      return loadFromFolder();
    }
  }

  async applyImportProposal(
    queueItem: QueueItem,
    candidates: ManualImportCandidate[],
    proposal: ResolutionProposal,
  ): Promise<ApplyResult> {
    const normalizedProposal = normalizeProposal(proposal);
    const validation = validateProposalForImport(candidates, normalizedProposal, queueItem);
    if (!validation.ok) {
      return { ok: false, message: validation.issues.map((issue) => issue.message).join(" ") };
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
        const movieId = resolveImportMovieId(normalizedProposal, candidateId);
        if (!movieId || !candidate.quality || candidate.languages.length === 0) {
          throw new Error(`Candidate ${candidateId} is missing Radarr import fields.`);
        }
        return {
          path: candidate.path,
          folderName: candidate.folderName,
          movieId,
          quality: candidate.quality,
          languages: candidate.languages,
          releaseGroup: candidate.releaseGroup,
          indexerFlags: candidate.indexerFlags,
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
        ? `Started Radarr ManualImport command ${command.id}.`
        : "Started Radarr ManualImport.",
    };
  }

  private async findGermanAudioDowngrades(
    proposal: ResolutionProposal,
    candidatesById: Map<string, ManualImportCandidate>,
  ): Promise<string[]> {
    const hasGerman = (labels: string[]) =>
      labels.some((label) => label.trim().toLowerCase() === "german");
    const messages: string[] = [];
    for (const selectedImport of proposal.selectedImports) {
      const candidate = candidatesById.get(selectedImport.candidateId);
      if (!candidate || hasGerman(candidate.languageLabels)) {
        continue;
      }
      const movieId =
        resolveImportMovieId(proposal, selectedImport.candidateId) ?? candidate.movieId;
      if (!movieId) {
        continue;
      }
      let movie: RadarrMovieRecord;
      try {
        movie = await this.getMovie(movieId);
      } catch {
        // If Radarr is unreachable the ManualImport command below would fail as well.
        continue;
      }
      const fileLanguages = (movie.movieFile?.languages ?? []).map(valueName);
      if (hasGerman(fileLanguages)) {
        const existing =
          movie.movieFile?.relativePath ?? movie.movieFile?.path ?? `the file for movie ${movieId}`;
        messages.push(
          `Blocked language downgrade: candidate ${selectedImport.candidateId} has no German language but would replace German-audio file ${existing}. Import manually in Radarr if the replacement is intended.`,
        );
      }
    }
    return messages;
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
