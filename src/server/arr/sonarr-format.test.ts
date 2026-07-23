import { describe, expect, it } from "vitest";
import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import { compactCandidate, episodeLabel } from "./sonarr-format.js";

describe("episodeLabel", () => {
  it("formats season and episode numbers with title", () => {
    expect(episodeLabel({ seasonNumber: 1, episodeNumber: 2, title: "Pilot" })).toBe(
      "S01E02 - Pilot",
    );
  });

  it("formats absolute-number-only episodes", () => {
    expect(episodeLabel({ absoluteEpisodeNumber: 42, title: "Long Day" })).toBe("A42 - Long Day");
  });

  it("formats numbered episodes with no title", () => {
    expect(episodeLabel({ seasonNumber: 3, episodeNumber: 7 })).toBe("S03E07");
  });
});

describe("compactCandidate", () => {
  const candidate: ManualImportCandidate = {
    id: "candidate_1",
    service: "sonarr",
    path: "/downloads/show/s01/episode.mkv",
    relativePath: "episode.mkv",
    folderName: "show",
    name: "episode",
    size: 1024,
    seriesId: 12,
    seriesTitle: "Show",
    seasonNumber: 1,
    episodeIds: [34],
    absoluteEpisodeNumbers: [34],
    episodeLabels: ["S01E02"],
    qualityLabel: "WEBRip-720p",
    languages: [],
    languageLabels: ["German"],
    customFormatLabels: ["Anime Dual Audio"],
    customFormatScore: 100,
    rejections: [],
    isLikelySample: false,
  };

  it("preserves the fields Pi relies on for the prompt", () => {
    const compact = compactCandidate(candidate);
    // seasonNumber and customFormatScore are load-bearing clues for season-pack / non-upgrade decisions.
    expect(compact.seasonNumber).toBe(1);
    expect(compact.customFormatScore).toBe(100);
    expect(compact.customFormats).toEqual(["Anime Dual Audio"]);
    expect(compact.seriesId).toBe(12);
    expect(compact.quality).toBe("WEBRip-720p");
    expect(compact.languages).toEqual(["German"]);
  });
});
