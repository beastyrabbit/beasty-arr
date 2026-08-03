import type { FixerQueueItemDto } from "../../shared/api-types.js";

export function waitsForReview(item: FixerQueueItemDto): boolean {
  return item.analysisState === "proposal" || item.analysisState === "needs_review";
}

/** One visible row per service/download, preferring the row that owns its analysis. */
export function uniqueQueueItems(items: FixerQueueItemDto[]): FixerQueueItemDto[] {
  const representatives = new Map<string, FixerQueueItemDto>();
  for (const item of items) {
    const key = item.downloadId
      ? `${item.service}:${item.downloadId}`
      : `${item.service}:${item.id}`;
    const current = representatives.get(key);
    if (!current || (!current.analysisId && item.analysisId)) {
      representatives.set(key, item);
    }
  }
  return [...representatives.values()];
}
