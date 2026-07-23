import { and, desc, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AppSettings, SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import { budgetBuckets, indexerSnapshots, indexers, pendingSelfEstimates } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import type { ProwlarrClient } from "../prowlarr/client.js";

const HOUR_MS = 3_600_000;
/** History window feeding the organic forecast. */
const FORECAST_WINDOW_HOURS = 28 * 24;
/** Hour-of-day weighting kicks in once this much history exists; flat mean before. */
const HOURLY_FORECAST_MIN_HOURS = 7 * 24;
const EWMA_ALPHA = 0.3;
/** Snapshots/buckets older than this are pruned on refresh. */
const RETENTION_MS = 30 * 24 * HOUR_MS;

/** Subset of the Prowlarr client the manager needs (structural, easy to fake). */
export type ProwlarrBudgetApi = Pick<
  ProwlarrClient,
  "getIndexers" | "getIndexerStats" | "getIndexerStatus"
>;

export type EstimateInput = { kind: "tv" | "movie"; searchOps: number; anime?: boolean };

export type DispatchDecision = { ok: true } | { ok: false; holdReason: string };

export type IndexerBudgetStatus = {
  id: number;
  name: string;
  /** Daily query cap; null = unlimited. */
  cap: number | null;
  /** Observed queries in the trailing 24 bucket-hours + pending self-estimates. */
  trailing24h: number;
  /** Our attributed share of the trailing 24h (bucket huntQueries, written at dispatch). */
  huntShare: number;
  /** Observed minus hunt attribution over the trailing 24h (floored at 0). */
  organicShare: number;
  /** Forecast organic spend over the next `budgetHorizonHours`. */
  forecastNextHorizon: number;
  target: number | null;
  huntRatePerHour: number | null;
  canHuntNow: boolean;
  inBackoff: boolean;
  excluded: boolean;
};

type IndexerRow = typeof indexers.$inferSelect;

type ControllerState = {
  trailing24h: number;
  huntShare: number;
  organicShare: number;
  huntHourSpend: number;
  forecast: number;
  /** Null for unlimited indexers (never gated). */
  target: number | null;
  huntRatePerHour: number | null;
};

/**
 * Demand-adaptive budget controller. Prowlarr exposes no remaining-quota API,
 * so we self-account: snapshot cumulative indexer stats, diff into hourly
 * buckets, attribute our own dispatches, forecast organic demand, and pace
 * hunting to keep trailing-24h usage hugging `cap*(1-safety) - expectedOrganic`.
 */
export class BudgetManager {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly prowlarr: ProwlarrBudgetApi,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Sync the indexers mirror, take cumulative snapshots, diff them into hourly
   * buckets, clear covered pending self-estimates, and update backoff flags.
   */
  async refresh(): Promise<void> {
    const [remote, stats, statuses] = await Promise.all([
      this.prowlarr.getIndexers(),
      this.prowlarr.getIndexerStats(),
      this.prowlarr.getIndexerStatus(),
    ]);
    const now = this.now();
    const hourUtc = Math.floor(now / HOUR_MS);
    const backoffIds = new Set(
      statuses
        .filter((s) => s.disabledTill !== null && s.disabledTill > now)
        .map((s) => s.indexerId),
    );

    for (const ix of remote) {
      const values = {
        name: ix.name,
        enabled: ix.enable,
        queryLimit: ix.queryLimit,
        grabLimit: ix.grabLimit,
        supportsTv: ix.supportsTv,
        supportsMovies: ix.supportsMovies,
        inBackoff: backoffIds.has(ix.id),
        lastSyncedAt: now,
      };
      this.db
        .insert(indexers)
        .values({ id: ix.id, ...values })
        .onConflictDoUpdate({ target: indexers.id, set: values })
        .run();
    }
    const remoteIds = remote.map((ix) => ix.id);
    if (remoteIds.length > 0) {
      this.db.delete(indexers).where(notInArray(indexers.id, remoteIds)).run();
    } else {
      this.db.delete(indexers).run();
    }

    const known = new Set(remoteIds);
    for (const stat of stats) {
      if (!known.has(stat.indexerId)) continue;
      const queriesTotal =
        stat.numberOfQueries + stat.numberOfRssQueries + stat.numberOfAuthQueries;
      const grabsTotal = stat.numberOfGrabs;
      const prev = this.db
        .select()
        .from(indexerSnapshots)
        .where(eq(indexerSnapshots.indexerId, stat.indexerId))
        .orderBy(desc(indexerSnapshots.takenAt))
        .limit(1)
        .get();
      this.db
        .insert(indexerSnapshots)
        .values({ indexerId: stat.indexerId, takenAt: now, queriesTotal, grabsTotal })
        .onConflictDoNothing()
        .run();
      if (!prev) continue; // first snapshot = baseline only
      let deltaQueries = queriesTotal - prev.queriesTotal;
      let deltaGrabs = grabsTotal - prev.grabsTotal;
      if (deltaQueries < 0 || deltaGrabs < 0) {
        // Prowlarr stats reset — re-baseline from the new totals with a 0 delta.
        this.log.warn(
          { indexerId: stat.indexerId, deltaQueries, deltaGrabs },
          "prowlarr stats went backwards; re-baselining",
        );
        deltaQueries = Math.max(0, deltaQueries);
        deltaGrabs = Math.max(0, deltaGrabs);
      }
      if (deltaQueries === 0 && deltaGrabs === 0) continue;
      this.db
        .insert(budgetBuckets)
        .values({
          indexerId: stat.indexerId,
          hourUtc,
          observedQueries: deltaQueries,
          observedGrabs: deltaGrabs,
          huntQueries: 0,
        })
        .onConflictDoUpdate({
          target: [budgetBuckets.indexerId, budgetBuckets.hourUtc],
          set: {
            observedQueries: sql`${budgetBuckets.observedQueries} + ${deltaQueries}`,
            observedGrabs: sql`${budgetBuckets.observedGrabs} + ${deltaGrabs}`,
          },
        })
        .run();
    }

    // Estimates dispatched before this snapshot are now covered by observed totals.
    this.db.delete(pendingSelfEstimates).where(lt(pendingSelfEstimates.at, now)).run();

    this.db
      .delete(indexerSnapshots)
      .where(lt(indexerSnapshots.takenAt, now - RETENTION_MS))
      .run();
    this.db
      .delete(budgetBuckets)
      .where(lt(budgetBuckets.hourUtc, hourUtc - FORECAST_WINDOW_HOURS - 24))
      .run();

    this.bus.emit("budget.updated", { indexers: this.getStatus() });
  }

  /** Per eligible indexer estimated queries for a command with `searchOps` search operations. */
  estimateCommand(input: EstimateInput): Map<number, number> {
    const perIndexer = Math.max(0, Math.ceil(input.searchOps)) * (input.anime ? 2 : 1);
    const out = new Map<number, number>();
    if (perIndexer === 0) return out;
    for (const ix of this.db.select().from(indexers).all()) {
      if (!ix.enabled || ix.inBackoff) continue;
      if (input.kind === "tv" ? !ix.supportsTv : !ix.supportsMovies) continue;
      // Unlimited and excluded indexers stay in the estimate: Prowlarr will
      // really query them, and attribution must stay accurate. Gating skips them.
      out.set(ix.id, perIndexer);
    }
    return out;
  }

  /**
   * ALL-rule dispatch gate: every limited, enabled, non-backoff, non-excluded
   * indexer must satisfy both `trailing24h + est <= target` and
   * `huntSpendThisHour + est <= huntRatePerHour`. Any failure holds the command.
   */
  mayDispatch(estimates: Map<number, number>): DispatchDecision {
    const cfg = this.settings.get();
    const excluded = new Set(cfg.excludeIndexerIds);
    const now = this.now();
    const rows = new Map(
      this.db
        .select()
        .from(indexers)
        .all()
        .map((ix) => [ix.id, ix]),
    );
    for (const [indexerId, est] of estimates) {
      const ix = rows.get(indexerId);
      if (!ix || ix.queryLimit === null) continue; // unlimited never gates
      if (excluded.has(indexerId)) continue;
      if (!ix.enabled || ix.inBackoff) continue;
      const c = this.controllerFor(ix, now, cfg);
      if (c.target === null || c.huntRatePerHour === null) continue;
      if (c.trailing24h + est > c.target) {
        return {
          ok: false,
          holdReason: `${ix.name}: trailing 24h ${c.trailing24h} + est ${est} exceeds target ${c.target.toFixed(1)}`,
        };
      }
      if (c.huntHourSpend + est > c.huntRatePerHour) {
        return {
          ok: false,
          holdReason: `${ix.name}: hunt spend this hour ${c.huntHourSpend} + est ${est} exceeds rate ${c.huntRatePerHour.toFixed(1)}/h`,
        };
      }
    }
    return { ok: true };
  }

  /** Record a dispatched command: pending self-estimates + hunt attribution in the current bucket. */
  recordDispatch(estimates: Map<number, number>, attemptId: number): void {
    const now = this.now();
    const hourUtc = Math.floor(now / HOUR_MS);
    for (const [indexerId, queries] of estimates) {
      if (queries <= 0) continue;
      this.db.insert(pendingSelfEstimates).values({ indexerId, at: now, queries, attemptId }).run();
      this.db
        .insert(budgetBuckets)
        .values({ indexerId, hourUtc, observedQueries: 0, observedGrabs: 0, huntQueries: queries })
        .onConflictDoUpdate({
          target: [budgetBuckets.indexerId, budgetBuckets.hourUtc],
          set: { huntQueries: sql`${budgetBuckets.huntQueries} + ${queries}` },
        })
        .run();
    }
    this.bus.emit("budget.updated", { attemptId });
  }

  getStatus(): IndexerBudgetStatus[] {
    const cfg = this.settings.get();
    const excluded = new Set(cfg.excludeIndexerIds);
    const now = this.now();
    return this.db
      .select()
      .from(indexers)
      .orderBy(indexers.name)
      .all()
      .map((ix) => {
        const c = this.controllerFor(ix, now, cfg);
        let canHuntNow = ix.enabled && !ix.inBackoff;
        if (canHuntNow && c.target !== null && c.huntRatePerHour !== null && !excluded.has(ix.id)) {
          canHuntNow = c.trailing24h < c.target && c.huntHourSpend < c.huntRatePerHour;
        }
        return {
          id: ix.id,
          name: ix.name,
          cap: ix.queryLimit,
          trailing24h: c.trailing24h,
          huntShare: c.huntShare,
          organicShare: c.organicShare,
          forecastNextHorizon: c.forecast,
          target: c.target,
          huntRatePerHour: c.huntRatePerHour,
          canHuntNow,
          inBackoff: ix.inBackoff,
          excluded: excluded.has(ix.id),
        };
      });
  }

  private controllerFor(ix: IndexerRow, now: number, cfg: AppSettings): ControllerState {
    const currentHour = Math.floor(now / HOUR_MS);
    const buckets24 = this.db
      .select()
      .from(budgetBuckets)
      .where(and(eq(budgetBuckets.indexerId, ix.id), gte(budgetBuckets.hourUtc, currentHour - 23)))
      .all();
    let observed24 = 0;
    let hunt24 = 0;
    let huntHourSpend = 0;
    for (const b of buckets24) {
      observed24 += b.observedQueries;
      hunt24 += b.huntQueries;
      if (b.hourUtc === currentHour) huntHourSpend = b.huntQueries;
    }
    const pending = this.db
      .select()
      .from(pendingSelfEstimates)
      .where(eq(pendingSelfEstimates.indexerId, ix.id))
      .all()
      .reduce((sum, p) => sum + p.queries, 0);

    // Bucket huntQueries are written eagerly at dispatch, so hunt24 already
    // contains the pending share; pending only tops up the observed total.
    const trailing24h = observed24 + pending;
    const huntShare = hunt24;
    const organicShare = Math.max(0, observed24 - hunt24);
    const forecast = this.expectedOrganic(ix.id, currentHour, cfg.budgetHorizonHours);

    if (ix.queryLimit === null) {
      return {
        trailing24h,
        huntShare,
        organicShare,
        huntHourSpend,
        forecast,
        target: null,
        huntRatePerHour: null,
      };
    }
    const cap = ix.queryLimit;
    const target = cap * (1 - cfg.budgetSafetyPct) - forecast;
    const surplus = target - trailing24h;
    const burstMax = cap / cfg.budgetBurstMaxDivisor;
    const huntRatePerHour = Math.min(
      Math.max(surplus / cfg.budgetPacingHorizonHours, cfg.budgetTrickleMinPerHour),
      burstMax,
    );
    return {
      trailing24h,
      huntShare,
      organicShare,
      huntHourSpend,
      forecast,
      target,
      huntRatePerHour,
    };
  }

  /**
   * EWMA hourly organic forecast summed over the next `horizonHours`.
   * Hour-of-day weighted once >=7 days of history exist; flat mean before that.
   * Missing buckets count as zero-organic hours; the current partial hour is excluded.
   */
  private expectedOrganic(indexerId: number, currentHour: number, horizonHours: number): number {
    const rows = this.db
      .select()
      .from(budgetBuckets)
      .where(
        and(
          eq(budgetBuckets.indexerId, indexerId),
          gte(budgetBuckets.hourUtc, currentHour - FORECAST_WINDOW_HOURS),
          lt(budgetBuckets.hourUtc, currentHour),
        ),
      )
      .all();
    if (rows.length === 0) return 0;
    const organicByHour = new Map<number, number>();
    let minHour = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      organicByHour.set(r.hourUtc, Math.max(0, r.observedQueries - r.huntQueries));
      if (r.hourUtc < minHour) minHour = r.hourUtc;
    }
    const span = currentHour - minHour;
    if (span < HOURLY_FORECAST_MIN_HOURS) {
      let total = 0;
      for (const v of organicByHour.values()) total += v;
      return (total / span) * horizonHours;
    }
    // Epoch hours are UTC-aligned, so hourUtc % 24 is the UTC hour of day.
    const slotEwma = new Array<number | null>(24).fill(null);
    for (let h = minHour; h < currentHour; h++) {
      const value = organicByHour.get(h) ?? 0;
      const slot = h % 24;
      const prev = slotEwma[slot];
      slotEwma[slot] = prev === null ? value : EWMA_ALPHA * value + (1 - EWMA_ALPHA) * prev;
    }
    let sum = 0;
    for (let i = 1; i <= horizonHours; i++) {
      sum += slotEwma[(currentHour + i) % 24] ?? 0;
    }
    return sum;
  }
}
