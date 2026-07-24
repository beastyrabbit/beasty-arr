import { describe, expect, it } from "vitest";
import type { HuntState } from "../../shared/domain.js";
import {
  AI_PAUSE_MIN_MS,
  aiPausedUntilFor,
  type DeriveStateInput,
  deriveState,
  originalLanguageAccepted,
  reconcileDerivedState,
} from "./state.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

const GERMAN = { id: 4, name: "German" };
const ENGLISH = { id: 1, name: "English" };

function base(over: Partial<DeriveStateInput> = {}): DeriveStateInput {
  return {
    kind: "episode",
    monitored: true,
    hasFile: false,
    hasGerman: false,
    airDateUtc: NOW - 30 * DAY,
    fileLanguages: null,
    qualityCutoffNotMet: null,
    languageCutoffNotMet: null,
    customFormatScore: null,
    profile: null,
    override: null,
    verdict: null,
    originalLanguage: "English",
    acceptedOriginalLanguages: [],
    now: NOW,
    ...over,
  };
}

function movie(over: Partial<DeriveStateInput> = {}): DeriveStateInput {
  return base({
    kind: "movie",
    airDateUtc: undefined,
    isAvailable: true,
    status: "released",
    ...over,
  });
}

const unlikelyVerdict = {
  verdict: "unlikely" as const,
  confidence: 0.85,
  recheckAfter: NOW + 200 * DAY,
};

describe("deriveState — table", () => {
  const cases: [string, DeriveStateInput, HuntState][] = [
    // unreleased
    ["episode with TBA air date", base({ airDateUtc: null }), "unreleased"],
    ["episode airing in the future", base({ airDateUtc: NOW + DAY }), "unreleased"],
    ["movie not yet available", movie({ isAvailable: false }), "unreleased"],
    [
      "movie without availability, status announced",
      movie({ isAvailable: null, status: "announced" }),
      "unreleased",
    ],
    [
      "movie without availability, status inCinemas",
      movie({ isAvailable: null, status: "inCinemas" }),
      "unreleased",
    ],
    [
      "movie without availability, status released",
      movie({ isAvailable: null, status: "released" }),
      "missing",
    ],
    [
      "unreleased wins over unmonitored",
      base({ airDateUtc: null, monitored: false }),
      "unreleased",
    ],
    [
      "unreleased wins over ignore override",
      base({ airDateUtc: null, override: { targetMode: "ignore" } }),
      "unreleased",
    ],
    [
      "a file on disk trumps a future air date",
      base({ airDateUtc: NOW + DAY, hasFile: true, fileLanguages: [GERMAN] }),
      "german",
    ],
    [
      "a file on disk trumps movie unavailability",
      movie({ isAvailable: false, hasFile: true, fileLanguages: [ENGLISH] }),
      "non_german",
    ],

    // unmonitored
    ["unmonitored without file", base({ monitored: false }), "unmonitored"],
    [
      "unmonitored wins over german file",
      base({ monitored: false, hasFile: true, fileLanguages: [GERMAN] }),
      "unmonitored",
    ],
    [
      "unmonitored wins over ignore override",
      base({ monitored: false, override: { targetMode: "ignore" } }),
      "unmonitored",
    ],

    // ignored
    ["ignore override", base({ override: { targetMode: "ignore" } }), "ignored"],
    [
      "ignore override wins over german file",
      base({ override: { targetMode: "ignore" }, hasFile: true, fileLanguages: [GERMAN] }),
      "ignored",
    ],

    // german (done)
    ["file with German language id 26", base({ hasFile: true, fileLanguages: [GERMAN] }), "german"],
    [
      "file with language named german (unknown id)",
      base({ hasFile: true, fileLanguages: [{ id: 999, name: "german" }] }),
      "german",
    ],
    [
      "hasGerman flag already derived",
      base({ hasFile: true, hasGerman: true, fileLanguages: null }),
      "german",
    ],
    [
      "original_ok override with non-German file",
      base({ hasFile: true, fileLanguages: [ENGLISH], override: { targetMode: "original_ok" } }),
      "german",
    ],
    [
      "German-original series with any file",
      base({ hasFile: true, fileLanguages: [ENGLISH], originalLanguage: "German" }),
      "german",
    ],
    [
      "accepted original language (anime japanese)",
      base({
        hasFile: true,
        fileLanguages: [{ id: 8, name: "Japanese" }],
        originalLanguage: "Japanese",
        acceptedOriginalLanguages: ["japanese"],
      }),
      "german",
    ],
    [
      "german audio without a file is NOT done",
      base({ hasGerman: true, hasFile: false }),
      "missing",
    ],

    // profile_blocked
    [
      "upgrades disabled with non-German file",
      base({
        hasFile: true,
        fileLanguages: [ENGLISH],
        profile: { upgradeAllowed: false, cutoffFormatScore: 10000 },
      }),
      "profile_blocked",
    ],
    [
      "all cutoffs met and score at cutoff",
      base({
        hasFile: true,
        fileLanguages: [ENGLISH],
        qualityCutoffNotMet: false,
        languageCutoffNotMet: false,
        customFormatScore: 10000,
        profile: { upgradeAllowed: true, cutoffFormatScore: 10000 },
      }),
      "profile_blocked",
    ],
    [
      "cutoffs met but score below cutoff — arr can still upgrade",
      base({
        hasFile: true,
        fileLanguages: [ENGLISH],
        qualityCutoffNotMet: false,
        languageCutoffNotMet: false,
        customFormatScore: 500,
        profile: { upgradeAllowed: true, cutoffFormatScore: 10000 },
      }),
      "non_german",
    ],
    [
      "quality cutoff not met — upgradable",
      base({
        hasFile: true,
        fileLanguages: [ENGLISH],
        qualityCutoffNotMet: true,
        languageCutoffNotMet: false,
        customFormatScore: 10000,
        profile: { upgradeAllowed: true, cutoffFormatScore: 10000 },
      }),
      "non_german",
    ],
    [
      "episode with unknown language cutoff is not blocked",
      base({
        hasFile: true,
        fileLanguages: [ENGLISH],
        qualityCutoffNotMet: false,
        languageCutoffNotMet: null,
        customFormatScore: 10000,
        profile: { upgradeAllowed: true, cutoffFormatScore: 10000 },
      }),
      "non_german",
    ],
    [
      "movie ignores the (nonexistent) language cutoff",
      movie({
        hasFile: true,
        fileLanguages: [ENGLISH],
        qualityCutoffNotMet: false,
        languageCutoffNotMet: null,
        customFormatScore: 10000,
        profile: { upgradeAllowed: true, cutoffFormatScore: 10000 },
      }),
      "profile_blocked",
    ],
    [
      "german file is done even when upgrades are off",
      base({
        hasFile: true,
        fileLanguages: [GERMAN],
        profile: { upgradeAllowed: false, cutoffFormatScore: 0 },
      }),
      "german",
    ],
    [
      "missing file is never profile_blocked",
      base({ hasFile: false, profile: { upgradeAllowed: false, cutoffFormatScore: 0 } }),
      "missing",
    ],

    // ai_paused
    [
      "unlikely verdict at confidence pauses a missing item",
      base({ verdict: unlikelyVerdict, aiPausedUntil: NOW + 100 * DAY, aiPauseConfidence: 0.7 }),
      "ai_paused",
    ],
    [
      "unlikely verdict pauses upgrade hunts on a non-German file too",
      base({
        hasFile: true,
        fileLanguages: [ENGLISH],
        verdict: unlikelyVerdict,
        aiPausedUntil: NOW + 100 * DAY,
      }),
      "ai_paused",
    ],
    [
      "confidence below threshold does not pause",
      base({
        verdict: { ...unlikelyVerdict, confidence: 0.6 },
        aiPausedUntil: NOW + 100 * DAY,
        aiPauseConfidence: 0.7,
      }),
      "missing",
    ],
    [
      "expired pause window does not pause",
      base({ verdict: unlikelyVerdict, aiPausedUntil: NOW - 1 }),
      "missing",
    ],
    [
      "non-unlikely verdicts never pause",
      base({
        verdict: { verdict: "exists", confidence: 0.99, recheckAfter: NOW + 100 * DAY },
        aiPausedUntil: NOW + 100 * DAY,
      }),
      "missing",
    ],
    [
      "falls back to recheckAfter when no aiPausedUntil is given",
      base({ verdict: unlikelyVerdict }),
      "ai_paused",
    ],
    [
      "german file wins over an unlikely verdict",
      base({
        hasFile: true,
        fileLanguages: [GERMAN],
        verdict: unlikelyVerdict,
        aiPausedUntil: NOW + 100 * DAY,
      }),
      "german",
    ],

    // missing / non_german
    ["aired and no file", base(), "missing"],
    ["available movie and no file", movie(), "missing"],
    ["file without German audio", base({ hasFile: true, fileLanguages: [ENGLISH] }), "non_german"],
    [
      "file with no language info at all",
      base({ hasFile: true, fileLanguages: null }),
      "non_german",
    ],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(deriveState(input)).toBe(expected);
  });

  it("never returns exhausted (tier-driven, engine-applied)", () => {
    for (const [, input] of cases) {
      expect(deriveState(input)).not.toBe("exhausted");
    }
  });
});

describe("reconcileDerivedState", () => {
  it("preserves exhausted while the tier still warrants it", () => {
    expect(reconcileDerivedState({ state: "exhausted", tier: 6 }, "missing")).toBe("exhausted");
    expect(reconcileDerivedState({ state: "exhausted", tier: 7 }, "non_german")).toBe("exhausted");
  });

  it("lets real transitions out of exhausted through", () => {
    expect(reconcileDerivedState({ state: "exhausted", tier: 6 }, "german")).toBe("german");
    expect(reconcileDerivedState({ state: "exhausted", tier: 6 }, "unmonitored")).toBe(
      "unmonitored",
    );
    expect(reconcileDerivedState({ state: "exhausted", tier: 6 }, "ai_paused")).toBe("ai_paused");
  });

  it("drops exhausted once the tier no longer warrants it", () => {
    expect(reconcileDerivedState({ state: "exhausted", tier: 2 }, "missing")).toBe("missing");
  });

  it("passes ordinary states through untouched", () => {
    expect(reconcileDerivedState({ state: "missing", tier: 0 }, "german")).toBe("german");
    expect(reconcileDerivedState({ state: "german", tier: 0 }, "missing")).toBe("missing");
  });
});

describe("helpers", () => {
  it("aiPausedUntilFor takes the max of 180d and recheckAfter", () => {
    const checkedAt = NOW;
    expect(aiPausedUntilFor({ checkedAt, recheckAfter: NOW + DAY })).toBe(
      checkedAt + AI_PAUSE_MIN_MS,
    );
    expect(aiPausedUntilFor({ checkedAt, recheckAfter: NOW + 400 * DAY })).toBe(NOW + 400 * DAY);
  });

  it("originalLanguageAccepted matches german and the accepted list, case-insensitively", () => {
    expect(originalLanguageAccepted("German", [])).toBe(true);
    expect(originalLanguageAccepted("deutsch", [])).toBe(true);
    expect(originalLanguageAccepted("Japanese", ["japanese"])).toBe(true);
    expect(originalLanguageAccepted("Japanese", ["Korean"])).toBe(false);
    expect(originalLanguageAccepted(null, ["japanese"])).toBe(false);
    expect(originalLanguageAccepted("English", [])).toBe(false);
  });
});
