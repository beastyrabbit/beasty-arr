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
      service === "radarr"
        ? "Use selectedImports to explicitly map each chosen file candidate to its exact Radarr movie id."
        : "Use selectedImports to explicitly map each chosen file candidate to the Sonarr episode ids it should be imported as.",
      service === "radarr"
        ? "The selectedImports mapping is authoritative; do not guess a movie id outside the queue or candidate context."
        : "The selectedImports mapping is authoritative; do not rely on Sonarr's parsed candidate episode ids when you decide they are wrong.",
      "Never select candidates marked as likely samples.",
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
              description: `Blocklist this exact release so ${serviceName} searches for a different one.`,
            }),
            skipRedownload: Type.Boolean({
              description: `When false, ${serviceName} may search/redownload a replacement.`,
            }),
            changeCategory: Type.Boolean({
              description: `Ask ${serviceName} to change the download category instead of deleting it.`,
            }),
          },
          {
            description:
              "Only for remove_queue_item. For ordinary non-upgrades where the existing episode file is already better, use removeFromClient=true, blocklist=false, skipRedownload=false, changeCategory=false. For unsuitable releases such as wrong episodes, wrong series, or unusable folders, use removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false.",
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
