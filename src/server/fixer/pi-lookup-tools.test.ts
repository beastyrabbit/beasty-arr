import { describe, expect, it } from "vitest";
import type { RadarrClient, RadarrMovieRecord } from "../arr/radarr-client.js";
import type { SonarrClient, SonarrEpisodeRecord } from "../arr/sonarr-client.js";
import { createRadarrLookupTools } from "./pi-radarr-tools.js";
import { createSonarrLookupTools } from "./pi-sonarr-tools.js";
import {
  realDevilsRejectsCandidate,
  realDevilsRejectsMovie,
  realDevilsRejectsQueueItem,
  realMentalistCandidate,
  realMentalistExistingEpisode,
  realMentalistQueueItem,
  realReviewCapture,
} from "./real-world-fixtures.js";

type ExecutableTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    a?: unknown,
    b?: unknown,
    c?: never,
  ) => Promise<{ details?: unknown }>;
};

async function executeTool(
  tools: unknown[],
  name: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = (tools as ExecutableTool[]).find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.execute("call_1", params, undefined, undefined, undefined as never);
  return result.details as Record<string, unknown>;
}

describe("fixer upgrade-context tools", () => {
  it("shows Bleach's season-bound arc titles in episode lookups", async () => {
    const capture = realReviewCapture("bleach-part4");
    const client = {
      getEpisodes: async () => capture.catalog,
      getSeriesById: async () => capture.series,
    } as unknown as SonarrClient;
    const tools = createSonarrLookupTools({
      client,
      queueItem: capture.queueItem,
      getCandidates: () => capture.candidates,
    });
    const details = await executeTool(tools, "sonarr_find_episodes");
    const series = details.series as {
      alternateTitles: Array<{ title: string; seasonNumber: number }>;
    };
    expect(series.alternateTitles).toContainEqual({
      title: "Bleach - Sennen Kessen-hen",
      seasonNumber: 17,
    });
  });

  it.each([
    ["the queued series", undefined, ["Ein ganz besonderes Geschenk"]],
    // A sequel or other series lacking the title says nothing about the queued one.
    ["another series", 999, []],
  ] as const)("records an unmatched title searched in %s", async (_label, seriesId, expected) => {
    const capture = realReviewCapture("benjamin");
    const unmatched: string[] = [];
    const client = {
      getEpisodes: async () => capture.catalog,
      getSeriesById: async () => capture.series,
    } as unknown as SonarrClient;
    const tools = createSonarrLookupTools({
      client,
      queueItem: capture.queueItem,
      getCandidates: () => capture.candidates,
      observeUnmatchedTitle: (title) => unmatched.push(title),
    });
    await executeTool(tools, "sonarr_find_episodes", {
      titleContains: "Ein ganz besonderes Geschenk",
      ...(seriesId ? { seriesId } : {}),
    });
    expect(unmatched).toEqual(expected);
  });

  it("shows every episode sharing Blacklist's wrongly associated season file", async () => {
    const capture = realReviewCapture("blacklist");
    const client = {
      getEpisodes: async () => capture.episodes,
      getQualityProfiles: async () => [],
      getCustomFormats: async () => [],
    } as unknown as SonarrClient;
    const tools = createSonarrLookupTools({
      client,
      queueItem: capture.queueItem,
      getCandidates: () => capture.candidates,
    });
    const details = await executeTool(tools, "sonarr_get_upgrade_context");
    expect(details.replacementFileSets).toEqual([
      { episodeFileId: 198627, episodeIds: Array.from({ length: 20 }, (_, index) => 8040 + index) },
    ]);
  });

  it("makes a Sonarr German-to-English conflict explicit to the model", async () => {
    const episodes: SonarrEpisodeRecord[] = [realMentalistExistingEpisode()];
    const client = {
      getEpisodes: async () => episodes,
      getQualityProfiles: async () => [],
      getCustomFormats: async () => [],
    } as unknown as SonarrClient;
    const tools = createSonarrLookupTools({
      client,
      queueItem: realMentalistQueueItem(),
      getCandidates: () => [realMentalistCandidate()],
    });

    const details = await executeTool(tools, "sonarr_get_upgrade_context");
    const target = (details.targetEpisodes as Array<Record<string, unknown>>)[0];
    const currentFile = target?.currentFile as Record<string, unknown>;
    const candidates = details.candidates as Array<Record<string, unknown>>;

    expect(currentFile).toMatchObject({
      arrLabelsKnown: true,
      arrLabelsSayGerman: true,
    });
    // The prompt already lists the full candidates; the tool repeats only what it assessed.
    expect(candidates).toEqual([
      {
        candidateId: "candidate_1",
        qualityLabel: "WEBDL-1080p",
        score: 57,
        languages: ["English"],
      },
    ]);
  });

  it("assesses a remapped Sonarr file against the episode it really is", async () => {
    // Sonarr mapped the file to S01E01, which has a better file; the file is
    // really S01E02, which has none.
    const series = { id: 9, title: "Show", qualityProfileId: 4 };
    const episodes: SonarrEpisodeRecord[] = [
      {
        id: 501,
        seriesId: 9,
        seasonNumber: 1,
        episodeNumber: 1,
        hasFile: true,
        episodeFile: {
          quality: { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1, real: 0 } },
          languages: [{ id: 1, name: "English" }],
          customFormatScore: 500,
        },
        series,
      },
      { id: 502, seriesId: 9, seasonNumber: 1, episodeNumber: 2, hasFile: false, series },
    ];
    const client = {
      getEpisodes: async ({ episodeIds }: { episodeIds?: number[] }) =>
        episodes.filter((episode) => episodeIds?.includes(episode.id ?? 0)),
      getQualityProfiles: async () => [
        {
          id: 4,
          name: "HD-1080p",
          upgradeAllowed: true,
          cutoff: 3,
          items: [
            { quality: { id: 4, name: "HDTV-720p" }, allowed: true },
            { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
          ],
        },
      ],
      getCustomFormats: async () => [],
    } as unknown as SonarrClient;
    const tools = createSonarrLookupTools({
      client,
      queueItem: { ...realMentalistQueueItem(), seriesId: 9, episodeIds: [501, 502] },
      getCandidates: () => [
        {
          ...realMentalistCandidate(),
          seriesId: 9,
          episodeIds: [501],
          quality: { quality: { id: 4, name: "HDTV-720p" }, revision: { version: 1, real: 0 } },
          qualityLabel: "HDTV-720p",
          customFormatScore: 0,
        },
      ],
    });

    const sonarrMapping = await executeTool(tools, "sonarr_get_upgrade_context");
    const remapped = await executeTool(tools, "sonarr_get_upgrade_context", {
      mappings: [{ candidateId: "candidate_1", episodeIds: [502] }],
    });

    expect((sonarrMapping.upgradeAssessment as unknown[])[0]).toMatchObject({
      episodeIds: [501],
      decision: "skip",
    });
    expect((remapped.upgradeAssessment as unknown[])[0]).toMatchObject({
      candidateId: "candidate_1",
      episodeIds: [502],
      decision: "import",
    });
  });

  it("makes a Radarr German-to-English conflict explicit to the model", async () => {
    const movie: RadarrMovieRecord = realDevilsRejectsMovie();
    const client = {
      getMovie: async () => movie,
      getQualityProfiles: async () => [],
      getCustomFormats: async () => [],
    } as unknown as RadarrClient;
    const tools = createRadarrLookupTools({
      client,
      queueItem: realDevilsRejectsQueueItem(),
      getCandidates: () => [realDevilsRejectsCandidate()],
    });

    const details = await executeTool(tools, "radarr_get_upgrade_context");
    const compactMovie = details.movie as Record<string, unknown>;
    const currentFile = compactMovie.currentFile as Record<string, unknown>;
    const candidate = (details.candidates as Array<Record<string, unknown>>)[0];

    expect(currentFile).toMatchObject({
      arrLabelsKnown: true,
      arrLabelsSayGerman: true,
    });
    expect(candidate).toMatchObject({
      arrLabelsKnown: true,
      arrLabelsSayGerman: false,
    });
  });

  it("assesses a Radarr REPACK against the library score from /moviefile", async () => {
    // He's All That (2021): /movie/{id} omits the score; /moviefile/{id} has 3050.
    const libraryFile = {
      id: 900,
      quality: { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1, real: 0 } },
      languages: [{ id: 1, name: "English" }],
    };
    const movie: RadarrMovieRecord = {
      id: 77,
      title: "He's All That",
      hasFile: true,
      movieFileId: 900,
      qualityProfileId: 7,
      movieFile: libraryFile,
    };
    const client = {
      getMovie: async () => movie,
      getMovieFile: async () => ({ ...libraryFile, customFormatScore: 3050 }),
      getQualityProfiles: async () => [
        {
          id: 7,
          name: "HD-1080p",
          upgradeAllowed: true,
          cutoff: 3,
          cutoffFormatScore: 10_000,
          items: [{ quality: { id: 3, name: "WEBDL-1080p" }, allowed: true }],
        },
      ],
      getCustomFormats: async () => [],
    } as unknown as RadarrClient;
    const tools = createRadarrLookupTools({
      client,
      queueItem: { ...realDevilsRejectsQueueItem(), movieId: 77 },
      getCandidates: () => [
        {
          ...realDevilsRejectsCandidate(),
          movieId: 77,
          quality: {
            quality: { id: 3, name: "WEBDL-1080p" },
            revision: { version: 2, real: 0, isRepack: true },
          },
          customFormatScore: 805,
        },
      ],
    });

    const details = await executeTool(tools, "radarr_get_upgrade_context");
    const currentFile = (details.movie as Record<string, unknown>).currentFile;
    const assessment = (details.upgradeAssessment as Array<Record<string, unknown>>)[0];

    expect(currentFile).toMatchObject({ customFormatScore: 3050 });
    expect(assessment).toMatchObject({ candidateId: "candidate_1", decision: "skip" });
    expect(assessment?.reason).toContain("score 3050");
  });

  // Countdown: the grabbed movie has a file, the queue-mapped movie does not.
  it("assesses a Radarr candidate against an explicit movie id", async () => {
    const libraryFile = {
      id: 900,
      quality: { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1, real: 0 } },
      languages: [{ id: 1, name: "English" }],
      customFormatScore: 3050,
    };
    const movies: Record<number, RadarrMovieRecord> = {
      77: { id: 77, title: "Grabbed", hasFile: true, movieFileId: 900, qualityProfileId: 7 },
      78: { id: 78, title: "Mapped", hasFile: false, qualityProfileId: 7 },
    };
    const client = {
      getMovie: async (id: number) => movies[id],
      getMovieFile: async () => libraryFile,
      getQualityProfiles: async () => [
        {
          id: 7,
          name: "HD-1080p",
          upgradeAllowed: true,
          cutoff: 3,
          cutoffFormatScore: 10_000,
          items: [{ quality: { id: 3, name: "WEBDL-1080p" }, allowed: true }],
        },
      ],
      getCustomFormats: async () => [],
    } as unknown as RadarrClient;
    const tools = createRadarrLookupTools({
      client,
      queueItem: { ...realDevilsRejectsQueueItem(), movieId: 77 },
      getCandidates: () => [
        { ...realDevilsRejectsCandidate(), movieId: 78, customFormatScore: 805 },
      ],
    });

    const grabbed = await executeTool(tools, "radarr_get_upgrade_context");
    const mapped = await executeTool(tools, "radarr_get_upgrade_context", { movieId: 78 });

    const decision = (details: Record<string, unknown>) =>
      (details.upgradeAssessment as Array<Record<string, unknown>>)[0]?.decision;
    expect(decision(grabbed)).not.toBe("import");
    expect((mapped.movie as Record<string, unknown>).id).toBe(78);
    expect(decision(mapped)).toBe("import");
  });
});
