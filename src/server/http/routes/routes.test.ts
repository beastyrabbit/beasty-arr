import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import type { AppContext } from "../../context.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  movies,
  searchAttempts,
  series,
} from "../../db/schema.js";

type Built = { app: FastifyInstance; ctx: AppContext; dir: string };

async function makeApp(env: Record<string, string> = {}): Promise<Built> {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-routes-"));
  const built = await buildApp({
    env: { NODE_ENV: "test", LOG_LEVEL: "error", ...env },
    dataDir: dir,
    serveStatic: false,
  });
  return { ...built, dir };
}

async function closeApp(b: Built): Promise<void> {
  await b.app.close();
  rmSync(b.dir, { recursive: true, force: true });
}

function get(app: FastifyInstance, url: string) {
  return app.inject({ method: "GET", url });
}
function post(app: FastifyInstance, url: string, payload?: unknown) {
  return app.inject({
    method: "POST",
    url,
    ...(payload === undefined
      ? {}
      : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  });
}
function put(app: FastifyInstance, url: string, payload?: unknown) {
  return app.inject({
    method: "PUT",
    url,
    ...(payload === undefined
      ? {}
      : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  });
}

const now = Date.now();

/** Three series (german / missing / non_german aggregate) + two movies. */
function seedLibrary(ctx: AppContext): void {
  const db = ctx.db;
  const mkSeries = (id: number, title: string) =>
    db
      .insert(series)
      .values({
        id,
        title,
        titleSlug: title.toLowerCase().replaceAll(" ", "-"),
        monitored: true,
        lastSyncedAt: now,
      })
      .run();
  const mkEpisode = (
    id: number,
    seriesId: number,
    ep: number,
    hasFile: boolean,
    hasGerman: boolean,
  ) =>
    db
      .insert(episodes)
      .values({
        id,
        seriesId,
        seasonNumber: 1,
        episodeNumber: ep,
        monitored: true,
        hasFile,
        hasGerman,
        lastSyncedAt: now,
      })
      .run();
  const mkEpHunt = (targetId: number, seriesId: number, state: string) =>
    db
      .insert(huntState)
      .values({
        source: "sonarr",
        targetKind: "episode",
        targetId,
        seriesId,
        seasonNumber: 1,
        state: state as never,
        stateChangedAt: now,
      })
      .run();

  mkSeries(1, "Alpha");
  mkEpisode(11, 1, 1, true, true);
  mkEpisode(12, 1, 2, true, true);
  mkEpHunt(11, 1, "german");
  mkEpHunt(12, 1, "german");

  mkSeries(2, "Beta");
  mkEpisode(21, 2, 1, false, false);
  mkEpisode(22, 2, 2, true, true);
  mkEpHunt(21, 2, "missing");
  mkEpHunt(22, 2, "german");

  mkSeries(3, "Gamma");
  mkEpisode(31, 3, 1, true, false);
  mkEpHunt(31, 3, "non_german");

  db.insert(movies)
    .values({
      id: 101,
      title: "Movie One",
      titleSlug: "movie-one",
      monitored: true,
      hasFile: false,
      lastSyncedAt: now,
    })
    .run();
  db.insert(movies)
    .values({
      id: 102,
      title: "Movie Two",
      titleSlug: "movie-two",
      monitored: true,
      hasFile: true,
      hasGerman: true,
      lastSyncedAt: now,
    })
    .run();
  db.insert(huntState)
    .values({
      source: "radarr",
      targetKind: "movie",
      targetId: 101,
      state: "missing",
      stateChangedAt: now,
    })
    .run();
  db.insert(huntState)
    .values({
      source: "radarr",
      targetKind: "movie",
      targetId: 102,
      state: "german",
      stateChangedAt: now,
    })
    .run();
}

// ============ open API ============

describe("open API", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
  });
  afterAll(() => closeApp(b));

  it("allows API access without credentials", async () => {
    for (const url of [
      "/api/status",
      "/api/dashboard/summary",
      "/api/library/series",
      "/api/hunt/status",
    ]) {
      const res = await b.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

// ============ status / dashboard ============

describe("status + dashboard", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
    seedLibrary(b.ctx);
  });
  afterAll(() => closeApp(b));

  it("summarises counts for the homepage widget", async () => {
    const res = await get(b.app, "/api/status");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.missingGerman).toBe(2); // ep21 + movie101
    expect(body.otherAudio).toBe(1); // ep31
    expect(body.budgetUsedPct).toBe(0);
    expect(body.aiStatus).toBe("unauthenticated");
    expect(typeof body.germanPct).toBe("number");
  });

  it("returns the dashboard summary shape", async () => {
    const res = await get(b.app, "/api/dashboard/summary");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engine.state).toBe("running");
    expect(body.engine.holdReason).toBeNull();
    expect(body.engine.heldSince).toBeNull();
    expect(body.counts.total.german).toBe(4); // ep11, ep12, ep22, movie102
    expect(body.counts.sonarr.german).toBe(3);
    expect(body.arrHealth).toEqual({ sonarr: "unknown", radarr: "unknown", prowlarr: "unknown" });
    expect(body.deltaWeekPct).toBeNull();
  });
});

// ============ library filtering + pagination ============

describe("library", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp({
      SONARR_EXTERNAL_URL: "https://sonarr.example.test",
      RADARR_EXTERNAL_URL: "https://radarr.example.test/base/",
    });
    seedLibrary(b.ctx);
  });
  afterAll(() => closeApp(b));

  it("aggregates series state and returns stateFilterCounts", async () => {
    const res = await get(b.app, "/api/library/series");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    const byId = Object.fromEntries(
      body.items.map((s: { id: number; state: string }) => [s.id, s.state]),
    );
    expect(byId[1]).toBe("german");
    expect(byId[2]).toBe("missing");
    expect(byId[3]).toBe("non_german");
    expect(body.stateFilterCounts.german).toBe(1);
    expect(body.stateFilterCounts.missing).toBe(1);
  });

  it("filters by state[] and paginates", async () => {
    const filtered = await get(b.app, "/api/library/series?state[]=missing");
    expect(filtered.json().items.map((s: { id: number }) => s.id)).toEqual([2]);
    // stateFilterCounts reflect the full (pre-state-filter) set
    expect(filtered.json().stateFilterCounts.german).toBe(1);

    const paged = await get(b.app, "/api/library/series?pageSize=1&page=1&sort=title");
    expect(paged.json().total).toBe(3);
    expect(paged.json().items).toHaveLength(1);
    expect(paged.json().items[0].title).toBe("Alpha");
  });

  it("returns series detail with seasons and episodes", async () => {
    const res = await get(b.app, "/api/library/series/2");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0].episodes).toHaveLength(2);
    expect(body.state).toBe("missing");
    expect(body.arrUrl).toBe("https://sonarr.example.test/series/beta");
  });

  it("returns a Radarr deep link when an external URL is configured", async () => {
    const res = await get(b.app, "/api/library/movies/101");
    expect(res.statusCode).toBe(200);
    expect(res.json().arrUrl).toBe("https://radarr.example.test/base/movie/movie-one");
  });

  it("404s an unknown series", async () => {
    const res = await get(b.app, "/api/library/series/9999");
    expect(res.statusCode).toBe(404);
  });

  it("typeaheads over titles", async () => {
    const res = await get(b.app, "/api/search?q=movie");
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.length).toBe(2);
    expect(items.every((i: { kind: string }) => i.kind === "movie")).toBe(true);
  });
});

// ============ items: dry-run translation + 503 ============

describe("items force", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
    seedLibrary(b.ctx);
  });
  afterAll(() => closeApp(b));

  it("503s when the arr client is not configured", async () => {
    const res = await post(b.app, "/api/items/radarr/movie/101/force", {});
    expect(res.statusCode).toBe(503);
  });

  it("returns a dry-run marker while dry-run is on", async () => {
    b.ctx.services.sonarr = { getSystemStatus: async () => ({}) } as never;
    const res = await post(b.app, "/api/items/sonarr/episode/31/force", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(typeof body.wouldHave).toBe("string");
  });

  it("404s a subject with no huntable targets", async () => {
    b.ctx.services.sonarr = { getSystemStatus: async () => ({}) } as never;
    const res = await post(b.app, "/api/items/sonarr/episode/999999/force", {});
    expect(res.statusCode).toBe(404);
  });
});

// ============ missing completeness workflow ============

describe("missing episodes", () => {
  let b: Built;
  const huntIds = new Map<number, number>();
  const insertEpisode = (
    id: number,
    seriesId: number,
    episodeNumber: number,
    airDateUtc: number,
    hasFile = false,
  ) => {
    b.ctx.db
      .insert(episodes)
      .values({
        id,
        seriesId,
        seasonNumber: 1,
        episodeNumber,
        monitored: true,
        hasFile,
        hasGerman: hasFile,
        airDateUtc,
        lastSyncedAt: now,
      })
      .run();
    const row = b.ctx.db
      .insert(huntState)
      .values({
        source: "sonarr",
        targetKind: "episode",
        targetId: id,
        seriesId,
        seasonNumber: 1,
        state: hasFile ? "german" : "missing",
        stateChangedAt: now,
      })
      .returning({ id: huntState.id })
      .get();
    huntIds.set(id, row.id);
  };

  beforeAll(async () => {
    b = await makeApp();
    b.ctx.db
      .insert(series)
      .values({ id: 10, title: "Gap Show", year: 2025, monitored: true, lastSyncedAt: now })
      .run();
    b.ctx.db
      .insert(series)
      .values({ id: 20, title: "Older Show", year: 2024, monitored: true, lastSyncedAt: now })
      .run();
    insertEpisode(101, 10, 1, Date.UTC(2025, 0, 1), true);
    insertEpisode(102, 10, 2, Date.UTC(2025, 0, 8));
    insertEpisode(103, 10, 3, Date.UTC(2025, 0, 15), true);
    insertEpisode(104, 10, 4, Date.UTC(2025, 1, 1));
    insertEpisode(105, 10, 5, Date.UTC(2025, 2, 1));
    insertEpisode(201, 20, 1, Date.UTC(2024, 5, 1));
    insertEpisode(106, 10, 6, Date.now() - 7 * 86_400_000);
    b.ctx.db
      .insert(searchAttempts)
      .values([
        {
          createdAt: now - 2,
          source: "sonarr",
          commandName: "EpisodeSearch",
          payload: {},
          targetIds: [huntIds.get(104) as number],
          trigger: "missing",
          estimatedQueries: 1,
          status: "completed",
          dryRun: false,
        },
        {
          createdAt: now - 1,
          source: "sonarr",
          commandName: "EpisodeSearch",
          payload: {},
          targetIds: [huntIds.get(104) as number],
          trigger: "missing",
          estimatedQueries: 1,
          status: "completed",
          dryRun: false,
        },
        {
          createdAt: now,
          source: "sonarr",
          commandName: "EpisodeSearch",
          payload: {},
          targetIds: [huntIds.get(104) as number],
          trigger: "missing",
          estimatedQueries: 1,
          status: "completed",
          dryRun: true,
        },
      ])
      .run();
  });
  afterAll(() => closeApp(b));

  it("defaults to episodes at least 14 days old and sorts newest first", async () => {
    const response = await get(b.app, "/api/missing/episodes");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.minimumAgeDays).toBe(14);
    expect(body.total).toBe(4);
    expect(body.items.map((item: { id: number }) => item.id)).toEqual([105, 104, 102, 201]);
    expect(body.items.find((item: { id: number }) => item.id === 104).manualAttempts).toBe(2);
  });

  it("filters by title, air year, prior Missing attempts, and exact neighbors", async () => {
    expect((await get(b.app, "/api/missing/episodes?q=gap&year=2025")).json().total).toBe(3);
    expect(
      (await get(b.app, "/api/missing/episodes?maximumManualAttempts=1"))
        .json()
        .items.map((item: { id: number }) => item.id),
    ).toEqual([105, 102, 201]);
    expect((await get(b.app, "/api/missing/episodes?gap=previous")).json().total).toBe(2);
    expect((await get(b.app, "/api/missing/episodes?gap=next")).json().total).toBe(1);
    const between = (await get(b.app, "/api/missing/episodes?gap=between")).json();
    expect(between.total).toBe(1);
    expect(between.items[0]).toMatchObject({
      id: 102,
      previousEpisodePresent: true,
      nextEpisodePresent: true,
    });
  });

  it("rejects a minimum age below the 14-day completeness floor", async () => {
    expect((await get(b.app, "/api/missing/episodes?minimumAgeDays=13")).statusCode).toBe(400);
  });

  it("forces only selected episodes that are still eligible", async () => {
    b.ctx.services.sonarr = { getSystemStatus: async () => ({}) } as never;
    const force = vi.spyOn(b.ctx.services.engine, "forceSubject");
    const response = await post(b.app, "/api/missing/force", {
      episodeIds: [102, 101, 106],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ dryRun: true });
    expect(force).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledWith({
      source: "sonarr",
      kind: "episode",
      id: 102,
      withAiRecheck: false,
      trigger: "missing",
    });

    const empty = await post(b.app, "/api/missing/force", {
      episodeIds: [101, 106],
    });
    expect(empty.statusCode).toBe(404);
  });
});

// ============ hunt + engine + system ============

describe("hunt + engine", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
    seedLibrary(b.ctx);
  });
  afterAll(() => closeApp(b));

  it("reports engine status with a closed queue gate", async () => {
    const res = await get(b.app, "/api/hunt/status");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engine).toBe("running");
    expect(body.holdReason).toBeNull();
    expect(body.heldSince).toBeNull();
    expect(body.queueGate.enabled).toBe(true);
    expect(body.queueGate.threshold).toBe(10);
    expect(body.current).toBeNull();
  });

  it("pauses and resumes the engine via the persisted flag", async () => {
    const pause = await post(b.app, "/api/engine/pause");
    expect(pause.json()).toEqual({ ok: true, engine: "paused" });
    expect((await get(b.app, "/api/hunt/status")).json().engine).toBe("paused");
    const resume = await post(b.app, "/api/engine/resume");
    expect(resume.json()).toEqual({ ok: true, engine: "running" });
  });

  it("toggles dry-run and requires the confirm phrase to go live", async () => {
    const missing = await post(b.app, "/api/system/dry-run", { enabled: false });
    expect(missing.statusCode).toBe(400);
    expect(b.ctx.settings.get().dryRun).toBe(true);

    const bad = await post(b.app, "/api/system/dry-run", { enabled: false, confirm: "nope" });
    expect(bad.statusCode).toBe(400);
    expect(b.ctx.settings.get().dryRun).toBe(true);

    const off = await post(b.app, "/api/system/dry-run", { enabled: false, confirm: "live" });
    expect(off.json()).toEqual({ dryRun: false });
    expect(b.ctx.settings.get().dryRun).toBe(false);
    await post(b.app, "/api/system/dry-run", { enabled: true });
  });

  it("keeps forced work out of the automatic next-hunts queue", async () => {
    b.ctx.services.sonarr = { getSystemStatus: async () => ({}) } as never;
    await post(b.app, "/api/items/sonarr/episode/21/force", {});
    const res = await get(b.app, "/api/hunt/queue");
    const body = res.json();
    const item = body.items.find((i: { targetId: number }) => i.targetId === 21);
    expect(item).toBeUndefined();
    expect(body.total).toBeGreaterThanOrEqual(body.items.length);
    expect(body.counts.forced).toBe(0);
  });

  it("requests a follow-up when Run cycle is clicked during an active cycle", async () => {
    const status = vi
      .spyOn(b.ctx.scheduler, "status")
      .mockReturnValue([{ name: "hunt.cycle", running: true, lastRunAt: null, lastError: null }]);
    const trigger = vi.spyOn(b.ctx.scheduler, "trigger").mockResolvedValue(true);

    const response = await post(b.app, "/api/engine/cycle");

    expect(response.json()).toEqual({ ok: true, started: true });
    expect(trigger).toHaveBeenCalledWith("hunt.cycle");
    status.mockRestore();
    trigger.mockRestore();
  });

  it("reports manual pause timing and groups a series AI verdict", async () => {
    const checkedAt = now - 60_000;
    const wakeAt = now + 30 * 86_400_000;
    const verdict = b.ctx.db
      .insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:2",
        title: "Beta",
        verdict: "unlikely",
        confidence: 0.91,
        evidence: ["No German dub listing."],
        provider: "codex",
        model: "test",
        promptVersion: "test",
        checkedAt,
        recheckAfter: wakeAt,
      })
      .returning({ id: aiVerdicts.id })
      .get();
    b.ctx.db
      .update(huntState)
      .set({ state: "ai_paused", aiVerdictId: verdict.id, nextEligibleAt: wakeAt })
      .where(sql`${huntState.targetId} in (21, 22)`)
      .run();

    await post(b.app, "/api/items/sonarr/episode/31/pause", {
      until: wakeAt,
      note: "wait for release",
    });
    const response = (await get(b.app, "/api/hunt/paused")).json();
    expect(response.userPaused).toContainEqual(
      expect.objectContaining({
        targetId: 31,
        since: expect.any(Number),
        until: wakeAt,
        note: "wait for release",
        targetCount: 1,
      }),
    );
    expect(response.aiDormant).toContainEqual(
      expect.objectContaining({
        kind: "series",
        targetId: 2,
        targetCount: 2,
        checkedAt,
        wakeAt,
      }),
    );

    await post(b.app, "/api/items/sonarr/episode/31/resume", {});
    b.ctx.db
      .update(huntState)
      .set({ state: "missing", aiVerdictId: null, nextEligibleAt: null })
      .where(eq(huntState.targetId, 21))
      .run();
    b.ctx.db
      .update(huntState)
      .set({ state: "german", aiVerdictId: null, nextEligibleAt: null })
      .where(eq(huntState.targetId, 22))
      .run();
  });
});

describe("development dry-run safety", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp({ NODE_ENV: "development" });
  });
  afterAll(() => closeApp(b));

  it("refuses to disable dry-run even with the live confirmation phrase", async () => {
    const res = await post(b.app, "/api/system/dry-run", {
      enabled: false,
      confirm: "live",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "live mode is disabled in local development; run a production deployment to enable it",
    });
    expect(b.ctx.settings.get().dryRun).toBe(true);
  });
});

// ============ budget ============

describe("budget", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
  });
  afterAll(() => closeApp(b));

  it("degrades gracefully with no prowlarr", async () => {
    const res = await get(b.app, "/api/budget");
    expect(res.statusCode).toBe(200);
    expect(res.json().indexers).toEqual([]);
    expect(res.json().refreshedAt).toBeNull();
  });

  it("updates budget settings", async () => {
    const res = await put(b.app, "/api/budget/settings", { budgetSafetyPct: 0.25 });
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetSafetyPct).toBe(0.25);
    expect(b.ctx.settings.get().budgetSafetyPct).toBe(0.25);
  });

  it("rejects unknown budget keys", async () => {
    const res = await put(b.app, "/api/budget/settings", { dryRun: false });
    expect(res.statusCode).toBe(400);
  });
});

// ============ logs: attempts / activity / verdicts ============

describe("logs", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
    b.ctx.db
      .insert(searchAttempts)
      .values({
        createdAt: now,
        source: "sonarr",
        commandName: "EpisodeSearch",
        payload: {},
        targetIds: [1],
        trigger: "scheduled",
        estimatedQueries: 2,
        status: "completed",
        dryRun: true,
      })
      .run();
    b.ctx.db
      .insert(activityLog)
      .values({ at: now, level: "info", type: "sync", message: "hello", data: null })
      .run();
    b.ctx.db
      .insert(aiVerdicts)
      .values({
        subjectKind: "series",
        subjectKey: "sonarr:1",
        title: "Alpha",
        verdict: "unlikely",
        confidence: 0.9,
        evidence: ["src"],
        provider: "codex",
        model: "gpt-5.5",
        promptVersion: "v1",
        checkedAt: now,
        recheckAfter: now + 1000,
      })
      .run();
  });
  afterAll(() => closeApp(b));

  it("pages search attempts", async () => {
    const res = await get(b.app, "/api/attempts?pageSize=10");
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].commandName).toBe("EpisodeSearch");
  });

  it("filters activity by type", async () => {
    expect((await get(b.app, "/api/activity?type=sync")).json().total).toBe(1);
    expect((await get(b.app, "/api/activity?type=fixer")).json().total).toBe(0);
  });

  it("invalidates a verdict by its subject key", async () => {
    const list = await get(b.app, "/api/verdicts");
    const id = list.json().items[0].id;
    const res = await post(b.app, `/api/verdicts/${id}/invalidate`);
    expect(res.json()).toEqual({ ok: true });
    const row = b.ctx.db.select().from(aiVerdicts).all()[0];
    expect(row.supersededBy).not.toBeNull();
  });

  it("404s an unknown verdict", async () => {
    expect((await post(b.app, "/api/verdicts/424242/invalidate")).statusCode).toBe(404);
  });
});

// ============ ai ============

describe("ai", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
  });
  afterAll(() => closeApp(b));

  it("reports codex status as unauthenticated without seeded auth", async () => {
    const res = await get(b.app, "/api/ai/status");
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("codex");
    expect(res.json().model).toBe("gpt-5.6-terra");
    expect(res.json().status).toBe("unauthenticated");
    expect(res.json().capPerDay).toBe(20);
    expect(res.json().dailyLimitEnabled).toBe(true);
    expect(res.json().parallelism).toBe(5);
    expect((await get(b.app, "/api/ai/bulk/status")).json()).toMatchObject({
      running: false,
      total: 0,
      active: [],
    });
  });

  it("accepts an explicit 25-title AI validation batch", async () => {
    let received: { limit?: number } | undefined;
    const original = b.ctx.services.oracle.startBulk.bind(b.ctx.services.oracle);
    b.ctx.services.oracle.startBulk = ((options: { limit?: number }) => {
      received = options;
      return { ok: true, total: options.limit ?? 0 };
    }) as typeof b.ctx.services.oracle.startBulk;
    try {
      const res = await post(b.app, "/api/ai/bulk/start", { limit: 25 });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true, total: 25 });
      expect(received).toEqual({ limit: 25 });
      expect((await post(b.app, "/api/ai/bulk/start", { limit: 0 })).statusCode).toBe(400);
    } finally {
      b.ctx.services.oracle.startBulk = original;
    }
  });

  it("drives the codex device-login flow", async () => {
    b.ctx.services.codexLogin = {
      startCodexLogin: () => ({ loginId: "login-1" }),
      getCodexLogin: (id: string) =>
        id === "login-1"
          ? { status: "waiting_user", verificationUri: "https://x", userCode: "1234" }
          : undefined,
    } as never;
    const start = await post(b.app, "/api/ai/codex-login/start");
    expect(start.statusCode).toBe(202);
    expect(start.json()).toEqual({ id: "login-1" });
    const status = await get(b.app, "/api/ai/codex-login/login-1");
    expect(status.json().status).toBe("authenticating");
    expect(status.json().userCode).toBe("1234");
    expect((await get(b.app, "/api/ai/codex-login/nope")).statusCode).toBe(404);
  });
});

// ============ fixer ============

describe("fixer", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
  });
  afterAll(() => closeApp(b));

  it("reports idle bulk status and empty history", async () => {
    expect((await get(b.app, "/api/fixer/bulk/status")).json().running).toBe(false);
    expect((await get(b.app, "/api/fixer/history")).json().total).toBe(0);
  });

  it("503s analyze when the service is not configured", async () => {
    const res = await post(b.app, "/api/fixer/items/sonarr/5/analyze");
    expect(res.statusCode).toBe(503);
  });

  it("passes exact selected targets to the auto-apply bulk runner", async () => {
    const start = vi
      .spyOn(b.ctx.services.fixerBulk, "start")
      .mockResolvedValue({ ok: true, total: 2 });
    const targets = [
      { service: "sonarr", queueItemId: 5 },
      { service: "radarr", queueItemId: 5 },
    ] as const;

    const res = await post(b.app, "/api/fixer/bulk/start", { targets, skipAnalyzed: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith({ targets, skipAnalyzed: true });
    start.mockRestore();
  });

  it("maps the queue with latest-analysis fields", async () => {
    vi.spyOn(b.ctx.services.fixer, "getQueue").mockResolvedValue({
      fetchedAt: 123,
      items: [
        {
          id: 5,
          service: "sonarr",
          title: "Stuck",
          statusMessages: [],
          episodeIds: [],
          absoluteEpisodeNumbers: [],
          episodeLabels: [],
          canAnalyze: true,
          issueType: "import blocked",
        },
      ],
      errors: {},
    });
    const res = await get(b.app, "/api/fixer/queue");
    expect(res.json().fetchedAt).toBe(123);
    expect(res.json().items[0].analysisId).toBeNull();
    expect(res.json().items[0].issueType).toBe("import blocked");
  });
});

// ============ config never echoes keys ============

describe("config", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp({
      SONARR_URL: "http://sonarr.test:8989",
      SONARR_API_KEY: "super-secret-sonarr-key-xyz",
    });
  });
  afterAll(() => closeApp(b));

  it("returns presence booleans and never the key material", async () => {
    const res = await get(b.app, "/api/config");
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain("super-secret-sonarr-key-xyz");
    const body = res.json();
    expect(body.connections.sonarr.keyPresent).toBe(true);
    expect(body.connections.sonarr.url).toBe("http://sonarr.test:8989");
    expect(body.connections.radarr.keyPresent).toBe(false);
    expect(typeof body.version).toBe("string");
  });

  it("tests a connection without echoing keys", async () => {
    b.ctx.services.sonarr = {
      getSystemStatus: async () => ({ version: "4.0.0", instanceName: "Sonarr" }),
    } as never;
    const res = await post(b.app, "/api/config/test-connection", { service: "sonarr" });
    expect(res.json().ok).toBe(true);
    expect(res.json().version).toBe("4.0.0");
    expect(res.payload).not.toContain("super-secret-sonarr-key-xyz");
  });

  it("rejects dryRun via the config PUT", async () => {
    const response = await put(b.app, "/api/config", { dryRun: false });
    expect(response.statusCode).toBe(400);
    expect(b.ctx.settings.get().dryRun).toBe(true);
  });

  it("keeps the application AI provider Codex-only", async () => {
    const res = await put(b.app, "/api/config", { aiProvider: "off" });
    expect(res.statusCode).toBe(400);
    expect(b.ctx.settings.get().aiProvider).toBe("codex");
  });

  it("updates only the supplied settings instead of resetting unrelated values", async () => {
    b.ctx.settings.update({
      aiModel: "gpt-5.6-sol",
      aiThinkingLevel: "xhigh",
      fixerParallelism: 7,
      maxCommandsPerCycle: 6,
    });

    const res = await put(b.app, "/api/config", { fixerAutoApply: true });

    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      aiModel: "gpt-5.6-sol",
      aiThinkingLevel: "xhigh",
      fixerParallelism: 7,
      maxCommandsPerCycle: 6,
      fixerAutoApply: true,
    });
    expect(b.ctx.settings.get()).toMatchObject(res.json().settings);
  });
});

// ============ webhooks ============

describe("webhooks", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp();
  });
  afterAll(() => closeApp(b));

  it("rejects a missing or wrong token", async () => {
    expect(
      (await b.app.inject({ method: "POST", url: "/api/webhooks/sonarr", payload: {} })).statusCode,
    ).toBe(401);
    expect(
      (await b.app.inject({ method: "POST", url: "/api/webhooks/sonarr?token=wrong", payload: {} }))
        .statusCode,
    ).toBe(401);
  });

  it("enqueues a targeted refresh on the dedicated webhook token", async () => {
    const refreshSeries = vi.fn().mockResolvedValue(undefined);
    b.ctx.services.sync = {
      targetedRefreshSeries: refreshSeries,
      targetedRefreshMovie: vi.fn().mockResolvedValue(undefined),
    } as never;
    const res = await b.app.inject({
      method: "POST",
      url: `/api/webhooks/sonarr?token=${b.ctx.webhookToken.token()}`,
      payload: { eventType: "Download", series: { id: 42 } },
    });
    expect(res.statusCode).toBe(204);
    expect(refreshSeries).toHaveBeenCalledWith(42);
  });
});

// ============ diagnostics ============

describe("diagnostics", () => {
  let b: Built;
  beforeAll(async () => {
    b = await makeApp({ SONARR_URL: "http://sonarr.test:8989", SONARR_API_KEY: "secret-key-abc" });
  });
  afterAll(() => closeApp(b));

  it("exports a redacted bundle without secrets", async () => {
    const res = await get(b.app, "/api/diagnostics/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.payload).not.toContain("secret-key-abc");
    const body = res.json();
    expect(body.connections.sonarr.keyPresent).toBe(true);
    expect(body.dryRun).toBe(true);
  });
});

describe("title-scoped history", () => {
  it("keeps cumulative season metrics after unrelated searches and verdict history", async () => {
    const b = await makeApp();
    try {
      seedLibrary(b.ctx);
      const target = b.ctx.db.select().from(huntState).where(eq(huntState.source, "sonarr")).get();
      if (!target?.seriesId) throw new Error("missing synthetic episode");
      const seriesId = target.seriesId;
      const baseAttempt = {
        source: "sonarr" as const,
        commandName: "EpisodeSearch",
        payload: {},
        estimatedQueries: 1,
        status: "completed",
        completedAt: now,
      };
      b.ctx.db
        .insert(searchAttempts)
        .values({ ...baseAttempt, createdAt: now - 1000, targetIds: [target.id] })
        .run();
      for (let i = 0; i < 405; i++)
        b.ctx.db
          .insert(searchAttempts)
          .values({ ...baseAttempt, createdAt: now + i, targetIds: [999999] })
          .run();
      const detail = (await get(b.app, `/api/library/series/${seriesId}`)).json();
      const season = detail.seasons.find(
        (row: { seasonNumber: number }) => row.seasonNumber === target.seasonNumber,
      );
      expect(season.searchCount).toBe(1);
      expect(season.lastSearchAt).toBe(now - 1000);
      expect(season.history.some((entry: { kind: string }) => entry.kind === "search")).toBe(true);
    } finally {
      await closeApp(b);
    }
  });
});
