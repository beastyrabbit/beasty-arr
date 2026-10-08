import { describe, expect, it, vi } from "vitest";
import type {
  ManualImportCandidate,
  QueueItem,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import {
  realHouseDragonExistingEpisode,
  realHouseDragonGermanUpgradeCandidate,
  realHouseDragonGermanUpgradeQueueItem,
  realMentalistCandidate,
  realMentalistExistingEpisode,
  realMentalistQueueItem,
  realOnePieceAbsoluteEpisode,
  realOnePieceCandidate,
  realOnePieceQueueItem,
} from "../fixer/real-world-fixtures.js";
import type { FetchImpl } from "./http-util.js";
import { SonarrClient } from "./sonarr-client.js";

const removalOptions = {
  removeFromClient: true,
  blocklist: true,
  skipRedownload: false,
  changeCategory: false,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: FetchImpl): SonarrClient {
  return new SonarrClient({
    baseUrl: "http://sonarr.local/",
    apiKey: "test-api-key",
    fetchImpl,
    retryDelayMs: 0,
  });
}

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    service: "sonarr",
    title: "Queue item",
    episodeIds: [],
    absoluteEpisodeNumbers: [],
    episodeLabels: [],
    statusMessages: [],
    canAnalyze: true,
    ...overrides,
  };
}

describe("SonarrClient", () => {
  it("loads every queue page and can include in-progress records for reconciliation", async () => {
    const fetchMock = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        jsonResponse({
          totalRecords: 501,
          records: [{ id: 1, status: "downloading", size: 100, sizeleft: 20 }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          totalRecords: 501,
          records: [{ id: 501, status: "completed", size: 100, sizeleft: 0 }],
        }),
      );
    const queue = await client(fetchMock).listQueue({ includeInProgress: true });
    expect(queue.map((item) => item.id)).toEqual([1, 501]);
    expect(queue[0]?.isInProgress).toBe(true);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("page=2");
  });
  it("reads the series and episodes a download was grabbed for", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        records: [
          { id: 1, eventType: "grabbed", seriesId: 77, episodeId: 301 },
          { id: 2, eventType: "grabbed", seriesId: 77, episodeId: 302 },
          { id: 3, eventType: "grabbed", seriesId: 77, episodeId: 301 },
        ],
      }),
    );
    await expect(client(fetchMock).getGrabbedEpisodes("dl-1")).resolves.toEqual({
      seriesId: 77,
      episodeIds: [301, 302],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v3/history?downloadId=dl-1&eventType=1&page=1&pageSize=250",
    );
  });

  it("reports no grabbed series when there is no grab or it spans several series", async () => {
    const none = vi.fn<FetchImpl>(async () => jsonResponse({ records: [] }));
    await expect(client(none).getGrabbedEpisodes("dl-1")).resolves.toBeUndefined();
    const mixed = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        records: [
          { id: 1, eventType: "grabbed", seriesId: 77, episodeId: 301 },
          { id: 2, eventType: "grabbed", seriesId: 5, episodeId: 101 },
        ],
      }),
    );
    await expect(client(mixed).getGrabbedEpisodes("dl-1")).resolves.toBeUndefined();
  });

  it("loads system status for connection tests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "4.0.0", instanceName: "Series" }));

    const status = await client(fetchMock).getSystemStatus();

    expect(status).toEqual({ version: "4.0.0", instanceName: "Series" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sonarr.local/api/v3/system/status",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "test-api-key" }),
      }),
    );
  });

  it("handles an empty successful queue removal response", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200, statusText: "OK" }));

    const result = await client(fetchMock).removeQueueItem(42, removalOptions);

    expect(result).toEqual({ ok: true, message: "Removed queue item 42." });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sonarr.local/api/v3/queue/42?removeFromClient=true&blocklist=true&skipRedownload=false&changeCategory=false",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Api-Key": "test-api-key",
        }),
      }),
    );
  });

  it("filters in-progress downloads out of the queue", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        records: [
          {
            id: 1,
            title: "Still downloading",
            status: "downloading",
            trackedDownloadStatus: "ok",
            trackedDownloadState: "downloading",
            downloadId: "download-1",
            size: 100,
            sizeleft: 50,
          },
          {
            id: 2,
            title: "Blocked import",
            status: "completed",
            trackedDownloadStatus: "warning",
            trackedDownloadState: "importBlocked",
            downloadId: "download-2",
            size: 100,
            sizeleft: 0,
          },
          {
            id: 3,
            title: "Warning but unfinished",
            status: "warning",
            trackedDownloadStatus: "warning",
            trackedDownloadState: "downloading",
            downloadId: "download-3",
            size: 100,
            sizeleft: 10,
          },
        ],
      }),
    );

    const queue = await client(fetchMock).listQueue();

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: 2,
      canAnalyze: true,
      isInProgress: false,
    });
  });

  it("does not ask Sonarr for manual import candidates while a download is in progress", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));

    const candidates = await client(fetchMock).getManualImportCandidates(
      queueItem({
        downloadId: "download-1",
        status: "downloading",
        trackedDownloadStatus: "warning",
        trackedDownloadState: "downloading",
        isInProgress: true,
      }),
    );

    expect(candidates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads manual import candidates for completed warning downloads", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          path: "/downloads/show/episode.mkv",
          relativePath: "episode.mkv",
          name: "episode",
          size: 1_000_000_000,
          series: { id: 12, title: "Show" },
          episodes: [{ id: 34, seasonNumber: 1, episodeNumber: 2, title: "Episode" }],
          quality: { quality: { name: "WEBRip-720p" } },
          languages: [{ name: "English" }],
          customFormats: [{ id: 311, name: "German" }],
          customFormatScore: 100,
          downloadId: "download-2",
        },
      ]),
    );

    const candidates = await client(fetchMock).getManualImportCandidates(
      queueItem({
        downloadId: "download-2",
        status: "completed",
        trackedDownloadStatus: "warning",
        trackedDownloadState: "importBlocked",
        isInProgress: false,
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      path: "/downloads/show/episode.mkv",
      seriesId: 12,
      episodeIds: [34],
      customFormatLabels: ["German"],
      customFormatScore: 100,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sonarr.local/api/v3/manualimport?downloadId=download-2&filterExistingFiles=false",
      expect.any(Object),
    );
  });

  it("falls back to folder manual import candidates when the downloadId query is empty", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v3/manualimport?downloadId=download-2&filterExistingFiles=false")) {
        return jsonResponse([]);
      }
      if (
        url.endsWith(
          "/api/v3/manualimport?folder=%2Fdownloads%2Fshow&downloadId=download-2&filterExistingFiles=false",
        )
      ) {
        return jsonResponse([
          {
            path: "/downloads/show/episode.mkv",
            relativePath: "episode.mkv",
            name: "episode",
            series: { id: 12, title: "Show" },
            episodes: [{ id: 34, seasonNumber: 1, episodeNumber: 2, title: "Episode" }],
            quality: { quality: { name: "WEBRip-720p" } },
            languages: [{ name: "English" }],
            downloadId: "download-2",
          },
        ]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const candidates = await client(fetchMock).getManualImportCandidates(
      queueItem({
        downloadId: "download-2",
        outputPath: "/downloads/show",
        status: "completed",
        trackedDownloadStatus: "warning",
        trackedDownloadState: "importBlocked",
        isInProgress: false,
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      path: "/downloads/show/episode.mkv",
      seriesId: 12,
      episodeIds: [34],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://sonarr.local/api/v3/manualimport?downloadId=download-2&filterExistingFiles=false",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://sonarr.local/api/v3/manualimport?folder=%2Fdownloads%2Fshow&downloadId=download-2&filterExistingFiles=false",
      expect.any(Object),
    );
  });

  it("loads quality profiles and custom formats for AI upgrade checks", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([{ id: 1, name: "720p", minUpgradeFormatScore: 1 }]);
      }
      if (url.endsWith("/api/v3/customformat")) {
        return jsonResponse([{ id: 311, name: "German" }]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const sonarr = client(fetchMock);
    await expect(sonarr.getQualityProfiles()).resolves.toEqual([
      { id: 1, name: "720p", minUpgradeFormatScore: 1 },
    ]);
    await expect(sonarr.getCustomFormats()).resolves.toEqual([{ id: 311, name: "German" }]);
  });

  function importCandidate(overrides: Partial<ManualImportCandidate> = {}): ManualImportCandidate {
    return {
      id: "candidate_1",
      service: "sonarr",
      path: "/downloads/Show.S01E01/Show.S01E01.mkv",
      seriesId: 5,
      episodeIds: [101],
      absoluteEpisodeNumbers: [],
      episodeLabels: ["S01E01"],
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      languageLabels: ["English"],
      rejections: [],
      isLikelySample: false,
      ...overrides,
    };
  }

  function importProposal(): ResolutionProposal {
    return {
      action: "import_candidates",
      confidence: 0.9,
      selectedCandidateIds: ["candidate_1"],
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [101] }],
      sampleCandidateIds: [],
      reason: "Fallback import.",
      issueSummary: "Import blocked by Sonarr.",
      evidence: [],
      warnings: [],
    };
  }

  it("blocks an anime import when the filename names a different known episode", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/v3/episode?")) {
        return jsonResponse([
          { id: 9, seriesId: 5, title: "Jamming with Edward" },
          { id: 22, seriesId: 5, title: "Cowboy Funk" },
        ]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const proposal: ResolutionProposal = {
      ...importProposal(),
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [22] }],
    };

    const result = await client(fetchMock).preflightImportProposal(
      queueItem({ episodeIds: [22], seriesId: 5 }),
      [
        importCandidate({
          path: "/downloads/Cowboy.Bebop.S01E09.Jamming.with.Edward.mkv",
          seriesType: "anime",
          episodeIds: [22],
          episodeLabels: ["S01E22"],
          languages: [{ name: "German" }],
          languageLabels: ["German"],
        }),
      ],
      proposal,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Jamming with Edward");
    expect(result.message).toContain("Cowboy Funk");
  });

  it("blocks imports that would replace a German-audio file with a non-German candidate", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/v3/episode?")) {
        return jsonResponse([
          {
            id: 101,
            episodeFile: {
              relativePath: "Season 01/Show - S01E01 [German DL].mkv",
              languages: [{ name: "German" }, { name: "English" }],
            },
          },
        ]);
      }
      if (String(url).endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const result = await client(fetchMock).applyImportProposal(
      queueItem({ episodeIds: [101] }),
      [importCandidate()],
      importProposal(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Blocked language downgrade");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v3/command"))).toBe(
      false,
    );
  });

  it("blocks the captured Mentalist German-audio downgrade in real preflight", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/v3/episode?")) {
        return jsonResponse([realMentalistExistingEpisode()]);
      }
      if (String(url).endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const proposal: ResolutionProposal = {
      ...importProposal(),
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [25_505] }],
    };

    const result = await client(fetchMock).preflightImportProposal(
      realMentalistQueueItem(),
      [realMentalistCandidate()],
      proposal,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Blocked language downgrade");
  });

  it("blocks a captured One Piece pack that does not contain the queued target", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/v3/episode?")) {
        return jsonResponse([realOnePieceAbsoluteEpisode()]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const proposal: ResolutionProposal = {
      ...importProposal(),
      selectedCandidateIds: ["candidate_9"],
      selectedImports: [{ candidateId: "candidate_9", episodeIds: [4_951] }],
    };

    const result = await client(fetchMock).preflightImportProposal(
      realOnePieceQueueItem(),
      [realOnePieceCandidate()],
      proposal,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("queued target episode");
  });

  it("imports a non-German candidate when the existing file also lacks German", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/v3/episode?")) {
        return jsonResponse([
          {
            id: 101,
            series: { id: 5, qualityProfileId: 6 },
            episodeFile: {
              relativePath: "Season 01/old.mkv",
              quality: { quality: { id: 1, name: "HDTV-720p" } },
              languages: [{ name: "English" }],
            },
          },
        ]);
      }
      if (String(url).endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([
          {
            id: 6,
            name: "HD-1080p",
            upgradeAllowed: true,
            cutoff: 3,
            items: [
              { quality: { id: 1, name: "HDTV-720p" }, allowed: true },
              { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
            ],
          },
        ]);
      }
      if (String(url).endsWith("/api/v3/command")) {
        return jsonResponse({ id: 55 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const result = await client(fetchMock).applyImportProposal(
      queueItem({ episodeIds: [101] }),
      [importCandidate()],
      importProposal(),
    );

    expect(result).toMatchObject({ ok: true, commandId: 55 });
  });

  it("imports a German candidate for a target that has no file yet", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/v3/episode?")) {
        return jsonResponse([{ id: 101, hasFile: false }]);
      }
      if (String(url).endsWith("/api/v3/qualityprofile")) {
        return jsonResponse([]);
      }
      if (String(url).endsWith("/api/v3/command")) {
        return jsonResponse({ id: 56 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const result = await client(fetchMock).applyImportProposal(
      queueItem({ episodeIds: [101] }),
      [
        importCandidate({
          languages: [{ name: "German" }, { name: "English" }],
          languageLabels: ["German", "English"],
        }),
      ],
      importProposal(),
    );

    expect(result).toMatchObject({ ok: true, commandId: 56, leftover: "none" });
  });

  // ---- hunt-engine read methods ----

  it("loads the full series list", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          id: 12,
          title: "Show",
          tvdbId: 999,
          year: 2020,
          status: "continuing",
          seriesType: "standard",
          originalLanguage: { id: 1, name: "English" },
          monitored: true,
          qualityProfileId: 4,
          tags: [1],
          path: "/tv/Show",
          images: [{ coverType: "poster", remoteUrl: "https://img/poster.jpg" }],
        },
      ]),
    );

    const series = await client(fetchMock).getSeries();

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ id: 12, tvdbId: 999, seriesType: "standard" });
    expect(fetchMock).toHaveBeenCalledWith("http://sonarr.local/api/v3/series", expect.any(Object));
  });

  it("loads episode files for a series", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ id: 7, seriesId: 12, languages: [{ id: 4, name: "German" }] }]),
    );

    const files = await client(fetchMock).getEpisodeFiles(12);

    expect(files[0]).toMatchObject({ id: 7, seriesId: 12 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sonarr.local/api/v3/episodefile?seriesId=12",
      expect.any(Object),
    );
  });

  it("pages history sorted by date descending", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        page: 1,
        pageSize: 50,
        totalRecords: 2,
        records: [
          { id: 900, eventType: "grabbed", episodeId: 34, seriesId: 12, downloadId: "d-1" },
          { id: 899, eventType: "downloadFolderImported", episodeId: 33, seriesId: 12 },
        ],
      }),
    );

    const history = await client(fetchMock).getHistoryPage({ page: 1, pageSize: 50 });

    expect(history.totalRecords).toBe(2);
    expect(history.records?.[0]).toMatchObject({
      id: 900,
      eventType: "grabbed",
      downloadId: "d-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sonarr.local/api/v3/history?page=1&pageSize=50&sortKey=date&sortDirection=descending",
      expect.any(Object),
    );
  });

  it("reads queue depth without materializing records", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ totalRecords: 17, records: [{}] }));

    await expect(client(fetchMock).getQueueStats()).resolves.toEqual({ totalRecords: 17 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sonarr.local/api/v3/queue?page=1&pageSize=1",
      expect.any(Object),
    );
  });

  it("collects queued download and episode ids across pages", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get("page");
      return jsonResponse({
        totalRecords: 1_001,
        records:
          page === "1"
            ? [{ id: 1, downloadId: "download-1", episodeId: 101, episode: { id: 102 } }]
            : [{ id: 2, downloadId: "download-2", episodes: [{ id: 103 }, { id: 104 }] }],
      });
    });

    const snapshot = await client(fetchMock).getQueueSnapshot();

    expect([...snapshot.downloadIds]).toEqual(["download-1", "download-2"]);
    expect([...snapshot.targetIds]).toEqual([101, 102, 103, 104]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://sonarr.local/api/v3/queue?page=1&pageSize=1000&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://sonarr.local/api/v3/queue?page=2&pageSize=1000&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true",
      expect.any(Object),
    );
  });

  it("sends and polls search commands", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v3/command") && init?.method === "POST") {
        return jsonResponse({ id: 71, name: "EpisodeSearch", status: "queued" });
      }
      if (url.endsWith("/api/v3/command/71")) {
        return jsonResponse({ id: 71, name: "EpisodeSearch", status: "completed" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const sonarr = client(fetchMock);
    const sent = await sonarr.sendCommand({ name: "EpisodeSearch", episodeIds: [34, 35] });
    expect(sent).toMatchObject({ id: 71, status: "queued" });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      name: "EpisodeSearch",
      episodeIds: [34, 35],
    });

    await expect(sonarr.getCommand(71)).resolves.toMatchObject({ id: 71, status: "completed" });
  });

  it("reads wanted missing/cutoff totals", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ totalRecords: 5, records: [{ id: 34 }] }));

    const sonarr = client(fetchMock);
    await expect(sonarr.getWantedMissing({ page: 1, pageSize: 1 })).resolves.toMatchObject({
      totalRecords: 5,
    });
    await expect(sonarr.getWantedCutoff()).resolves.toMatchObject({ totalRecords: 5 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://sonarr.local/api/v3/wanted/missing?page=1&pageSize=1",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://sonarr.local/api/v3/wanted/cutoff?page=1&pageSize=1",
      expect.any(Object),
    );
  });
});

describe("SonarrClient pack imports", () => {
  const profile = {
    id: 6,
    name: "HD-1080p",
    upgradeAllowed: true,
    cutoff: 3,
    cutoffFormatScore: 10_000,
    minUpgradeFormatScore: 1,
    items: [
      { quality: { id: 1, name: "HDTV-720p" }, allowed: true },
      { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
    ],
  };

  function packCandidate(index: number, episodeId: number): ManualImportCandidate {
    return {
      id: `candidate_${index}`,
      service: "sonarr",
      path: `/downloads/pack/Show.S01E0${index}.mkv`,
      relativePath: `Show.S01E0${index}.mkv`,
      seriesId: 5,
      episodeIds: [episodeId],
      absoluteEpisodeNumbers: [],
      episodeLabels: [`S01E0${index}`],
      quality: { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1 } },
      customFormatScore: 125,
      languages: [{ id: 1, name: "English" }],
      languageLabels: ["English"],
      rejections: [],
      isLikelySample: false,
      downloadId: "pack",
    };
  }

  function packEpisode(id: number, existingScore: number | null) {
    return {
      id,
      seriesId: 5,
      hasFile: existingScore !== null,
      series: { id: 5, qualityProfileId: 6 },
      ...(existingScore === null
        ? {}
        : {
            episodeFile: {
              relativePath: `Season 01/old-${id}.mkv`,
              quality: { quality: { id: 3, name: "WEBDL-1080p" } },
              customFormatScore: existingScore,
              languages: [{ id: 1, name: "English" }],
            },
          }),
    };
  }

  function packProposal(imports: Array<[string, number]>): ResolutionProposal {
    return {
      action: "import_candidates",
      confidence: 0.95,
      selectedCandidateIds: imports.map(([candidateId]) => candidateId),
      selectedImports: imports.map(([candidateId, episodeId]) => ({
        candidateId,
        episodeIds: [episodeId],
      })),
      sampleCandidateIds: [],
      reason: "Import the missing and upgraded episodes.",
      issueSummary: "Series matched by id.",
      evidence: [],
      warnings: [],
    };
  }

  function packFetch(options: { episodes: unknown[]; queueRows: number[] }) {
    let queueRows = options.queueRows;
    const deleted: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === "DELETE") {
        deleted.push(target);
        queueRows = [];
        return new Response(null, { status: 200, statusText: "OK" });
      }
      if (target.includes("/api/v3/episode?")) return jsonResponse(options.episodes);
      if (target.endsWith("/api/v3/qualityprofile")) return jsonResponse([profile]);
      if (target.endsWith("/api/v3/command")) return jsonResponse({ id: 77 });
      if (target.endsWith("/api/v3/command/77")) return jsonResponse({ status: "completed" });
      if (target.includes("/api/v3/queue?")) {
        return jsonResponse({
          totalRecords: queueRows.length,
          records: queueRows.map((id) => ({ id, downloadId: "pack", status: "completed" })),
        });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    return { fetchMock, deleted };
  }

  /** Preflight of one selected file (candidate_1 → episode 101) against one target episode. */
  function preflightSingleFile(episode: unknown) {
    const { fetchMock } = packFetch({ episodes: [episode], queueRows: [1] });
    return client(fetchMock).preflightImportProposal(
      queueItem({ episodeIds: [101], seriesId: 5, downloadId: "pack" }),
      [packCandidate(1, 101)],
      packProposal([["candidate_1", 101]]),
    );
  }

  it("refuses a selected file whose upgrade cannot be verified", async () => {
    const result = await preflightSingleFile({ ...packEpisode(101, 125), series: { id: 5 } });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot verify that Show.S01E01.mkv improves the library");
    expect(result.message).toContain("quality profile is unavailable");
  });

  it("refuses a multi-episode file when any of its targets cannot be verified", async () => {
    const { fetchMock } = packFetch({
      episodes: [packEpisode(101, null)],
      queueRows: [1],
    });

    const result = await client(fetchMock).preflightImportProposal(
      queueItem({ episodeIds: [101, 102], seriesId: 5, downloadId: "pack" }),
      [{ ...packCandidate(1, 101), episodeIds: [101, 102] }],
      {
        ...packProposal([["candidate_1", 101]]),
        selectedImports: [{ candidateId: "candidate_1", episodeIds: [101, 102] }],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot verify");
    expect(result.message).toContain("did not return the target episode");
  });

  it("refuses a selected file that is not an upgrade for its target", async () => {
    const result = await preflightSingleFile(packEpisode(101, 125));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Blocked non-upgrade");
    expect(result.message).toContain("Show.S01E01.mkv");
  });

  it("imports the missing and upgraded files of a pack and removes the verified non-upgrade leftovers", async () => {
    const { fetchMock, deleted } = packFetch({
      episodes: [packEpisode(101, null), packEpisode(102, 50), packEpisode(103, 125)],
      queueRows: [1, 2, 3],
    });
    const sonarr = client(fetchMock);
    const target = queueItem({ episodeIds: [101, 102, 103], seriesId: 5, downloadId: "pack" });
    const candidates = [packCandidate(1, 101), packCandidate(2, 102), packCandidate(3, 103)];

    const started = await sonarr.applyImportProposal(
      target,
      candidates,
      packProposal([
        ["candidate_1", 101],
        ["candidate_2", 102],
      ]),
    );
    expect(started).toMatchObject({ ok: true, commandId: 77, leftover: "remove" });
    const command = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v3/command"));
    const body = JSON.parse(String(command?.[1]?.body)) as { files: Array<{ path: string }> };
    expect(body.files.map((file) => file.path)).toEqual([
      "/downloads/pack/Show.S01E01.mkv",
      "/downloads/pack/Show.S01E02.mkv",
    ]);

    const verified = await sonarr.verifyImportApplied(target, started);

    expect(verified.ok).toBe(true);
    expect(verified.message).toContain("non-upgrade files were removed");
    expect(deleted).toEqual([
      "http://sonarr.local/api/v3/queue/1?removeFromClient=true&blocklist=false&skipRedownload=false&changeCategory=false",
    ]);
  });

  it("fetches episodes and quality profiles once per preflight for selected and leftover files", async () => {
    const { fetchMock } = packFetch({
      episodes: [packEpisode(101, null), packEpisode(102, 125)],
      queueRows: [1, 2],
    });

    const result = await client(fetchMock).preflightImportProposal(
      queueItem({ episodeIds: [101, 102], seriesId: 5, downloadId: "pack" }),
      [packCandidate(1, 101), packCandidate(2, 102)],
      packProposal([["candidate_1", 101]]),
    );

    expect(result).toMatchObject({ ok: true, leftover: "remove" });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.endsWith("/api/v3/qualityprofile"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("includeEpisodeFile=true"))).toHaveLength(1);
  });

  it("discards an unselected sample with the download once the real files are imported", async () => {
    const { fetchMock, deleted } = packFetch({
      episodes: [packEpisode(101, null)],
      queueRows: [1],
    });
    const sonarr = client(fetchMock);
    const target = queueItem({ episodeIds: [101], seriesId: 5, downloadId: "pack" });
    const sample: ManualImportCandidate = {
      ...packCandidate(2, 101),
      path: "/downloads/pack/Sample/Show.S01E01.sample.mkv",
      relativePath: "Sample/Show.S01E01.sample.mkv",
      isLikelySample: true,
      sampleReason: "sample folder",
    };

    const started = await sonarr.applyImportProposal(
      target,
      [packCandidate(1, 101), sample],
      packProposal([["candidate_1", 101]]),
    );
    expect(started).toMatchObject({ ok: true, leftover: "remove" });

    const verified = await sonarr.verifyImportApplied(target, started);

    expect(verified.ok).toBe(true);
    expect(deleted).toHaveLength(1);
  });

  it("keeps leftovers for review when an unselected file is not a verified non-upgrade", async () => {
    const { fetchMock, deleted } = packFetch({
      episodes: [packEpisode(101, null), packEpisode(102, null)],
      queueRows: [1, 2],
    });
    const sonarr = client(fetchMock);
    const target = queueItem({ episodeIds: [101, 102], seriesId: 5, downloadId: "pack" });

    const started = await sonarr.applyImportProposal(
      target,
      [packCandidate(1, 101), packCandidate(2, 102)],
      packProposal([["candidate_1", 101]]),
    );
    expect(started).toMatchObject({ ok: true, leftover: "keep" });

    const verified = await sonarr.verifyImportApplied(target, started);

    expect(verified.ok).toBe(true);
    expect(verified.message).toContain("stay in the queue for review");
    expect(deleted).toEqual([]);
  });

  it("passes the captured House of the Dragon German upgrade through the deterministic check", async () => {
    const { fetchMock } = packFetch({
      episodes: [
        {
          ...realHouseDragonExistingEpisode(),
          series: { ...realHouseDragonExistingEpisode().series, qualityProfileId: 6 },
        },
      ],
      queueRows: [1],
    });

    const result = await client(fetchMock).preflightImportProposal(
      realHouseDragonGermanUpgradeQueueItem(),
      [realHouseDragonGermanUpgradeCandidate()],
      packProposal([["candidate_1", 86_875]]),
    );

    expect(result).toMatchObject({ ok: true, leftover: "none" });
  });
});
