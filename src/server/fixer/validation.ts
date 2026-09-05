import type {
  ManualImportCandidate,
  ProposalAction,
  QueueItem,
  QueueRemovalOptions,
  ResolutionProposal,
  SelectedImport,
  ValidationIssue,
  ValidationResult,
} from "../../shared/fixer-types.js";
import { isDiscStreamPath } from "../arr/sample.js";

const proposalActions: ProposalAction[] = [
  "import_candidates",
  "needs_review",
  "ignore_queue_item",
  "remove_queue_item",
];

export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeIdList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [
    ...new Set(
      values.flatMap((value) => {
        const normalized = String(value ?? "").trim();
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

function normalizeEpisodeIds(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const ids = values.flatMap((value) => {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? [numeric] : [];
  });
  return [...new Set(ids)];
}

function normalizeSelectedImports(values: unknown): SelectedImport[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const imports: SelectedImport[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<SelectedImport>;
    const candidateId = String(record.candidateId ?? "").trim();
    if (!candidateId || seen.has(candidateId)) {
      continue;
    }
    seen.add(candidateId);
    const reason = String(record.reason ?? "").trim();
    imports.push({
      candidateId,
      episodeIds: normalizeEpisodeIds(record.episodeIds),
      ...(Number.isSafeInteger(Number(record.movieId)) && Number(record.movieId) > 0
        ? { movieId: Number(record.movieId) }
        : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return imports;
}

function normalizeQueueRemovalOptions(value: unknown): QueueRemovalOptions | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<QueueRemovalOptions>;
  return {
    removeFromClient: Boolean(record.removeFromClient),
    blocklist: Boolean(record.blocklist),
    skipRedownload: Boolean(record.skipRedownload),
    changeCategory: Boolean(record.changeCategory),
  };
}

export function normalizeProposal(input: ResolutionProposal): ResolutionProposal {
  const selectedImports = normalizeSelectedImports(input.selectedImports);
  const selectedCandidateIds = normalizeIdList([
    ...(input.selectedCandidateIds ?? []),
    ...selectedImports.map((selectedImport) => selectedImport.candidateId),
  ]);
  return {
    action: proposalActions.includes(input.action) ? input.action : "needs_review",
    confidence: normalizeConfidence(input.confidence),
    selectedCandidateIds,
    selectedImports,
    sampleCandidateIds: normalizeIdList(input.sampleCandidateIds),
    reason: String(input.reason ?? "").trim(),
    issueSummary: String(input.issueSummary ?? "").trim(),
    evidence: (input.evidence ?? []).flatMap((item) => {
      const normalized = String(item);
      return normalized ? [normalized] : [];
    }),
    warnings: (input.warnings ?? []).flatMap((warning) => {
      const normalized = String(warning);
      return normalized ? [normalized] : [];
    }),
    queueRemovalOptions: normalizeQueueRemovalOptions(input.queueRemovalOptions),
  };
}

export function resolveImportEpisodeIds(
  proposalInput: ResolutionProposal,
  candidateId: string,
): number[] {
  const proposal = normalizeProposal(proposalInput);
  return (
    proposal.selectedImports.find((selectedImport) => selectedImport.candidateId === candidateId)
      ?.episodeIds ?? []
  );
}

export function resolveImportMovieId(
  proposalInput: ResolutionProposal,
  candidateId: string,
): number | undefined {
  const proposal = normalizeProposal(proposalInput);
  return proposal.selectedImports.find(
    (selectedImport) => selectedImport.candidateId === candidateId,
  )?.movieId;
}

export function validateProposalForImport(
  candidates: ManualImportCandidate[],
  proposalInput: ResolutionProposal,
  queueItem?: QueueItem,
  allowedEpisodeIdsInput: number[] = [],
): ValidationResult {
  const proposal = normalizeProposal(proposalInput);
  const issues: ValidationIssue[] = [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const service = queueItem?.service ?? candidates[0]?.service ?? "sonarr";
  const serviceName = service === "radarr" ? "Radarr" : "Sonarr";

  if (proposal.action !== "import_candidates") {
    return { ok: true, issues };
  }

  if (proposal.selectedCandidateIds.length === 0) {
    issues.push({ severity: "error", message: "No import candidates selected." });
  }

  if (proposal.selectedImports.length === 0) {
    issues.push({
      severity: "error",
      message:
        service === "radarr"
          ? "No explicit import mapping selected. Pi must choose candidate ids and a Radarr movie id."
          : "No explicit import mapping selected. Pi must choose candidate ids and Sonarr episode ids.",
    });
  }
  if (service === "radarr" && proposal.selectedImports.length > 1) {
    issues.push({
      severity: "error",
      message: "Radarr imports are limited to one feature file per queue item.",
    });
  }

  const selectedImportIds = new Set(
    proposal.selectedImports.map((selectedImport) => selectedImport.candidateId),
  );
  for (const candidateId of proposal.selectedCandidateIds) {
    if (!byId.has(candidateId)) {
      issues.push({
        severity: "error",
        message: `Unknown candidate id ${candidateId}.`,
        candidateId,
      });
    }
    if (!selectedImportIds.has(candidateId)) {
      issues.push({
        severity: "error",
        message:
          service === "radarr"
            ? `Candidate ${candidateId} is selected but has no explicit movie id mapping from Pi.`
            : `Candidate ${candidateId} is selected but has no explicit episode id mapping from Pi.`,
        candidateId,
      });
    }
  }

  const allowedEpisodeIds = new Set([
    ...(queueItem?.episodeIds ?? []),
    ...candidates.flatMap((candidate) => candidate.episodeIds),
    ...allowedEpisodeIdsInput,
  ]);
  const seenEpisodes = new Set<number>();
  const seenMovies = new Set<number>();
  for (const selectedImport of proposal.selectedImports) {
    const candidate = byId.get(selectedImport.candidateId);
    if (!candidate) {
      issues.push({
        severity: "error",
        message: `Unknown candidate id ${selectedImport.candidateId}.`,
        candidateId: selectedImport.candidateId,
      });
      continue;
    }

    if (isDiscStreamPath(candidate.path)) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} is a Blu-ray disc stream, not an importable episode or movie file.`,
        candidateId: candidate.id,
      });
    }
    if (candidate.isLikelySample) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} is flagged as a sample (${candidate.sampleReason ?? "sample heuristic"}).`,
        candidateId: candidate.id,
      });
    }

    if (candidate.rejections.length > 0) {
      issues.push({
        severity: "warning",
        message: `Candidate ${candidate.id} has ${serviceName} rejections: ${candidate.rejections.join("; ")}`,
        candidateId: candidate.id,
      });
    }

    if (service === "sonarr" && !candidate.seriesId) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} has no series id.`,
        candidateId: candidate.id,
      });
    }

    if (
      service === "sonarr" &&
      queueItem?.seriesId &&
      candidate.seriesId &&
      candidate.seriesId !== queueItem.seriesId
    ) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} belongs to Sonarr series ${candidate.seriesId}, not queued series ${queueItem.seriesId}.`,
        candidateId: candidate.id,
      });
    }

    if (!candidate.quality) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} has no quality.`,
        candidateId: candidate.id,
      });
    }

    if (candidate.languages.length === 0) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} has no languages.`,
        candidateId: candidate.id,
      });
    }

    if (service === "sonarr" && selectedImport.episodeIds.length === 0) {
      issues.push({
        severity: "error",
        message: `Candidate ${candidate.id} has no explicit episode ids selected by Pi.`,
        candidateId: candidate.id,
      });
    }

    if (service === "radarr") {
      if (!selectedImport.movieId) {
        issues.push({
          severity: "error",
          message: `Candidate ${candidate.id} has no explicit movie id selected by Pi.`,
          candidateId: candidate.id,
        });
      } else {
        const allowedMovieIds = new Set(
          [queueItem?.movieId, ...candidates.map((item) => item.movieId)].filter(
            (value): value is number => typeof value === "number",
          ),
        );
        if (allowedMovieIds.size > 0 && !allowedMovieIds.has(selectedImport.movieId)) {
          issues.push({
            severity: "error",
            message: `Movie id ${selectedImport.movieId} is not present in the Radarr queue or manual import context.`,
            candidateId: candidate.id,
          });
        }
        if (seenMovies.has(selectedImport.movieId)) {
          issues.push({
            severity: "error",
            message: `Movie id ${selectedImport.movieId} is selected more than once.`,
            candidateId: candidate.id,
          });
        }
        seenMovies.add(selectedImport.movieId);
      }
      continue;
    }

    for (const episodeId of selectedImport.episodeIds) {
      if (allowedEpisodeIds.size > 0 && !allowedEpisodeIds.has(episodeId)) {
        issues.push({
          severity: "error",
          message: `Episode id ${episodeId} is not present in the Sonarr queue or manual import context.`,
          candidateId: candidate.id,
        });
      }
      if (seenEpisodes.has(episodeId)) {
        issues.push({
          severity: "error",
          message: `Episode id ${episodeId} is selected more than once.`,
          candidateId: candidate.id,
        });
      }
      seenEpisodes.add(episodeId);
    }
  }

  if (
    service === "sonarr" &&
    queueItem?.episodeIds.length &&
    proposal.selectedImports.length > 0 &&
    !queueItem.episodeIds.some((episodeId) => seenEpisodes.has(episodeId))
  ) {
    issues.push({
      severity: "error",
      message:
        "The selected imports do not contain the queued target episode. Refusing to import unrelated episodes from this download.",
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}
