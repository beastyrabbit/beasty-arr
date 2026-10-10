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
  const target = service === "radarr" ? "movie" : "episode";
  const selectedImport =
    service === "radarr"
      ? Type.Object({
          candidateId,
          movieId: Type.Integer({
            minimum: 1,
            description: "Exact Radarr movie id this file should be imported as.",
          }),
          reason: Type.Optional(
            Type.String({ description: "Why this file is this Radarr movie." }),
          ),
        })
      : Type.Object({
          candidateId,
          episodeIds: Type.Array(Type.Integer({ minimum: 1 }), {
            minItems: 1,
            description:
              "Exact Sonarr episode ids this file really is, established from your own inspection, not from Sonarr's guess.",
          }),
          reason: Type.Optional(
            Type.String({
              description:
                "Why this file is these episodes, especially when Sonarr guessed otherwise.",
            }),
          ),
        });

  return defineTool({
    name: toolName,
    label: `Propose ${serviceName} Resolution`,
    description: `Return the final typed ${serviceName} queue resolution proposal. This is the only tool that decides what the app will do.`,
    promptSnippet: `Return the final typed ${serviceName} queue resolution proposal.`,
    promptGuidelines: [
      `Always finish by calling ${toolName} exactly once.`,
      `Before calling ${toolName}, inspect the real files with inspect_media_files and read the upgrade context; ${serviceName}'s labels are claims, not facts.`,
      `identity is mandatory: say what the download actually is and how you know. verdict confirmed only when your own observations (embedded title, subtitle dialogue, runtime against the looked-up runtime, NFO ids, ${serviceName}'s independent parse) show it is the queued ${target}. Matching ids from ${serviceName}'s grab history are never evidence.`,
      "An import with identity verdict other than confirmed is never applied automatically; it waits for the user.",
      "Never select candidates that are samples, extras, or Blu-ray disc structure chunks.",
      "Judge languages from the inspected audio streams (including untagged tracks titled German/Deutsch), not from the arr's language labels. An explicit release-name marker such as German, Deutsch, GER or DEU is useful corroborating evidence; when a stream tag and title disagree, weigh the filename marker, other streams, and release context like a person doing a manual import, then explain the uncertainty in rationale.",
      "When active Dub Oracle context says exists with confidence greater than 0.6 and the inspected candidate has no German audio, use remove_queue_item with removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false so a German release is searched, unless the current library file already has German audio.",
      "If the current library file has German audio (per inspection) and the candidate does not, use remove_queue_item with removeFromClient=true, blocklist=true, skipRedownload=true, changeCategory=false: block the exact release, no replacement search is needed because the library target is already satisfied.",
      "Never remove a candidate that has German audio while the current library file has none; import it or use needs_review.",
      "Use needs_review only when direct observations leave the identity or right action materially unresolved. A stale arr label or one conflicting stream metadata field alone is not enough; make the best supported decision from the whole release.",
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
        description:
          "Probability that the action is right. Below 0.9 whenever any identity, language, or quality fact rests on labels you could not verify.",
      }),
      identity: Type.Object(
        {
          verdict: Type.Union(
            [Type.Literal("confirmed"), Type.Literal("contradicted"), Type.Literal("uncertain")],
            {
              description: `confirmed: the file is the queued ${target}; contradicted: it is something else; uncertain: you could not prove either.`,
            },
          ),
          actualWork: Type.String({
            minLength: 1,
            description:
              service === "radarr"
                ? "What the file really is, e.g. 'Sunset (1988, Blake Edwards)'."
                : "What the file really is, e.g. 'Monster: The Lizzie Borden Story, S04E07 The Trial of the Century'.",
          }),
          evidence: Type.Array(Type.String(), {
            minItems: 1,
            description:
              "Your own observations that establish the identity: embedded title, subtitle lines, measured runtime vs looked-up runtime, NFO ids, independent parse/lookup results.",
          }),
        },
        { description: "What the download actually is, established independently of the arr." },
      ),
      // Lists below are optional: a removal or review has nothing to put in them.
      selectedCandidateIds: Type.Optional(
        Type.Array(candidateId, {
          description:
            "Candidates to import; only for import_candidates. Must match the candidateId values in selectedImports.",
          maxItems: service === "radarr" ? 1 : candidateIds.length,
        }),
      ),
      selectedImports: Type.Optional(
        Type.Array(selectedImport, {
          description:
            service === "radarr"
              ? "Authoritative file-to-movie mapping; required for import_candidates."
              : "Authoritative file-to-episode mapping; required for import_candidates.",
          maxItems: service === "radarr" ? 1 : candidateIds.length,
        }),
      ),
      sampleCandidateIds: Type.Optional(
        Type.Array(candidateId, {
          description: "Candidates believed to be samples.",
          maxItems: candidateIds.length,
        }),
      ),
      queueRemovalOptions: Type.Optional(
        Type.Object(
          {
            removeFromClient: Type.Boolean({
              description: "Delete/remove this release from the download client.",
            }),
            blocklist: Type.Boolean({
              description: `Blocklist this exact release so ${serviceName} does not grab it again.`,
            }),
            skipRedownload: Type.Boolean({
              description: `When true, do not trigger a replacement search; when false, ${serviceName} searches for a replacement.`,
            }),
            changeCategory: Type.Boolean({
              description: `Ask ${serviceName} to change the download category instead of deleting it.`,
            }),
          },
          {
            description: `Only for remove_queue_item. Wrong ${target} or unusable release: removeFromClient=true, blocklist=true, skipRedownload=false, changeCategory=false (search again). Duplicate of the library file or not an upgrade over it: removeFromClient=true, blocklist=true, skipRedownload=true, changeCategory=false (the target is satisfied; blocklisting stops the same release from being grabbed again).`,
          },
        ),
      ),
      reason: Type.String({
        minLength: 1,
        description: "One-sentence summary of the decision.",
      }),
      rationale: Type.String({
        minLength: 1,
        description:
          "Your written reasoning, as a human operator would note it: what the file is, what the library has, how languages and quality compare, why this action. Mention anything you could not verify.",
      }),
      issueSummary: Type.String({
        description: `What ${serviceName} complained about and whether the complaint was right.`,
      }),
      evidence: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Concrete facts used for the decision (identity, languages from inspected streams, resolution, runtime, scores).",
        }),
      ),
      warnings: Type.Optional(
        Type.Array(Type.String(), { description: "Risks or ambiguity the user should review." }),
      ),
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
