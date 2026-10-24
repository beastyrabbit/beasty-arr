import { hasGermanAudio, hasKnownLanguageMetadata } from "../../shared/domain.js";
import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import type {
  SonarrEpisodeRecord,
  SonarrQualityProfileItem,
  SonarrQualityProfileRecord,
} from "../arr/sonarr-client.js";

/**
 * Deterministic per-file import decision, modelled on Sonarr's own
 * UpgradableSpecification plus the German-audio preference of this tool.
 *
 * - import: the target has no file, or the candidate is an upgrade.
 * - skip: the target already has an equal or better file.
 * - blocked: importing would replace German audio with non-German audio.
 * - unverified: Sonarr did not return enough data to compare.
 */
export type UpgradeDecision = "import" | "skip" | "blocked" | "unverified";

export interface UpgradeAssessment {
  decision: UpgradeDecision;
  reason: string;
  /** Quality to send with the import when it differs from the detected one. */
  importQuality?: unknown;
}

type ParsedQuality = {
  id?: number;
  name?: string;
  version: number;
  real: number;
};

function parseQuality(value: unknown): ParsedQuality | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { quality?: unknown; revision?: unknown; id?: unknown; name?: unknown };
  const inner =
    record.quality && typeof record.quality === "object"
      ? (record.quality as { id?: unknown; name?: unknown })
      : record;
  const id = Number(inner.id);
  const name = typeof inner.name === "string" ? inner.name : undefined;
  if (!Number.isFinite(id) && !name) return undefined;
  const revision =
    record.revision && typeof record.revision === "object"
      ? (record.revision as { version?: unknown; real?: unknown; isRepack?: unknown })
      : {};
  return {
    ...(Number.isFinite(id) ? { id } : {}),
    ...(name ? { name } : {}),
    version: Number.isFinite(Number(revision.version)) ? Number(revision.version) : 1,
    real: Number.isFinite(Number(revision.real)) ? Number(revision.real) : 0,
  };
}

type QualityRanking = {
  byId: Map<number, number>;
  byName: Map<string, number>;
  allowedIds: Set<number>;
  allowedNames: Set<string>;
  cutoffRank?: number;
};

function registerQuality(
  ranking: QualityRanking,
  item: SonarrQualityProfileItem,
  rank: number,
  cutoff: number | undefined,
): void {
  const quality = item.quality;
  if (!quality) return;
  if (typeof quality.id === "number") {
    ranking.byId.set(quality.id, rank);
    if (item.allowed) ranking.allowedIds.add(quality.id);
    if (cutoff === quality.id) ranking.cutoffRank = rank;
  }
  if (quality.name) {
    const name = quality.name.toLowerCase();
    ranking.byName.set(name, rank);
    if (item.allowed) ranking.allowedNames.add(name);
  }
}

function rankProfile(profile: SonarrQualityProfileRecord): QualityRanking {
  const ranking: QualityRanking = {
    byId: new Map(),
    byName: new Map(),
    allowedIds: new Set(),
    allowedNames: new Set(),
  };
  const visit = (item: SonarrQualityProfileItem, rank: number) => {
    registerQuality(ranking, item, rank, profile.cutoff);
    if (typeof item.id === "number" && profile.cutoff === item.id) ranking.cutoffRank = rank;
    for (const child of item.items ?? []) visit({ ...child, allowed: item.allowed }, rank);
  };
  for (const [index, item] of (profile.items ?? []).entries()) visit(item, index);
  return ranking;
}

function qualityRank(ranking: QualityRanking, quality: ParsedQuality): number | undefined {
  if (quality.id !== undefined && ranking.byId.has(quality.id)) return ranking.byId.get(quality.id);
  if (quality.name) return ranking.byName.get(quality.name.toLowerCase());
  return undefined;
}

function qualityAllowed(ranking: QualityRanking, quality: ParsedQuality): boolean {
  if (quality.id !== undefined && ranking.byId.has(quality.id)) {
    return ranking.allowedIds.has(quality.id);
  }
  return quality.name ? ranking.allowedNames.has(quality.name.toLowerCase()) : false;
}

function describeQuality(quality: ParsedQuality | undefined): string {
  if (!quality) return "unknown quality";
  const base = quality.name ?? `quality ${quality.id}`;
  return quality.version > 1 ? `${base} v${quality.version}` : base;
}

export interface AssessUpgradeInput {
  candidate: Pick<
    ManualImportCandidate,
    | "quality"
    | "releaseQuality"
    | "germanAudioProbed"
    | "inspectedLibraryAudio"
    | "customFormatScore"
    | "languages"
  >;
  episode: SonarrEpisodeRecord | undefined;
  profile: SonarrQualityProfileRecord | undefined;
}

/**
 * German audio the library lacks outranks the profile, but only at a quality
 * the profile allows: a file labelled below the cutoff is replaced by the
 * arr's next non-German quality upgrade, which re-grabs the German release in
 * a loop. So when inspection hears German in a file rated outside the profile (a
 * "1080p" release that is really 1280x960) and the quality the arr parsed
 * from the release name at grab time is allowed, assess and import it at that
 * release quality, as the arr itself rated it when grabbing.
 */
export function assessCandidateUpgrade(raw: AssessUpgradeInput): UpgradeAssessment {
  // The library file's languages as inspection heard them outrank the arr's
  // labels, which miss untagged German tracks and mislabel English ones, but
  // only while the library file is still the one inspected: a saved verdict
  // must not judge a file imported since.
  const inspected =
    raw.episode?.id !== undefined
      ? raw.candidate.inspectedLibraryAudio?.[raw.episode.id]
      : undefined;
  const file = raw.episode?.episodeFile;
  const input =
    inspected && file?.path !== undefined && file.path === inspected.path
      ? {
          ...raw,
          episode: { ...raw.episode, episodeFile: { ...file, languages: inspected.languages } },
        }
      : raw;
  const { candidate, episode, profile } = input;
  const ranking = profile ? rankProfile(profile) : undefined;
  const detected = parseQuality(candidate.quality);
  const release = parseQuality(candidate.releaseQuality);
  const existingLanguages = episode?.episodeFile?.languages ?? [];
  const addsGerman =
    hasGermanAudio(candidate.languages) &&
    ((episode?.hasFile !== true && episode?.episodeFile === undefined) ||
      (hasKnownLanguageMetadata(existingLanguages) && !hasGermanAudio(existingLanguages)));
  if (
    !episode ||
    !ranking ||
    !detected ||
    !release ||
    !addsGerman ||
    candidate.germanAudioProbed !== true ||
    qualityRank(ranking, detected) === undefined ||
    qualityAllowed(ranking, detected) ||
    !qualityAllowed(ranking, release)
  ) {
    return assessDetectedUpgrade(input);
  }
  const result = assessDetectedUpgrade({
    ...input,
    candidate: { ...candidate, quality: candidate.releaseQuality },
  });
  if (result.decision !== "import") return result;
  return {
    ...result,
    reason: `${result.reason} It is imported as ${describeQuality(release)}, the quality parsed from the release name, because the inspected ${describeQuality(detected)} is outside quality profile ${profileLabel(profile)} and the arr would replace it with a non-German upgrade.`,
    importQuality: candidate.releaseQuality,
  };
}

function assessDetectedUpgrade(input: AssessUpgradeInput): UpgradeAssessment {
  const { candidate, episode, profile } = input;
  if (!episode) {
    return { decision: "unverified", reason: "Sonarr did not return the target episode." };
  }
  const candidateQuality = parseQuality(candidate.quality);
  const ranking = profile ? rankProfile(profile) : undefined;
  if (
    ranking &&
    candidateQuality &&
    qualityRank(ranking, candidateQuality) !== undefined &&
    !qualityAllowed(ranking, candidateQuality)
  ) {
    return {
      decision: "skip",
      reason: `${describeQuality(candidateQuality)} is not allowed by quality profile ${profileLabel(profile)}.`,
    };
  }

  const existing = episode.episodeFile;
  if (episode.hasFile !== true && existing === undefined) {
    return { decision: "import", reason: "The target episode has no file." };
  }
  const existingLanguages = existing?.languages ?? [];
  if (
    hasKnownLanguageMetadata(candidate.languages) &&
    !hasGermanAudio(candidate.languages) &&
    hasGermanAudio(existingLanguages)
  ) {
    return {
      decision: "blocked",
      reason: "The candidate has no German audio but the existing file does.",
    };
  }

  const existingQuality = parseQuality(existing?.quality);
  if (!ranking || !candidateQuality || !existingQuality) {
    return {
      decision: "unverified",
      reason: ranking
        ? "Quality data is missing for the candidate or the existing file."
        : "The series quality profile is unavailable.",
    };
  }
  const candidateRank = qualityRank(ranking, candidateQuality);
  const existingRank = qualityRank(ranking, existingQuality);
  if (candidateRank === undefined || existingRank === undefined) {
    return {
      decision: "unverified",
      reason: "The quality profile does not rank the candidate or the existing file.",
    };
  }
  return compareWithExisting({
    profile,
    ranking,
    candidate: {
      quality: candidateQuality,
      rank: candidateRank,
      score: candidate.customFormatScore ?? 0,
      hasGerman: hasGermanAudio(candidate.languages),
    },
    existing: {
      quality: existingQuality,
      rank: existingRank,
      score: existing?.customFormatScore ?? 0,
      hasGerman: hasGermanAudio(existingLanguages),
    },
  });
}

function profileLabel(profile: SonarrQualityProfileRecord | undefined): string {
  return String(profile?.name ?? profile?.id ?? "unknown");
}

type RankedFile = { quality: ParsedQuality; rank: number; score: number; hasGerman: boolean };

type Comparison = {
  profile: SonarrQualityProfileRecord | undefined;
  ranking: QualityRanking;
  candidate: RankedFile;
  existing: RankedFile;
};

function describeFile(file: RankedFile): string {
  return `${describeQuality(file.quality)} (score ${file.score})`;
}

function compareWithExisting(input: Comparison): UpgradeAssessment {
  const { profile, ranking, candidate, existing } = input;
  if (profile?.upgradeAllowed === false) {
    return {
      decision: "skip",
      reason: `Quality profile ${profileLabel(profile)} does not allow upgrades and the target already has ${describeFile(existing)}.`,
    };
  }
  // German audio the library lacks is the goal, so an allowed quality that adds
  // it wins over a higher-ranked or better-scored file without German.
  if (candidate.hasGerman && !existing.hasGerman) {
    return {
      decision: "import",
      reason: `The candidate adds German audio to the existing ${describeFile(existing)}.`,
    };
  }
  if (candidate.rank < existing.rank) {
    return {
      decision: "skip",
      reason: `${describeFile(candidate)} is a quality downgrade from the existing ${describeFile(existing)}.`,
    };
  }
  if (candidate.rank > existing.rank) {
    const cutoffRank = ranking.cutoffRank;
    const cutoffScore = profile?.cutoffFormatScore ?? Number.POSITIVE_INFINITY;
    if (cutoffRank !== undefined && existing.rank >= cutoffRank && existing.score >= cutoffScore) {
      return {
        decision: "skip",
        reason: `The existing ${describeFile(existing)} already meets the profile cutoff.`,
      };
    }
    return {
      decision: "import",
      reason: `${describeFile(candidate)} is a quality upgrade over the existing ${describeFile(existing)}.`,
    };
  }
  return compareSameQuality(input);
}

function sameQuality(a: ParsedQuality, b: ParsedQuality): boolean {
  if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
  return a.name !== undefined && a.name.toLowerCase() === b.name?.toLowerCase();
}

/**
 * Equal rank means equal quality or two qualities sharing a profile group
 * (e.g. WEB 720p and 1080p). Like Sonarr, a PROPER/REPACK only outranks the
 * exact same quality; across a group the custom-format score decides. A newer
 * revision that lowers the custom-format score is not an upgrade either: the
 * arr rejects it as "Not a Custom Format upgrade", so the score decides then.
 */
function compareSameQuality(input: Comparison): UpgradeAssessment {
  const { profile, candidate, existing } = input;
  const revisionDelta = sameQuality(candidate.quality, existing.quality)
    ? candidate.quality.real - existing.quality.real ||
      candidate.quality.version - existing.quality.version
    : 0;
  if (revisionDelta > 0 && candidate.score >= existing.score) {
    return {
      decision: "import",
      reason: `${describeFile(candidate)} is a revision upgrade over the existing ${describeFile(existing)}.`,
    };
  }
  if (revisionDelta < 0) {
    return {
      decision: "skip",
      reason: `${describeFile(candidate)} is an older revision than the existing ${describeFile(existing)}.`,
    };
  }
  const cutoffScore = profile?.cutoffFormatScore;
  if (cutoffScore !== undefined && existing.score >= cutoffScore) {
    return {
      decision: "skip",
      reason: `The existing ${describeFile(existing)} already meets the custom format cutoff score ${cutoffScore}.`,
    };
  }
  const minUpgradeScore = Math.max(1, profile?.minUpgradeFormatScore ?? 1);
  if (candidate.score - existing.score >= minUpgradeScore) {
    return {
      decision: "import",
      reason: `${describeFile(candidate)} improves the custom format score of the existing ${describeFile(existing)}.`,
    };
  }
  return {
    decision: "skip",
    reason: `${describeFile(candidate)} is not an upgrade over the existing ${describeFile(existing)}.`,
  };
}

export interface AssessedImport {
  candidateId: string;
  episodeIds: number[];
  assessment: UpgradeAssessment;
}

/**
 * Aggregates per-episode assessments for one file. A file mapped to several
 * episodes is blocked if any target blocks it, unverified if any target could
 * not be checked, imported if any remaining target needs it, and skipped only
 * when every target already has an equal or better file.
 */
export function assessImportMappings(input: {
  imports: Array<{ candidateId: string; episodeIds: number[] }>;
  candidatesById: Map<string, ManualImportCandidate>;
  episodesById: Map<number, SonarrEpisodeRecord>;
  profilesById: Map<number, SonarrQualityProfileRecord>;
}): AssessedImport[] {
  return input.imports.map(({ candidateId, episodeIds }) => {
    const candidate = input.candidatesById.get(candidateId);
    if (!candidate) {
      return {
        candidateId,
        episodeIds,
        assessment: { decision: "unverified", reason: "Unknown candidate." },
      };
    }
    const perEpisode = episodeIds.map((episodeId) => {
      const episode = input.episodesById.get(episodeId);
      const profileId = episode?.series?.qualityProfileId;
      return assessCandidateUpgrade({
        candidate,
        episode,
        profile: profileId === undefined ? undefined : input.profilesById.get(profileId),
      });
    });
    const pick = (decision: UpgradeDecision) =>
      perEpisode.find((entry) => entry.decision === decision);
    // The release quality is file-wide, so it may replace the detected one only
    // when every mapped episode qualifies; otherwise a missing episode would
    // carry the file past the profile for an episode that already has German.
    const unqualified = perEpisode.some((entry) => entry.importQuality !== undefined)
      ? perEpisode.find((entry) => entry.importQuality === undefined)
      : undefined;
    if (unqualified) {
      return {
        candidateId,
        episodeIds,
        assessment: {
          decision: unqualified.decision === "import" ? "skip" : unqualified.decision,
          reason: `${unqualified.reason} The release-quality exception must hold for every episode the file covers.`,
        },
      };
    }
    const assessment = pick("blocked") ??
      pick("unverified") ??
      pick("import") ??
      pick("skip") ?? {
        decision: "unverified",
        reason: "No episode ids to compare.",
      };
    return { candidateId, episodeIds, assessment };
  });
}
