/**
 * Sanitized captures from real dry-run analyses against the connected ARR
 * instances on 2026-08-03. Keep these fixtures representative of the payloads
 * the resolver actually receives; synthetic fixtures belong only in tests for
 * states that cannot be captured safely/reliably from the live queue.
 */
import type { ManualImportCandidate, QueueItem } from "../../shared/fixer-types.js";
import type { RadarrMovieRecord } from "../arr/radarr-client.js";
import type { SonarrEpisodeRecord } from "../arr/sonarr-client.js";

export function realMentalistQueueItem(): QueueItem {
  return {
    id: 29_107_916,
    service: "sonarr",
    title: "The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE",
    seriesId: 318,
    seriesTitle: "The Mentalist",
    downloadId: "ce8ab632-70f5-4854-a5e7-5b1e0c17dae7",
    status: "completed",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importPending",
    isInProgress: false,
    size: 2_193_770_684,
    outputPath:
      "/data/usenet/complete/tv/The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE/",
    episodeIds: [25_505],
    absoluteEpisodeNumbers: [23],
    episodeLabels: ["S01E23 - Red John's Footsteps"],
    seasonEpisode: "S01E23",
    statusMessages: [
      "The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE",
      "Not a Custom Format upgrade for existing episode file(s). New: [1080p, AMZN, Repack/Proper, v2, x265 (HD), x265 (no HDR/DV)] (57) do not improve on Existing: [1080p, German DL (undefined), Language: Not Original] (11050)",
    ],
    canAnalyze: true,
    addedAt: "2026-08-02T22:56:22Z",
  };
}

export function realMentalistCandidate(): ManualImportCandidate {
  return {
    id: "candidate_1",
    service: "sonarr",
    path: "/data/usenet/complete/tv/The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE/The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE.mkv",
    relativePath: "The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE.mkv",
    folderName: "The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE",
    name: "The.Mentalist.S01E23.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.265-NORViNE",
    size: 2_121_815_428,
    seriesId: 318,
    seriesTitle: "The Mentalist",
    seasonNumber: 1,
    episodeIds: [25_505],
    absoluteEpisodeNumbers: [23],
    episodeLabels: ["S01E23 - Red John's Footsteps"],
    quality: {
      quality: { id: 3, name: "WEBDL-1080p", source: "web", resolution: 1080 },
      revision: { version: 2, real: 0, isRepack: true },
    },
    qualityLabel: "WEBDL-1080p",
    languages: [{ id: 1, name: "English" }],
    languageLabels: ["English"],
    releaseGroup: "NORViNE",
    customFormats: [
      { id: 310, name: "1080p" },
      { id: 271, name: "AMZN" },
      { id: 273, name: "Repack/Proper" },
      { id: 341, name: "v2" },
      { id: 270, name: "x265 (HD)" },
      { id: 324, name: "x265 (no HDR/DV)" },
    ],
    customFormatLabels: ["1080p", "AMZN", "Repack/Proper", "v2", "x265 (HD)", "x265 (no HDR/DV)"],
    customFormatScore: 57,
    indexerFlags: 0,
    releaseType: "singleEpisode",
    rejections: [
      "Not a Custom Format upgrade for existing episode file(s). New: [1080p, AMZN, Repack/Proper, v2, x265 (HD), x265 (no HDR/DV)] (57) do not improve on Existing: [1080p, German DL (undefined), Language: Not Original] (11050)",
    ],
    downloadId: "ce8ab632-70f5-4854-a5e7-5b1e0c17dae7",
    isLikelySample: false,
  };
}

export function realMentalistExistingEpisode(): SonarrEpisodeRecord {
  return {
    id: 25_505,
    seriesId: 318,
    title: "Red John's Footsteps",
    seasonNumber: 1,
    episodeNumber: 23,
    absoluteEpisodeNumber: 23,
    hasFile: true,
    episodeFile: {
      languages: [{ id: 4, name: "German" }],
      customFormatScore: 11_050,
    },
    series: { id: 318, title: "The Mentalist" },
  };
}

export function realOnePieceQueueItem(): QueueItem {
  return {
    id: 20_804_907,
    service: "sonarr",
    title: "One.Piece.1999.S03.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX",
    seriesId: 77,
    seriesTitle: "One Piece",
    downloadId: "4306bdf9-116f-4017-a548-6ad7f7edd34f",
    status: "completed",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importBlocked",
    isInProgress: false,
    size: 15_100_646_004,
    outputPath:
      "/data/usenet/complete/tv/One.Piece.1999.S03.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX",
    episodeIds: [4_904],
    absoluteEpisodeNumbers: [31],
    episodeLabels: ["S03E01 - The Worst Man in the Eastern Seas! Fishman Pirate Arlong!"],
    seasonEpisode: "S03E01",
    statusMessages: [
      "One or more episodes expected in this release were not imported or missing from the release",
      "One.Piece.1999.S03E78.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX.mkv",
      "Invalid season or episode",
    ],
    canAnalyze: true,
    addedAt: "2026-08-01T09:55:52Z",
  };
}

export function realOnePieceCandidate(): ManualImportCandidate {
  return {
    id: "candidate_9",
    service: "sonarr",
    path: "/data/usenet/complete/tv/One.Piece.1999.S03.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX/One.Piece.1999.S03E78.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX/One.Piece.1999.S03E78.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX.mkv",
    relativePath:
      "One.Piece.1999.S03E78.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX/One.Piece.1999.S03E78.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX.mkv",
    folderName: "One.Piece.1999.S03.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX",
    name: "One.Piece.1999.S03E78.German.ML.ANiME.1080p.NF.WEB.H264-WAREZCX",
    size: 958_992_152,
    seriesId: 77,
    seriesTitle: "One Piece",
    episodeIds: [],
    absoluteEpisodeNumbers: [],
    episodeLabels: [],
    quality: {
      quality: { id: 3, name: "WEBDL-1080p", source: "web", resolution: 1080 },
      revision: { version: 1, real: 0, isRepack: false },
    },
    qualityLabel: "WEBDL-1080p",
    languages: [
      { id: 4, name: "German" },
      { id: 8, name: "Japanese" },
      { id: 1, name: "English" },
    ],
    languageLabels: ["German", "Japanese", "English"],
    releaseGroup: "WAREZCX",
    customFormats: [
      { id: 310, name: "1080p" },
      { id: 283, name: "German 1080p Booster" },
      { id: 327, name: "German Anime Web Tier 02" },
      { id: 312, name: "German DL" },
      { id: 301, name: "German Web Tier 01" },
      { id: 313, name: "NF" },
    ],
    customFormatLabels: [
      "1080p",
      "German 1080p Booster",
      "German Anime Web Tier 02",
      "German DL",
      "German Web Tier 01",
      "NF",
    ],
    customFormatScore: 13_875,
    indexerFlags: 0,
    releaseType: "seasonPack",
    rejections: ["Invalid season or episode"],
    downloadId: "4306bdf9-116f-4017-a548-6ad7f7edd34f",
    isLikelySample: false,
  };
}

export function realOnePieceAbsoluteEpisode(): SonarrEpisodeRecord {
  return {
    id: 4_951,
    seriesId: 77,
    title: "Nami's Sick? Beyond the Snow Falling on the Ocean!",
    seasonNumber: 6,
    episodeNumber: 9,
    absoluteEpisodeNumber: 78,
    hasFile: false,
    series: { id: 77, title: "One Piece" },
  };
}

export function realDevilsRejectsQueueItem(): QueueItem {
  return {
    id: 1_757_214_544,
    service: "radarr",
    title: "The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL",
    seriesId: 5_454,
    seriesTitle: "The Devil's Rejects",
    movieId: 5_454,
    movieTitle: "The Devil's Rejects",
    movieYear: 2005,
    downloadId: "d53c23a7-7635-4a2a-8128-0c2d9877e84f",
    status: "completed",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importPending",
    isInProgress: false,
    size: 4_573_487_577,
    outputPath: "/data/usenet/complete/movies/The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL/",
    episodeIds: [5_454],
    absoluteEpisodeNumbers: [],
    episodeLabels: ["The Devil's Rejects (2005)"],
    seasonEpisode: "2005",
    statusMessages: [
      "The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL",
      "Unable to determine if file is a sample",
    ],
    canAnalyze: true,
    addedAt: "2026-07-29T17:56:04Z",
  };
}

export function realDevilsRejectsCandidate(): ManualImportCandidate {
  return {
    id: "candidate_1",
    service: "radarr",
    path: "/data/usenet/complete/movies/The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL/The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL.mkv",
    relativePath: "The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL.mkv",
    folderName: "The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL",
    name: "The.Devils.Rejects.2005.MULTi.1080p.WEB.H265-CHiLL",
    size: 4_230_952_991,
    seriesId: 5_454,
    seriesTitle: "The Devil's Rejects",
    movieId: 5_454,
    movieTitle: "The Devil's Rejects",
    movieYear: 2005,
    episodeIds: [5_454],
    absoluteEpisodeNumbers: [],
    episodeLabels: ["The Devil's Rejects (2005)"],
    quality: {
      quality: {
        id: 3,
        name: "WEBDL-1080p",
        source: "webdl",
        resolution: 1080,
        modifier: "none",
      },
      revision: { version: 1, real: 0, isRepack: false },
    },
    qualityLabel: "WEBDL-1080p",
    languages: [{ id: 1, name: "English" }],
    languageLabels: ["English"],
    releaseGroup: "CHiLL",
    customFormats: [
      { id: 164, name: "1080p" },
      { id: 239, name: "x265 (HD)" },
      { id: 187, name: "x265 (no HDR/DV)" },
    ],
    customFormatLabels: ["1080p", "x265 (HD)", "x265 (no HDR/DV)"],
    customFormatScore: 50,
    indexerFlags: 0,
    rejections: ["Unable to determine if file is a sample"],
    downloadId: "d53c23a7-7635-4a2a-8128-0c2d9877e84f",
    isLikelySample: false,
  };
}

export function realDevilsRejectsMovie(): RadarrMovieRecord {
  return {
    id: 5_454,
    title: "The Devil's Rejects",
    year: 2005,
    hasFile: true,
    movieFile: {
      path: "/data/media/Filme/The Devils Rejects (2005) {imdb-tt0395584}/The.Devils.Rejects.2005.DC.GERMAN.DL.1080p.BluRay.x264-TSCC.mkv",
      languages: [
        { id: 4, name: "German" },
        { id: 1, name: "English" },
      ],
    },
  };
}
