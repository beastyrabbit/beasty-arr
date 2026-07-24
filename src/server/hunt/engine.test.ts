import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { backoffForTier } from "../../shared/domain.js";
import { SettingsService } from "../config/settings.js";
import { createDb, type Db } from "../db/index.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  itemOverrides,
  manualRequests,
  movies,
  searchAttempts,
  series,
} from "../db/schema.js";
import { EventBus } from "../events/bus.js";
import {
  type BudgetManagerPort,
  type HuntArrClientPort,
  HuntEngine,
  type SyncRefreshPort,
} from "./engine.js";
import { aiPausedUntilFor } from "./state.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);

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

class FakeArr implements HuntArrClientPort {
  systemStatusError: Error | null = null;
  queueTotal = 0;
  sent: Record<string, unknown>[] = [];
  defaultCommandStatus = "completed";
  commandStatuses: string[] = [];
  getCommandCalls = 0;
  private nextCommandId = 100;

  async getSystemStatus(): Promise<unknown> {
    if (this.systemStatusError) throw this.systemStatusError;
    return {};
  }
  async getQueueStats(): Promise<{ totalRecords: number }> {
    return { totalRecords: this.queueTotal };
  }
  async sendCommand(body: { name: string } & Record<string, unknown>) {
    this.sent.push(body);
    return { id: this.nextCommandId++, status: "queued" };
  }
  async getCommand(_id: number): Promise<{ status?: string }> {
    this.getCommandCalls++;
    return { status: this.commandStatuses.shift() ?? this.defaultCommandStatus };
  }
}

class FakeBudget implements BudgetManagerPort {
  refreshCalls = 0;
  estimateCalls: { kind: "tv" | "movie"; searchOps: number; anime?: boolean }[] = [];
  recorded: { estimates: Map<number, number>; attemptId: number }[] = [];
  /** Number of mayDispatch calls allowed before holding. */
  holdAfter = Number.POSITIVE_INFINITY;
  private decisions = 0;

  async refresh(): Promise<void> {
    this.refreshCalls++;
  }
  estimateCommand(input: { kind: "tv" | "movie"; searchOps: number; anime?: boolean }) {
    this.estimateCalls.push(input);
    return new Map([[1, input.searchOps * (input.anime ? 2 : 1)]]);
  }
  mayDispatch(_estimates: Map<number, number>) {
    this.decisions++;
    if (this.decisions > this.holdAfter) {
      return { ok: false as const, holdReason: "ix1: budget hold (test)" };
    }
    return { ok: true as const };
  }
  recordDispatch(estimates: Map<number, number>, attemptId: number): void {
    this.recorded.push({ estimates, attemptId });
  }
}

class FakeSync implements SyncRefreshPort {
  seriesRefreshes: number[] = [];
  movieRefreshes: number[] = [];
  onSeriesRefresh: ((seriesId: number) => void) | null = null;

  async targetedRefreshSeries(seriesId: number): Promise<void> {
    this.seriesRefreshes.push(seriesId);
    this.onSeriesRefresh?.(seriesId);
  }
  async targetedRefreshMovie(movieId: number): Promise<void> {
    this.movieRefreshes.push(movieId);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeHarness(opts: { random?: () => number; noClients?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-hunt-test-"));
  const { db, sqlite } = createDb(dir, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = new SettingsService(db);
  const bus = new EventBus();
  const sonarr = new FakeArr();
  const radarr = new FakeArr();
  const budget = new FakeBudget();
  const sync = new FakeSync();
  const clock = { ms: T0 };
  const engine = new HuntEngine(
    db,
    settings,
    opts.noClients ? { sonarr: null, radarr: null } : { sonarr, radarr },
    budget,
    sync,
    bus,
    noopLog,
    {
      now: () => clock.ms,
      sleep: async (ms) => {
        clock.ms += ms;
      },
      random: opts.random ?? (() => 0.5), // jitter factor 1.0
    },
  );
  return { db, settings, bus, sonarr, radarr, budget, sync, clock, engine };
}

function seedSeries(db: Db, over: Partial<typeof series.$inferInsert> & { id: number }): void {
  db.insert(series)
    .values({ title: `Series ${over.id}`, monitored: true, lastSyncedAt: 0, ...over })
    .run();
}

function seedEpisode(
  db: Db,
  ep: Partial<typeof episodes.$inferInsert> & { id: number; seriesId: number },
  hunt: Partial<typeof huntState.$inferInsert> = {},
): number {
  db.insert(episodes)
    .values({
      seasonNumber: 1,
      episodeNumber: 1,
      monitored: true,
      hasFile: false,
      hasGerman: false,
      airDateUtc: T0 - 30 * DAY_MS,
      lastSyncedAt: 0,
      ...ep,
    })
    .run();
  const row = db
    .insert(huntState)
    .values({
      source: "sonarr",
      targetKind: "episode",
      targetId: ep.id,
      seriesId: ep.seriesId,
      seasonNumber: ep.seasonNumber ?? 1,
      state: "missing",
      stateChangedAt: 0,
      ...hunt,
    })
    .returning({ id: huntState.id })
    .get();
  return row.id;
}

function seedMovie(
  db: Db,
  m: Partial<typeof movies.$inferInsert> & { id: number },
  hunt: Partial<typeof huntState.$inferInsert> = {},
): number {
  db.insert(movies)
    .values({
      title: `Movie ${m.id}`,
      year: 2020,
      monitored: true,
      hasFile: false,
      hasGerman: false,
      digitalRelease: T0 - 60 * DAY_MS,
      lastSyncedAt: 0,
      ...m,
    })
    .run();
  const row = db
    .insert(huntState)
    .values({
      source: "radarr",
      targetKind: "movie",
      targetId: m.id,
      state: "missing",
      stateChangedAt: 0,
      ...hunt,
    })
    .returning({ id: huntState.id })
    .get();
  return row.id;
}

function huntRow(db: Db, id: number) {
  const row = db.select().from(huntState).where(eq(huntState.id, id)).get();
  expect(row).toBeDefined();
  return row as NonNullable<typeof row>;
}

function seedVerdict(db: Db, over: Partial<typeof aiVerdicts.$inferInsert> = {}) {
  return db
    .insert(aiVerdicts)
    .values({
      subjectKind: "series",
      subjectKey: "sonarr:1",
      title: "Series 1",
      verdict: "unlikely",
      confidence: 0.9,
      evidence: [],
      provider: "codex",
      model: "gpt-5.5",
      promptVersion: "v1",
      checkedAt: T0,
      recheckAfter: T0 + 90 * DAY_MS,
      ...over,
    })
    .returning()
    .get();
}

describe("selection ordering and interleave", () => {
  it("interleaves missing:upgrade 1:2 by priority score, manual first", () => {
    const { db, engine } = makeHarness();
    for (const id of [1, 2, 3, 4, 5, 6]) seedSeries(db, { id });
    // missing: A (score 710), B (score 530)
    const a = seedEpisode(db, { id: 11, seriesId: 1, airDateUtc: T0 - 10 * DAY_MS });
    const b = seedEpisode(db, { id: 21, seriesId: 2, airDateUtc: T0 - 100 * DAY_MS });
    // upgrades: C 670, D 630, E 570
    const c = seedEpisode(
      db,
      { id: 31, seriesId: 3, hasFile: true, airDateUtc: T0 - 30 * DAY_MS },
      { state: "non_german" },
    );
    const d = seedEpisode(
      db,
      { id: 41, seriesId: 4, hasFile: true, airDateUtc: T0 - 50 * DAY_MS },
      { state: "non_german" },
    );
    const e = seedEpisode(
      db,
      { id: 51, seriesId: 5, hasFile: true, airDateUtc: T0 - 80 * DAY_MS },
      { state: "non_german" },
    );
    const forced = seedEpisode(
      db,
      { id: 61, seriesId: 6, airDateUtc: T0 - 300 * DAY_MS },
      { manualPriority: 3 },
    );

    const view = engine.queueView();
    expect(view.map((v) => v.huntStateId)).toEqual([forced, a, c, d, b, e]);
    expect(view[0].reason).toBe("FORCED");
    expect(view[1].reason).toBe("SCHEDULED");
    expect(view[1].score).toBe(710);
  });

  it("marks previously-searched candidates as RETRY", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    seedEpisode(db, { id: 11, seriesId: 1 }, { searchCount: 2, lastSearchAt: T0 - DAY_MS });
    expect(engine.queueView()[0].reason).toBe("RETRY");
  });

  it("respects nextEligibleAt for scheduled and requires a passed one for exhausted", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    seedEpisode(db, { id: 11, seriesId: 1 }, { nextEligibleAt: T0 + HOUR_MS });
    seedEpisode(db, { id: 12, seriesId: 1, episodeNumber: 2 }, { state: "exhausted", tier: 6 });
    const ok = seedEpisode(
      db,
      { id: 13, seriesId: 1, episodeNumber: 3 },
      { state: "exhausted", tier: 6, nextEligibleAt: T0 - HOUR_MS },
    );
    expect(engine.queueView().map((v) => v.huntStateId)).toEqual([ok]);
  });
});

describe("dub-lag and specials gating", () => {
  it("waits dubLagDays after a non-German import before the first upgrade search", () => {
    const { db, engine, clock } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1, hasFile: true, fileImportedAt: T0 - 3 * DAY_MS },
      { state: "non_german" },
    );
    expect(engine.queueView()).toHaveLength(0); // default lag 7d
    clock.ms = T0 + 5 * DAY_MS; // 8d after import
    expect(engine.queueView().map((v) => v.huntStateId)).toEqual([hs]);
  });

  it("honors the season > series > default dub-lag override chain", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1, hasFile: true, fileImportedAt: T0 - 3 * DAY_MS },
      { state: "non_german" },
    );
    db.insert(itemOverrides)
      .values({ source: "sonarr", subjectKind: "series", subjectId: 1, dubLagDays: 30 })
      .run();
    expect(engine.queueView()).toHaveLength(0);
    db.insert(itemOverrides)
      .values({
        source: "sonarr",
        subjectKind: "season",
        subjectId: 1,
        seasonNumber: 1,
        dubLagDays: 1,
      })
      .run();
    expect(engine.queueView().map((v) => v.huntStateId)).toEqual([hs]);
  });

  it("skips specials unless huntSpecials is enabled", () => {
    const { db, engine, settings } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1, seasonNumber: 0 });
    expect(engine.queueView()).toHaveLength(0);
    settings.update({ huntSpecials: true });
    expect(engine.queueView().map((v) => v.huntStateId)).toEqual([hs]);
  });
});

describe("runCycle — dry-run", () => {
  it("records attempts without sending commands or recording budget spend", async () => {
    const { db, engine, sonarr, budget, bus } = makeHarness();
    seedSeries(db, { id: 1 });
    seedEpisode(db, { id: 11, seriesId: 1 });

    await engine.runCycle();
    expect(budget.refreshCalls).toBe(1);
    expect(sonarr.sent).toHaveLength(0);
    expect(budget.recorded).toHaveLength(0);
    const attempts = db.select().from(searchAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      commandName: "EpisodeSearch",
      status: "completed",
      result: null,
      dryRun: true,
      trigger: "scheduled",
      estimatedQueries: 1,
    });
    // dry-run must not touch hunt state
    const rows = db.select().from(huntState).all();
    expect(rows[0]).toMatchObject({ tier: 0, searchCount: 0, lastSearchAt: null });
    expect(
      bus.since(0).find((event) => event.type === "hunt.search.started")?.payload,
    ).toMatchObject({
      commandName: "EpisodeSearch",
    });
  });

  it("clears manual priorities in dry-run so the queue keeps moving", async () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 });
    engine.forceSubject({ source: "sonarr", kind: "episode", id: 11 });
    await engine.runCycle();
    expect(huntRow(db, hs).manualPriority).toBe(0);
    expect(db.select().from(manualRequests).all()[0].status).toBe("done");
  });
});

describe("runCycle — live dispatch", () => {
  it("groups a season, dispatches, polls to completion and bumps tiers with jitter", async () => {
    const low = makeHarness({ random: () => 0 }); // jitter factor 0.9
    low.settings.update({ dryRun: false });
    seedSeries(low.db, { id: 1 });
    const ids = [1, 2, 3].map((n) =>
      seedEpisode(low.db, { id: 10 + n, seriesId: 1, episodeNumber: n }),
    );
    await low.engine.runCycle();

    expect(low.sonarr.sent).toEqual([{ name: "SeasonSearch", seriesId: 1, seasonNumber: 1 }]);
    expect(
      low.bus.since(0).find((event) => event.type === "hunt.search.started")?.payload,
    ).toMatchObject({ commandName: "SeasonSearch" });
    expect(low.budget.estimateCalls).toEqual([{ kind: "tv", searchOps: 1, anime: false }]);
    expect(low.budget.recorded).toHaveLength(1);
    expect(low.sync.seriesRefreshes).toEqual([1]);
    const attempt = low.db.select().from(searchAttempts).all()[0];
    expect(attempt).toMatchObject({
      commandName: "SeasonSearch",
      status: "completed",
      result: "no_grab",
      targetLabel: "Series 1 S01",
      dryRun: false,
    });
    expect(attempt.targetIds).toEqual(ids);
    const completedAt = attempt.completedAt as number;
    for (const id of ids) {
      const row = huntRow(low.db, id);
      expect(row.tier).toBe(1);
      expect(row.searchCount).toBe(1);
      expect(row.lastSearchAt).toBe(completedAt);
      // first failure walks the ladder from the start: 12h, here with 0.9 jitter
      expect(row.nextEligibleAt).toBe(completedAt + Math.round(backoffForTier(0) * 0.9));
    }

    const high = makeHarness({ random: () => 1 }); // jitter factor 1.1
    high.settings.update({ dryRun: false });
    seedSeries(high.db, { id: 1 });
    const hs = seedEpisode(high.db, { id: 11, seriesId: 1 });
    await high.engine.runCycle();
    const a2 = high.db.select().from(searchAttempts).all()[0];
    expect(huntRow(high.db, hs).nextEligibleAt).toBe(
      (a2.completedAt as number) + Math.round(backoffForTier(0) * 1.1),
    );
  });

  it("transitions to exhausted when the tier reaches EXHAUSTED_TIER", async () => {
    const { db, engine, settings } = makeHarness();
    settings.update({ dryRun: false });
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 }, { tier: 5, searchCount: 5 });
    await engine.runCycle();
    const row = huntRow(db, hs);
    expect(row).toMatchObject({ tier: 6, state: "exhausted", searchCount: 6 });
  });

  it("skips the tier bump when a grab was credited during the search", async () => {
    const { db, engine, settings, sync } = makeHarness();
    settings.update({ dryRun: false });
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 });
    // Simulate the sync history poll landing mid-search: grab credited + flag set.
    sync.onSeriesRefresh = () => {
      db.update(huntState).set({ awaitingImportSince: T0 }).where(eq(huntState.id, hs)).run();
      const attempt = db.select().from(searchAttempts).all()[0];
      db.update(searchAttempts)
        .set({ result: "grabbed" })
        .where(eq(searchAttempts.id, attempt.id))
        .run();
    };
    await engine.runCycle();
    const attempt = db.select().from(searchAttempts).all()[0];
    expect(attempt.result).toBe("grabbed");
    const row = huntRow(db, hs);
    expect(row.tier).toBe(0);
    expect(row.nextEligibleAt).toBeNull();
    expect(row.searchCount).toBe(1);
  });

  it("marks the attempt timeout when the command never completes", async () => {
    const { db, engine, settings, sonarr } = makeHarness();
    settings.update({ dryRun: false });
    sonarr.defaultCommandStatus = "started";
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 });
    await engine.runCycle();
    expect(sonarr.getCommandCalls).toBeGreaterThanOrEqual(59);
    const attempt = db.select().from(searchAttempts).all()[0];
    expect(attempt).toMatchObject({ status: "timeout", result: "no_grab" });
    expect(huntRow(db, hs).tier).toBe(1); // search presumably ran — back off
  });

  it("caps commands per cycle at maxCommandsPerCycle", async () => {
    const { db, engine, settings, sonarr } = makeHarness();
    settings.update({ dryRun: false, maxCommandsPerCycle: 2 });
    for (const id of [1, 2, 3, 4]) {
      seedSeries(db, { id });
      seedEpisode(db, { id: id * 10, seriesId: id });
    }
    await engine.runCycle();
    expect(sonarr.sent).toHaveLength(2);
  });
});

describe("runCycle — gates and holds", () => {
  it("budget hold stops the scheduled portion but manual ran first", async () => {
    const { db, engine, settings, sonarr, budget } = makeHarness();
    settings.update({ dryRun: false });
    budget.holdAfter = 1;
    seedSeries(db, { id: 1 });
    seedSeries(db, { id: 2 });
    seedEpisode(db, { id: 11, seriesId: 1 }, { manualPriority: 5 });
    seedEpisode(db, { id: 21, seriesId: 2 });

    await engine.runCycle();
    expect(sonarr.sent).toHaveLength(1); // manual only
    const attempts = db.select().from(searchAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].trigger).toBe("forced");
    const status = engine.engineStatus();
    expect(status.state).toBe("held");
    expect(status.holdReason).toContain("budget hold");
    const holds = db
      .select()
      .from(activityLog)
      .all()
      .filter((r) => r.type === "budget");
    expect(holds).toHaveLength(1);
    expect(holds[0].level).toBe("warn");
  });

  it("download queue gate skips scheduled hunts but still runs manual", async () => {
    const { db, engine, settings, sonarr, radarr } = makeHarness();
    settings.update({ dryRun: false });
    sonarr.queueTotal = 20; // > threshold 15 across both arrs
    seedSeries(db, { id: 1 });
    seedEpisode(db, { id: 11, seriesId: 1 }); // scheduled — must be gated
    seedMovie(db, { id: 9 }, { manualPriority: 2 });

    await engine.runCycle();
    expect(sonarr.sent).toHaveLength(0);
    expect(radarr.sent).toEqual([{ name: "MoviesSearch", movieIds: [9] }]);
    expect(engine.engineStatus().holdReason).toContain("queue gate");
  });

  it("skips the cycle when all configured arrs are unreachable", async () => {
    const { db, engine, settings, sonarr, radarr } = makeHarness();
    settings.update({ dryRun: false });
    sonarr.systemStatusError = new Error("down");
    radarr.systemStatusError = new Error("down");
    seedSeries(db, { id: 1 });
    seedEpisode(db, { id: 11, seriesId: 1 });
    await engine.runCycle();
    expect(sonarr.sent).toHaveLength(0);
    expect(db.select().from(searchAttempts).all()).toHaveLength(0);
    expect(engine.engineStatus()).toMatchObject({ state: "held" });
  });
});

describe("tier reset on fresh imports", () => {
  it("resets tier when the mirrored import is newer than our last search", async () => {
    const { db, engine } = makeHarness({ noClients: true });
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1, hasFile: true, fileImportedAt: T0 - HOUR_MS },
      {
        state: "exhausted",
        tier: 6,
        searchCount: 6,
        lastSearchAt: T0 - 2 * HOUR_MS,
        nextEligibleAt: T0 + 60 * DAY_MS,
      },
    );
    const untouched = seedEpisode(
      db,
      { id: 12, seriesId: 1, episodeNumber: 2, hasFile: true, fileImportedAt: T0 - 3 * HOUR_MS },
      { state: "non_german", tier: 3, lastSearchAt: T0 - 2 * HOUR_MS },
    );
    await engine.runCycle(); // no clients: holds, but resets still run first
    expect(huntRow(db, hs)).toMatchObject({ tier: 0, nextEligibleAt: null, state: "non_german" });
    expect(huntRow(db, untouched)).toMatchObject({ tier: 3, state: "non_german" });
  });
});

describe("applyVerdict", () => {
  it("pauses unlikely series at/above the confidence threshold, honoring perSeason", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const s1 = seedEpisode(db, { id: 11, seriesId: 1, seasonNumber: 1 });
    const s2 = seedEpisode(
      db,
      { id: 21, seriesId: 1, seasonNumber: 2, episodeNumber: 1 },
      { seasonNumber: 2 },
    );
    const done = seedEpisode(
      db,
      { id: 31, seriesId: 1, seasonNumber: 3, episodeNumber: 1, hasFile: true, hasGerman: true },
      { seasonNumber: 3, state: "german" },
    );
    const verdict = seedVerdict(db, {
      perSeason: [{ season: 2, verdict: "exists" }],
    });
    const res = engine.applyVerdict(verdict);
    expect(res.applied).toBe(2);
    expect(huntRow(db, s1)).toMatchObject({
      state: "ai_paused",
      aiVerdictId: verdict.id,
      nextEligibleAt: aiPausedUntilFor(verdict),
    });
    // listed exists season: tier 2, immediately eligible, NOT paused
    expect(huntRow(db, s2)).toMatchObject({ state: "missing", tier: 2, nextEligibleAt: null });
    expect(huntRow(db, done).state).toBe("german"); // untouched
  });

  it("doubles the pause on consecutive unlikely verdicts, capped at 365d", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 });
    const v1 = seedVerdict(db, {});
    engine.applyVerdict(v1);
    expect(huntRow(db, hs).nextEligibleAt).toBe(T0 + 180 * DAY_MS);

    const v2 = seedVerdict(db, { checkedAt: T0 + 180 * DAY_MS, recheckAfter: T0 + 270 * DAY_MS });
    engine.applyVerdict(v2);
    // doubled previous 180d horizon
    expect(huntRow(db, hs).nextEligibleAt).toBe(T0 + 180 * DAY_MS + 360 * DAY_MS);

    const v3 = seedVerdict(db, { checkedAt: T0 + 540 * DAY_MS, recheckAfter: T0 + 630 * DAY_MS });
    engine.applyVerdict(v3);
    // 2*360d capped at 365d
    expect(huntRow(db, hs).nextEligibleAt).toBe(T0 + 540 * DAY_MS + 365 * DAY_MS);
  });

  it("does not pause below the confidence threshold and unpauses instead", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1 },
      { state: "ai_paused", nextEligibleAt: T0 + 100 * DAY_MS },
    );
    const v = seedVerdict(db, { confidence: 0.5 });
    engine.applyVerdict(v);
    expect(huntRow(db, hs)).toMatchObject({
      state: "missing",
      nextEligibleAt: null,
      aiVerdictId: v.id,
    });
  });

  it("applies announced (tier 2, eligible at expectedAvailability) and exists (tier 2, now)", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 }, { tier: 5 });
    const announced = seedVerdict(db, {
      verdict: "announced",
      expectedAvailability: T0 + 45 * DAY_MS,
    });
    engine.applyVerdict(announced);
    expect(huntRow(db, hs)).toMatchObject({ tier: 2, nextEligibleAt: T0 + 45 * DAY_MS });

    const announcedNoDate = seedVerdict(db, { verdict: "announced" });
    engine.applyVerdict(announcedNoDate);
    expect(huntRow(db, hs).nextEligibleAt).toBe(T0 + 30 * DAY_MS);

    const exists = seedVerdict(db, { verdict: "exists" });
    engine.applyVerdict(exists);
    expect(huntRow(db, hs)).toMatchObject({ tier: 2, nextEligibleAt: null });
  });

  it("applies movie verdicts via radarr subject keys", () => {
    const { db, engine } = makeHarness();
    const hs = seedMovie(db, { id: 9 });
    const v = seedVerdict(db, { subjectKind: "movie", subjectKey: "radarr:9" });
    expect(engine.applyVerdict(v).applied).toBe(1);
    expect(huntRow(db, hs).state).toBe("ai_paused");
  });
});

describe("force / pause / resume", () => {
  it("queues a whole series at one shared priority, skipping done/never-search items", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const a = seedEpisode(db, { id: 11, seriesId: 1 });
    const b = seedEpisode(
      db,
      { id: 12, seriesId: 1, episodeNumber: 2, hasFile: true },
      { state: "non_german", manualPriority: 4 },
    );
    const german = seedEpisode(
      db,
      { id: 13, seriesId: 1, episodeNumber: 3, hasFile: true, hasGerman: true },
      { state: "german" },
    );
    const ignored = seedEpisode(
      db,
      { id: 14, seriesId: 1, episodeNumber: 4 },
      { state: "ignored" },
    );

    const res = engine.forceSubject({ source: "sonarr", kind: "series", id: 1 });
    expect(res).toEqual({ queuedTargets: 2, queuePosition: 1 });
    expect(huntRow(db, a).manualPriority).toBe(5); // max(4)+1
    expect(huntRow(db, b).manualPriority).toBe(5);
    expect(huntRow(db, german).manualPriority).toBe(0);
    expect(huntRow(db, ignored).manualPriority).toBe(0);
    const req = db.select().from(manualRequests).all();
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ subject: "sonarr:series:1", status: "pending" });
  });

  it("force lifts an ai_paused state back to its mirror-derived state", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1, hasFile: true },
      { state: "ai_paused", nextEligibleAt: T0 + 100 * DAY_MS },
    );
    engine.forceSubject({ source: "sonarr", kind: "episode", id: 11 });
    expect(huntRow(db, hs)).toMatchObject({
      state: "non_german",
      nextEligibleAt: null,
      manualPriority: 1,
    });
  });

  it("completes manual requests after a live forced search", async () => {
    const { db, engine, settings } = makeHarness();
    settings.update({ dryRun: false });
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 });
    engine.forceSubject({ source: "sonarr", kind: "episode", id: 11 });
    await engine.runCycle();
    expect(huntRow(db, hs).manualPriority).toBe(0);
    expect(db.select().from(manualRequests).all()[0].status).toBe("done");
    expect(db.select().from(searchAttempts).all()[0].trigger).toBe("forced");
  });

  it("pause sets the flag (dropping any queued force), resume clears it", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(db, { id: 11, seriesId: 1 }, { manualPriority: 2 });
    engine.pauseSubject({
      source: "sonarr",
      kind: "episode",
      id: 11,
      until: T0 + DAY_MS,
      note: "later",
    });
    expect(huntRow(db, hs)).toMatchObject({
      userPaused: true,
      userPausedUntil: T0 + DAY_MS,
      userPausedNote: "later",
      manualPriority: 0,
    });
    expect(engine.queueView()).toHaveLength(0);

    engine.resumeSubject({ source: "sonarr", kind: "episode", id: 11 });
    expect(huntRow(db, hs)).toMatchObject({ userPaused: false, userPausedUntil: null });
  });

  it("resume with overrideAi + force lifts ai pause and eligibility backoff", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1 },
      { state: "ai_paused", userPaused: true, nextEligibleAt: T0 + 200 * DAY_MS },
    );
    engine.resumeSubject({
      source: "sonarr",
      kind: "episode",
      id: 11,
      force: true,
      overrideAi: true,
    });
    expect(huntRow(db, hs)).toMatchObject({
      state: "missing",
      userPaused: false,
      nextEligibleAt: null,
    });
  });

  it("expires timed user pauses at cycle start", async () => {
    const { db, engine } = makeHarness({ noClients: true });
    seedSeries(db, { id: 1 });
    const hs = seedEpisode(
      db,
      { id: 11, seriesId: 1 },
      { userPaused: true, userPausedUntil: T0 - 1, userPausedNote: "old" },
    );
    await engine.runCycle();
    expect(huntRow(db, hs)).toMatchObject({ userPaused: false, userPausedNote: null });
  });
});

describe("queue management and views", () => {
  it("bumps and removes queue entries", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1 });
    const manual = seedEpisode(db, { id: 11, seriesId: 1 }, { manualPriority: 3 });
    const scheduled = seedEpisode(
      db,
      { id: 12, seriesId: 1, episodeNumber: 2 },
      { tier: 2, searchCount: 2 },
    );

    engine.bumpQueueEntry(scheduled);
    expect(huntRow(db, scheduled).manualPriority).toBe(4);

    engine.removeQueueEntry(scheduled); // manual entry → back to scheduled
    expect(huntRow(db, scheduled).manualPriority).toBe(0);

    engine.removeQueueEntry(scheduled); // scheduled entry → deferred one backoff step
    expect(huntRow(db, scheduled).nextEligibleAt).toBe(T0 + backoffForTier(2));

    engine.removeQueueEntry(manual);
    expect(huntRow(db, manual).manualPriority).toBe(0);
  });

  it("reports paused and ai-dormant items with labels and verdict summaries", () => {
    const { db, engine } = makeHarness();
    seedSeries(db, { id: 1, title: "Dark" });
    seedEpisode(
      db,
      { id: 11, seriesId: 1, seasonNumber: 2, episodeNumber: 4 },
      { userPaused: true, userPausedNote: "vacation" },
    );
    const verdict = seedVerdict(db, {});
    seedMovie(
      db,
      { id: 9, title: "Heat", year: 1995 },
      { state: "ai_paused", aiVerdictId: verdict.id, nextEligibleAt: T0 + 180 * DAY_MS },
    );
    const view = engine.pausedView();
    expect(view.manual).toHaveLength(1);
    expect(view.manual[0]).toMatchObject({ label: "Dark S02E04", note: "vacation" });
    expect(view.aiPaused).toHaveLength(1);
    expect(view.aiPaused[0]).toMatchObject({
      label: "Heat (1995)",
      nextEligibleAt: T0 + 180 * DAY_MS,
      verdict: { verdict: "unlikely", confidence: 0.9 },
    });
  });

  it("exposes engine status with dry-run flag and next tick estimate", async () => {
    const { engine, settings } = makeHarness({ noClients: true });
    expect(engine.engineStatus()).toMatchObject({ state: "idle", dryRun: true, inFlight: [] });
    await engine.runCycle();
    const status = engine.engineStatus();
    expect(status.state).toBe("held"); // no clients configured
    expect(status.lastCycleAt).toBe(T0);
    expect(status.nextTickAt).toBe(T0 + settings.get().huntTickMinutes * 60_000);
    engine.setNextTickAt(T0 + 123);
    expect(engine.engineStatus().nextTickAt).toBe(T0 + 123);
  });
});
