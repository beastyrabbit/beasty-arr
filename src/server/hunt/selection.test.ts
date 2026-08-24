import { describe, expect, it } from "vitest";
import {
  candidateLabel,
  episodeCode,
  firstUpgradeBlockedUntil,
  groupCommands,
  type HuntCandidate,
  interleaveByRatio,
  parseRatio,
  priorityScore,
} from "./selection.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function cand(over: Partial<HuntCandidate> & { huntStateId: number }): HuntCandidate {
  return {
    source: "sonarr",
    kind: "episode",
    targetId: over.huntStateId * 10,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: over.huntStateId,
    title: "Dark",
    year: null,
    anime: false,
    score: 0,
    bucket: "missing",
    searchCount: 0,
    manualPriority: 0,
    ...over,
  };
}

describe("priorityScore", () => {
  it("implements 400·due + 300·exists + 2·recency − 50·tier − 5·count", () => {
    expect(
      priorityScore({
        announcedDue: true,
        existsVerdict: true,
        daysSinceRelease: 100,
        tier: 2,
        searchCount: 3,
      }),
    ).toBe(400 + 300 + 2 * 265 - 100 - 15);
  });

  it("gives no recency boost for unknown or ancient releases", () => {
    const base = { announcedDue: false, existsVerdict: false, tier: 0, searchCount: 0 };
    expect(priorityScore({ ...base, daysSinceRelease: null })).toBe(0);
    expect(priorityScore({ ...base, daysSinceRelease: 400 })).toBe(0);
    // Future dates (negative days) clamp to the max boost, not beyond.
    expect(priorityScore({ ...base, daysSinceRelease: -10 })).toBe(730);
  });
});

describe("parseRatio / interleaveByRatio", () => {
  it("parses a:b and falls back to 1:2 on malformed input", () => {
    expect(parseRatio("1:2")).toEqual({ missing: 1, upgrade: 2 });
    expect(parseRatio("3:1")).toEqual({ missing: 3, upgrade: 1 });
    expect(parseRatio("bogus")).toEqual({ missing: 1, upgrade: 2 });
    expect(parseRatio("0:0")).toEqual({ missing: 1, upgrade: 2 });
  });

  it("interleaves 1 missing : 2 upgrades and drains leftovers", () => {
    const out = interleaveByRatio(["m1", "m2", "m3"], ["u1", "u2", "u3", "u4"], {
      missing: 1,
      upgrade: 2,
    });
    expect(out).toEqual(["m1", "u1", "u2", "m2", "u3", "u4", "m3"]);
  });

  it("handles a degenerate 0:n ratio without hanging", () => {
    expect(interleaveByRatio(["m1", "m2"], [], { missing: 0, upgrade: 2 })).toEqual(["m1", "m2"]);
  });
});

describe("firstUpgradeBlockedUntil", () => {
  const T0 = Date.UTC(2026, 5, 1);
  it("blocks until fileImportedAt + dubLagDays when never searched since import", () => {
    expect(
      firstUpgradeBlockedUntil({ fileImportedAt: T0, lastSearchAt: null, dubLagDays: 7 }),
    ).toBe(T0 + 7 * DAY_MS);
    expect(
      firstUpgradeBlockedUntil({ fileImportedAt: T0, lastSearchAt: T0 - DAY_MS, dubLagDays: 7 }),
    ).toBe(T0 + 7 * DAY_MS);
  });

  it("does not gate once a search ran after the import, or with no import", () => {
    expect(
      firstUpgradeBlockedUntil({ fileImportedAt: T0, lastSearchAt: T0 + 1, dubLagDays: 7 }),
    ).toBeNull();
    expect(
      firstUpgradeBlockedUntil({ fileImportedAt: null, lastSearchAt: null, dubLagDays: 7 }),
    ).toBeNull();
  });
});

describe("groupCommands", () => {
  it("groups >=3 episodes sharing series+season into one SeasonSearch (searchOps=1)", () => {
    const commands = groupCommands([
      cand({ huntStateId: 1, seasonNumber: 3 }),
      cand({ huntStateId: 2, seasonNumber: 3 }),
      cand({ huntStateId: 3, seasonNumber: 3 }),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "SeasonSearch",
      kind: "tv",
      searchOps: 1,
      label: "Dark S03",
      payload: { name: "SeasonSearch", seriesId: 1, seasonNumber: 3 },
    });
    expect(commands[0].covered.map((c) => c.huntStateId)).toEqual([1, 2, 3]);
  });

  it("puts <3 episodes into an EpisodeSearch capped at 5 ids, batched per series", () => {
    const commands = groupCommands([
      cand({ huntStateId: 1, seasonNumber: 1 }),
      cand({ huntStateId: 2, seasonNumber: 2 }),
      cand({ huntStateId: 3, seriesId: 2, title: "Other" }),
    ]);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      name: "EpisodeSearch",
      searchOps: 2,
      payload: { name: "EpisodeSearch", episodeIds: [10, 20] },
    });
    expect(commands[1]).toMatchObject({
      name: "EpisodeSearch",
      searchOps: 1,
      payload: { episodeIds: [30] },
    });
  });

  it("keeps a season-pack season out of a same-series EpisodeSearch", () => {
    const commands = groupCommands([
      cand({ huntStateId: 1, seasonNumber: 1 }),
      cand({ huntStateId: 2, seasonNumber: 2 }),
      cand({ huntStateId: 3, seasonNumber: 2 }),
      cand({ huntStateId: 4, seasonNumber: 2 }),
      cand({ huntStateId: 5, seasonNumber: 1 }),
    ]);
    expect(commands.map((c) => c.name)).toEqual(["EpisodeSearch", "SeasonSearch"]);
    expect(commands[0].covered.map((c) => c.huntStateId)).toEqual([1, 5]);
    expect(commands[1].covered.map((c) => c.huntStateId)).toEqual([2, 3, 4]);
  });

  it("caps EpisodeSearch at 5 ids and leaves the rest for the next command", () => {
    const sixSingles = [1, 2, 3, 4, 5, 6].map((i) =>
      cand({ huntStateId: i, seasonNumber: i, episodeNumber: 1 }),
    );
    const commands = groupCommands(sixSingles);
    expect(commands).toHaveLength(2);
    expect(commands[0].searchOps).toBe(5);
    expect(commands[1].searchOps).toBe(1);
  });

  it("batches movies into MoviesSearch capped at 3, preserving priority order", () => {
    const movie = (id: number, title: string) =>
      cand({ huntStateId: id, kind: "movie", targetId: id, seriesId: null, title, year: 2020 });
    const commands = groupCommands([
      movie(1, "Alpha"),
      cand({ huntStateId: 9, seriesId: 5, title: "Show" }),
      movie(2, "Beta"),
      movie(3, "Gamma"),
      movie(4, "Delta"),
    ]);
    expect(commands.map((c) => c.name)).toEqual(["MoviesSearch", "EpisodeSearch", "MoviesSearch"]);
    expect(commands[0]).toMatchObject({
      kind: "movie",
      searchOps: 3,
      label: "Alpha (2020) +2",
      payload: { name: "MoviesSearch", movieIds: [1, 2, 3] },
    });
    expect(commands[2].payload).toMatchObject({ movieIds: [4] });
  });

  it("flags anime when any covered episode is anime", () => {
    const commands = groupCommands([
      cand({ huntStateId: 1 }),
      cand({ huntStateId: 2, anime: true }),
    ]);
    expect(commands[0].anime).toBe(true);
  });

  it("uses individually budgetable EpisodeSearch commands for anime seasons", () => {
    const commands = groupCommands([
      cand({ huntStateId: 1, anime: true }),
      cand({ huntStateId: 2, anime: true }),
      cand({ huntStateId: 3, anime: true }),
    ]);
    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command.name === "EpisodeSearch")).toBe(true);
    expect(commands.every((command) => command.anime && command.searchOps === 1)).toBe(true);
  });
});

describe("labels", () => {
  it("formats episode and movie labels", () => {
    expect(episodeCode(3, 7)).toBe("S03E07");
    expect(candidateLabel(cand({ huntStateId: 1, seasonNumber: 2, episodeNumber: 4 }))).toBe(
      "Dark S02E04",
    );
    expect(
      candidateLabel(
        cand({ huntStateId: 1, kind: "movie", title: "Heat", year: 1995, seriesId: null }),
      ),
    ).toBe("Heat (1995)");
  });
});
