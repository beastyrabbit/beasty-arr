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
    { quality: { id: 5, name: "WEBDL-720p" }, allowed: false },
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

  it("skips a non-German file whose quality the profile does not allow, even for a missing target", () => {
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

  // Batman TAS and ER S10E14: German "1080p" releases that inspection measures
  // as WEBDL-720p, which HD-1080p excludes, over English 1080p library files.
  const releaseQuality = quality(3, "WEBDL-1080p");
  it.each([
    ["missing target", false, undefined, releaseQuality, true, "import"],
    ["English library", true, [{ id: 1, name: "English" }], releaseQuality, true, "import"],
    ["German library", true, [{ id: 4, name: "German" }], releaseQuality, true, "skip"],
    ["unknown library language", true, [], releaseQuality, true, "skip"],
    ["missing release quality", false, undefined, undefined, true, "skip"],
    ["disallowed release quality", false, undefined, quality(19, "Bluray-2160p"), true, "skip"],
    // A German release-name label the probe did not confirm (GERMAN.SUBBED).
    ["German label without probed audio", false, undefined, releaseQuality, false, "skip"],
  ] as const)(
    "judges disallowed German quality for a %s",
    (_label, hasFile, languages, release, probed, expected) => {
      const result = assessCandidateUpgrade({
        candidate: {
          ...candidate({
            quality: quality(5, "WEBDL-720p"),
            languages: [{ id: 4, name: "German" }],
          }),
          releaseQuality: release,
          germanAudioProbed: probed,
        },
        episode: episode({
          hasFile,
          episodeFile: hasFile
            ? { quality: quality(3, "WEBDL-1080p"), languages: [...(languages ?? [])] }
            : undefined,
        }),
        profile,
      });
      expect(result.decision).toBe(expected);
      // A lower label would make the arr replace the German file with any
      // non-German 1080p, so the import carries the release quality.
      expect(result.importQuality).toEqual(expected === "import" ? releaseQuality : undefined);
    },
  );

  it("refuses the override when inspection heard German in an English-labelled library file", () => {
    const result = assessCandidateUpgrade({
      candidate: {
        ...candidate({ quality: quality(5, "WEBDL-720p"), languages: [{ id: 4, name: "German" }] }),
        releaseQuality,
        germanAudioProbed: true,
        germanLibraryTargetIds: [101],
      },
      episode: episode({
        episodeFile: { quality: quality(5, "WEBDL-720p"), languages: [{ id: 1, name: "English" }] },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.importQuality).toBeUndefined();
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

  it("imports a lower allowed quality when it adds German audio the library lacks", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({
        quality: quality(1, "HDTV-720p"),
        languages: [{ id: 4, name: "German" }],
      }),
      episode: episode({
        episodeFile: {
          quality: quality(7, "Bluray-1080p"),
          customFormatScore: 125,
          languages: [{ id: 1, name: "English" }],
        },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "import" });
    expect(result.reason).toContain("adds German audio");
  });

  it("respects a profile that forbids upgrades even when German would be added", () => {
    const result = assessCandidateUpgrade({
      candidate: candidate({
        quality: quality(1, "HDTV-720p"),
        languages: [{ id: 4, name: "German" }],
      }),
      episode: episode({
        episodeFile: {
          quality: quality(7, "Bluray-1080p"),
          languages: [{ id: 1, name: "English" }],
        },
      }),
      profile: { ...profile, upgradeAllowed: false },
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.reason).toContain("does not allow upgrades");
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

  it("does not import a PROPER that lowers the custom-format score", () => {
    // The Office S02E06-E12: WEBDL-1080p v2 at score 57 against the PCOK
    // WEBDL-1080p v1 at 575; Sonarr rejected these as "Not a Custom Format upgrade".
    const result = assessCandidateUpgrade({
      candidate: candidate({ quality: quality(3, "WEBDL-1080p", 2), customFormatScore: 57 }),
      episode: episode({
        episodeFile: { quality: quality(3, "WEBDL-1080p"), customFormatScore: 575 },
      }),
      profile,
    });
    expect(result).toMatchObject({ decision: "skip" });
    expect(result.reason).toContain("not an upgrade");
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
  it.each([
    ["one episode already German", [{ id: 4, name: "German" }], "skip", undefined],
    ["both episodes lacking German", [{ id: 1, name: "English" }], "import", true],
  ] as const)(
    "judges the release-quality override for a two-episode file with %s",
    (_label, secondLanguages, expected, relabeled) => {
      // E01 is missing; E02 has a 720p file. The German file measures WEBDL-720p
      // (outside HD-1080p) and was grabbed as WEBDL-1080p.
      const file: ManualImportCandidate = {
        id: "candidate_1",
        service: "sonarr",
        path: "/downloads/pack/e01e02.mkv",
        episodeIds: [101, 102],
        absoluteEpisodeNumbers: [],
        episodeLabels: [],
        languageLabels: ["German"],
        rejections: [],
        isLikelySample: false,
        ...candidate({ quality: quality(5, "WEBDL-720p"), languages: [{ id: 4, name: "German" }] }),
        releaseQuality: quality(3, "WEBDL-1080p"),
        germanAudioProbed: true,
      };
      const [result] = assessImportMappings({
        imports: [{ candidateId: "candidate_1", episodeIds: [101, 102] }],
        candidatesById: new Map([["candidate_1", file]]),
        episodesById: new Map<number, SonarrEpisodeRecord>([
          [101, episode({ id: 101, hasFile: false })],
          [
            102,
            episode({
              id: 102,
              episodeFile: { quality: quality(5, "WEBDL-720p"), languages: [...secondLanguages] },
            }),
          ],
        ]),
        profilesById: new Map([[6, profile]]),
      });
      expect(result?.assessment.decision).toBe(expected);
      expect(result?.assessment.importQuality !== undefined || undefined).toBe(relabeled);
    },
  );

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
