import type {
  ManualImportCandidate,
  QueueItem,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import { isDiscStreamPath } from "../arr/sample.js";
import type { SonarrQualityProfileRecord } from "../arr/sonarr-client.js";
import { applyGuards } from "./guards.js";
import type { InspectionFacts } from "./inspection.js";
import { assessCandidateUpgrade } from "./upgrade.js";

const TERMINAL_IMPORT_STATE = /^(?:importPending|importBlocked|importFailed|failed)$/i;
// Split in two only to keep each expression simple; either one matching means transient.
const TRANSIENT_IMPORT_WORK = /archiv|extract|unpack|repair|pending|in progress|locked|temporar/i;
const TRANSIENT_IMPORT_ACCESS =
  /access|permission|denied|not accessible|not available|not found|does not exist|unable to (?:read|list)|timed? ?out|connection/i;
const EMPTY_IMPORT_REJECTION =
  /No files found are eligible for import|release was matched to (?:series|movie) by ID\. Automatic import is not possible/i;

/** A removal is safe even with uncertain identity when no feature could improve its targets. */
export function safeNonUpgradeRemoval(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  facts: InspectionFacts,
  profiles: SonarrQualityProfileRecord[],
  original: ResolutionProposal,
): ResolutionProposal | undefined {
  const ids = queueItem.service === "radarr" ? [queueItem.movieId ?? 0] : queueItem.episodeIds;
  if (
    queueItem.isInProgress ||
    !facts.proberAvailable ||
    ids.length === 0 ||
    !ids.every((id) => libraryInspected(facts, id))
  )
    return;
  const features = candidates.filter((c) => !c.isLikelySample && !isDiscStreamPath(c.path));
  if (
    features.length === 0 ||
    !features.every((candidate) =>
      isVerifiedNonUpgrade(queueItem, candidate, ids, facts, profiles, original),
    )
  )
    return;
  const proposal = applyGuards({
    queueItem,
    candidates,
    facts,
    proposal: {
      ...original,
      action: "remove_queue_item",
      confidence: original.action === "remove_queue_item" ? original.confidence : 1,
      selectedCandidateIds: [],
      selectedImports: [],
      // Identity is irrelevant here; it must not bypass the German/upgrade-loss guards.
      identity: {
        verdict: "uncertain",
        actualWork: original.identity?.actualWork ?? queueItem.title,
        evidence: original.identity?.evidence ?? [],
      },
      reason:
        "Every target already has a library file and every feature is a verified non-upgrade. Remove and blocklist without a new search.",
      rationale:
        "The library was read again after investigation. Every queued target has a file; deterministic upgrade checks mark every feature skip or blocked, and removal guards confirm that removing the download loses no German audio or wanted upgrade. Identity and cut uncertainty do not affect this comparison.",
      reviewReasons: [],
      queueRemovalOptions: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: true,
        changeCategory: false,
      },
    },
  });
  return proposal.action === "remove_queue_item" ? proposal : undefined;
}

/**
 * The target's library file was probed and its audio languages are known.
 * A library label alone must not establish a language block: a failed or
 * ambiguous probe could hide an English library file behind a German label.
 */
function libraryInspected(facts: InspectionFacts, id: number): boolean {
  const file = facts.targets.get(id)?.currentFile;
  return Boolean(file && file.id !== undefined && audioKnown(facts, file.path));
}

/** The probe heard German, or every audio track has a known language. */
function audioKnown(facts: InspectionFacts, path: string | undefined): boolean {
  const probe = path ? facts.probes.get(path) : undefined;
  if (!probe?.ok) return false;
  return (
    probe.hasGermanAudio ||
    (probe.audio.length > 0 &&
      probe.audio.every((stream) => stream.inferredLanguage && stream.inferredLanguage !== "und"))
  );
}

/** Every queued target this probed feature maps to rates it skip or blocked. */
function isVerifiedNonUpgrade(
  queueItem: QueueItem,
  candidate: ManualImportCandidate,
  ids: number[],
  facts: InspectionFacts,
  profiles: SonarrQualityProfileRecord[],
  original: ResolutionProposal,
): boolean {
  if (!facts.probes.get(candidate.path)?.ok) return false;
  const mapped = original.selectedImports?.find(
    (selection) => selection.candidateId === candidate.id,
  )?.episodeIds;
  const mappings = mapped?.length ? mapped : candidate.episodeIds;
  const targets = queueItem.service === "radarr" || mappings.length === 0 ? ids : mappings;
  if (targets.some((id) => !ids.includes(id))) return false;
  // An untagged track could be German, so "blocked" against a German library
  // would rest on the arr's label alone: it must also be a non-upgrade as if
  // the track were German (Ghosts of War is; a German 2160p over 1080p is not).
  const variants = audioKnown(facts, candidate.path)
    ? [candidate]
    : [candidate, { ...candidate, languages: [...candidate.languages, GERMAN] }];
  return targets.every((id) => {
    const episode = facts.libraryEpisodes?.get(id);
    const profile = profiles.find((entry) => entry.id === episode?.series?.qualityProfileId);
    return variants.every((variant) => {
      const { decision } = assessCandidateUpgrade({ candidate: variant, episode, profile });
      return decision === "skip" || decision === "blocked";
    });
  });
}

const GERMAN = { id: 4, name: "German" };

/** Empty listings are actionable only with an explicit terminal arr explanation. */
export function emptyCandidateRemoval(queue: QueueItem): ResolutionProposal | undefined {
  const messages = queue.statusMessages.join(" ");
  if (
    queue.isInProgress ||
    queue.status?.toLowerCase() !== "completed" ||
    !TERMINAL_IMPORT_STATE.test(queue.trackedDownloadState ?? "") ||
    TRANSIENT_IMPORT_WORK.test(messages) ||
    TRANSIENT_IMPORT_ACCESS.test(messages) ||
    !EMPTY_IMPORT_REJECTION.test(messages)
  )
    return;
  return {
    action: "remove_queue_item",
    confidence: 1,
    selectedCandidateIds: [],
    selectedImports: [],
    sampleCandidateIds: [],
    reason: `Completed download has no importable files: ${messages}`,
    rationale:
      "The arr returned an empty candidate list and an explicit terminal import rejection, with no extraction or transient filesystem warning. Blocklist, remove and search again.",
    issueSummary: "Completed download cannot be imported",
    evidence: queue.statusMessages,
    warnings: [],
    queueRemovalOptions: {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: false,
      changeCategory: false,
    },
  };
}
