import type { ResolutionProposal, ValidationResult } from "./fixer-types.js";

const PROVIDER_USAGE_LIMIT =
  /usage limit|insufficient[_ -]?quota|quota exceeded|out of budget|rate.?limit|too many requests|\b429\b/i;

export function isProviderUsageLimit(message: string): boolean {
  return PROVIDER_USAGE_LIMIT.test(message);
}

export function autoApplyBlockReason(
  proposal: ResolutionProposal,
  validation: ValidationResult | null,
  settings: { fixerAutoImportConfidence: number; fixerAutoRemoveConfidence: number },
): string | null {
  if (!validation?.ok)
    return validation?.issues.map((issue) => issue.message).join(" ") || "Validation is required.";
  if (proposal.action !== "import_candidates" && proposal.action !== "remove_queue_item") {
    return proposal.reason || "Manual review required.";
  }
  const removal = proposal.action === "remove_queue_item";
  const threshold = removal
    ? settings.fixerAutoRemoveConfidence
    : settings.fixerAutoImportConfidence;
  if (proposal.confidence < threshold) {
    return `${Math.round(proposal.confidence * 100)}% confidence; ${removal ? "removal" : "import"} requires ${Math.round(threshold * 100)}%.`;
  }
  const options = proposal.queueRemovalOptions;
  if (
    removal &&
    (!options?.removeFromClient ||
      options.changeCategory ||
      (options.skipRedownload && !options.blocklist))
  ) {
    return "Removal options require manual review.";
  }
  return null;
}
