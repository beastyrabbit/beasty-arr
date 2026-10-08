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

type FrameSize = { width?: number; height?: number };

/**
 * Resolution class (2160/1080/720/576/480) from width or height, like Sonarr:
 * a 1920x800 scope film is 1080p and a 1280x960 file is 720p.
 */
function resolutionClass(size: FrameSize | undefined): number | undefined {
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  if (!width && !height) return undefined;
  if (width >= 3200 || height >= 2100) return 2160;
  if (width >= 1800 || height >= 1000) return 1080;
  if (width >= 1200 || height >= 700) return 720;
  // 540 keeps cropped PAL encodes (720x544) in the 576 class.
  if (width >= 1000 || height >= 540) return 576;
  return 480;
}

function arrFrameSize(resolution: string | undefined): FrameSize | undefined {
  const [width, height] = (resolution ?? "").split("x").map(Number);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function currentFrameSize(facts: InspectionFacts, target: TargetFacts): FrameSize | undefined {
  const probed = probeOf(facts, target.currentFile?.path)?.video;
  return probed?.height ? probed : arrFrameSize(target.currentFile?.mediaInfo?.resolution);
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

/**
 * A series cannot start after its episode aired: a release whose series title
 * carries a later year (Monster.The.Lizzie.Borden.Story.2026 for a 2022
 * episode) is a newer show or season, whatever the arr mapped it to.
 */
function seriesYearReason(facts: InspectionFacts, file: SelectedFile): string | undefined {
  const seriesYear = facts.parse?.parsedYear;
  if (!seriesYear) return undefined;
  const aired = file.targets.find((target) => target.year && seriesYear > target.year + 1);
  if (!aired) return undefined;
  return `The release names a series from ${seriesYear}, but ${aired.label} aired in ${aired.year}.`;
}

function yearReason(
  queueItem: QueueItem,
  file: SelectedFile,
  facts: InspectionFacts,
): string | undefined {
  if (queueItem.service === "sonarr") return seriesYearReason(facts, file);
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
    if (probe?.hasGermanAudio && probe.germanAudioUncertain && germanNow) {
      reasons.push(
        `${name}'s German audio is uncertain (a track's language tag and title disagree) and it would replace the German-audio file of ${target.label}.`,
      );
    }
    const before = resolutionClass(currentFrameSize(facts, target));
    const after = resolutionClass(probe?.video);
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

/** A Radarr import into a different movie than the queued one is never automatic. */
function otherMovieReason(queueItem: QueueItem, proposal: ResolutionProposal): string | undefined {
  if (queueItem.service !== "radarr" || queueItem.movieId === undefined) return undefined;
  const other = proposal.selectedImports.find(
    (selected) => selected.movieId !== undefined && selected.movieId !== queueItem.movieId,
  );
  if (!other) return undefined;
  return `The file would be imported as movie ${other.movieId}, not the queued movie ${queueItem.movieId}.`;
}

/**
 * The queue mapped the download to another work of the same title (Mary vs
 * Maria); the arr's candidate data was computed against that namesake, so an
 * import waits for a person.
 */
function namesakeReason(queueItem: QueueItem): string | undefined {
  if (queueItem.queueMappedId === undefined) return undefined;
  const arr = queueItem.service === "radarr" ? "Radarr" : "Sonarr";
  return `${arr}'s queue mapped this download to another work of the same title (id ${queueItem.queueMappedId}) than the one it was grabbed for.`;
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
    namesakeReason(queueItem),
    parseReason(queueItem, facts),
    otherMovieReason(queueItem, proposal),
  ];
  for (const file of selectedFiles(queueItem, candidates, proposal, facts)) {
    if (facts.proberAvailable && !file.probe) {
      reasons.push(
        `${file.name} could not be inspected (${probeFailure(facts, file.candidate.path)}).`,
      );
    }
    reasons.push(
      yearReason(queueItem, file, facts),
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

function isFeatureFile(candidate: ManualImportCandidate): boolean {
  return !candidate.isLikelySample && !isDiscStreamPath(candidate.path);
}

/**
 * "It is a different work" must be backed by more than the AI's reading: the
 * release year, the runtime, or the arr's own parse naming another title.
 * Mary (2024) checked against Maria (2024) had none of them, and two correct
 * releases were blocklisted. A parse naming the namesake the queue mapped the
 * download to is no evidence: the two works share the title.
 */
function wrongWorkReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  targets: TargetFacts[],
  facts: InspectionFacts,
): string[] {
  const parsedNamesake =
    queueItem.queueMappedId !== undefined && facts.parse?.matchedId === queueItem.queueMappedId;
  if (!parsedNamesake && parseReason(queueItem, facts)) return [];
  const backed = candidates.filter(isFeatureFile).some((candidate) => {
    const file: SelectedFile = {
      name: fileName(candidate.path),
      candidate,
      probe: probeOf(facts, candidate.path),
      targets: targetsOfCandidate(queueItem, candidate, targets),
    };
    // An episode file not mapped to a target would be measured against the
    // whole pack's summed runtime, so its runtime proves nothing.
    const ownRuntime =
      queueItem.service === "radarr" ||
      targets.some((target) => candidate.episodeIds.includes(target.id));
    return Boolean(
      yearReason(queueItem, file, facts) || (ownRuntime && runtimeReason(queueItem.service, file)),
    );
  });
  if (backed) return [];
  const labels = targets.map((target) => target.label).join(", ") || "the queued target";
  return [
    `The AI judged the download to be a different work, but neither its release year, its runtime nor the arr's own parse of the name contradicts ${labels}.`,
  ];
}

const NOT_AN_UPGRADE =
  /\bnot an? (?:(?:custom format|quality revision|quality|revision) )?upgrade\b/i;

/**
 * A removal must not throw away a German file that may be an upgrade: the arr
 * scores it higher than the library file (Benjamin Blümchen S01E03: 11700
 * against -23300), or its labels missed the German track, so its scores and
 * rejections were computed without it. The arr's own "not an upgrade" counts
 * only when its labels saw the German track; a lower resolution never upgrades.
 */
function upgradeLossReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  targets: TargetFacts[],
  facts: InspectionFacts,
): string[] {
  const arr = queueItem.service === "radarr" ? "Radarr" : "Sonarr";
  return candidates.filter(isFeatureFile).flatMap((candidate) => {
    if (!mayHaveGerman(facts, candidate)) return [];
    const name = fileName(candidate.path);
    const after = resolutionClass(probeOf(facts, candidate.path)?.video);
    // A target without a file is germanLossReasons' case.
    const comparable = targetsOfCandidate(queueItem, candidate, targets).filter((target) => {
      if (!target.currentFile) return false;
      const before = resolutionClass(currentFrameSize(facts, target));
      return !(before && after && after < before);
    });
    if (comparable.length === 0) return [];
    if (candidate.germanFromInspection) {
      return [
        `${name} has German audio that ${arr}'s labels missed, so ${arr}'s scores ignore it and it may be an upgrade.`,
      ];
    }
    if (candidate.rejections.some((rejection) => NOT_AN_UPGRADE.test(rejection))) return [];
    const score = candidate.customFormatScore;
    return comparable.flatMap((target) => {
      const now = target.currentFile?.customFormatScore;
      if (score !== undefined && now !== undefined && score <= now) return [];
      return [
        `${name} keeps German audio and ${arr} scores it ${score ?? "unknown"} against ${now ?? "unknown"} for the library file of ${target.label}, so it may be an upgrade.`,
      ];
    });
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

  if (proposal.identity?.verdict === "contradicted") {
    reasons.push(...wrongWorkReasons(queueItem, candidates, targets, facts));
  } else {
    reasons.push(
      ...germanLossReasons(queueItem, candidates, targets, facts),
      ...upgradeLossReasons(queueItem, candidates, targets, facts),
    );
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
