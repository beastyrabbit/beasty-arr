import { defineTool } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { MediaService, ResolutionProposal } from "../../shared/fixer-types.js";
import { normalizeProposal } from "./validation.js";

type ProposalCapture = (proposal: ResolutionProposal) => void;

function literalUnion(values: string[], fallback: TSchema): TSchema {
  if (values.length === 0) {
    return fallback;
  }
  if (values.length === 1) {
    return Type.Literal(values[0]);
  }
  const literals = values.map((value) => Type.Literal(value)) as unknown as [
    TSchema,
    TSchema,
    ...TSchema[],
  ];
  return Type.Union(literals);
}

export function createProposalTool(
  candidateIds: string[],
  capture: ProposalCapture,
  service: MediaService = "sonarr",
) {
  const candidateId = literalUnion(candidateIds, Type.String({ minLength: 1 }));
  const serviceName = service === "radarr" ? "Radarr" : "Sonarr";
  const toolName = service === "radarr" ? "propose_radarr_resolution" : "propose_sonarr_resolution";
  const selectedImport =
    service === "radarr"
      ? Type.Object({
          candidateId,
          movieId: Type.Integer({
            minimum: 1,
            description: "Exact Radarr movie id this file should be imported as.",
          }),
          reason: Type.Optional(
            Type.String({ description: "Why this file matches the selected Radarr movie." }),
          ),
        })
      : Type.Object({
          candidateId,
          episodeIds: Type.Array(Type.Integer({ minimum: 1 }), {
            minItems: 1,
            description:
              "Exact Sonarr episode ids this file should be imported as. Choose these ids from the queue/episode lookup context.",
          }),
          reason: Type.Optional(
            Type.String({
              description:
                "Why this file should be imported using these episode ids, especially when Sonarr parsed it differently.",
            }),
          ),
        });

  return defineTool({
    name: toolName,
    label: `Propose ${serviceName} Resolution`,
    description: `Return the final typed ${serviceName} queue resolution proposal. This is the only tool that decides what the app will import.`,
    promptSnippet: `Return the final typed ${serviceName} queue resolution proposal.`,
    promptGuidelines: [
      `Always finish ${serviceName} queue analysis by calling ${toolName}.`,
      `Before calling ${toolName}, always call ${service === "radarr" ? "radarr_get_upgrade_context" : "sonarr_get_upgrade_context"}; the initial candidate list does not prove whether a library file already exists.`,
      service === "radarr"
        ? "Use selectedImports to explicitly map each chosen file candidate to its exact Radarr movie id."
        : "Use selectedImports to explicitly map each chosen file candidate to the Sonarr episode ids it should be imported as.",
      service === "radarr"
        ? "The selectedImports mapping is authoritative; do not guess a movie id outside the queue or candidate context."
        : "The selectedImports mapping is authoritative; do not rely on Sonarr's parsed candidate episode ids when you decide they are wrong.",
      service === "radarr"
        ? "The selected movie must be the queued movie."
        : "Every import proposal must include the queued target episode. Do not import unrelated episodes while leaving the target unresolved.",
      "Never select candidates marked as likely samples.",
      "When active Dub Oracle context says exists with confidence greater than 0.6, a candidate with known language metadata but no German audio must use remove_queue_item with removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false, even when it is a quality upgrade or the current file is non-German or missing. For Sonarr, apply the exact perSeason verdict when available.",
      "If a current library file has German audio and the incoming candidate has known language metadata but no German audio, use remove_queue_item with removeFromClient=true, blocklist=true, skipRedownload=true, changeCategory=false. The exact bad release must be blocked, but no replacement search is needed because the library target is already satisfied. This is not needs_review and not an ordinary non-upgrade removal.",
      service === "sonarr"
        ? "A 'Not a quality revision upgrade' rejection may be overridden with import_candidates when the mapping is exact, the candidate adds German audio to a non-German current file, the quality profile allows it, and the custom-format score is materially higher."
        : "Use the current movie, quality profile, and custom-format evidence to distinguish a real upgrade from a blocking rejection.",
      "Use needs_review when the candidate data is ambiguous or incomplete.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("import_candidates"),
        Type.Literal("needs_review"),
        Type.Literal("ignore_queue_item"),
        Type.Literal("remove_queue_item"),
      ]),
      confidence: Type.Number({
        minimum: 0,
        maximum: 1,
        description: "Confidence from 0 to 1.",
      }),
      selectedCandidateIds: Type.Array(candidateId, {
        description:
          "Candidates to import. Empty unless action is import_candidates. Must match the candidateId values in selectedImports.",
        maxItems: service === "radarr" ? 1 : candidateIds.length,
      }),
      selectedImports: Type.Array(selectedImport, {
        description:
          service === "radarr"
            ? "Authoritative file-to-movie mapping for import_candidates. Empty for non-import actions."
            : "Authoritative file-to-episode mapping for import_candidates. Empty for non-import actions.",
        maxItems: service === "radarr" ? 1 : candidateIds.length,
      }),
      sampleCandidateIds: Type.Array(candidateId, {
        description: "Candidates believed to be samples.",
        maxItems: candidateIds.length,
      }),
      queueRemovalOptions: Type.Optional(
        Type.Object(
          {
            removeFromClient: Type.Boolean({
              description: "Delete/remove this release from the download client.",
            }),
            blocklist: Type.Boolean({
              description: `Blocklist this exact release so ${serviceName} cannot select it again.`,
            }),
            skipRedownload: Type.Boolean({
              description: `When true, do not trigger an immediate replacement search; when false, ${serviceName} may search/redownload a replacement.`,
            }),
            changeCategory: Type.Boolean({
              description: `Ask ${serviceName} to change the download category instead of deleting it.`,
            }),
          },
          {
            description:
              "Only for remove_queue_item. For ordinary non-upgrades where the existing library file is better, use removeFromClient=true, blocklist=false, skipRedownload=false, changeCategory=false. When a candidate explicitly lacks German and would replace a German-audio library file, use removeFromClient=true, blocklist=true, skipRedownload=true, changeCategory=false because the target is already satisfied. For unsuitable releases such as wrong episodes, wrong series/movie, or unusable folders, use removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so the missing or unresolved target can be searched again.",
          },
        ),
      ),
      reason: Type.String({
        minLength: 1,
        description: "Short reason for the proposal.",
      }),
      issueSummary: Type.String({
        description: `Explain what ${serviceName} complained about and how that warning affected the decision.`,
      }),
      evidence: Type.Array(Type.String(), {
        description: `Concrete evidence used for the decision, such as parsed target, path, quality, language, size, or ${serviceName} warnings.`,
      }),
      warnings: Type.Array(Type.String(), {
        description: "Risks or ambiguity the user should review.",
      }),
    }),
    async execute(_toolCallId, params) {
      capture(normalizeProposal(params as ResolutionProposal));
      return {
        content: [{ type: "text", text: `Captured ${serviceName} resolution proposal.` }],
        details: params,
        terminate: true,
      };
    },
  });
}
