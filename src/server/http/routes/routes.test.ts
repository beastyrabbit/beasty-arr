import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  return app.inject({ method: "POST", url, payload });
}
function put(app: FastifyInstance, url: string, payload?: unknown) {
  return app.inject({ method: "PUT", url, payload });
}

const now = Date.now();

/** Three series (german / missing / non_german aggregate) + two movies. */
function seedLibrary(ctx: AppContext): void {
  const db = ctx.db;
  const mkSeries = (id: number, title: string) =>
    db.insert(series).values({ id, title, monitored: true, lastSyncedAt: now }).run();
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
    .values({ id: 101, title: "Movie One", monitored: true, hasFile: false, lastSyncedAt: now })
    .run();
  db.insert(movies)
    .values({
      id: 102,
      title: "Movie Two",
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
    b = await makeApp();
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

  it("surfaces the forced queue after a force", async () => {
    b.ctx.services.sonarr = { getSystemStatus: async () => ({}) } as never;
    await post(b.app, "/api/items/sonarr/episode/21/force", {});
    const res = await get(b.app, "/api/hunt/queue");
    const item = res.json().items.find((i: { targetId: number }) => i.targetId === 21);
    expect(item).toBeDefined();
    expect(item.reason).toBe("forced");
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
    expect(res.json().status).toBe("unauthenticated");
    expect(res.json().capPerDay).toBe(20);
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

    const res = await post(b.app, "/api/fixer/bulk/start", { targets });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith({ targets });
    start.mockRestore();
  });

  // This replaces the whole fixer service, so it runs last.
  it("maps the queue with latest-analysis fields", async () => {
    b.ctx.services.fixer = {
      getQueue: async () => ({
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
      }),
    } as never;
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
    // dryRun is stripped by the schema; a settings-only PUT still succeeds and leaves dryRun on.
    await put(b.app, "/api/config", { huntTickMinutes: 15 });
    expect(b.ctx.settings.get().huntTickMinutes).toBe(15);
    expect(b.ctx.settings.get().dryRun).toBe(true);
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
