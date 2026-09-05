import { and, desc, eq, gte, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AppSettings, SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import {
  budgetBuckets,
  indexerSnapshots,
  indexers,
  pendingSelfEstimates,
  searchAttempts,
} from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import type { ProwlarrClient, ProwlarrHistoryRecord } from "../prowlarr/client.js";

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
> &
  Partial<Pick<ProwlarrClient, "getHistorySince">>;

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
  trailing24hGrabs: number;
  attribution: {
    observedSonarr: number;
    observedRadarr: number;
    observedOther: number;
    observedOtherSources: Record<string, number>;
    huntSonarr: number;
    huntRadarr: number;
  };
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
  trailing24hGrabs: number;
  attribution: IndexerBudgetStatus["attribution"];
};

/**
 * Demand-adaptive budget controller. Prowlarr exposes no remaining-quota API,
 * so we self-account: snapshot cumulative indexer stats, diff into hourly
 * buckets, attribute our own dispatches, forecast organic demand, and pace
 * hunting to keep trailing-24h usage hugging `cap*(1-safety) - expectedOrganic`.
 */
export class BudgetManager {
  private readonly now: () => number;
  private observationAt: number | null = null;
  private readonly history = new Map<number, ProwlarrHistoryRecord>();
  private historyAt: number | null = null;
  private fullHistoryAt: number | null = null;

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
    this.observationAt = null;
    const cutoff = this.now();
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
        priority: ix.priority,
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

    this.db
      .delete(indexerSnapshots)
      .where(lt(indexerSnapshots.takenAt, now - RETENTION_MS))
      .run();
    this.db
      .delete(budgetBuckets)
      .where(lt(budgetBuckets.hourUtc, hourUtc - FORECAST_WINDOW_HOURS - 24))
      .run();

    if (this.prowlarr.getHistorySince) {
      try {
        await this.refreshSourceAttribution(cutoff);
        this.reconcileReservations(cutoff);
      } catch (err) {
        this.log.warn({ err }, "prowlarr history attribution refresh failed; keeping prior data");
        throw err;
      }
    }

    const observed = new Set(stats.map((stat) => stat.indexerId));
    if (remote.length > 0 && remote.every((ix) => !ix.enable || observed.has(ix.id))) {
      this.observationAt = cutoff;
    }

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
    if (this.observationAt === null || now - this.observationAt > 5 * 60_000) {
      return { ok: false, holdReason: "budget observation unavailable or older than five minutes" };
    }
    if (estimates.size === 0) {
      return { ok: false, holdReason: "no eligible observed indexers for this search" };
    }
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
  recordDispatch(
    estimates: Map<number, number>,
    attemptId: number,
    source: "sonarr" | "radarr",
  ): void {
    const now = this.now();
    const hourUtc = Math.floor(now / HOUR_MS);
    for (const [indexerId, queries] of estimates) {
      if (queries <= 0) continue;
      this.db.insert(pendingSelfEstimates).values({ indexerId, at: now, queries, attemptId }).run();
      this.db
        .insert(budgetBuckets)
        .values({
          indexerId,
          hourUtc,
          observedQueries: 0,
          observedGrabs: 0,
          huntQueries: queries,
          huntSonarrQueries: source === "sonarr" ? queries : 0,
          huntRadarrQueries: source === "radarr" ? queries : 0,
        })
        .onConflictDoUpdate({
          target: [budgetBuckets.indexerId, budgetBuckets.hourUtc],
          set: {
            huntQueries: sql`${budgetBuckets.huntQueries} + ${queries}`,
            ...(source === "sonarr"
              ? {
                  huntSonarrQueries: sql`${budgetBuckets.huntSonarrQueries} + ${queries}`,
                }
              : {
                  huntRadarrQueries: sql`${budgetBuckets.huntRadarrQueries} + ${queries}`,
                }),
          },
        })
        .run();
    }
    this.bus.emit("budget.updated", { attemptId });
  }

  /** A definite HTTP rejection performed no search; undo its dispatch estimate once. */
  releaseRejectedDispatch(attemptId: number, source: "sonarr" | "radarr"): void {
    this.db.transaction((tx) => {
      const reservations = tx
        .select()
        .from(pendingSelfEstimates)
        .where(
          and(
            eq(pendingSelfEstimates.attemptId, attemptId),
            isNull(pendingSelfEstimates.reconciledAt),
          ),
        )
        .all();
      for (const row of reservations) {
        tx.update(budgetBuckets)
          .set({
            huntQueries: sql`max(0, ${budgetBuckets.huntQueries} - ${row.queries})`,
            ...(source === "sonarr"
              ? {
                  huntSonarrQueries: sql`max(0, ${budgetBuckets.huntSonarrQueries} - ${row.queries})`,
                }
              : {
                  huntRadarrQueries: sql`max(0, ${budgetBuckets.huntRadarrQueries} - ${row.queries})`,
                }),
          })
          .where(
            and(
              eq(budgetBuckets.indexerId, row.indexerId),
              eq(budgetBuckets.hourUtc, Math.floor(row.at / HOUR_MS)),
            ),
          )
          .run();
        tx.delete(pendingSelfEstimates).where(eq(pendingSelfEstimates.id, row.id)).run();
      }
    });
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
        let canHuntNow =
          ix.enabled &&
          !ix.inBackoff &&
          this.observationAt !== null &&
          now - this.observationAt <= 5 * 60_000;
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
          trailing24hGrabs: c.trailing24hGrabs,
          attribution: c.attribution,
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
    let trailing24hGrabs = 0;
    const attribution: IndexerBudgetStatus["attribution"] = {
      observedSonarr: 0,
      observedRadarr: 0,
      observedOther: 0,
      observedOtherSources: {},
      huntSonarr: 0,
      huntRadarr: 0,
    };
    for (const b of buckets24) {
      observed24 += b.observedQueries;
      trailing24hGrabs += b.observedGrabs;
      hunt24 += b.huntQueries;
      attribution.observedSonarr += b.sonarrQueries;
      attribution.observedRadarr += b.radarrQueries;
      attribution.observedOther += b.otherQueries;
      for (const [source, queries] of Object.entries(b.sourceQueries ?? {})) {
        const normalized = source.toLowerCase();
        if (normalized === "sonarr" || normalized === "radarr") continue;
        attribution.observedOtherSources[source] =
          (attribution.observedOtherSources[source] ?? 0) + queries;
      }
      attribution.huntSonarr += b.huntSonarrQueries;
      attribution.huntRadarr += b.huntRadarrQueries;
      if (b.hourUtc === currentHour) huntHourSpend = b.huntQueries;
    }
    const pending = this.db
      .select()
      .from(pendingSelfEstimates)
      .where(
        and(eq(pendingSelfEstimates.indexerId, ix.id), isNull(pendingSelfEstimates.reconciledAt)),
      )
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
        trailing24hGrabs,
        attribution,
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
      trailing24hGrabs,
      attribution,
    };
  }

  private async refreshSourceAttribution(now: number): Promise<void> {
    if (!this.prowlarr.getHistorySince) return;
    // Re-fetch complete hours with overlap for late events; rebuild the trailing
    // day hourly to catch older arrivals and upstream resets.
    const full = this.fullHistoryAt === null || now - this.fullHistoryAt >= HOUR_MS;
    const since = full
      ? now - 24 * HOUR_MS
      : Math.max(now - 24 * HOUR_MS, (this.historyAt ?? now) - 2 * HOUR_MS);
    const startHour = Math.floor(since / HOUR_MS);
    const fetched = await this.prowlarr.getHistorySince(startHour * HOUR_MS);
    if (full) this.history.clear();
    for (const [id, record] of this.history) {
      if (
        record.at < (Math.floor(now / HOUR_MS) - 24) * HOUR_MS ||
        record.at >= startHour * HOUR_MS
      )
        this.history.delete(id);
    }
    for (const record of fetched) this.history.set(record.id, record);
    this.historyAt = now;
    if (full) this.fullHistoryAt = now;
    const records = [...this.history.values()].filter((record) => record.at >= startHour * HOUR_MS);
    const grouped = new Map<
      string,
      {
        indexerId: number;
        hourUtc: number;
        sonarr: number;
        radarr: number;
        other: number;
        grabs: number;
        sources: Record<string, number>;
      }
    >();
    for (const record of records) {
      const hourUtc = Math.floor(record.at / HOUR_MS);
      const key = `${record.indexerId}:${hourUtc}`;
      const bucket = grouped.get(key) ?? {
        indexerId: record.indexerId,
        hourUtc,
        sonarr: 0,
        radarr: 0,
        other: 0,
        grabs: 0,
        sources: {},
      };
      if (record.eventType === "releaseGrabbed") {
        bucket.grabs += 1;
        grouped.set(key, bucket);
        continue;
      }
      const source = record.source.toLowerCase();
      if (source === "sonarr") bucket.sonarr += 1;
      else if (source === "radarr") bucket.radarr += 1;
      else bucket.other += 1;
      const sourceLabel = record.source.trim() || "Unknown";
      bucket.sources[sourceLabel] = (bucket.sources[sourceLabel] ?? 0) + 1;
      grouped.set(key, bucket);
    }

    this.db
      .update(budgetBuckets)
      .set({
        observedQueries: 0,
        observedGrabs: 0,
        sonarrQueries: 0,
        radarrQueries: 0,
        otherQueries: 0,
        sourceQueries: {},
      })
      .where(gte(budgetBuckets.hourUtc, startHour))
      .run();
    for (const bucket of grouped.values()) {
      this.db
        .insert(budgetBuckets)
        .values({
          indexerId: bucket.indexerId,
          hourUtc: bucket.hourUtc,
          observedQueries: bucket.sonarr + bucket.radarr + bucket.other,
          observedGrabs: bucket.grabs,
          sonarrQueries: bucket.sonarr,
          radarrQueries: bucket.radarr,
          otherQueries: bucket.other,
          sourceQueries: bucket.sources,
        })
        .onConflictDoUpdate({
          target: [budgetBuckets.indexerId, budgetBuckets.hourUtc],
          set: {
            observedQueries: bucket.sonarr + bucket.radarr + bucket.other,
            observedGrabs: bucket.grabs,
            sonarrQueries: bucket.sonarr,
            radarrQueries: bucket.radarr,
            otherQueries: bucket.other,
            sourceQueries: bucket.sources,
          },
        })
        .run();
    }
  }

  private reconcileReservations(cutoff: number): void {
    const reservations = this.db
      .select()
      .from(pendingSelfEstimates)
      .orderBy(pendingSelfEstimates.at)
      .all();
    const used = new Set(reservations.flatMap((row) => row.observedIds));
    const records = [...this.history.values()].sort((a, b) => a.at - b.at);
    this.db.transaction((tx) => {
      for (const reservation of reservations) {
        if (reservation.reconciledAt !== null || reservation.attemptId === null) continue;
        const attempt = tx
          .select()
          .from(searchAttempts)
          .where(eq(searchAttempts.id, reservation.attemptId))
          .get();
        if (
          !attempt ||
          attempt.completedAt === null ||
          attempt.completedAt >= cutoff ||
          !["completed", "failed"].includes(attempt.status)
        )
          continue;
        const evidence = records
          .filter(
            (record) =>
              record.indexerId === reservation.indexerId &&
              record.eventType === "indexerQuery" &&
              record.source.toLowerCase() === attempt.source &&
              record.at >= reservation.at &&
              record.at < cutoff &&
              !used.has(record.id),
          )
          .slice(0, reservation.queries);
        // No time-only expiry: incomplete observations keep the reservation.
        if (evidence.length < reservation.queries) continue;
        for (const record of evidence) used.add(record.id);
        tx.update(pendingSelfEstimates)
          .set({ reconciledAt: cutoff, observedIds: evidence.map((record) => record.id) })
          .where(eq(pendingSelfEstimates.id, reservation.id))
          .run();
      }
      tx.delete(pendingSelfEstimates)
        .where(lt(pendingSelfEstimates.reconciledAt, cutoff - RETENTION_MS))
        .run();
    });
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
