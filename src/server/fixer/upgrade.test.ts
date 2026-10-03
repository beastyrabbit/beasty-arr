import { describe, expect, it } from "vitest";
import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import type { SonarrEpisodeRecord, SonarrQualityProfileRecord } from "../arr/sonarr-client.js";
import { assessCandidateUpgrade, assessImportMappings } from "./upgrade.js";

const profile: SonarrQualityProfileRecord = {
  id: 6,
  name: "HD-1080p",
  upgradeAllowed: true,
  cutoff: 1000,
  cutoffFormatScore: 10_000,
  minUpgradeFormatScore: 1,
  items: [
    { quality: { id: 1, name: "HDTV-720p" }, allowed: true },
    {
      id: 1000,
      name: "WEB 1080p",
      allowed: true,
      items: [
        { quality: { id: 3, name: "WEBDL-1080p" } },
        { quality: { id: 15, name: "WEBRip-1080p" } },
      ],
    },
    { quality: { id: 7, name: "Bluray-1080p" }, allowed: true },
    { quality: { id: 19, name: "Bluray-2160p" }, allowed: false },
  ],
};

function quality(id: number, name: string, version = 1) {
  return { quality: { id, name }, revision: { version, real: 0, isRepack: version > 1 } };
}

function candidate(
  over: Partial<Pick<ManualImportCandidate, "quality" | "customFormatScore" | "languages">> = {},
) {
  return {
    quality: quality(3, "WEBDL-1080p"),
    customFormatScore: 125,
    languages: [{ id: 1, name: "English" }],
    ...over,
  };
}

function episode(over: Partial<SonarrEpisodeRecord> = {}): SonarrEpisodeRecord {
  return { id: 101, hasFile: true, series: { id: 5, qualityProfileId: 6 }, ...over };
}

describe("assessCandidateUpgrade", () => {
  it("imports when the target has no file", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate(),
      episode: episode({ hasFile: false, episodeFile: undefined }),
      profile,
    });
    expect(result.decision).toBe("import");
  });

  it("skips a file whose quality the profile does not allow, even for a missing target", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(19, "Bluray-2160p") }),
      episode: episode({ hasFile: false }),
      profile,
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.reason).toContain("not allowed");
  });

  it("skips an equal file with an equal score", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate(),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 125 },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.reason).toContain("not an upgrade");
  });

  it("imports a higher custom format score at equal quality", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ customFormatScore: 200 }),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 125 },
      }),
      profile,
    });
    expect(result.decision).toBe("import");
  });

  it("skips a quality downgrade even with a better score", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(1, "HDTV-720p"), customFormatScore: 9_000 }),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 125 },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.reason).toContain("downgrade");
  });

  it("imports a quality upgrade below the cutoff and skips once the cutoff is met", () => {
    const upgrade = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(3, "WEBDL-1080p") }),
      episode: episode({
        episodeFile: { quality: quality(1, "HDTV-720p"), customFormatScore: 0 },
      }),
      profile,
    });
    expect(upgrade.decision).toBe("import");

    const atCutoff = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(7, "Bluray-1080p") }),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 10_000 },
      }),
      profile,
    });
    expect(atCutoff).toMatchObject({ decision: "skip" });
    expect(atCutoff.reason).toContain("cutoff");
  });

  it("imports a proper revision of the same quality", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(3, "WEBDL-1080p", 2) }),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 125 },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "import" });
    expect(result.reason).toContain("revision");
  });

  it("lets a proper outrank only the exact same quality, not a grouped sibling", () => {
    // Real 24 S09E12 case: a WEBDL-720p PROPER replaced a 1080p file because
    // the profile groups 720p with 1080p and the revision won the comparison.
    const groupedProfile: SonarrQualityProfileRecord = {
      ...profile,
      items: [
        {
          id: 1001,
          name: "HD",
          allowed: true,
          items: [
            { quality: { id: 5, name: "WEBDL-720p" } },
            { quality: { id: 3, name: "WEBDL-1080p" } },
          ],
        },
      ],
    };
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(5, "WEBDL-720p", 2), customFormatScore: 12 }),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 50 },
      }),
      profile: groupedProfile,
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.reason).not.toContain("revision");
  });

  it("imports when German audio is added, regardless of custom format score", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ languages: [{ id: 4, name: "German" }], customFormatScore: 0 }),
      episode: episode({
        episodeFile: {
          quality: quality(3, "WEBDL-1080p"),
          customFormatScore: 407,
          languages: [{ id: 1, name: "English" }],
        },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "import" });
    expect(result.reason).toContain("German");
  });

  it("blocks a non-German file over a German file", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(7, "Bluray-1080p"), customFormatScore: 9_000 }),
      episode: episode({
        episodeFile: {
          quality: quality(3, "WEBDL-1080p"),
          customFormatScore: 100,
          languages: [{ id: 4, name: "German" }],
        },
      }),
      profile,
    });
    expect(result.decision).toBe("blocked");
  });

  it("skips upgrades when the profile forbids them", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(7, "Bluray-1080p") }),
      episode: episode({
        episodeFile: { quality: quality(1, "HDTV-720p"), customFormatScore: 0 },
      }),
      profile: { ...profile, upgradeAllowed: false },
    });
    expect(result.decision).toBe("skip");
  });

  it("is unverified without a profile or episode data", () => {
    expect(
      assessCandidateUpgrade({
        candidate: candidate(),
        episode: episode({ episodeFile: { quality: quality(3, "WEBDL-1080p") } }),
        profile: undefined,
      }).decision,
    ).toBe("unverified");
    expect(
      assessCandidateUpgrade({ candidate: candidate(), episode: undefined, profile }).decision,
    ).toBe("unverified");
  });
});

describe("assessImportMappings", () => {
  it("aggregates per file: blocked, then unverified, then import; skip only when every target is satisfied", () => {
    const base: ManualImportCandidate = {
      id: "candidate_1",
      service: "sonarr",
      path: "/downloads/pack/e01e02.mkv",
      episodeIds: [101, 102],
      absoluteEpisodeNumbers: [],
      episodeLabels: [],
      languageLabels: ["English"],
      rejections: [],
      isLikelySample: false,
      ...candidate(),
    };
    const episodesById = new Map<number, SonarrEpisodeRecord>([
      [
        101,
        episode({
          id: 101,
          episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 125 },
        }),
      ],
      [102, episode({ id: 102, hasFile: false })],
    ]);
    const profilesById = new Map([[6, profile]]);
    const [mixed] = assessImportMappings({
      imports: [{ candidateId: "candidate_1", episodeIds: [101, 102] }],
      candidatesById: new Map([["candidate_1", base]]),
      episodesById,
      profilesById,
    });
    expect(mixed?.assessment.decision).toBe("import");

    const [satisfied] = assessImportMappings({
      imports: [{ candidateId: "candidate_1", episodeIds: [101] }],
      candidatesById: new Map([["candidate_1", base]]),
      episodesById,
      profilesById,
    });
    expect(satisfied?.assessment.decision).toBe("skip");

    const [partlyUnverified] = assessImportMappings({
      imports: [{ candidateId: "candidate_1", episodeIds: [102, 103] }],
      candidatesById: new Map([["candidate_1", base]]),
      episodesById,
      profilesById,
    });
    expect(partlyUnverified?.assessment.decision).toBe("unverified");
  });
});
