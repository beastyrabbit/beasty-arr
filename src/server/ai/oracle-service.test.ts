import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type AppSettings, SettingsService } from "../config/settings.js";
import { createDb, type Db } from "../db/index.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  itemOverrides,
  movies,
  series,
} from "../db/schema.js";
import { EventBus } from "../events/bus.js";
import { type RawDubVerdict, REPORT_TOOL_NAME } from "./existence-check.js";
import { type AiVerdictRow, OracleService } from "./oracle-service.js";
import type { PiRunner, PiSessionRequest } from "./providers.js";

const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const DAY = 86_400_000;
const OLD = NOW - 800 * DAY; // ~2.2 years ago
const RECENT = NOW - 60 * DAY; // 2 months ago

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

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(patch: Partial<AppSettings> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-oracle-test-"));
  const { db, sqlite } = createDb(dir, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = new SettingsService(db);
  settings.update({ dryRun: false, ...patch });
  const bus = new EventBus();
  return { db, settings, bus };
}

function seedSeries(db: Db, id: number, over: Partial<typeof series.$inferInsert> = {}) {
  db.insert(series)
    .values({
      id,
      title: `Series ${id}`,
      tvdbId: 1000 + id,
      imdbId: `tt${id}`,
      year: 2018,
      originalLanguage: "english",
      monitored: true,
      lastSyncedAt: NOW,
      ...over,
    })
    .run();
}

function seedMovie(db: Db, id: number, over: Partial<typeof movies.$inferInsert> = {}) {
  db.insert(movies)
    .values({
      id,
      title: `Movie ${id}`,
      tmdbId: 2000 + id,
      imdbId: `tt9${id}`,
      year: 2015,
      originalLanguage: "english",
      monitored: true,
      hasFile: false,
      digitalRelease: OLD,
      lastSyncedAt: NOW,
      ...over,
    })
    .run();
}

type SeriesSubjectOpts = {
  searchCount?: number;
  state?: "missing" | "non_german" | "exhausted";
  airDateUtc?: number;
  season?: number;
  seriesOver?: Partial<typeof series.$inferInsert>;
};

/** One series with one hunted episode. */
function seedSeriesSubject(db: Db, id: number, opts: SeriesSubjectOpts = {}) {
  const { searchCount = 5, state = "non_german", airDateUtc = OLD, season = 1 } = opts;
  seedSeries(db, id, opts.seriesOver);
  const episodeId = id * 100 + 1;
  db.insert(episodes)
    .values({
      id: episodeId,
      seriesId: id,
      seasonNumber: season,
      episodeNumber: 1,
      airDateUtc,
      monitored: true,
      hasFile: state === "non_german",
      lastSyncedAt: NOW,
    })
    .run();
  db.insert(huntState)
    .values({
      source: "sonarr",
      targetKind: "episode",
      targetId: episodeId,
      seriesId: id,
      seasonNumber: season,
      state,
      stateChangedAt: NOW,
      searchCount,
    })
    .run();
}

function seedMovieSubject(
  db: Db,
  id: number,
  opts: { searchCount?: number; state?: "missing" | "non_german" | "exhausted" } & Partial<
    typeof movies.$inferInsert
  > = {},
) {
  const { searchCount = 5, state = "missing", ...movieOver } = opts;
  seedMovie(db, id, movieOver);
  db.insert(huntState)
    .values({
      source: "radarr",
      targetKind: "movie",
      targetId: id,
      state,
      stateChangedAt: NOW,
      searchCount,
    })
    .run();
}

function seedVerdict(
  db: Db,
  subjectKey: string,
  over: Partial<typeof aiVerdicts.$inferInsert> = {},
) {
  return db
    .insert(aiVerdicts)
    .values({
      subjectKind: subjectKey.startsWith("sonarr") ? "series" : "movie",
      subjectKey,
      title: subjectKey,
      verdict: "unlikely",
      confidence: 0.8,
      evidence: ["seed"],
      provider: "codex",
      model: "gpt-5.5",
      promptVersion: "dub-oracle-v0",
      checkedAt: NOW - 10 * DAY,
      recheckAfter: NOW + 100 * DAY,
      ...over,
    })
    .returning()
    .get();
}

async function callTool(req: PiSessionRequest, name: string, args: unknown) {
  const tool = req.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  await (
    tool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<unknown>
  )("call-1", args, undefined, undefined, {});
}

function scriptedRunner(script?: (req: PiSessionRequest) => Promise<void> | void) {
  const calls: PiSessionRequest[] = [];
  const runner: PiRunner = async (req) => {
    calls.push(req);
    await script?.(req);
    return {
      provider: req.provider ?? "codex",
      model: req.model ?? "gpt-5.5",
      text: "",
      toolCalls: [],
      terminated: true,
      usage: { input: 0, output: 0, cost: 0 },
    };
  };
  return { runner, calls };
}

const reportVerdict =
  (args: Partial<RawDubVerdict> = {}) =>
  async (req: PiSessionRequest) => {
    const subjectJson = req.prompt
      .slice(req.prompt.indexOf("{"), req.prompt.indexOf("Instructions:"))
      .trim();
    const subject = JSON.parse(subjectJson) as { kind: "series" | "movie"; seasons?: number[] };
    const verdict = args.verdict ?? "unlikely";
    const perSeason =
      args.perSeason ??
      (subject.kind === "series"
        ? (subject.seasons ?? []).map((season) => ({
            season,
            verdict,
            confidence: args.confidence ?? 0.8,
            evidence: ["season evidence"],
            recheckAfterDays: args.recheckAfterDays ?? 180,
          }))
        : undefined);
    await callTool(req, "fetch_url", { url: "https://example.com/dub-evidence" });
    await callTool(req, REPORT_TOOL_NAME, {
      verdict: "unlikely",
      confidence: 0.8,
      evidence: ["no synchronkartei entry"],
      recheckAfterDays: 180,
      ...args,
      ...(perSeason ? { perSeason } : {}),
    });
  };

function makeOracle(
  ctx: ReturnType<typeof setup>,
  runner: PiRunner,
  opts: ConstructorParameters<typeof OracleService>[5] = {},
) {
  return new OracleService(ctx.db, ctx.settings, runner, ctx.bus, noopLog, {
    now: () => NOW,
    sleep: async () => undefined,
    fetchImpl: async () =>
      new Response("verified web evidence", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    lookupFn: async () => [{ address: "93.184.216.34" }],
    ...opts,
  });
}

describe("OracleService.selectSubjects (trigger policy)", () => {
  it("selects after configured failures and skips german-original/override/valid-verdict ones", () => {
    const ctx = setup({ aiMinSearchesBeforeCheck: 4 });
    seedSeriesSubject(ctx.db, 1); // searched enough → selected
    seedSeriesSubject(ctx.db, 2, { searchCount: 1 }); // too few searches
    seedSeriesSubject(ctx.db, 3, { airDateUtc: RECENT, searchCount: 9 }); // age does not block
    seedSeriesSubject(ctx.db, 4, { state: "exhausted", searchCount: 0, airDateUtc: RECENT }); // exhausted → always
    seedSeriesSubject(ctx.db, 5, { seriesOver: { originalLanguage: "German" } }); // german original
    seedSeriesSubject(ctx.db, 6); // original_ok override
    ctx.db
      .insert(itemOverrides)
      .values({ source: "sonarr", subjectKind: "series", subjectId: 6, targetMode: "original_ok" })
      .run();
    seedSeriesSubject(ctx.db, 7); // active verdict → skipped
    seedVerdict(ctx.db, "sonarr:7");
    seedSeriesSubject(ctx.db, 8); // expired verdict → re-selected
    seedVerdict(ctx.db, "sonarr:8", { recheckAfter: NOW - DAY });
    seedSeriesSubject(ctx.db, 9); // superseded verdict only → re-selected
    seedVerdict(ctx.db, "sonarr:9", { supersededBy: 12345 });
    seedMovieSubject(ctx.db, 10, { searchCount: 4 }); // failed enough → selected
    seedMovieSubject(ctx.db, 11, {
      searchCount: 9,
      digitalRelease: RECENT,
      physicalRelease: null,
      year: 2026,
    }); // release age does not block after enough failures

    const oracle = makeOracle(ctx, scriptedRunner().runner);
    const selected = oracle.selectSubjects();
    const keys = selected.map((subject) => subject.subjectKey);
    expect(keys).toContain("sonarr:1");
    expect(keys).toContain("sonarr:4");
    expect(keys).toContain("sonarr:8");
    expect(keys).toContain("sonarr:9");
    expect(keys).toContain("radarr:10");
    expect(keys).not.toContain("sonarr:2");
    expect(keys).toContain("sonarr:3");
    expect(keys).not.toContain("sonarr:5");
    expect(keys).not.toContain("sonarr:6");
    expect(keys).not.toContain("sonarr:7");
    expect(keys).toContain("radarr:11");
    // Exhausted subjects come first.
    expect(keys[0]).toBe("sonarr:4");
    const seriesSubject = selected.find((subject) => subject.subjectKey === "sonarr:1");
    expect(seriesSubject).toMatchObject({
      subjectKind: "series",
      title: "Series 1",
      seasons: [1],
      externalIds: { tvdbId: 1001, imdbId: "tt1" },
    });
  });

  it("skips AI for huntable episodes when their season already has a German file", () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 2, searchCount: 3 });
    ctx.db
      .insert(episodes)
      .values({
        id: 199,
        seriesId: 1,
        seasonNumber: 2,
        episodeNumber: 2,
        monitored: true,
        hasFile: true,
        hasGerman: true,
        lastSyncedAt: NOW,
      })
      .run();
    const oracle = makeOracle(ctx, scriptedRunner().runner);
    expect(oracle.selectSubjects().map((subject) => subject.subjectKey)).not.toContain("sonarr:1");
  });

  it("skips subjects while a matching grab is awaiting import", () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { searchCount: 1 });
    seedMovieSubject(ctx.db, 2, { searchCount: 1 });
    ctx.db
      .update(huntState)
      .set({ awaitingImportSince: NOW - 30_000 })
      .where(inArray(huntState.targetId, [101, 2]))
      .run();

    const oracle = makeOracle(ctx, scriptedRunner().runner);
    expect(oracle.selectSubjects()).toEqual([]);
  });

  it("scopes a series check to seasons that have actually failed", () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1, searchCount: 1 });
    ctx.db
      .insert(episodes)
      .values({
        id: 102,
        seriesId: 1,
        seasonNumber: 2,
        episodeNumber: 1,
        monitored: true,
        hasFile: false,
        hasGerman: false,
        lastSyncedAt: NOW,
      })
      .run();
    ctx.db
      .insert(huntState)
      .values({
        source: "sonarr",
        targetKind: "episode",
        targetId: 102,
        seriesId: 1,
        seasonNumber: 2,
        state: "missing",
        stateChangedAt: NOW,
        searchCount: 0,
      })
      .run();
    const subject = makeOracle(ctx, scriptedRunner().runner)
      .selectSubjects()
      .find((candidate) => candidate.subjectKey === "sonarr:1");
    expect(subject?.seasons).toEqual([1]);
  });

  it("does not let a fresh verdict for one season suppress a newly failing season", () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1, searchCount: 2 });
    ctx.db
      .insert(episodes)
      .values({
        id: 102,
        seriesId: 1,
        seasonNumber: 2,
        episodeNumber: 1,
        monitored: true,
        hasFile: false,
        hasGerman: false,
        lastSyncedAt: NOW,
      })
      .run();
    ctx.db
      .insert(huntState)
      .values({
        source: "sonarr",
        targetKind: "episode",
        targetId: 102,
        seriesId: 1,
        seasonNumber: 2,
        state: "missing",
        stateChangedAt: NOW,
        searchCount: 2,
      })
      .run();
    seedVerdict(ctx.db, "sonarr:1", {
      verdict: "exists",
      perSeason: [{ season: 1, verdict: "exists" }],
    });

    const subject = makeOracle(ctx, scriptedRunner().runner)
      .selectSubjects()
      .find((candidate) => candidate.subjectKey === "sonarr:1");

    expect(subject?.seasons).toEqual([2]);
  });
});

describe("OracleService.runDailyBatch", () => {
  it("stores the verdict with clamps, supersedes the old row and notifies", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1);
    const expired = seedVerdict(ctx.db, "sonarr:1", { recheckAfter: NOW - DAY });
    const events: string[] = [];
    ctx.bus.subscribe((event) => events.push(event.type));
    const { runner, calls } = scriptedRunner(
      reportVerdict({ recheckAfterDays: 5, confidence: 0.95, germanTitle: "Die Serie" }),
    );
    const oracle = makeOracle(ctx, runner);
    const applied: AiVerdictRow[] = [];
    oracle.onVerdict = (row) => applied.push(row);

    const result = await oracle.runDailyBatch();
    expect(result).toMatchObject({ selected: 1, checked: 1, failed: 0 });
    expect(calls[0]?.terminatingTool).toBe(REPORT_TOOL_NAME);
    expect(calls[0]?.provider).toBe("codex");

    const rows = ctx.db
      .select()
      .from(aiVerdicts)
      .where(eq(aiVerdicts.subjectKey, "sonarr:1"))
      .all();
    const fresh = rows.find((row) => row.id !== expired.id);
    expect(fresh).toMatchObject({
      subjectKind: "series",
      verdict: "unlikely",
      germanTitle: "Die Serie",
      promptVersion: "dub-oracle-v13",
      checkedAt: NOW,
      recheckAfter: NOW + 365 * DAY, // local "no dub" policy overrides model suggestion
      confidence: 0.95,
      perSeason: [{ season: 1, verdict: "unlikely", confidence: 0.95 }],
      supersededBy: null,
    });
    expect(rows.find((row) => row.id === expired.id)?.supersededBy).toBe(fresh?.id);
    expect(applied.map((row) => row.id)).toEqual([fresh?.id]);
    expect(events).toContain("ai.check.started");
    expect(events).toContain("ai.check.completed");
    const activity = ctx.db.select().from(activityLog).all();
    expect(activity.some((row) => row.type === "ai.check" && row.level === "info")).toBe(true);
  });

  it("keeps high confidence when a fetch_url call succeeded", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1);
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<p>Deutsche Fassung bei Synchronkartei</p>",
    })) as unknown as typeof fetch;
    const { runner } = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", { url: "https://www.synchronkartei.de/suche?q=Series+1" });
      await reportVerdict({ verdict: "exists", confidence: 0.95 })(req);
    });
    const oracle = makeOracle(ctx, runner, {
      fetchImpl,
      lookupFn: async () => [{ address: "93.184.216.34" }],
    });
    await oracle.runDailyBatch();
    const row = ctx.db.select().from(aiVerdicts).get();
    expect(row).toMatchObject({ verdict: "unlikely", confidence: 0.95 });
  });

  it("discards a verdict when no web source was fetched", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1);
    const unverified = scriptedRunner(async (req) => {
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "exists",
        confidence: 0.99,
        evidence: ["claimed from memory"],
        recheckAfterDays: 90,
      });
    });
    const result = await makeOracle(ctx, unverified.runner).runDailyBatch();
    expect(result).toMatchObject({ selected: 1, checked: 0, failed: 1 });
    expect(ctx.db.select().from(aiVerdicts).all()).toHaveLength(0);
  });

  it("discards a response without the structured verdict tool", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1);
    const noStructuredOutput = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", { url: "https://example.com/dub-evidence" });
    });
    const result = await makeOracle(ctx, noStructuredOutput.runner).runDailyBatch();
    expect(result).toMatchObject({ selected: 1, checked: 0, failed: 1 });
    expect(ctx.db.select().from(aiVerdicts).all()).toHaveLength(0);
  });

  it("caps checks per calendar day", async () => {
    const ctx = setup({ aiMaxChecksPerDay: 2 });
    seedSeriesSubject(ctx.db, 1);
    seedSeriesSubject(ctx.db, 2);
    seedSeriesSubject(ctx.db, 3);
    const { runner, calls } = scriptedRunner(reportVerdict());
    const oracle = makeOracle(ctx, runner);
    const first = await oracle.runDailyBatch();
    expect(first).toMatchObject({ selected: 2, checked: 2 });
    expect(calls).toHaveLength(2);
    // Two verdicts checked today → the third subject must wait for tomorrow.
    const second = await oracle.runDailyBatch();
    expect(second).toMatchObject({ selected: 0, checked: 0, skippedReason: "daily_cap" });
  });

  it("runs five different titles concurrently when the daily limit is disabled", async () => {
    const ctx = setup({ aiDailyLimitEnabled: false, aiMaxChecksPerDay: 1, aiParallelism: 5 });
    for (let id = 1; id <= 7; id += 1) seedMovieSubject(ctx.db, id);
    let active = 0;
    let maxActive = 0;
    const { runner, calls } = scriptedRunner(async (req) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await reportVerdict({ verdict: "exists" })(req);
      active -= 1;
    });
    const result = await makeOracle(ctx, runner).runDailyBatch();
    expect(result).toMatchObject({ selected: 7, checked: 7, failed: 0 });
    expect(calls).toHaveLength(7);
    expect(maxActive).toBe(5);
  });

  it("stores explicit negative verdicts for every requested season", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1 });
    ctx.db
      .insert(episodes)
      .values({
        id: 102,
        seriesId: 1,
        seasonNumber: 2,
        episodeNumber: 1,
        monitored: true,
        hasFile: false,
        hasGerman: false,
        lastSyncedAt: NOW,
      })
      .run();
    ctx.db
      .insert(huntState)
      .values({
        source: "sonarr",
        targetKind: "episode",
        targetId: 102,
        seriesId: 1,
        seasonNumber: 2,
        state: "missing",
        stateChangedAt: NOW,
        searchCount: 5,
      })
      .run();
    await makeOracle(ctx, scriptedRunner(reportVerdict()).runner).runDailyBatch();
    expect(ctx.db.select().from(aiVerdicts).get()?.perSeason).toMatchObject([
      { season: 1, verdict: "unlikely" },
      { season: 2, verdict: "unlikely" },
    ]);
  });

  it("discards an incomplete season result instead of inventing a fallback", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1 });
    ctx.db
      .insert(episodes)
      .values({
        id: 102,
        seriesId: 1,
        seasonNumber: 2,
        episodeNumber: 1,
        monitored: true,
        hasFile: false,
        hasGerman: false,
        lastSyncedAt: NOW,
      })
      .run();
    ctx.db
      .insert(huntState)
      .values({
        source: "sonarr",
        targetKind: "episode",
        targetId: 102,
        seriesId: 1,
        seasonNumber: 2,
        state: "missing",
        stateChangedAt: NOW,
        searchCount: 5,
      })
      .run();
    const runner = scriptedRunner(
      reportVerdict({
        verdict: "exists",
        confidence: 0.95,
        perSeason: [
          {
            season: 1,
            verdict: "exists",
            confidence: 0.95,
            evidence: ["confirmed"],
            recheckAfterDays: 90,
          },
        ],
      }),
    );
    const result = await makeOracle(ctx, runner.runner).runDailyBatch();
    expect(result).toMatchObject({ checked: 0, failed: 1 });
    expect(ctx.db.select().from(aiVerdicts).all()).toHaveLength(0);
  });

  it("discards duplicate season results", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1 });
    const duplicate = {
      season: 1,
      verdict: "unlikely" as const,
      confidence: 0.8,
      evidence: ["source"],
      recheckAfterDays: 365,
    };
    const runner = scriptedRunner(reportVerdict({ perSeason: [duplicate, duplicate] }));
    const result = await makeOracle(ctx, runner.runner).runDailyBatch();
    expect(result).toMatchObject({ checked: 0, failed: 1 });
    expect(ctx.db.select().from(aiVerdicts).all()).toHaveLength(0);
  });

  it("upgrades an exact season with localized German episode titles and a German premiere", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1 });
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.fernsehserien.de/series-1/episodenguide/staffel-1",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unlikely",
        confidence: 0.8,
        perSeason: [
          {
            season: 1,
            verdict: "unlikely",
            confidence: 0.8,
            evidence: ["missing Synchronkartei entry"],
            recheckAfterDays: 365,
          },
        ],
        evidence: ["missing Synchronkartei entry"],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response(
          "Series 1 – Deutscher Titel Staffel 1 Episodenguide – fernsehserien.de\n1. Vom Hund in die Hand (Pay It Forward)\nDeutsche TV-Premiere 17.06.2015 sixx",
          { headers: { "content-type": "text/plain" } },
        ),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "exists",
      perSeason: [{ season: 1, verdict: "exists", confidence: 1 }],
    });
  });

  it("upgrades a German-broadcast season when the localized series title is documented", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 6 });
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.fernsehserien.de/series-1/episodenguide/staffel-6",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unlikely",
        confidence: 0.8,
        perSeason: [
          {
            season: 6,
            verdict: "unlikely",
            confidence: 0.8,
            evidence: ["episode title stayed English"],
            recheckAfterDays: 365,
          },
        ],
        evidence: ["episode title stayed English"],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response(
          "Series 1 – Deutscher Titel Staffel 6 Episodenguide – fernsehserien.de\nSwim Shady (Swim Shady)\nDeutsche TV-Premiere 18.09.2019 DMAX",
          { headers: { "content-type": "text/plain" } },
        ),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "exists",
      perSeason: [{ season: 6, verdict: "exists", confidence: 1 }],
    });
  });

  it("downgrades a positive season contradicted by an exact OmU season page", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1 });
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.fernsehserien.de/series-1/episodenguide/staffel-1",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "exists",
        confidence: 0.9,
        perSeason: [
          {
            season: 1,
            verdict: "exists",
            confidence: 0.9,
            evidence: ["aggregator claimed German audio"],
            recheckAfterDays: 90,
          },
        ],
        evidence: ["aggregator claimed German audio"],
        recheckAfterDays: 90,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response(
          "Series 1 Staffel 1 Episodenguide – fernsehserien.de\nFolge 1 (The Beginning)\nDeutsche TV-Premiere 07.10.2022\nOmU (Original mit Untertiteln)",
          { headers: { "content-type": "text/plain" } },
        ),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "unlikely",
      perSeason: [{ season: 1, verdict: "unlikely", confidence: 1 }],
    });
  });

  it("downgrades a JustWatch-only positive season without independent season proof", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1, { season: 1 });
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.justwatch.com/de/Serie/series-1/staffel-1",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "exists",
        confidence: 0.9,
        perSeason: [
          {
            season: 1,
            verdict: "exists",
            confidence: 0.9,
            evidence: ["JustWatch exact season page lists German audio"],
            recheckAfterDays: 90,
          },
        ],
        evidence: ["JustWatch exact season page lists German audio"],
        recheckAfterDays: 90,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response("Series 1 Staffel 1 – Stream\nAudio\nEnglish, Deutsch\nUntertitel\nDeutsch", {
          headers: { "content-type": "text/plain" },
        }),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "unlikely",
      perSeason: [
        {
          season: 1,
          verdict: "unlikely",
          note: expect.stringContaining("independent season-specific source"),
        },
      ],
    });
  });

  it("overrides a movie verdict contradicted by exact-title German audio", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 1);
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", { url: "https://www.netflix.com/title/81234567" });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unknown",
        confidence: 0.9,
        evidence: ["incorrect negative"],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response("Audio\nEnglish, Deutsch\nUntertitel\nEnglish", {
          headers: { "content-type": "text/plain" },
        }),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "exists",
      confidence: 1,
    });
  });

  it("overrides a negative contradicted by Fernsehserien structured German audio", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 1);
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.fernsehserien.de/filme/all-die-leeren-zimmer",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unlikely",
        confidence: 0.9,
        evidence: ["English original with German subtitles"],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response(
          "Movie 1 – fernsehserien.de\nNetflix (Englisch)\nStreaming & Mediatheken\nde (Sprache: Deutsch) en (ov)\nUT de (Untertitel: Deutsch)",
          { headers: { "content-type": "text/plain" } },
        ),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "exists",
      confidence: 1,
    });
  });

  it("overrides a negative for a structured German production", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 1, { title: "Adam & Ida - Die lange Suche der Zwillinge" });
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.fernsehserien.de/suche/adam-ida-die-lange-suche-der-zwillinge",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unlikely",
        confidence: 0.9,
        evidence: ["incorrect negative"],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response("Adam & Ida - Die lange Suche der Zwillinge\nD (Deutschland) 2022 (80 Min.)", {
          headers: { "content-type": "text/plain" },
        }),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "exists",
      confidence: 1,
    });
  });

  it("does not trust a fuzzy Fernsehserien search page for another title", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 1, { title: "Anonymous Club" });
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", {
        url: "https://www.fernsehserien.de/suche/anonymous-club",
      });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unlikely",
        confidence: 0.9,
        evidence: ["No matching German dub evidence"],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response("Vampire Club – fernsehserien.de\nde (Sprache: Deutsch)", {
          headers: { "content-type": "text/plain" },
        }),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).get()).toMatchObject({
      verdict: "unlikely",
      confidence: 0.9,
    });
  });

  it("allows a provider-backed negative when the exact provider page is inaccessible", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 1);
    const runner = scriptedRunner(async (req) => {
      await callTool(req, "fetch_url", { url: "https://www.justwatch.com/de/Film/Movie-1" });
      await callTool(req, REPORT_TOOL_NAME, {
        verdict: "unlikely",
        confidence: 0.9,
        evidence: ["JustWatch says Movie 1 is available to stream on Netflix."],
        recheckAfterDays: 365,
      });
    });
    const result = await makeOracle(ctx, runner.runner, {
      fetchImpl: async () =>
        new Response("Movie 1 is currently available on Netflix", {
          headers: { "content-type": "text/plain" },
        }),
    }).runDailyBatch();
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    expect(ctx.db.select().from(aiVerdicts).all()).toHaveLength(1);
  });

  it("prefilters bulk movies through Wikidata and passes series evidence to one AI job", async () => {
    const ctx = setup({ aiDailyLimitEnabled: false, aiParallelism: 5 });
    seedMovieSubject(ctx.db, 1, { searchCount: 0 });
    seedSeriesSubject(ctx.db, 2, { searchCount: 0 });
    const scripted = scriptedRunner(reportVerdict({ verdict: "unlikely" }));
    const oracle = makeOracle(ctx, scripted.runner, {
      catalogLookup: async () =>
        new Map([
          [
            "radarr:1",
            {
              subjectKey: "radarr:1",
              source: "wikidata-synchronkartei" as const,
              sourceId: "123",
              url: "https://www.synchronkartei.de/film/123",
            },
          ],
          [
            "sonarr:2",
            {
              subjectKey: "sonarr:2",
              source: "wikidata-synchronkartei" as const,
              sourceId: "456",
              url: "https://www.synchronkartei.de/serie/456",
            },
          ],
        ]),
    });
    expect(oracle.startBulk()).toMatchObject({ ok: true, total: 2 });
    while (oracle.getBulkStatus().running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(oracle.getBulkStatus()).toMatchObject({ completed: 2, failed: 0, remaining: 0 });
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.prompt).toContain("wikidata-synchronkartei");
    expect(
      ctx.db
        .select()
        .from(aiVerdicts)
        .all()
        .find((row) => row.subjectKey === "sonarr:2"),
    ).toMatchObject({ verdict: "exists", confidence: 1 });
    expect(
      ctx.db
        .select()
        .from(aiVerdicts)
        .all()
        .find((row) => row.subjectKey === "radarr:1"),
    ).toMatchObject({ verdict: "exists", provider: "wikidata", confidence: 1 });
  });

  it("limits an initial bulk to an explicit validation batch size", async () => {
    const ctx = setup({ aiDailyLimitEnabled: false, aiParallelism: 5 });
    for (let id = 1; id <= 30; id += 1) seedMovieSubject(ctx.db, id, { searchCount: 0 });
    const scripted = scriptedRunner(reportVerdict());
    const oracle = makeOracle(ctx, scripted.runner, { catalogLookup: async () => new Map() });
    expect(oracle.startBulk({ limit: 25 })).toMatchObject({ ok: true, total: 25 });
    while (oracle.getBulkStatus().running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(oracle.getBulkStatus()).toMatchObject({ completed: 25, failed: 0 });
    expect(scripted.calls).toHaveLength(25);
  });

  it("cancels a bulk run while its catalog prefilter is still pending", async () => {
    const ctx = setup({ aiDailyLimitEnabled: false });
    seedMovieSubject(ctx.db, 1, { searchCount: 0 });
    let catalogStarted = false;
    const oracle = makeOracle(ctx, scriptedRunner(reportVerdict()).runner, {
      catalogLookup: async (_subjects, _fetchImpl, signal) => {
        catalogStarted = true;
        await new Promise<void>((_resolve, reject) => {
          if (!signal) throw new Error("missing bulk abort signal");
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return new Map();
      },
    });

    expect(oracle.startBulk()).toMatchObject({ ok: true, total: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(catalogStarted).toBe(true);
    expect(oracle.cancelBulk()).toBe(true);
    while (oracle.getBulkStatus().running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(oracle.getBulkStatus()).toMatchObject({
      cancelled: true,
      completed: 0,
      failed: 0,
      remaining: 1,
    });
  });

  it("reports live progress when the catalog prefilter falls back to AI", async () => {
    const ctx = setup({ aiDailyLimitEnabled: false, aiParallelism: 1 });
    seedMovieSubject(ctx.db, 1, { searchCount: 0 });
    let releaseRunner: (() => void) | undefined;
    const runnerWaiting = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const scripted = scriptedRunner(async (req) => {
      await reportVerdict({ verdict: "exists" })(req);
      await runnerWaiting;
    });
    const oracle = makeOracle(ctx, scripted.runner, {
      catalogLookup: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(oracle.startBulk()).toMatchObject({ ok: true, total: 1 });
    while (scripted.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(oracle.getBulkStatus()).toMatchObject({
      running: true,
      completed: 0,
      failed: 0,
      remaining: 1,
      active: [{ subjectKey: "radarr:1", title: "Movie 1" }],
    });
    releaseRunner?.();
    while (oracle.getBulkStatus().running) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(oracle.getBulkStatus()).toMatchObject({ completed: 1, failed: 0, remaining: 0 });
  });

  it("is skipped entirely in dry-run and when the provider is off", async () => {
    const dry = setup({ dryRun: true });
    seedSeriesSubject(dry.db, 1);
    const dryOracle = makeOracle(dry, scriptedRunner(reportVerdict()).runner);
    expect(await dryOracle.runDailyBatch()).toMatchObject({ skippedReason: "dry_run" });
    expect(dry.db.select().from(aiVerdicts).all()).toHaveLength(0);

    const off = setup({ aiProvider: "off" });
    seedSeriesSubject(off.db, 1);
    const offOracle = makeOracle(off, scriptedRunner(reportVerdict()).runner);
    expect(await offOracle.runDailyBatch()).toMatchObject({ skippedReason: "provider_off" });
  });

  it("counts runner failures without storing a verdict", async () => {
    const ctx = setup();
    seedSeriesSubject(ctx.db, 1);
    const { runner } = scriptedRunner(() => {
      throw new Error("provider exploded");
    });
    const oracle = makeOracle(ctx, runner);
    const result = await oracle.runDailyBatch();
    expect(result).toMatchObject({ selected: 1, checked: 0, failed: 1 });
    expect(ctx.db.select().from(aiVerdicts).all()).toHaveLength(0);
    const warn = ctx.db.select().from(activityLog).all();
    expect(warn.some((row) => row.level === "warn" && row.type === "ai.check")).toBe(true);
  });
});

describe("OracleService.checkAfterFailedSearch", () => {
  it("waits for import reconciliation, checks only the failed subject, and respects dry-run", async () => {
    const live = setup();
    seedSeriesSubject(live.db, 1, { searchCount: 1 });
    seedSeriesSubject(live.db, 2, { searchCount: 1 });
    const liveRunner = scriptedRunner(reportVerdict({ verdict: "exists" }));
    const waits: number[] = [];
    const liveOracle = makeOracle(live, liveRunner.runner, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const result = await liveOracle.checkAfterFailedSearch(["sonarr:2"]);
    expect(result).toMatchObject({ selected: 1, checked: 1, failed: 0 });
    expect(waits).toEqual([2 * 60 * 1000]);
    expect(live.db.select().from(aiVerdicts).all()).toHaveLength(1);
    expect(live.db.select().from(aiVerdicts).get()?.subjectKey).toBe("sonarr:2");

    const dry = setup({ dryRun: true });
    seedSeriesSubject(dry.db, 3, { searchCount: 1 });
    const dryRunner = scriptedRunner(reportVerdict());
    const dryOracle = makeOracle(dry, dryRunner.runner);
    expect(await dryOracle.checkAfterFailedSearch(["sonarr:3"])).toMatchObject({
      skippedReason: "dry_run",
    });
    expect(dryRunner.calls).toHaveLength(0);
  });

  it("refreshes Arr history after the grace period and skips a late Radarr grab", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 13_867, { searchCount: 1, title: "The Roast of Kevin Hart" });
    const runner = scriptedRunner(reportVerdict());
    const order: string[] = [];
    const oracle = makeOracle(ctx, runner.runner, {
      sleep: async () => {
        order.push("grace");
      },
      refreshAutomaticState: async () => {
        order.push("incremental-sync");
        ctx.db
          .update(huntState)
          .set({ awaitingImportSince: Date.UTC(2026, 7, 4, 8, 36, 32) })
          .where(eq(huntState.targetId, 13_867))
          .run();
      },
    });

    expect(await oracle.checkAfterFailedSearch(["radarr:13867"])).toMatchObject({
      selected: 0,
      checked: 0,
      failed: 0,
    });
    expect(order).toEqual(["grace", "incremental-sync"]);
    expect(runner.calls).toHaveLength(0);
  });

  it("fails closed when fresh Arr state cannot be loaded", async () => {
    const ctx = setup();
    seedMovieSubject(ctx.db, 1, { searchCount: 1 });
    const runner = scriptedRunner(reportVerdict());
    const oracle = makeOracle(ctx, runner.runner, {
      refreshAutomaticState: async () => {
        throw new Error("Radarr history unavailable");
      },
    });

    expect(await oracle.checkAfterFailedSearch(["radarr:1"])).toMatchObject({
      selected: 0,
      checked: 0,
      failed: 0,
      skippedReason: "state_refresh_failed",
    });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("OracleService.recheckSubject", () => {
  it("runs even in dry-run and invalidates the previous verdict", async () => {
    const ctx = setup({ dryRun: true });
    seedSeriesSubject(ctx.db, 1);
    const old = seedVerdict(ctx.db, "sonarr:1");
    const { runner } = scriptedRunner(reportVerdict({ verdict: "exists" }));
    const oracle = makeOracle(ctx, runner);
    const row = await oracle.recheckSubject("sonarr:1");
    expect(row).toMatchObject({ subjectKey: "sonarr:1", verdict: "unlikely" });
    const oldRow = ctx.db.select().from(aiVerdicts).where(eq(aiVerdicts.id, old.id)).get();
    expect(oldRow?.supersededBy).not.toBeNull();
  });

  it("respects the daily cap unless forced", async () => {
    const ctx = setup({ aiMaxChecksPerDay: 1 });
    seedSeriesSubject(ctx.db, 1);
    seedVerdict(ctx.db, "sonarr:999", { checkedAt: NOW - 1000 }); // today's budget is spent
    const { runner } = scriptedRunner(reportVerdict());
    const oracle = makeOracle(ctx, runner);
    await expect(oracle.recheckSubject("sonarr:1")).rejects.toThrow(/budget exhausted/);
    const row = await oracle.recheckSubject("sonarr:1", true);
    expect(row.subjectKey).toBe("sonarr:1");
  });

  it("rejects unknown subjects and disabled provider", async () => {
    const ctx = setup();
    const oracle = makeOracle(ctx, scriptedRunner(reportVerdict()).runner);
    await expect(oracle.recheckSubject("sonarr:404")).rejects.toThrow(/Unknown oracle subject/);
    await expect(oracle.recheckSubject("garbage")).rejects.toThrow(/Unknown oracle subject/);

    const off = setup({ aiProvider: "off" });
    seedSeriesSubject(off.db, 1);
    const offOracle = makeOracle(off, scriptedRunner(reportVerdict()).runner);
    await expect(offOracle.recheckSubject("sonarr:1")).rejects.toThrow(/disabled/);
  });

  it("loads movie subjects for manual rechecks", async () => {
    const ctx = setup();
    seedMovie(ctx.db, 12);
    const { runner, calls } = scriptedRunner(reportVerdict({ verdict: "announced" }));
    const oracle = makeOracle(ctx, runner);
    const row = await oracle.recheckSubject("radarr:12");
    expect(row).toMatchObject({
      subjectKey: "radarr:12",
      subjectKind: "movie",
      verdict: "announced",
    });
    expect(calls[0]?.prompt).toContain('"kind": "movie"');
  });
});
