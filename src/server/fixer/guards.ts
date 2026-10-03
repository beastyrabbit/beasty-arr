import { hasGermanAudio } from "../../shared/domain.js";
import type {
  ManualImportCandidate,
  QueueItem,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import { isDiscStreamPath } from "../arr/sample.js";
import type { MediaProbeOk, MediaProbeResult } from "../media/types.js";
import type { InspectionFacts, TargetFacts } from "./inspection.js";

/**
 * Deterministic checks that run after the AI proposed an action. They never
 * make an action happen; they only stop one (turn it into needs_review) when
 * the fixer's own observations contradict it or cannot support it. The AI's
 * confidence is not trusted for this.
 */

const RELEASE_YEAR = /(?<!\d)(?:19|20)\d{2}(?!\d)/g;

function releaseYears(names: Array<string | undefined>): number[] {
  return [...new Set(names.flatMap((name) => (name?.match(RELEASE_YEAR) ?? []).map(Number)))];
}

function probeOf(facts: InspectionFacts, path: string | undefined): MediaProbeOk | undefined {
  if (!path) return undefined;
  const probe = facts.probes.get(path);
  return probe?.ok ? probe : undefined;
}

function probeFailure(facts: InspectionFacts, path: string): string {
  const probe: MediaProbeResult | undefined = facts.probes.get(path);
  return probe && !probe.ok ? probe.reason : "it was not inspected";
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Resolution class from pixel height: 2160, 1080, 720, 576, 480. */
function resolutionClass(height: number | undefined): number | undefined {
  if (!height) return undefined;
  if (height >= 1600) return 2160;
  if (height >= 900) return 1080;
  if (height >= 650) return 720;
  if (height >= 540) return 576;
  return 480;
}

function arrResolutionHeight(resolution: string | undefined): number | undefined {
  const height = Number(resolution?.split("x")[1]);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

function currentHeight(facts: InspectionFacts, target: TargetFacts): number | undefined {
  const probed = probeOf(facts, target.currentFile?.path)?.video?.height;
  return probed ?? arrResolutionHeight(target.currentFile?.mediaInfo?.resolution);
}

function currentHasGerman(facts: InspectionFacts, target: TargetFacts): boolean | undefined {
  if (!target.currentFile) return false;
  const probe = probeOf(facts, target.currentFile.path);
  return probe ? probe.hasGermanAudio : undefined;
}

/** Allowed gap between measured and expected runtime. */
function runtimeTolerance(service: "sonarr" | "radarr", expectedMinutes: number): number {
  return service === "radarr"
    ? Math.max(12, expectedMinutes * 0.12)
    : Math.max(8, expectedMinutes * 0.3);
}

function identityReason(proposal: ResolutionProposal): string | undefined {
  const identity = proposal.identity;
  if (identity?.verdict === "confirmed") return undefined;
  return identity
    ? `The AI could not confirm the file is the queued target (identity ${identity.verdict}: ${identity.actualWork || "unknown"}).`
    : "The AI gave no identity assessment.";
}

function parseReason(queueItem: QueueItem, facts: InspectionFacts): string | undefined {
  const matchedId = facts.parse?.matchedId;
  const queuedId = queueItem.service === "radarr" ? queueItem.movieId : queueItem.seriesId;
  if (matchedId === undefined || queuedId === undefined || matchedId === queuedId) {
    return undefined;
  }
  const arr = queueItem.service === "radarr" ? "Radarr" : "Sonarr";
  const matched = facts.parse?.matchedTitle ?? `id ${matchedId}`;
  return `${arr} parses the release name as ${matched}, not the queued target.`;
}

/** One selected file mapped to its targets, with what the fixer observed about it. */
type SelectedFile = {
  name: string;
  candidate: ManualImportCandidate;
  probe: MediaProbeOk | undefined;
  targets: TargetFacts[];
};

function yearReason(queueItem: QueueItem, file: SelectedFile): string | undefined {
  if (queueItem.service !== "radarr") return undefined;
  const movieYear = file.targets[0]?.year ?? queueItem.movieYear;
  // The file's own names describe what was imported; the queue title is only
  // the grabbed release name and must not mask a different year inside it.
  const fileYears = releaseYears([file.candidate.folderName, file.candidate.relativePath]);
  const years = fileYears.length > 0 ? fileYears : releaseYears([queueItem.title]);
  if (!movieYear || years.length === 0 || years.some((year) => Math.abs(year - movieYear) <= 1)) {
    return undefined;
  }
  const label = file.targets[0]?.label ?? `${queueItem.movieTitle ?? "the movie"} (${movieYear})`;
  return `Release year ${years.join("/")} does not match ${label}.`;
}

function runtimeReason(service: QueueItem["service"], file: SelectedFile): string | undefined {
  const { targets, probe } = file;
  if (!probe?.durationSeconds || !targets.every((target) => target.expectedRuntimeMinutes)) {
    return undefined;
  }
  const expected = targets.reduce((sum, target) => sum + (target.expectedRuntimeMinutes ?? 0), 0);
  const measured = probe.durationSeconds / 60;
  if (!expected || Math.abs(measured - expected) <= runtimeTolerance(service, expected)) {
    return undefined;
  }
  const labels = targets.map((target) => target.label).join(" + ");
  return `${file.name} runs ${Math.round(measured)} min, but ${labels} should run about ${expected} min.`;
}

/** German-audio loss and resolution downgrade against each target's current file. */
function replacementReasons(facts: InspectionFacts, file: SelectedFile): string[] {
  const { name, probe } = file;
  return file.targets.flatMap((target) => {
    const reasons: string[] = [];
    const currentPath = target.currentFile?.path;
    if (facts.proberAvailable && currentPath && !probeOf(facts, currentPath)) {
      // Without the library file's real streams, a German-audio loss cannot be ruled out.
      reasons.push(
        `The library file of ${target.label} could not be inspected (${probeFailure(facts, currentPath)}).`,
      );
    }
    const germanNow = currentHasGerman(facts, target);
    if (probe && germanNow && !probe.hasGermanAudio) {
      reasons.push(
        `${name} has no German audio but would replace the German-audio file of ${target.label}.`,
      );
    }
    const before = resolutionClass(currentHeight(facts, target));
    const after = resolutionClass(probe?.video?.height);
    const addsGerman = probe?.hasGermanAudio === true && germanNow === false;
    if (before && after && after < before && !addsGerman) {
      reasons.push(
        `${name} is ${after}p and would replace the ${before}p file of ${target.label} without adding German audio.`,
      );
    }
    return reasons;
  });
}

function selectedFiles(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): SelectedFile[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return proposal.selectedImports.flatMap((selected) => {
    const candidate = byId.get(selected.candidateId);
    if (!candidate) return [];
    const targetIds =
      queueItem.service === "radarr"
        ? [selected.movieId ?? queueItem.movieId ?? 0]
        : selected.episodeIds;
    const targets = targetIds.flatMap((id) => {
      const target = facts.targets.get(id);
      return target ? [target] : [];
    });
    return [
      {
        name: fileName(candidate.path),
        candidate,
        probe: probeOf(facts, candidate.path),
        targets,
      },
    ];
  });
}

function importReviewReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): string[] {
  const reasons = [
    identityReason(proposal),
    facts.proberAvailable
      ? undefined
      : "Media inspection is not configured, so the real file could not be checked.",
    parseReason(queueItem, facts),
  ];
  for (const file of selectedFiles(queueItem, candidates, proposal, facts)) {
    if (facts.proberAvailable && !file.probe) {
      reasons.push(
        `${file.name} could not be inspected (${probeFailure(facts, file.candidate.path)}).`,
      );
    }
    reasons.push(
      yearReason(queueItem, file),
      runtimeReason(queueItem.service, file),
      ...replacementReasons(facts, file),
    );
  }
  return reasons.filter((reason): reason is string => Boolean(reason));
}

/** The queued targets a candidate file is for; all of them when Sonarr mapped it elsewhere. */
function targetsOfCandidate(
  queueItem: QueueItem,
  candidate: ManualImportCandidate,
  targets: TargetFacts[],
): TargetFacts[] {
  if (queueItem.service === "radarr") return targets;
  const mapped = targets.filter((target) => candidate.episodeIds.includes(target.id));
  return mapped.length > 0 ? mapped : targets;
}

/**
 * Whether a candidate may carry German audio. An inspected file answers it;
 * a file that could not be read counts as possibly German; without media
 * inspection the arr's labels are all there is.
 */
function mayHaveGerman(facts: InspectionFacts, candidate: ManualImportCandidate): boolean {
  const probe = facts.probes.get(candidate.path);
  if (probe?.ok) return probe.hasGermanAudio;
  return facts.proberAvailable || hasGermanAudio(candidate.languages);
}

/**
 * A removal must not discard German audio that a queued target lacks in the
 * library. Checked per file, so a mixed season pack cannot hide one episode's
 * only German source behind episodes that already have German.
 */
function germanLossReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  targets: TargetFacts[],
  facts: InspectionFacts,
): string[] {
  return candidates.flatMap((candidate) => {
    if (candidate.isLikelySample || isDiscStreamPath(candidate.path)) return [];
    if (!mayHaveGerman(facts, candidate)) return [];
    const lacking = targetsOfCandidate(queueItem, candidate, targets).filter(
      (target) => currentHasGerman(facts, target) !== true,
    );
    if (lacking.length === 0) return [];
    const labels = lacking.map((target) => target.label).join(", ");
    return [
      `${fileName(candidate.path)} has German audio that the library copy of ${labels} lacks or could not be checked for; removing it would throw that away.`,
    ];
  });
}

function removalReviewReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): string[] {
  const reasons: string[] = [];
  const queuedIds = queueItem.service === "radarr" ? [queueItem.movieId] : queueItem.episodeIds;
  const targets = queuedIds.flatMap((id) => {
    const target = id === undefined ? undefined : facts.targets.get(id);
    return target ? [target] : [];
  });
  const libraryHasGerman =
    targets.length > 0 && targets.every((target) => currentHasGerman(facts, target) === true);

  if (proposal.identity?.verdict !== "contradicted") {
    reasons.push(...germanLossReasons(queueItem, candidates, targets, facts));
  }
  if (
    libraryHasGerman &&
    proposal.identity?.verdict === "confirmed" &&
    proposal.queueRemovalOptions &&
    !proposal.queueRemovalOptions.skipRedownload
  ) {
    reasons.push(
      "The removal asks for a new search although the library file already has German audio.",
    );
  }
  return reasons;
}

/** Applies the guards; a blocked proposal becomes needs_review with reviewReasons. */
export function applyGuards(input: {
  queueItem: QueueItem;
  candidates: ManualImportCandidate[];
  proposal: ResolutionProposal;
  facts: InspectionFacts;
}): ResolutionProposal {
  const { queueItem, candidates, proposal, facts } = input;
  let reasons: string[] = [];
  if (proposal.action === "import_candidates") {
    reasons = importReviewReasons(queueItem, candidates, proposal, facts);
  } else if (proposal.action === "remove_queue_item") {
    reasons = removalReviewReasons(queueItem, candidates, proposal, facts);
  }
  if (reasons.length === 0) return proposal;
  return {
    ...proposal,
    action: "needs_review",
    reason: `Held for review: ${reasons[0]}`,
    reviewReasons: [...(proposal.reviewReasons ?? []), ...reasons],
  };
}
