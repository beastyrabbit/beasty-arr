import { describe, expect, it, vi } from "vitest";
import type { QueueItem, ResolutionProposal } from "../../shared/fixer-types.js";
import {
  realDevilsRejectsCandidate,
  realDevilsRejectsMovie,
  realDevilsRejectsQueueItem,
} from "../fixer/real-world-fixtures.js";
import type { FetchImpl } from "./http-util.js";
import { RadarrClient } from "./radarr-client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: FetchImpl): RadarrClient {
  return new RadarrClient({
    baseUrl: "http://radarr.local/",
    apiKey: "api-key",
    fetchImpl,
    retryDelayMs: 0,
  });
}

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 9,
    service: "radarr",
    title: "Arrival.2016",
    movieId: 42,
    movieTitle: "Arrival",
    movieYear: 2016,
    downloadId: "download-9",
    status: "completed",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importBlocked",
    isInProgress: false,
    episodeIds: [42],
    absoluteEpisodeNumbers: [],
    episodeLabels: ["Arrival (2016)"],
    statusMessages: ["Not an upgrade for existing movie file"],
    canAnalyze: true,
    ...overrides,
  };
}

describe("RadarrClient", () => {
  it("loads system status for connection tests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: "5.1.0", instanceName: "Movies" }));

    const status = await client(fetchMock).getSystemStatus();

    expect(status).toEqual({ version: "5.1.0", instanceName: "Movies" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://radarr.local/api/v3/system/status",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "api-key" }),
      }),
    );
  });

  it("normalizes completed Radarr movie queue items", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        records: [
          {
            id: 9,
            title: "Arrival.2016",
            movieId: 42,
            movie: { id: 42, title: "Arrival", year: 2016 },
            status: "completed",
            trackedDownloadStatus: "warning",
            trackedDownloadState: "importBlocked",
            downloadId: "download-9",
            size: 100,
            sizeleft: 0,
          },
        ],
      }),
    );

    const queue = await client(fetchMock).listQueue();

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      service: "radarr",
      movieId: 42,
      movieTitle: "Arrival",
      movieYear: 2016,
      episodeIds: [42],
      canAnalyze: true,
    });
  });

  it("loads Radarr manual import candidates with movie metadata", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          path: "/downloads/Arrival.2016/Arrival.2016.German.mkv",
          name: "Arrival.2016.German",
          size: 8_000_000_000,
          movie: { id: 42, title: "Arrival", year: 2016 },
          quality: { quality: { name: "Bluray-1080p" } },
          languages: [{ name: "German" }],
          customFormats: [{ id: 1, name: "German" }],
          customFormatScore: 100,
          downloadId: "download-9",
        },
      ]),
    );

    const candidates = await client(fetchMock).getManualImportCandidates(queueItem());

    expect(candidates[0]).toMatchObject({
      service: "radarr",
      movieId: 42,
      movieTitle: "Arrival",
      movieYear: 2016,
      qualityLabel: "Bluray-1080p",
      languageLabels: ["German"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://radarr.local/api/v3/manualimport?downloadId=download-9&filterExistingFiles=false",
      expect.any(Object),
    );
  });

  it("starts a Radarr ManualImport command with a movie id mapping", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/api/v3/command")) {
        return jsonResponse({ id: 88 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const candidate = {
      id: "candidate_1",
      service: "radarr" as const,
      path: "/downloads/Arrival.2016/Arrival.mkv",
      movieId: 42,
      movieTitle: "Arrival",
      movieYear: 2016,
      episodeIds: [42],
      absoluteEpisodeNumbers: [],
      episodeLabels: ["Arrival (2016)"],
      quality: { quality: { name: "Bluray-1080p" } },
      languages: [{ name: "German" }],
      languageLabels: ["German"],
      rejections: [],
      downloadId: "download-9",
      isLikelySample: false,
    };
    const proposal: ResolutionProposal = {
      action: "import_candidates",
      confidence: 0.98,
      selectedCandidateIds: ["candidate_1"],
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [], movieId: 42 }],
      sampleCandidateIds: [],
      reason: "The feature file matches Arrival.",
      issueSummary: "Radarr could not import automatically.",
      evidence: ["The parsed movie id is 42."],
      warnings: [],
    };

    const result = await client(fetchMock).applyImportProposal(queueItem(), [candidate], proposal);

    expect(result).toMatchObject({ ok: true, commandId: 88 });
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v3/command"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      name: "ManualImport",
      files: [{ movieId: 42, path: candidate.path, downloadId: "download-9" }],
    });
  });

  it("blocks a non-German import that would replace a German-audio movie file", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/api/v3/movie/42")) {
        return jsonResponse({
          id: 42,
          movieFile: {
            relativePath: "Arrival (2016) German DL.mkv",
            languages: [{ name: "German" }, { name: "English" }],
          },
        });
      }
      if (url.endsWith("/api/v3/command")) {
        return jsonResponse({ id: 89 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const candidate = {
      id: "candidate_1",
      service: "radarr" as const,
      path: "/downloads/Arrival.2016/Arrival.mkv",
      movieId: 42,
      movieTitle: "Arrival",
      movieYear: 2016,
      episodeIds: [42],
      absoluteEpisodeNumbers: [],
      episodeLabels: ["Arrival (2016)"],
      quality: { quality: { name: "Bluray-1080p" } },
      languages: [{ name: "English" }],
      languageLabels: ["English"],
      rejections: [],
      downloadId: "download-9",
      isLikelySample: false,
    };
    const proposal: ResolutionProposal = {
      action: "import_candidates",
      confidence: 0.98,
      selectedCandidateIds: ["candidate_1"],
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [], movieId: 42 }],
      sampleCandidateIds: [],
      reason: "English fallback import.",
      issueSummary: "Radarr could not import automatically.",
      evidence: [],
      warnings: [],
    };

    const result = await client(fetchMock).applyImportProposal(queueItem(), [candidate], proposal);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Blocked language downgrade");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v3/command"))).toBe(
      false,
    );
  });

  it("blocks the captured Devil's Rejects German-audio downgrade in real preflight", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v3/movie/5454")) {
        return jsonResponse(realDevilsRejectsMovie());
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const proposal: ResolutionProposal = {
      action: "import_candidates",
      confidence: 0.98,
      selectedCandidateIds: ["candidate_1"],
      selectedImports: [{ candidateId: "candidate_1", episodeIds: [], movieId: 5_454 }],
      sampleCandidateIds: [],
      reason: "English candidate.",
      issueSummary: "Manual import warning.",
      evidence: [],
      warnings: [],
    };

    const result = await client(fetchMock).preflightImportProposal(
      realDevilsRejectsQueueItem(),
      [realDevilsRejectsCandidate()],
      proposal,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Blocked language downgrade");
  });

  // ---- hunt-engine read methods ----

  it("loads the full movie list with availability fields", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          id: 42,
          title: "Arrival",
          tmdbId: 329865,
          year: 2016,
          status: "released",
          isAvailable: true,
          digitalRelease: "2017-01-24T00:00:00Z",
          physicalRelease: "2017-02-14T00:00:00Z",
          originalLanguage: { id: 1, name: "English" },
          monitored: true,
          hasFile: false,
          qualityProfileId: 4,
          tags: [],
          images: [{ coverType: "poster", remoteUrl: "https://img/arrival.jpg" }],
          path: "/movies/Arrival (2016)",
        },
      ]),
    );

    const movies = await client(fetchMock).getMovies();

    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({ id: 42, tmdbId: 329865, isAvailable: true });
    expect(fetchMock).toHaveBeenCalledWith("http://radarr.local/api/v3/movie", expect.any(Object));
  });

  it("pages history sorted by date descending", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        totalRecords: 1,
        records: [{ id: 500, eventType: "grabbed", movieId: 42, downloadId: "d-9" }],
      }),
    );

    const history = await client(fetchMock).getHistoryPage();

    expect(history.records?.[0]).toMatchObject({ id: 500, movieId: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://radarr.local/api/v3/history?page=1&pageSize=100&sortKey=date&sortDirection=descending",
      expect.any(Object),
    );
  });

  it("collects queued download and movie ids across pages", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get("page");
      return jsonResponse({
        totalRecords: 1_001,
        records:
          page === "1"
            ? [{ id: 1, downloadId: "download-1", movieId: 41 }]
            : [{ id: 2, downloadId: "download-2", movie: { id: 42 } }],
      });
    });

    const snapshot = await client(fetchMock).getQueueSnapshot();

    expect([...snapshot.downloadIds]).toEqual(["download-1", "download-2"]);
    expect([...snapshot.targetIds]).toEqual([41, 42]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://radarr.local/api/v3/queue?page=1&pageSize=1000&includeUnknownMovieItems=true&includeMovie=true",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://radarr.local/api/v3/queue?page=2&pageSize=1000&includeUnknownMovieItems=true&includeMovie=true",
      expect.any(Object),
    );
  });

  it("reads queue depth, commands, and wanted totals", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/v3/queue?")) {
        return jsonResponse({ totalRecords: 3 });
      }
      if (url.endsWith("/api/v3/command") && init?.method === "POST") {
        return jsonResponse({ id: 12, name: "MoviesSearch", status: "queued" });
      }
      if (url.endsWith("/api/v3/command/12")) {
        return jsonResponse({ id: 12, status: "completed" });
      }
      if (url.includes("/api/v3/wanted/missing")) {
        return jsonResponse({ totalRecords: 8, records: [{ id: 42 }] });
      }
      if (url.includes("/api/v3/wanted/cutoff")) {
        return jsonResponse({ totalRecords: 2, records: [{ id: 43 }] });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const radarr = client(fetchMock);
    await expect(radarr.getQueueStats()).resolves.toEqual({ totalRecords: 3 });
    await expect(
      radarr.sendCommand({ name: "MoviesSearch", movieIds: [42] }),
    ).resolves.toMatchObject({
      id: 12,
      status: "queued",
    });
    await expect(radarr.getCommand(12)).resolves.toMatchObject({ id: 12, status: "completed" });
    await expect(radarr.getWantedMissing()).resolves.toMatchObject({ totalRecords: 8 });
    await expect(radarr.getWantedCutoff()).resolves.toMatchObject({ totalRecords: 2 });
  });
});
