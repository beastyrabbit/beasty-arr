import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  BudgetLedgerEntry,
  BudgetLedgerResponse,
  BudgetResponse,
  BudgetSettings,
  BudgetSettingsResponse,
  IndexerBudget,
} from "../../../shared/api-types.js";
import type { AppSettings } from "../../config/settings.js";
import type { AppContext } from "../../context.js";
import { budgetBuckets, indexers } from "../../db/schema.js";
import { pageOffset, parse } from "./util.js";

function budgetSettingsOf(s: AppSettings): BudgetSettings {
  return {
    budgetSafetyPct: s.budgetSafetyPct,
    budgetHorizonHours: s.budgetHorizonHours,
    budgetTrickleMinPerHour: s.budgetTrickleMinPerHour,
    budgetPacingHorizonHours: s.budgetPacingHorizonHours,
    budgetBurstMaxDivisor: s.budgetBurstMaxDivisor,
    excludeIndexerIds: s.excludeIndexerIds,
  };
}

const budgetPatchSchema = z
  .object({
    budgetSafetyPct: z.number().min(0).max(0.9).optional(),
    budgetHorizonHours: z.number().int().min(1).max(24).optional(),
    budgetTrickleMinPerHour: z.number().min(0).optional(),
    budgetPacingHorizonHours: z.number().int().min(1).max(24).optional(),
    budgetBurstMaxDivisor: z.number().int().min(1).optional(),
    excludeIndexerIds: z.array(z.number().int()).optional(),
  })
  .strict();

const ledgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  indexerId: z.coerce.number().int().optional(),
});

export function registerBudgetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/budget", async () => {
    const settings = budgetSettingsOf(ctx.settings.get());
    const budget = ctx.services.budget;
    if (!budget) {
      const response: BudgetResponse = { indexers: [], settings, refreshedAt: null };
      return response;
    }
    // enabled + grabLimit are not in the controller status; pull them from the mirror.
    const extras = new Map<
      number,
      { enabled: boolean; grabLimit: number | null; lastSyncedAt: number }
    >();
    for (const ix of ctx.db.select().from(indexers).all()) {
      extras.set(ix.id, {
        enabled: ix.enabled,
        grabLimit: ix.grabLimit,
        lastSyncedAt: ix.lastSyncedAt,
      });
    }
    const items: IndexerBudget[] = budget.getStatus().map((s) => {
      const extra = extras.get(s.id);
      return {
        id: s.id,
        name: s.name,
        enabled: extra?.enabled ?? true,
        cap: s.cap,
        grabLimit: extra?.grabLimit ?? null,
        trailing24h: s.trailing24h,
        huntShare: s.huntShare,
        organicShare: s.organicShare,
        forecastNextHorizon: s.forecastNextHorizon,
        target: s.target,
        huntRatePerHour: s.huntRatePerHour,
        canHuntNow: s.canHuntNow,
        inBackoff: s.inBackoff,
        excluded: s.excluded,
      };
    });
    let refreshedAt: number | null = null;
    for (const extra of extras.values()) {
      refreshedAt =
        refreshedAt == null ? extra.lastSyncedAt : Math.max(refreshedAt, extra.lastSyncedAt);
    }
    const response: BudgetResponse = { indexers: items, settings, refreshedAt };
    return response;
  });

  app.get("/api/budget/ledger", async (request, reply) => {
    const q = parse(reply, ledgerQuerySchema, request.query);
    if (!q.ok) return;
    const filters = q.data.indexerId != null ? [eq(budgetBuckets.indexerId, q.data.indexerId)] : [];
    const where = filters.length ? and(...filters) : undefined;
    const total = ctx.db.select({ n: count() }).from(budgetBuckets).where(where).get()?.n ?? 0;
    const rows = ctx.db
      .select({
        indexerId: budgetBuckets.indexerId,
        hourUtc: budgetBuckets.hourUtc,
        observedQueries: budgetBuckets.observedQueries,
        observedGrabs: budgetBuckets.observedGrabs,
        huntQueries: budgetBuckets.huntQueries,
        indexerName: indexers.name,
      })
      .from(budgetBuckets)
      .leftJoin(indexers, eq(budgetBuckets.indexerId, indexers.id))
      .where(where)
      .orderBy(desc(budgetBuckets.hourUtc))
      .limit(q.data.pageSize)
      .offset(pageOffset(q.data.page, q.data.pageSize))
      .all();
    const items: BudgetLedgerEntry[] = rows.map((r) => ({
      indexerId: r.indexerId,
      indexerName: r.indexerName ?? `#${r.indexerId}`,
      hourUtc: r.hourUtc,
      observedQueries: r.observedQueries,
      observedGrabs: r.observedGrabs,
      huntQueries: r.huntQueries,
      organicQueries: Math.max(0, r.observedQueries - r.huntQueries),
    }));
    const response: BudgetLedgerResponse = {
      items,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
    };
    return response;
  });

  app.put("/api/budget/settings", async (request, reply) => {
    const b = parse(reply, budgetPatchSchema, request.body);
    if (!b.ok) return;
    const updated = ctx.settings.update(b.data);
    ctx.bus.emit("budget.updated", { reason: "settings" });
    const response: BudgetSettingsResponse = budgetSettingsOf(updated);
    return response;
  });
}
