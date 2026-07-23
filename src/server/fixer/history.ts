import { desc, sql } from "drizzle-orm";
import type { ArrSource } from "../../shared/domain.js";
import type { Db } from "../db/index.js";
import { fixerHistory } from "../db/schema.js";

export type FixerHistoryEntry = typeof fixerHistory.$inferSelect;
export type FixerHistoryAction = "import" | "ignore" | "remove" | "blocklist";
export type FixerHistorySourceKind = "ai_auto" | "ai_user" | "user";
export type FixerHistoryResult = "ok" | "error" | "simulated";

export interface FixerHistoryInput {
  at: number;
  service: ArrSource;
  itemLabel: string;
  action: FixerHistoryAction;
  sourceKind: FixerHistorySourceKind;
  confidence?: number;
  analysisId?: string;
  dryRun: boolean;
  result: FixerHistoryResult;
  detail?: Record<string, unknown>;
}

export interface FixerHistoryPage {
  items: FixerHistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export function recordFixerHistory(db: Db, entry: FixerHistoryInput): number {
  const row = db
    .insert(fixerHistory)
    .values({
      at: entry.at,
      service: entry.service,
      itemLabel: entry.itemLabel,
      action: entry.action,
      sourceKind: entry.sourceKind,
      confidence: entry.confidence ?? null,
      analysisId: entry.analysisId ?? null,
      dryRun: entry.dryRun,
      result: entry.result,
      detail: entry.detail ?? null,
    })
    .returning({ id: fixerHistory.id })
    .get();
  return row.id;
}

export function listFixerHistory(
  db: Db,
  opts: { page?: number; pageSize?: number } = {},
): FixerHistoryPage {
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(opts.pageSize ?? 50)));
  const items = db
    .select()
    .from(fixerHistory)
    .orderBy(desc(fixerHistory.at), desc(fixerHistory.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const total = db.select({ count: sql<number>`count(*)` }).from(fixerHistory).get()?.count ?? 0;
  return { items, total, page, pageSize };
}
