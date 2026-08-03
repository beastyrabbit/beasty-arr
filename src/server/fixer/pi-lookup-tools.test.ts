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

async function executeTool(tools: unknown[], name: string): Promise<Record<string, unknown>> {
  const tool = (tools as ExecutableTool[]).find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.execute("call_1", {}, undefined, undefined, undefined as never);
  return result.details as Record<string, unknown>;
}

describe("fixer upgrade-context tools", () => {
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
    const candidate = (details.candidates as Array<Record<string, unknown>>)[0];

    expect(currentFile).toMatchObject({
      languageMetadataPresent: true,
      hasGermanAudio: true,
    });
    expect(candidate).toMatchObject({
      languageMetadataPresent: true,
      hasGermanAudio: false,
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
      languageMetadataPresent: true,
      hasGermanAudio: true,
    });
    expect(candidate).toMatchObject({
      languageMetadataPresent: true,
      hasGermanAudio: false,
    });
  });
});
