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

function rankProfile(profile: SonarrQualityProfileRecord): QualityRanking {
  const ranking: QualityRanking = {
    byId: new Map(),
    byName: new Map(),
    allowedIds: new Set(),
    allowedNames: new Set(),
  };
  const visit = (item: SonarrQualityProfileItem, rank: number) => {
    if (item.quality) {
      if (typeof item.quality.id === "number") {
        ranking.byId.set(item.quality.id, rank);
        if (item.allowed) ranking.allowedIds.add(item.quality.id);
        if (profile.cutoff === item.quality.id) ranking.cutoffRank = rank;
      }
      if (item.quality.name) {
        const name = item.quality.name.toLowerCase();
        ranking.byName.set(name, rank);
        if (item.allowed) ranking.allowedNames.add(name);
      }
    }
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
  candidate: Pick<ManualImportCandidate, "quality" | "customFormatScore" | "languages">;
  episode: SonarrEpisodeRecord | undefined;
  profile: SonarrQualityProfileRecord | undefined;
}

export function assessCandidateUpgrade(input: AssessUpgradeInput): UpgradeAssessment {
  const { candidate, episode, profile } = input;
  if (!episode) {
    return { decision: "unverified", reason: "Sonarr did not return the target episode." };
  }
  const existing = episode.episodeFile;
  const hasFile = episode.hasFile === true || existing !== undefined;
  const candidateQuality = parseQuality(candidate.quality);
  const ranking = profile ? rankProfile(profile) : undefined;

  if (ranking && candidateQuality && qualityRank(ranking, candidateQuality) !== undefined) {
    if (!qualityAllowed(ranking, candidateQuality)) {
      return {
        decision: "skip",
        reason: `${describeQuality(candidateQuality)} is not allowed by quality profile ${profile?.name ?? profile?.id}.`,
      };
    }
  }

  if (!hasFile) {
    return { decision: "import", reason: "The target episode has no file." };
  }

  const existingLanguages = existing?.languages ?? [];
  const candidateHasGerman = hasGermanAudio(candidate.languages);
  if (
    hasKnownLanguageMetadata(candidate.languages) &&
    !candidateHasGerman &&
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
      reason: !ranking
        ? "The series quality profile is unavailable."
        : "Quality data is missing for the candidate or the existing file.",
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

  const existingScore = existing?.customFormatScore ?? 0;
  const candidateScore = candidate.customFormatScore ?? 0;
  const addsGerman = candidateHasGerman && !hasGermanAudio(existingLanguages);
  const upgradeAllowed = profile?.upgradeAllowed !== false;
  const existingDescription = `${describeQuality(existingQuality)} (score ${existingScore})`;
  const candidateDescription = `${describeQuality(candidateQuality)} (score ${candidateScore})`;

  if (candidateRank < existingRank) {
    return {
      decision: "skip",
      reason: `${candidateDescription} is a quality downgrade from the existing ${existingDescription}.`,
    };
  }

  if (!upgradeAllowed) {
    return {
      decision: "skip",
      reason: `Quality profile ${profile?.name ?? profile?.id} does not allow upgrades and the target already has ${existingDescription}.`,
    };
  }

  if (candidateRank > existingRank) {
    const cutoffRank = ranking.cutoffRank;
    const cutoffScore = profile?.cutoffFormatScore ?? Number.POSITIVE_INFINITY;
    if (cutoffRank !== undefined && existingRank >= cutoffRank && existingScore >= cutoffScore) {
      return {
        decision: "skip",
        reason: `The existing ${existingDescription} already meets the profile cutoff.`,
      };
    }
    return {
      decision: "import",
      reason: `${candidateDescription} is a quality upgrade over the existing ${existingDescription}.`,
    };
  }

  const revisionDelta =
    candidateQuality.real - existingQuality.real ||
    candidateQuality.version - existingQuality.version;
  if (revisionDelta > 0) {
    return {
      decision: "import",
      reason: `${candidateDescription} is a revision upgrade over the existing ${existingDescription}.`,
    };
  }
  if (revisionDelta < 0) {
    return {
      decision: "skip",
      reason: `${candidateDescription} is an older revision than the existing ${existingDescription}.`,
    };
  }

  if (addsGerman) {
    return {
      decision: "import",
      reason: `The candidate adds German audio to the existing ${existingDescription}.`,
    };
  }

  const minUpgradeScore = Math.max(1, profile?.minUpgradeFormatScore ?? 1);
  const cutoffScore = profile?.cutoffFormatScore;
  if (cutoffScore !== undefined && existingScore >= cutoffScore) {
    return {
      decision: "skip",
      reason: `The existing ${existingDescription} already meets the custom format cutoff score ${cutoffScore}.`,
    };
  }
  if (candidateScore - existingScore >= minUpgradeScore) {
    return {
      decision: "import",
      reason: `${candidateDescription} improves the custom format score of the existing ${existingDescription}.`,
    };
  }
  return {
    decision: "skip",
    reason: `${candidateDescription} is not an upgrade over the existing ${existingDescription}.`,
  };
}

export interface AssessedImport {
  candidateId: string;
  episodeIds: number[];
  assessment: UpgradeAssessment;
}

/**
 * Aggregates per-episode assessments for one file. A file mapped to several
 * episodes is blocked if any target blocks it, imported if any target needs
 * it, skipped only when every target already has an equal or better file.
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
    const assessment =
      pick("blocked") ??
      pick("import") ??
      (perEpisode.length > 0 && perEpisode.every((item) => item.decision === "skip")
        ? pick("skip")
        : pick("unverified")) ??
      ({
        decision: "unverified",
        reason: "No episode ids to compare.",
      } satisfies UpgradeAssessment);
    return { candidateId, episodeIds, assessment };
  });
}
