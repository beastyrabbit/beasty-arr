/**
 * Adapts the loose arr client DTOs (everything optional — the arrs' JSON is
 * messy) to the strict sync ports. Records missing identity fields are
 * dropped here so the sync service never sees them.
 */

import type {
  RadarrClient,
  RadarrMovieFileRecord,
  RadarrMovieRecord,
} from "../arr/radarr-client.js";
import type {
  SonarrClient,
  SonarrEpisodeFileRecord,
  SonarrSeriesResource,
} from "../arr/sonarr-client.js";
import type {
  ArrHistoryPageDto,
  ArrLanguageDto,
  ArrQualityDto,
  RadarrMovieDto,
  RadarrMovieFileDto,
  RadarrSyncPort,
  SonarrEpisodeFileDto,
  SonarrSeriesDto,
  SonarrSyncPort,
} from "./arr-ports.js";

function toLanguage(
  value: { id?: number; name?: string } | null | undefined,
): ArrLanguageDto | null {
  if (!value || typeof value.id !== "number") return null;
  return { id: value.id, name: value.name ?? "" };
}

function toLanguages(value: unknown[] | undefined): ArrLanguageDto[] {
  if (!Array.isArray(value)) return [];
  const result: ArrLanguageDto[] = [];
  for (const entry of value) {
    const lang = toLanguage(entry as { id?: number; name?: string });
    if (lang) result.push(lang);
  }
  return result;
}

function toQuality(value: unknown): ArrQualityDto | null {
  if (!value || typeof value !== "object") return null;
  return value as ArrQualityDto;
}

function toSeriesDto(record: SonarrSeriesResource): SonarrSeriesDto | null {
  if (typeof record.id !== "number" || typeof record.title !== "string") return null;
  return {
    id: record.id,
    title: record.title,
    tvdbId: record.tvdbId ?? null,
    imdbId: record.imdbId ?? null,
    year: record.year ?? null,
    status: record.status ?? null,
    seriesType: record.seriesType ?? null,
    originalLanguage: toLanguage(record.originalLanguage),
    monitored: record.monitored ?? false,
    qualityProfileId: record.qualityProfileId ?? null,
    tags: record.tags ?? null,
    images: record.images?.map((i) => ({
      coverType: i.coverType ?? "",
      url: i.url ?? null,
      remoteUrl: i.remoteUrl ?? null,
    })),
    path: record.path ?? null,
  };
}

function toEpisodeFileDto(record: SonarrEpisodeFileRecord): SonarrEpisodeFileDto | null {
  if (typeof record.id !== "number" || typeof record.seriesId !== "number") return null;
  return {
    id: record.id,
    seriesId: record.seriesId,
    languages: toLanguages(record.languages),
    quality: toQuality(record.quality),
    qualityCutoffNotMet: record.qualityCutoffNotMet ?? null,
    languageCutoffNotMet: record.languageCutoffNotMet ?? null,
    customFormatScore: record.customFormatScore ?? null,
    dateAdded: record.dateAdded ?? null,
  };
}

function toMovieFileDto(record: RadarrMovieFileRecord | undefined): RadarrMovieFileDto | null {
  if (!record || typeof record.id !== "number") return null;
  return {
    id: record.id,
    languages: toLanguages(record.languages),
    quality: toQuality(record.quality),
    qualityCutoffNotMet: record.qualityCutoffNotMet ?? null,
    customFormatScore: record.customFormatScore ?? null,
    dateAdded: record.dateAdded ?? null,
  };
}

function toMovieDto(record: RadarrMovieRecord): RadarrMovieDto | null {
  if (typeof record.id !== "number" || typeof record.title !== "string") return null;
  return {
    id: record.id,
    title: record.title,
    tmdbId: record.tmdbId ?? null,
    imdbId: record.imdbId ?? null,
    year: record.year ?? null,
    status: record.status ?? null,
    isAvailable: record.isAvailable ?? null,
    digitalRelease: record.digitalRelease ?? null,
    physicalRelease: record.physicalRelease ?? null,
    originalLanguage: toLanguage(record.originalLanguage),
    monitored: record.monitored ?? false,
    hasFile: record.hasFile ?? false,
    movieFileId: record.movieFileId ?? null,
    movieFile: toMovieFileDto(record.movieFile),
    qualityProfileId: record.qualityProfileId ?? null,
    tags: record.tags ?? null,
    images: record.images?.map((i) => ({
      coverType: i.coverType ?? "",
      url: i.url ?? null,
      remoteUrl: i.remoteUrl ?? null,
    })),
    path: record.path ?? null,
  };
}

function toHistoryPage(
  page: {
    page?: number;
    pageSize?: number;
    totalRecords?: number;
    records?: Array<{
      id: number;
      eventType?: string;
      date?: string;
      episodeId?: number;
      seriesId?: number;
      movieId?: number;
      downloadId?: string;
      sourceTitle?: string;
    }>;
  },
  requested: { page: number; pageSize: number },
): ArrHistoryPageDto {
  return {
    page: page.page ?? requested.page,
    pageSize: page.pageSize ?? requested.pageSize,
    totalRecords: page.totalRecords ?? 0,
    records: (page.records ?? [])
      .filter((r) => typeof r.id === "number" && r.eventType && r.date)
      .map((r) => ({
        id: r.id,
        eventType: r.eventType as string,
        date: r.date as string,
        episodeId: r.episodeId ?? null,
        seriesId: r.seriesId ?? null,
        movieId: r.movieId ?? null,
        downloadId: r.downloadId ?? null,
        sourceTitle: r.sourceTitle ?? null,
      })),
  };
}

export function sonarrSyncPort(client: SonarrClient): SonarrSyncPort {
  return {
    async getSeries() {
      const rows = await client.getSeries();
      return rows.map(toSeriesDto).filter((r): r is SonarrSeriesDto => r !== null);
    },
    async getEpisodes(seriesId: number) {
      const rows = await client.getEpisodes({ seriesId });
      return rows
        .filter(
          (r) =>
            typeof r.id === "number" &&
            typeof r.seasonNumber === "number" &&
            typeof r.episodeNumber === "number",
        )
        .map((r) => ({
          id: r.id as number,
          seriesId: r.seriesId ?? seriesId,
          seasonNumber: r.seasonNumber as number,
          episodeNumber: r.episodeNumber as number,
          absoluteEpisodeNumber: r.absoluteEpisodeNumber ?? null,
          title: r.title ?? null,
          airDateUtc: r.airDateUtc ?? null,
          monitored: r.monitored ?? false,
          hasFile: r.hasFile ?? false,
          episodeFileId: r.episodeFileId ?? null,
        }));
    },
    async getEpisodeFiles(seriesId: number) {
      const rows = await client.getEpisodeFiles(seriesId);
      return rows.map(toEpisodeFileDto).filter((r): r is SonarrEpisodeFileDto => r !== null);
    },
    async getQualityProfiles() {
      const rows = await client.getQualityProfiles();
      return rows
        .filter((r) => typeof r.id === "number")
        .map((r) => ({ ...r, id: r.id as number, name: r.name ?? null }));
    },
    async getHistoryPage(opts) {
      return toHistoryPage(await client.getHistoryPage(opts), opts);
    },
    getQueueSnapshot: () => client.getQueueSnapshot(),
  };
}

export function radarrSyncPort(client: RadarrClient): RadarrSyncPort {
  return {
    async getMovies() {
      const rows = await client.getMovies();
      return rows.map(toMovieDto).filter((r): r is RadarrMovieDto => r !== null);
    },
    async getMovie(id: number) {
      const dto = toMovieDto(await client.getMovie(id));
      if (!dto) throw new Error(`Radarr movie ${id} has no usable id/title`);
      return dto;
    },
    async getQualityProfiles() {
      const rows = await client.getQualityProfiles();
      return rows
        .filter((r) => typeof r.id === "number")
        .map((r) => ({ ...r, id: r.id as number, name: r.name ?? null }));
    },
    async getHistoryPage(opts) {
      return toHistoryPage(await client.getHistoryPage(opts), opts);
    },
    getQueueSnapshot: () => client.getQueueSnapshot(),
  };
}
