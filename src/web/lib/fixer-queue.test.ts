import { describe, expect, it } from "vitest";
import type { FixerQueueItemDto } from "../../shared/api-types.js";
import { uniqueQueueItems, waitsForReview } from "./fixer-queue.js";

function item(overrides: Partial<FixerQueueItemDto>): FixerQueueItemDto {
  return {
    id: 1,
    service: "sonarr",
    title: "Show.S01E01",
    episodeIds: [101],
    absoluteEpisodeNumbers: [],
    episodeLabels: ["S01E01"],
    statusMessages: [],
    canAnalyze: true,
    issueType: "warning",
    analysisId: null,
    analysisState: null,
    confidence: null,
    ...overrides,
  };
}

describe("Fixer queue presentation", () => {
  it("shows one row per service/download and prefers the row with the analysis", () => {
    const rows = uniqueQueueItems([
      item({ id: 1, downloadId: "pack" }),
      item({ id: 2, downloadId: "pack", analysisId: "analysis-2", analysisState: "proposal" }),
      item({ id: 3, service: "radarr", downloadId: "pack" }),
      item({ id: 4 }),
    ]);

    expect(rows.map((row) => `${row.service}:${row.id}`)).toEqual([
      "sonarr:2",
      "radarr:3",
      "sonarr:4",
    ]);
  });

  it("counts proposals and needs-review results as waiting, not running", () => {
    expect(waitsForReview(item({ analysisState: "proposal" }))).toBe(true);
    expect(waitsForReview(item({ analysisState: "needs_review" }))).toBe(true);
    expect(waitsForReview(item({ analysisState: "analyzing" }))).toBe(false);
  });
});
