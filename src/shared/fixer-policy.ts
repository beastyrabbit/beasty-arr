import type { ResolutionProposal, ValidationResult } from "./fixer-types.js";

const PROVIDER_USAGE_LIMIT =
  /usage limit|insufficient[_ -]?quota|quota exceeded|out of budget|rate.?limit|too many requests|\b429\b/i;

/** An HTTP error from Sonarr or Radarr ("Sonarr 429 Too Many Requests: …"), not the AI provider. */
const ARR_HTTP_ERROR = /^(?:Sonarr|Radarr) \d{3}\b/;

export function isProviderUsageLimit(message: string): boolean {
  return PROVIDER_USAGE_LIMIT.test(message) && !ARR_HTTP_ERROR.test(message);
}

type ConfidenceGates = { fixerAutoImportConfidence: number; fixerAutoRemoveConfidence: number };

/**
 * The confidence an automatic apply needs: the removal gate for removals,
 * except a verified non-upgrade removal that blocklists without a new search,
 * which the deterministic library comparison backs like an import.
 */
export function autoApplyThreshold(
  proposal: ResolutionProposal,
  validation: ValidationResult | null,
  settings: ConfidenceGates,
): number {
  const options = proposal.queueRemovalOptions;
  const safeNonUpgrade =
    validation?.safeNonUpgradeRemoval && options?.blocklist && options.skipRedownload;
  return proposal.action === "remove_queue_item" && !safeNonUpgrade
    ? settings.fixerAutoRemoveConfidence
    : settings.fixerAutoImportConfidence;
}

export function autoApplyBlockReason(
  proposal: ResolutionProposal,
  validation: ValidationResult | null,
  settings: ConfidenceGates,
): string | null {
  if (!validation?.ok)
    return validation?.issues.map((issue) => issue.message).join(" ") || "Validation is required.";
  if (proposal.action !== "import_candidates" && proposal.action !== "remove_queue_item") {
    return proposal.reason || "Manual review required.";
  }
  const removal = proposal.action === "remove_queue_item";
  const options = proposal.queueRemovalOptions;
  const threshold = autoApplyThreshold(proposal, validation, settings);
  if (proposal.confidence < threshold) {
    return `${Math.round(proposal.confidence * 100)}% confidence; ${removal ? "removal" : "import"} requires ${Math.round(threshold * 100)}%.`;
  }
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
