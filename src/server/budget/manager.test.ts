import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsService } from "../config/settings.js";
import { createDb, type Db, type SqliteHandle } from "../db/index.js";
import { budgetBuckets, indexerSnapshots, indexers, pendingSelfEstimates } from "../db/schema.js";
import { EventBus } from "../events/bus.js";
import type {
  ProwlarrIndexer,
  ProwlarrIndexerStats,
  ProwlarrIndexerStatus,
} from "../prowlarr/client.js";
import { BudgetManager, type ProwlarrBudgetApi } from "./manager.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 5, 15, 12, 30, 0);
const H0 = Math.floor(T0 / HOUR_MS);

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child() {
    return this;
  },
  level: "silent",
} as unknown as FastifyBaseLogger;

class FakeProwlarr implements ProwlarrBudgetApi {
  indexers: ProwlarrIndexer[] = [];
  stats: ProwlarrIndexerStats[] = [];
  statuses: ProwlarrIndexerStatus[] = [];
  async getIndexers() {
    return this.indexers;
  }
  async getIndexerStats() {
    return this.stats;
  }
  async getIndexerStatus() {
    return this.statuses;
  }
}

function ix(id: number, name: string, over: Partial<ProwlarrIndexer> = {}): ProwlarrIndexer {
  return {
    id,
    name,
    enable: true,
    protocol: "usenet",
    queryLimit: 240,
    grabLimit: null,
    supportsTv: true,
    supportsMovies: true,
    ...over,
  };
}

function stat(
  indexerId: number,
  queries: number,
  rss = 0,
  auth = 0,
  grabs = 0,
): ProwlarrIndexerStats {
  return {
    indexerId,
    indexerName: `ix${indexerId}`,
    numberOfQueries: queries,
    numberOfRssQueries: rss,
    numberOfAuthQueries: auth,
    numberOfGrabs: grabs,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-budget-test-"));
  const { db, sqlite } = createDb(dir, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = new SettingsService(db);
  // Keep controller-math tests independent from the application-level
  // recommended defaults, which are covered in app.test.ts.
  settings.update({
    budgetSafetyPct: 0.1,
    budgetHorizonHours: 6,
    budgetTrickleMinPerHour: 2,
    budgetPacingHorizonHours: 6,
    budgetBurstMaxDivisor: 12,
  });
  const bus = new EventBus();
  const prowlarr = new FakeProwlarr();
  const clock = { ms: T0 };
  const mgr = new BudgetManager(db, settings, prowlarr, bus, noopLog, { now: () => clock.ms });
  return { db, sqlite: sqlite as SqliteHandle, settings, bus, prowlarr, clock, mgr };
}

function seedIndexerRow(db: Db, over: Partial<typeof indexers.$inferInsert> & { id: number }) {
  db.insert(indexers)
    .values({
      name: `ix${over.id}`,
      enabled: true,
      queryLimit: 240,
      grabLimit: null,
      supportsTv: true,
      supportsMovies: true,
      inBackoff: false,
      lastSyncedAt: 0,
      ...over,
    })
    .run();
}

function seedBucket(db: Db, indexerId: number, hourUtc: number, observed: number, hunt = 0) {
  db.insert(budgetBuckets)
    .values({ indexerId, hourUtc, observedQueries: observed, observedGrabs: 0, huntQueries: hunt })
    .run();
}

function statusOf(mgr: BudgetManager, id: number) {
  const status = mgr.getStatus().find((s) => s.id === id);
  expect(status).toBeDefined();
  return status as NonNullable<typeof status>;
}

describe("BudgetManager.refresh — indexer sync", () => {
  it("mirrors indexers, flags backoff from indexerstatus, prunes removed ones", async () => {
    const { db, prowlarr, clock, mgr, bus } = makeHarness();
    prowlarr.indexers = [ix(1, "Alpha"), ix(2, "Beta", { queryLimit: null, enable: false })];
    prowlarr.statuses = [
      { indexerId: 2, disabledTill: clock.ms + HOUR_MS },
      { indexerId: 1, disabledTill: clock.ms - HOUR_MS }, // expired -> not in backoff
    ];
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));

    await mgr.refresh();
    const rows = db.select().from(indexers).all();
    expect(rows).toHaveLength(2);
    const alpha = rows.find((r) => r.id === 1);
    const beta = rows.find((r) => r.id === 2);
    expect(alpha).toMatchObject({
      name: "Alpha",
      enabled: true,
      queryLimit: 240,
      inBackoff: false,
    });
    expect(beta).toMatchObject({ name: "Beta", enabled: false, queryLimit: null, inBackoff: true });
    expect(events).toContain("budget.updated");

    prowlarr.indexers = [ix(1, "Alpha")];
    prowlarr.statuses = [];
    await mgr.refresh();
    const after = db.select().from(indexers).all();
    expect(after.map((r) => r.id)).toEqual([1]);
    expect(after[0].inBackoff).toBe(false);
  });
});

describe("BudgetManager.refresh — snapshot diffing", () => {
  it("baselines on first snapshot and writes the delta into the current hourly bucket", async () => {
    const { db, prowlarr, clock, mgr } = makeHarness();
    prowlarr.indexers = [ix(1, "Alpha")];
    prowlarr.stats = [stat(1, 100, 20, 5, 3)]; // total 125
    await mgr.refresh();
    expect(db.select().from(budgetBuckets).all()).toHaveLength(0); // baseline only

    clock.ms = T0 + HOUR_MS;
    prowlarr.stats = [stat(1, 130, 25, 5, 4)]; // total 160 -> delta 35, grabs +1
    await mgr.refresh();
    const buckets = db.select().from(budgetBuckets).all();
    expect(buckets).toEqual([
      { indexerId: 1, hourUtc: H0 + 1, observedQueries: 35, observedGrabs: 1, huntQueries: 0 },
    ]);
  });

  it("re-baselines with a 0 delta when totals go backwards (Prowlarr reset)", async () => {
    const { db, prowlarr, clock, mgr } = makeHarness();
    prowlarr.indexers = [ix(1, "Alpha")];
    prowlarr.stats = [stat(1, 125, 0, 0, 3)];
    await mgr.refresh();

    clock.ms = T0 + HOUR_MS;
    prowlarr.stats = [stat(1, 10, 0, 0, 0)]; // reset: totals dropped
    await mgr.refresh();
    expect(db.select().from(budgetBuckets).all()).toHaveLength(0);

    clock.ms = T0 + 2 * HOUR_MS;
    prowlarr.stats = [stat(1, 30, 0, 0, 2)]; // diffed from the new baseline
    await mgr.refresh();
    expect(db.select().from(budgetBuckets).all()).toEqual([
      { indexerId: 1, hourUtc: H0 + 2, observedQueries: 20, observedGrabs: 2, huntQueries: 0 },
    ]);
  });

  it("ignores stats for indexers Prowlarr no longer lists", async () => {
    const { db, prowlarr, mgr, clock } = makeHarness();
    prowlarr.indexers = [ix(1, "Alpha")];
    prowlarr.stats = [stat(1, 10), stat(99, 500)];
    await mgr.refresh();
    clock.ms = T0 + HOUR_MS;
    prowlarr.stats = [stat(1, 20), stat(99, 900)];
    await mgr.refresh();
    const snapshotIds = db
      .select()
      .from(indexerSnapshots)
      .all()
      .map((s) => s.indexerId);
    expect(new Set(snapshotIds)).toEqual(new Set([1]));
  });
});

describe("BudgetManager attribution and pending estimates", () => {
  it("splits observed spend into hunt vs organic and clears covered pendings", async () => {
    const { db, prowlarr, clock, mgr } = makeHarness();
    prowlarr.indexers = [ix(1, "Alpha")];
    prowlarr.stats = [stat(1, 100, 20, 5, 3)]; // total 125 baseline
    await mgr.refresh();

    clock.ms = T0 + 60_000;
    mgr.recordDispatch(new Map([[1, 6]]), 42);
    const pendings = db.select().from(pendingSelfEstimates).all();
    expect(pendings).toHaveLength(1);
    expect(pendings[0]).toMatchObject({ indexerId: 1, queries: 6, attemptId: 42 });
    // pending covers the dispatch-to-snapshot gap
    expect(statusOf(mgr, 1)).toMatchObject({ trailing24h: 6, huntShare: 6, organicShare: 0 });

    clock.ms = T0 + 600_000;
    prowlarr.stats = [stat(1, 110, 20, 5, 3)]; // total 135 -> observed delta 10
    await mgr.refresh();
    expect(db.select().from(pendingSelfEstimates).all()).toHaveLength(0);
    const status = statusOf(mgr, 1);
    expect(status.trailing24h).toBe(10); // observed only, pending cleared
    expect(status.huntShare).toBe(6); // bucket attribution survives
    expect(status.organicShare).toBe(4); // 10 observed - 6 hunt
  });
});

describe("BudgetManager forecast and controller math", () => {
  it("uses a flat hourly mean below 7 days of history and derives target/rate from it", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1, queryLimit: 240 });
    // 48h of history: observed 4/h of which 1/h was ours -> organic 3/h
    for (let h = H0 - 48; h < H0; h++) seedBucket(db, 1, h, 4, 1);

    const status = statusOf(mgr, 1);
    expect(status.forecastNextHorizon).toBeCloseTo(3 * 6, 6); // flat 3/h * 6h horizon
    expect(status.target).toBeCloseTo(240 * 0.9 - 18, 6); // 198
    // trailing24h = 23 in-window buckets * 4 observed
    expect(status.trailing24h).toBe(92);
    expect(status.huntShare).toBe(23);
    expect(status.organicShare).toBe(69);
    // rate = clamp(2, (198-92)/6, 240/12) = 17.67
    expect(status.huntRatePerHour).toBeCloseTo(106 / 6, 6);
    expect(status.canHuntNow).toBe(true);
  });

  it("weights by hour-of-day once >=7 days of buckets exist", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1, queryLimit: 240 });
    // 8 days where only one specific hour-of-day sees organic traffic (12 queries),
    // and that hour falls inside the next 6h horizon.
    const spikeSlot = (H0 + 3) % 24;
    for (let h = H0 - 8 * 24; h < H0; h++) {
      if (h % 24 === spikeSlot) seedBucket(db, 1, h, 12, 0);
    }
    const status = statusOf(mgr, 1);
    // Hour-of-day EWMA forecasts the full spike (12); a flat mean would say 12/24*6 = 3.
    expect(status.forecastNextHorizon).toBeCloseTo(12, 6);
  });

  it("forecasts 0 with no history and clamps the rate to burstMax", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1, queryLimit: 240 });
    const status = statusOf(mgr, 1);
    expect(status.forecastNextHorizon).toBe(0);
    expect(status.target).toBeCloseTo(216, 6);
    // surplus/pacing = 216/6 = 36 -> clamped to burstMax = 240/12 = 20
    expect(status.huntRatePerHour).toBeCloseTo(20, 6);
  });

  it("drops to the trickle rate and stops hunting when trailing usage exceeds target", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1, queryLimit: 240 });
    seedBucket(db, 1, H0, 230, 0); // organic burst ate the budget
    const status = statusOf(mgr, 1);
    expect(status.trailing24h).toBe(230);
    expect(status.huntRatePerHour).toBeCloseTo(2, 6); // trickleMin floor
    expect(status.canHuntNow).toBe(false);
    const decision = mgr.mayDispatch(new Map([[1, 1]]));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.holdReason).toContain("target");
  });
});

describe("BudgetManager.mayDispatch — ALL-rule gating", () => {
  it("holds when any limited indexer would exceed its target", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1, name: "Alpha", queryLimit: 240 });
    seedIndexerRow(db, { id: 2, name: "Beta", queryLimit: 240 });
    seedBucket(db, 2, H0, 230, 0); // Beta over target
    const estimates = new Map([
      [1, 3],
      [2, 3],
    ]);
    const decision = mgr.mayDispatch(estimates);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.holdReason).toContain("Beta");
  });

  it("never gates on unlimited indexers", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 3, name: "Free", queryLimit: null });
    seedBucket(db, 3, H0, 10_000, 0);
    expect(mgr.mayDispatch(new Map([[3, 100]]))).toEqual({ ok: true });
    expect(statusOf(mgr, 3)).toMatchObject({ cap: null, target: null, canHuntNow: true });
  });

  it("skips excluded indexers so a tiny cap cannot throttle everything", () => {
    const { db, mgr, settings } = makeHarness();
    seedIndexerRow(db, { id: 1, name: "Alpha", queryLimit: 240 });
    seedIndexerRow(db, { id: 2, name: "Tiny", queryLimit: 10 });
    seedBucket(db, 2, H0, 9, 0);
    const estimates = new Map([
      [1, 3],
      [2, 3],
    ]);
    expect(mgr.mayDispatch(estimates).ok).toBe(false);
    settings.update({ excludeIndexerIds: [2] });
    expect(mgr.mayDispatch(estimates)).toEqual({ ok: true });
    expect(statusOf(mgr, 2).excluded).toBe(true);
  });

  it("enforces the hourly pacing gate on hunt spend", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1, name: "Alpha", queryLimit: 240 });
    // rate = clamp(2, (216-18)/6, 20) = 20; hunt spend this hour 18 + est 6 > 20
    mgr.recordDispatch(new Map([[1, 18]]), 7);
    const decision = mgr.mayDispatch(new Map([[1, 6]]));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.holdReason).toContain("hunt spend this hour");
    // a smaller estimate still fits under the rate
    expect(mgr.mayDispatch(new Map([[1, 2]]))).toEqual({ ok: true });
  });
});

describe("BudgetManager.estimateCommand", () => {
  it("estimates per eligible indexer, filtered by kind, backoff and enabled", () => {
    const { db, mgr } = makeHarness();
    seedIndexerRow(db, { id: 1 }); // tv + movies
    seedIndexerRow(db, { id: 2, supportsTv: false }); // movies only
    seedIndexerRow(db, { id: 3, enabled: false });
    seedIndexerRow(db, { id: 4, inBackoff: true });
    seedIndexerRow(db, { id: 5, supportsMovies: false }); // tv only

    expect(mgr.estimateCommand({ kind: "tv", searchOps: 3 })).toEqual(
      new Map([
        [1, 3],
        [5, 3],
      ]),
    );
    expect(mgr.estimateCommand({ kind: "movie", searchOps: 3 })).toEqual(
      new Map([
        [1, 3],
        [2, 3],
      ]),
    );
    expect(mgr.estimateCommand({ kind: "tv", searchOps: 3, anime: true })).toEqual(
      new Map([
        [1, 6],
        [5, 6],
      ]),
    );
  });

  it("keeps unlimited and excluded indexers in the estimate for attribution", () => {
    const { db, mgr, settings } = makeHarness();
    seedIndexerRow(db, { id: 1, queryLimit: null });
    seedIndexerRow(db, { id: 2, queryLimit: 10 });
    settings.update({ excludeIndexerIds: [2] });
    expect(mgr.estimateCommand({ kind: "tv", searchOps: 2 })).toEqual(
      new Map([
        [1, 2],
        [2, 2],
      ]),
    );
  });
});
