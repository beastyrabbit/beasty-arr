import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManualImportCandidate } from "../../shared/fixer-types.js";
import type { MediaProber } from "../media/types.js";
import { type InspectionFacts, probePaths, summarizeProbe } from "./inspection.js";

const MAX_FILES_PER_CALL = 6;

/**
 * Lets the AI look inside the real files: the downloaded candidates and the
 * current library files. Read-only; results are stored in the shared facts so
 * the deterministic guards see the same observations.
 */
export function createInspectMediaTool(input: {
  prober: MediaProber | undefined;
  facts: InspectionFacts;
  getCandidates: () => ManualImportCandidate[];
  /** Library file paths of the given targets (movie id / episode ids); defaults to the queued targets. */
  currentFilePaths: (targetIds?: number[]) => Promise<string[]>;
}) {
  return defineTool({
    name: "inspect_media_files",
    label: "Inspect Media Files",
    description:
      "Look inside the real files with ffprobe: duration, embedded title, chapters, video resolution, every audio and subtitle stream with its language (untagged tracks inferred from their titles), plus optionally the first subtitle dialogue lines and the download folder listing with NFO ids. Use it to establish what a file actually is and which languages it really has.",
    promptSnippet:
      "Use inspect_media_files to see what a downloaded or library file really contains.",
    promptGuidelines: [
      "Subtitle dialogue (subtitleExcerpt=true) is the strongest identity evidence when names and runtimes are ambiguous: it names characters, places and plot.",
      "Folder listings and NFO files often carry the real IMDb/TMDb/TVDB id of the release.",
      "Inspect the current library file too before claiming what languages or resolution the library has.",
    ],
    parameters: Type.Object({
      candidateIds: Type.Optional(
        Type.Array(Type.String(), {
          description: `Manual import candidate ids to inspect (max ${MAX_FILES_PER_CALL}).`,
        }),
      ),
      currentFilesForTargetIds: Type.Optional(
        Type.Array(Type.Integer(), {
          description:
            "Movie id or episode ids whose current library files should be inspected. Omit for the queued targets; pass [] for none.",
        }),
      ),
      subtitleExcerpt: Type.Optional(
        Type.Boolean({ description: "Include the first subtitle dialogue lines (slower)." }),
      ),
      folder: Type.Optional(
        Type.Boolean({ description: "Include the folder listing and NFO ids (candidates only)." }),
      ),
    }),
    executionMode: "parallel" as const,
    async execute(_toolCallId, params) {
      const candidates = input.getCandidates();
      const wanted = params.candidateIds ?? [];
      const candidatePaths = candidates
        .filter((candidate) => wanted.includes(candidate.id))
        .map((candidate) => candidate.path);
      const currentPaths =
        params.currentFilesForTargetIds?.length === 0
          ? []
          : await input.currentFilePaths(params.currentFilesForTargetIds);
      const options = { subtitleExcerpt: params.subtitleExcerpt === true };
      const [candidateResults, currentResults] = await Promise.all([
        probePaths(input.facts, input.prober, candidatePaths.slice(0, MAX_FILES_PER_CALL), {
          ...options,
          folder: params.folder === true,
        }),
        probePaths(input.facts, input.prober, currentPaths.slice(0, MAX_FILES_PER_CALL), options),
      ]);
      const details = {
        candidates: candidateResults.map((result) => ({
          candidateId: candidates.find((candidate) => candidate.path === result.path)?.id,
          ...summarizeProbe(result),
        })),
        currentLibraryFiles: currentResults.map(summarizeProbe),
        unknownCandidateIds: wanted.filter((id) => !candidates.some((c) => c.id === id)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
}
