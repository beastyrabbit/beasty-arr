// Ported near-verbatim from sonarr_fixer src/shared/types.ts (framework-free).

import type { AiVerdictValue } from "./domain.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type MediaService = "sonarr" | "radarr";

export interface PiModelOption {
  provider: string;
  model: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface PiModelCatalog {
  options: PiModelOption[];
  source: "codex-app-server" | "pi-registry";
  warning?: string;
}

export interface TestConnectionInput {
  service: MediaService;
  baseUrl: string;
  apiKey?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  service: MediaService;
  message: string;
  version?: string;
  instanceName?: string;
}

export interface QueueItem {
  id: number;
  service: MediaService;
  title: string;
  seriesId?: number;
  seriesTitle?: string;
  seriesType?: string;
  downloadId?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  isInProgress?: boolean;
  size?: number;
  outputPath?: string;
  /**
   * Every Sonarr queue row that belongs to this download. Sonarr lists a
   * season pack as one row per episode; the fixer merges them into one item
   * whose episodeIds cover all queued targets.
   */
  queueItemIds?: number[];
  episodeIds: number[];
  absoluteEpisodeNumbers: number[];
  episodeLabels: string[];
  seasonEpisode?: string;
  movieId?: number;
  movieTitle?: string;
  movieYear?: number;
  statusMessages: string[];
  canAnalyze: boolean;
  addedAt?: string;
}

export interface ManualImportCandidate {
  id: string;
  service: MediaService;
  path: string;
  relativePath?: string;
  folderName?: string;
  name?: string;
  size?: number;
  seriesId?: number;
  seriesTitle?: string;
  seriesType?: string;
  seasonNumber?: number;
  movieId?: number;
  movieTitle?: string;
  movieYear?: number;
  episodeIds: number[];
  absoluteEpisodeNumbers: number[];
  episodeLabels: string[];
  quality?: unknown;
  qualityLabel?: string;
  languages: unknown[];
  languageLabels: string[];
  releaseGroup?: string;
  customFormats?: unknown[];
  customFormatLabels?: string[];
  customFormatScore?: number;
  indexerFlags?: number;
  releaseType?: string;
  rejections: string[];
  downloadId?: string;
  isLikelySample: boolean;
  sampleReason?: string;
}

/** Active Dub Oracle research supplied as evidence to the fixer model. */
export interface FixerDubVerdictContext {
  verdict: AiVerdictValue;
  confidence: number;
  germanTitle: string | null;
  perSeason: { season: number; verdict: AiVerdictValue; note?: string }[] | null;
  evidence: string[];
  expectedAvailability: number | null;
  checkedAt: number;
  recheckAfter: number;
}

export type ProposalAction =
  | "import_candidates"
  | "needs_review"
  | "ignore_queue_item"
  | "remove_queue_item";

export interface SelectedImport {
  candidateId: string;
  episodeIds: number[];
  movieId?: number;
  reason?: string;
}

export interface ResolutionProposal {
  action: ProposalAction;
  confidence: number;
  selectedCandidateIds: string[];
  selectedImports: SelectedImport[];
  sampleCandidateIds: string[];
  reason: string;
  issueSummary: string;
  evidence: string[];
  warnings: string[];
  queueRemovalOptions?: QueueRemovalOptions;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  candidateId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface AnalysisResult {
  queueItemId: number;
  candidates: ManualImportCandidate[];
  proposal: ResolutionProposal;
  validation: ValidationResult;
  status: "proposal" | "needs_review" | "error";
  log: string[];
}

export interface ApplyImportInput {
  queueItem: QueueItem;
  candidates: ManualImportCandidate[];
  proposal: ResolutionProposal;
}

/**
 * What happens to files of the same download that were not selected:
 * - none: every candidate was selected.
 * - remove: every unselected file is a verified non-upgrade and the download
 *   is removed from the client once the import command completes.
 * - keep: some unselected files need a human decision; the queue rows stay.
 */
export type LeftoverDisposition = "none" | "remove" | "keep";

export interface ApplyResult {
  ok: boolean;
  message: string;
  commandId?: number;
  leftover?: LeftoverDisposition;
}

export interface QueueRemovalOptions {
  removeFromClient: boolean;
  blocklist: boolean;
  skipRedownload: boolean;
  changeCategory: boolean;
}

export interface ResolverEvent {
  type: "info" | "warning" | "error" | "pi" | "sonarr" | "radarr";
  message: string;
  timestamp: string;
  itemId?: number;
  details?: unknown;
}

export interface SonarrSystemStatus {
  version?: string;
  instanceName?: string;
  appName?: string;
}

export type ArrSystemStatus = SonarrSystemStatus;
