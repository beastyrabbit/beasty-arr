import { describe, expect, it } from "vitest";
import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import { animeTitleConflict } from "./anime-title-match.js";

const candidate = (name: string): ManualImportCandidate => ({
  id: "candidate_1",
  service: "sonarr",
  path: `/downloads/${name}.mkv`,
  name,
  episodeIds: [],
  absoluteEpisodeNumbers: [],
  episodeLabels: [],
  languages: [{ id: 1, name: "English" }],
  languageLabels: ["English"],
  rejections: [],
  isLikelySample: false,
});

const episodes = [
  { id: 9, title: "Jamming with Edward" },
  { id: 13, title: "Jupiter Jazz (2)" },
  { id: 22, title: "Cowboy Funk" },
];

describe("animeTitleConflict", () => {
  it("blocks a filename that explicitly names another episode", () => {
    expect(
      animeTitleConflict(
        candidate("Kauboi.bibappu.S01E09.Jamming.with.Edward.1080p"),
        episodes[1]!,
        episodes,
      ),
    ).toContain("Jamming with Edward");
  });

  it("accepts an explicit matching title", () => {
    expect(
      animeTitleConflict(
        candidate("Kauboi.bibappu.S01E22.Cowboy.Funk.1080p"),
        episodes[2]!,
        episodes,
      ),
    ).toBeNull();
  });

  it("does not block when the filename contains no recognizable episode title", () => {
    expect(animeTitleConflict(candidate("Show.S01E13.1080p"), episodes[1]!, episodes)).toBeNull();
  });

  it("ignores an episode titled like the series itself (real Re:Zero S04E09)", () => {
    // Every Re:Zero file name carries the series name, and one Sonarr episode is
    // titled exactly that, which used to hold every correct import for review.
    const reZero = [
      { id: 1, title: "Re:ZERO -Starting Life in Another World-" },
      { id: 86592, title: "Empty Shell" },
    ];
    expect(
      animeTitleConflict(
        {
          ...candidate("Re.ZERO.Starting.Life.in.Another.World.2020.S04E09.German.ML.1080p"),
          seriesTitle: "Re: ZERO, Starting Life in Another World",
        },
        reZero[1]!,
        reZero,
      ),
    ).toBeNull();
  });
});
