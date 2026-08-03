import type {
  AnalysisResult,
  FixerDubVerdictContext,
  ManualImportCandidate,
  MediaService,
  QueueItem,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import type { RadarrClient } from "../arr/radarr-client.js";
import type { SonarrClient } from "../arr/sonarr-client.js";
import { compactCandidate } from "../arr/sonarr-format.js";
import type { FixerAnalysisEvent, FixerPiRunner } from "./ai-port.js";
import { createProposalTool } from "./pi-proposal-tool.js";
import { createRadarrLookupTools } from "./pi-radarr-tools.js";
import { createSonarrLookupTools } from "./pi-sonarr-tools.js";
import { validateProposalForImport } from "./validation.js";

/**
 * Narrow structural views of the arr clients covering everything the fixer
 * needs: queue orchestration (service.ts) plus the read-only lookups used by
 * the Pi tools. The real clients in src/server/arr/ satisfy these via Pick;
 * tests inject fakes.
 */
export type SonarrFixerClientPort = Pick<
  SonarrClient,
  | "listQueue"
  | "getManualImportCandidates"
  | "preflightImportProposal"
  | "applyImportProposal"
  | "removeQueueItem"
  | "getEpisodes"
  | "getQualityProfiles"
  | "getCustomFormats"
>;

export type RadarrFixerClientPort = Pick<
  RadarrClient,
  | "listQueue"
  | "getManualImportCandidates"
  | "preflightImportProposal"
  | "applyImportProposal"
  | "removeQueueItem"
  | "getMovie"
  | "getQualityProfiles"
  | "getCustomFormats"
>;

export type FixerClientPort = SonarrFixerClientPort | RadarrFixerClientPort;

const SONARR_TOOL_NAMES = [
  "sonarr_get_queue_context",
  "sonarr_find_episodes",
  "sonarr_get_manual_import_candidates",
  "sonarr_get_upgrade_context",
  "propose_sonarr_resolution",
];

const RADARR_TOOL_NAMES = [
  "radarr_get_queue_context",
  "radarr_get_movie",
  "radarr_get_manual_import_candidates",
  "radarr_get_upgrade_context",
  "propose_radarr_resolution",
];

// ============ fixer decision contract ============

function buildSonarrSystemPrompt(): string {
  return [
    "You resolve Sonarr downloaded-queue manual import problems.",
    "You may use the provided read-only Sonarr lookup tools, but you do not mutate Sonarr.",
    "You receive one queue item plus Sonarr manual import candidates, and you have read-only Sonarr lookup tools.",
    "You must finish by calling propose_sonarr_resolution exactly once.",
    "You decide both the physical file candidate or candidates and the exact Sonarr episode ids to import them as.",
    "Return that decision only through selectedImports in propose_sonarr_resolution.",
    "Always call sonarr_get_upgrade_context before the proposal tool, for every queue item. The initial queue/candidate payload does not show whether a target already has a library file. This requirement also applies when the only warning is sample detection.",
    "Never select candidates marked as likely samples.",
    "German audio is preferred but not required. When several usable candidates exist, prefer one whose languages include German.",
    "Candidates without German, such as English or original-language releases, are acceptable fallbacks only when the mapped target does not already have German audio. A German version may arrive later through the normal upgrade flow.",
    "Never remove or blocklist a queue item only because its languages lack German.",
    "Dub Oracle context is separate research about whether a German dub exists. It takes precedence over the ordinary non-German fallback rule when it is relevant to the target season and has confidence greater than 0.6.",
    "For a series, use only the exact perSeason entry for the candidate's target season when perSeason entries exist; it overrides the global verdict for that season. If perSeason is non-empty but has no entry for the target season, there is no relevant Oracle verdict and the global verdict must not be used. A relevant verified exists verdict means a German release is obtainable and the fixer must keep hunting for it.",
    "When the relevant Dub Oracle verdict is exists with confidence greater than 0.6 and a candidate has known language metadata but no German audio, do not import it even if it is a quality upgrade or the current episode is English-only or missing. Use remove_queue_item with queueRemovalOptions removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so Sonarr rejects that exact release and searches for a German one.",
    "Do not apply the Dub Oracle blocking rule to announced, unlikely, unknown, expired/missing context, confidence at or below 0.6, or unknown candidate language metadata. Use the normal rules and needs_review for genuine ambiguity.",
    "The fallback rule never runs backwards: when a candidate has known language metadata and lacks German while the mapped existing episode file has German audio, do not import it and do not use needs_review. Use remove_queue_item with queueRemovalOptions removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so Sonarr rejects this release and searches for a different one.",
    "Unknown or missing candidate language metadata is ambiguity, not proof that German is absent; use needs_review instead of the language-downgrade rule.",
    "Never import Blu-ray disc structure stream chunks such as BDMV/STREAM/*.m2ts.",
    "If the download is only Blu-ray disc structure stream chunks, use remove_queue_item.",
    "Treat Sonarr status messages as the main diagnostic clue.",
    "Use sonarr_get_upgrade_context on every analysis and compare the candidate to the current episode file, quality profile, custom format score, and languages.",
    "If the candidate is otherwise valid but does not improve the existing episode file according to Sonarr's profile/custom-format scoring, do not import it. Use remove_queue_item with queueRemovalOptions removeFromClient=true, blocklist=false, skipRedownload=false, changeCategory=false.",
    "For unsuitable or unwanted releases, such as wrong episodes, wrong series, missing usable video files, or disc structures, use remove_queue_item with queueRemovalOptions removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so Sonarr searches again.",
    "A multi-file Season Pack may be imported only when the selected files include the queued target episode. Never import unrelated episodes while leaving the target unresolved.",
    "If a download does not contain the queued target episode, treat it as the wrong release and use remove_queue_item with removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so Sonarr can search again.",
    "Use sonarr_find_episodes to verify anime absolute numbers, scene numbers, season/episode mapping, and titles before resolving unexpected-episode warnings.",
    "Sonarr's candidate episode ids are Sonarr's current guess; you may override them in selectedImports when the warning and Sonarr episode lookup show the file should import as different episode ids.",
    "If a file visibly matches the queued episode's absolute number/title after lookup, select that file and map it to the correct Sonarr episode ids.",
    "If the file identity, target episode ids, or episode mapping remain uncertain after lookup, use needs_review.",
    "Explain how the selected candidate resolves or conflicts with Sonarr's warning.",
    "Use needs_review when the data is ambiguous, incomplete, or would require guessing.",
    "Use remove_queue_item only when the queue item clearly cannot be imported or should not be imported.",
    "Use ignore_queue_item only when the download should stay untouched in the download client but Sonarr should stop tracking it, for example files the user keeps outside Sonarr's library.",
  ].join("\n");
}

function buildSonarrPrompt(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  dubVerdict?: FixerDubVerdictContext,
): string {
  return `Analyze this Sonarr queue item and choose the safest resolution.

Queue item:
${JSON.stringify(
  {
    id: queueItem.id,
    title: queueItem.title,
    seriesTitle: queueItem.seriesTitle,
    targetEpisodeIds: queueItem.episodeIds,
    targetAbsoluteEpisodeNumbers: queueItem.absoluteEpisodeNumbers,
    seasonEpisode: queueItem.seasonEpisode,
    episodeLabels: queueItem.episodeLabels,
    status: queueItem.status,
    trackedDownloadStatus: queueItem.trackedDownloadStatus,
    trackedDownloadState: queueItem.trackedDownloadState,
    statusMessages: queueItem.statusMessages,
    outputPath: queueItem.outputPath,
    size: queueItem.size,
  },
  null,
  2,
)}

Manual import candidates:
${JSON.stringify(candidates.map(compactCandidate), null, 2)}

Active Dub Oracle context:
${dubVerdict ? JSON.stringify(dubVerdict, null, 2) : "No active Dub Oracle verdict is available for this series."}

Rules:
- Read Sonarr's statusMessages first. They describe the actual failure mode.
- Always call sonarr_get_upgrade_context before the proposal tool, even when the only warning is sample detection. The initial payload does not say whether a library file already exists.
- Use sonarr_find_episodes when Sonarr mentions an unexpected episode, anime absolute numbers, or scene numbering.
- Compare Sonarr's target episode ids, the queue folder/title, the candidate filename/title, and Sonarr's episode lookup before deciding.
- Prefer candidates whose languages include German when several usable candidates exist. Candidates with known non-German language metadata are acceptable fallbacks only when the mapped target does not already have German audio.
- Do not propose remove_queue_item only because no candidate includes German.
- If the Active Dub Oracle context has confidence greater than 0.6, use only the exact perSeason verdict for each candidate's season when perSeason is non-empty; that season verdict overrides the global series verdict. If perSeason has no entry for the target season, treat the Oracle as unavailable for that season and never fall back to the global verdict. A relevant exists verdict means German audio is obtainable.
- For a relevant verified exists verdict, reject every candidate with languageMetadataPresent=true and hasGermanAudio=false even if it is higher quality or the existing file is English-only or missing. Propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: true, skipRedownload: false, changeCategory: false } so Sonarr searches for a German release. This rule takes precedence over the ordinary non-German fallback and quality-upgrade rules.
- If the Dub Oracle context is absent, expired, not above 0.6 confidence, not exists for the target season, or the candidate language metadata is absent, do not infer this block from the Oracle; use the other evidence and normal rules.
- If a candidate has languageMetadataPresent=true and hasGermanAudio=false while the mapped current file has hasGermanAudio=true, propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: true, skipRedownload: false, changeCategory: false }. Do not import it, use needs_review, or treat it as an ordinary non-upgrade.
- If candidate language metadata is absent, use needs_review; absence of metadata does not prove absence of German audio.
- If Sonarr's upgrade context shows the existing file is already better and the candidate is otherwise valid, propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: false, skipRedownload: false, changeCategory: false }. Do not blocklist these ordinary non-upgrades.
- If the release is unsuitable or unwanted, such as wrong episode, wrong series, missing usable video files, or disc structure, propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: true, skipRedownload: false, changeCategory: false } so Sonarr searches again.
- You are allowed to import a candidate using episode ids different from Sonarr's parsed candidate ids if your Sonarr lookup supports that mapping.
- For multi-file Season Pack candidates from the same download, you may select multiple safe candidates only when the selected files include the queued target episode. Never import a pack that leaves the queued target unresolved merely because it contains other valid monitored episodes.
- If none of the physical files maps to the queued target after Sonarr lookup, propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: true, skipRedownload: false, changeCategory: false } so Sonarr searches for the correct release.
- Because blocklisting removes the whole download, use needs_review for a mixed Season Pack that contains both safe imports and a non-German-over-German conflict; do not discard safe files automatically.
- Put the exact import mapping in selectedImports: candidateId plus the Sonarr episode ids to import the file as.
- Do not import if you cannot explain why the selected file and selected episode ids are the correct pair.
- If one real episode file and one sample are present, select only the real episode file and list the sample id in sampleCandidateIds.
- Do not select sample-like candidates even if Sonarr guessed an episode.
- Do not import Blu-ray disc structure chunks such as BDMV/STREAM/*.m2ts.
- If all candidates are Blu-ray disc structure chunks, use remove_queue_item.
- If Sonarr rejections are blocking or the episode/series mapping is unclear, use needs_review.
- Call propose_sonarr_resolution now.`;
}

function buildRadarrSystemPrompt(): string {
  return [
    "You resolve Radarr downloaded-queue manual import problems.",
    "You may use the provided read-only Radarr lookup tools, but you do not mutate Radarr.",
    "You receive one queue item plus Radarr manual import candidates.",
    "You must finish by calling propose_radarr_resolution exactly once.",
    "You decide the physical file candidate and exact Radarr movie id to import it as.",
    "Return that decision through selectedImports using candidateId and movieId.",
    "Always call radarr_get_upgrade_context before the proposal tool, for every queue item. The initial queue/candidate payload does not show whether the movie already has a library file. This requirement also applies when the only warning is sample detection.",
    "Never select candidates marked as likely samples.",
    "German audio is preferred but not required. When several usable candidates exist, prefer one whose languages include German.",
    "Candidates without German, such as English or original-language releases, are acceptable fallbacks only when the movie does not already have German audio. A German version may arrive later through the normal upgrade flow.",
    "Never remove or blocklist a queue item only because its languages lack German.",
    "Dub Oracle context is separate research about whether a German dub exists. It takes precedence over the ordinary non-German fallback rule when its verdict is exists with confidence greater than 0.6.",
    "A verified exists verdict means a German movie release is obtainable. When the candidate has known language metadata but no German audio, do not import it even if it is a quality upgrade or the current movie is English-only or missing. Use remove_queue_item with queueRemovalOptions removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so Radarr rejects that exact release and searches for a German one.",
    "Do not apply the Dub Oracle blocking rule to announced, unlikely, unknown, expired/missing context, confidence at or below 0.6, or unknown candidate language metadata. Use the normal rules and needs_review for genuine ambiguity.",
    "The fallback rule never runs backwards: when a candidate has known language metadata and lacks German while the existing movie file has German audio, do not import it and do not use needs_review. Use remove_queue_item with queueRemovalOptions removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so Radarr rejects this release and searches for a different one.",
    "Unknown or missing candidate language metadata is ambiguity, not proof that German is absent; use needs_review instead of the language-downgrade rule.",
    "Never import Blu-ray disc structure stream chunks such as BDMV/STREAM/*.m2ts.",
    "Treat Radarr status messages as the main diagnostic clue.",
    "Use radarr_get_upgrade_context on every analysis and compare the candidate to the current movie file, quality profile, custom format score, and languages.",
    "If the existing movie file is already better, remove the queue item without blocklisting it.",
    "For unsuitable releases such as the wrong movie, missing usable video files, or disc structures, remove and blocklist so Radarr searches again.",
    "Use radarr_get_movie to verify title, year, TMDb/IMDb identity, and the existing file before resolving a wrong-movie or ambiguous match.",
    "Do not import more than one feature file for a movie. Samples and extras must not be selected.",
    "Use needs_review when the file identity, movie id, or upgrade decision remains uncertain.",
    "Use ignore_queue_item only when the download should stay untouched in the download client but Radarr should stop tracking it.",
  ].join("\n");
}

function buildRadarrPrompt(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  dubVerdict?: FixerDubVerdictContext,
): string {
  return `Analyze this Radarr queue item and choose the safest resolution.

Queue item:
${JSON.stringify(
  {
    id: queueItem.id,
    title: queueItem.title,
    movieId: queueItem.movieId,
    movieTitle: queueItem.movieTitle,
    movieYear: queueItem.movieYear,
    status: queueItem.status,
    trackedDownloadStatus: queueItem.trackedDownloadStatus,
    trackedDownloadState: queueItem.trackedDownloadState,
    statusMessages: queueItem.statusMessages,
    outputPath: queueItem.outputPath,
    size: queueItem.size,
  },
  null,
  2,
)}

Manual import candidates:
${JSON.stringify(candidates.map(compactCandidate), null, 2)}

Active Dub Oracle context:
${dubVerdict ? JSON.stringify(dubVerdict, null, 2) : "No active Dub Oracle verdict is available for this movie."}

Rules:
- Read Radarr's statusMessages first.
- Always call radarr_get_upgrade_context before the proposal tool, even when the only warning is sample detection. The initial payload does not say whether a library file already exists.
- Use radarr_get_movie for movie identity when needed; use the mandatory upgrade context for current-file, quality, custom-format, and language comparison.
- Prefer German candidates. Candidates with known non-German language metadata are acceptable fallbacks only when the movie does not already have German audio; do not remove a download merely because it lacks German.
- If the Active Dub Oracle verdict is exists with confidence greater than 0.6, German audio is obtainable. Reject a candidate with languageMetadataPresent=true and hasGermanAudio=false even if it is higher quality or the current movie is English-only or missing. Propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: true, skipRedownload: false, changeCategory: false } so Radarr searches for a German release. This rule takes precedence over the ordinary non-German fallback and quality-upgrade rules.
- If the Dub Oracle context is absent, expired, not above 0.6 confidence, not exists, or the candidate language metadata is absent, do not infer this block from the Oracle; use the other evidence and normal rules.
- If a candidate has languageMetadataPresent=true and hasGermanAudio=false while the current movie file has hasGermanAudio=true, propose remove_queue_item with queueRemovalOptions { removeFromClient: true, blocklist: true, skipRedownload: false, changeCategory: false }. Do not import it, use needs_review, or treat it as an ordinary non-upgrade.
- If candidate language metadata is absent, use needs_review; absence of metadata does not prove absence of German audio.
- Map the chosen candidate to the exact queue/candidate movie id in selectedImports.movieId.
- Select only the main movie file; never select samples, extras, or Blu-ray disc structure chunks.
- If the existing file is better, remove without blocklisting. If the release is unsuitable or the wrong movie, remove and blocklist so Radarr searches again.
- If Radarr rejections are blocking or the movie mapping is unclear, use needs_review.
- Call propose_radarr_resolution now.`;
}

export function fallbackProposal(reason: string): ResolutionProposal {
  return {
    action: "needs_review",
    confidence: 0,
    selectedCandidateIds: [],
    selectedImports: [],
    sampleCandidateIds: [],
    reason,
    issueSummary: reason,
    evidence: [],
    warnings: [reason],
  };
}

// ============ resolution flow (ported from PiResolver.analyze; session runs via FixerPiRunner) ============

type ToolEmit = { type: string; itemId?: number; message: string; details?: unknown };

export interface ResolveQueueItemInput {
  queueItem: QueueItem;
  candidates: ManualImportCandidate[];
  dubVerdict?: FixerDubVerdictContext;
  /** Must match queueItem.service (sonarr port for sonarr items, radarr for radarr). */
  client: FixerClientPort;
  runner: FixerPiRunner;
  signal?: AbortSignal;
  onEvent?: (event: FixerAnalysisEvent) => void;
}

export async function resolveQueueItem(input: ResolveQueueItemInput): Promise<AnalysisResult> {
  const { queueItem, candidates, runner, signal } = input;
  const service: MediaService = queueItem.service;
  const serviceName = service === "radarr" ? "Radarr" : "Sonarr";
  const proposalToolName =
    service === "radarr" ? "propose_radarr_resolution" : "propose_sonarr_resolution";
  const log: string[] = [];

  const step = (
    level: "info" | "warning" | "error",
    source: "fixer" | "pi" | "sonarr" | "radarr",
    message: string,
    details?: unknown,
  ) =>
    input.onEvent?.({
      kind: "step",
      level,
      source,
      message,
      itemId: queueItem.id,
      ts: Date.now(),
      ...(details === undefined ? {} : { details }),
    });
  const toolEmit = (event: ToolEmit) =>
    step(
      event.type === "error" ? "error" : event.type === "warning" ? "warning" : "info",
      event.type === "pi" || event.type === "sonarr" || event.type === "radarr"
        ? event.type
        : "fixer",
      event.message,
      event.details,
    );

  if (candidates.length === 0) {
    const proposal = fallbackProposal(`${serviceName} returned no manual import candidates.`);
    return {
      queueItemId: queueItem.id,
      candidates,
      proposal,
      validation: { ok: true, issues: [] },
      status: "needs_review",
      log,
    };
  }

  const candidateIds = candidates.map((candidate) => candidate.id);
  let currentCandidates = candidates;
  const knownEpisodeIds = new Set<number>([
    ...queueItem.episodeIds,
    ...candidates.flatMap((candidate) => candidate.episodeIds),
  ]);
  const rememberEpisodeIds = (episodeIds: number[]) => {
    for (const episodeId of episodeIds) {
      if (Number.isSafeInteger(episodeId) && episodeId > 0) {
        knownEpisodeIds.add(episodeId);
      }
    }
  };
  let capturedProposal: ResolutionProposal | undefined;
  const proposalTool = createProposalTool(
    candidateIds,
    (proposal) => {
      capturedProposal = proposal;
    },
    service,
  );
  // The lookup tools only call the read-only methods in the client ports; the
  // class types cannot be satisfied structurally (private members), hence the casts.
  const lookupTools =
    service === "radarr"
      ? (() => {
          const client = input.client as RadarrFixerClientPort;
          return createRadarrLookupTools({
            client: client as unknown as RadarrClient,
            queueItem,
            getCandidates: () => currentCandidates,
            refreshCandidates: async () => {
              currentCandidates = await client.getManualImportCandidates(queueItem);
              return currentCandidates;
            },
            emit: toolEmit,
          });
        })()
      : (() => {
          const client = input.client as SonarrFixerClientPort;
          return createSonarrLookupTools({
            client: client as unknown as SonarrClient,
            queueItem,
            getCandidates: () => currentCandidates,
            refreshCandidates: async () => {
              currentCandidates = await client.getManualImportCandidates(queueItem);
              rememberEpisodeIds(currentCandidates.flatMap((candidate) => candidate.episodeIds));
              return currentCandidates;
            },
            rememberEpisodeIds,
            emit: toolEmit,
          });
        })();

  if (!signal?.aborted) {
    step("info", "pi", "Starting typed Pi analysis.");
    const runResult = await runner({
      service,
      queueItemId: queueItem.id,
      systemPrompt: service === "radarr" ? buildRadarrSystemPrompt() : buildSonarrSystemPrompt(),
      prompt:
        service === "radarr"
          ? buildRadarrPrompt(queueItem, candidates, input.dubVerdict)
          : buildSonarrPrompt(queueItem, candidates, input.dubVerdict),
      followUp: {
        prompt: `You did not call ${proposalToolName}. Call it now with the safest ${serviceName} resolution.`,
        when: () => {
          if (capturedProposal || signal?.aborted) {
            return false;
          }
          step("warning", "fixer", "Pi did not call the proposal tool; retrying once.");
          return true;
        },
      },
      tools: [...lookupTools, proposalTool],
      toolNames: service === "radarr" ? [...RADARR_TOOL_NAMES] : [...SONARR_TOOL_NAMES],
      signal,
      onEvent: input.onEvent,
    });
    log.push(...runResult.log);
  }

  const proposal = capturedProposal ?? fallbackProposal("Pi did not return a typed proposal.");
  const validation = validateProposalForImport(currentCandidates, proposal, queueItem, [
    ...knownEpisodeIds,
  ]);
  const status = proposal.action === "needs_review" || !validation.ok ? "needs_review" : "proposal";

  return {
    queueItemId: queueItem.id,
    candidates: currentCandidates,
    proposal,
    validation,
    status,
    log,
  };
}
