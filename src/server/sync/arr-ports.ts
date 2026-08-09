/**
 * Narrow, structurally-typed views of the Sonarr/Radarr clients — exactly the
 * fields the sync service consumes (aligned with the arr v3 APIs and our
 * mirror schema). The real clients in src/server/arr/ satisfy these ports via
 * structural typing; tests inject fakes.
 */

export type ArrLanguageDto = { id: number; name: string };

export type ArrImageDto = {
  coverType: string;
  url?: string | null;
  remoteUrl?: string | null;
};

export type ArrQualityDto = {
  quality?: { id?: number; name?: string | null } | null;
};

export type SonarrSeriesDto = {
  id: number;
  title: string;
  tvdbId?: number | null;
  imdbId?: string | null;
  year?: number | null;
  status?: string | null;
  seriesType?: string | null;
  originalLanguage?: ArrLanguageDto | null;
  monitored: boolean;
  qualityProfileId?: number | null;
  tags?: number[] | null;
  images?: ArrImageDto[] | null;
  path?: string | null;
};

export type SonarrEpisodeDto = {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number | null;
  title?: string | null;
  /** ISO timestamp; absent/null = TBA. */
  airDateUtc?: string | null;
  monitored: boolean;
  hasFile: boolean;
  episodeFileId?: number | null;
};

export type SonarrEpisodeFileDto = {
  id: number;
  seriesId: number;
  languages?: ArrLanguageDto[] | null;
  quality?: ArrQualityDto | null;
  qualityCutoffNotMet?: boolean | null;
  languageCutoffNotMet?: boolean | null;
  customFormatScore?: number | null;
  /** ISO timestamp the file was imported. */
  dateAdded?: string | null;
};

export type RadarrMovieFileDto = {
  id: number;
  languages?: ArrLanguageDto[] | null;
  quality?: ArrQualityDto | null;
  qualityCutoffNotMet?: boolean | null;
  customFormatScore?: number | null;
  dateAdded?: string | null;
};

export type RadarrMovieDto = {
  id: number;
  title: string;
  tmdbId?: number | null;
  imdbId?: string | null;
  year?: number | null;
  status?: string | null;
  isAvailable?: boolean | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  originalLanguage?: ArrLanguageDto | null;
  monitored: boolean;
  hasFile: boolean;
  movieFileId?: number | null;
  /** Radarr inlines the file on the movie resource. */
  movieFile?: RadarrMovieFileDto | null;
  qualityProfileId?: number | null;
  tags?: number[] | null;
  images?: ArrImageDto[] | null;
  path?: string | null;
};

export type QualityProfileDto = {
  id: number;
  name?: string | null;
  upgradeAllowed?: boolean | null;
  cutoffFormatScore?: number | null;
  minFormatScore?: number | null;
} & Record<string, unknown>;

export type ArrHistoryRecordDto = {
  id: number;
  /** grabbed | downloadFolderImported | episodeFileDeleted | movieFileDeleted | ... */
  eventType: string;
  /** ISO timestamp. */
  date: string;
  episodeId?: number | null;
  seriesId?: number | null;
  movieId?: number | null;
  downloadId?: string | null;
  sourceTitle?: string | null;
};

export type ArrHistoryPageDto = {
  page: number;
  pageSize: number;
  totalRecords: number;
  /** Contract: sorted by date descending (newest first) — the arr default. */
  records: ArrHistoryRecordDto[];
};

export type ArrHistoryPager = {
  getHistoryPage(opts: { page: number; pageSize: number }): Promise<ArrHistoryPageDto>;
};

export type ArrQueueSnapshotDto = {
  downloadIds: Set<string>;
  targetIds: Set<number>;
};

export interface SonarrSyncPort extends ArrHistoryPager {
  getSeries(): Promise<SonarrSeriesDto[]>;
  getEpisodes(seriesId: number): Promise<SonarrEpisodeDto[]>;
  getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFileDto[]>;
  getQualityProfiles(): Promise<QualityProfileDto[]>;
  getQueueSnapshot(): Promise<ArrQueueSnapshotDto>;
}

export interface RadarrSyncPort extends ArrHistoryPager {
  getMovies(): Promise<RadarrMovieDto[]>;
  getMovie(id: number): Promise<RadarrMovieDto>;
  getQualityProfiles(): Promise<QualityProfileDto[]>;
  getQueueSnapshot(): Promise<ArrQueueSnapshotDto>;
}
