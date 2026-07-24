import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsService } from "../config/settings.js";
import { createDb } from "../db/index.js";
import {
  activityLog,
  episodes,
  huntState,
  movies,
  searchAttempts,
  series,
  syncState,
} from "../db/schema.js";
import { type AppEvent, EventBus } from "../events/bus.js";
import type {
  ArrHistoryPageDto,
  ArrHistoryRecordDto,
  QualityProfileDto,
  RadarrMovieDto,
  RadarrSyncPort,
  SonarrEpisodeDto,
  SonarrEpisodeFileDto,
  SonarrSeriesDto,
  SonarrSyncPort,
} from "./arr-ports.js";
import {
  AWAITING_IMPORT_RETRY_DELAY_MS,
  AWAITING_IMPORT_TIMEOUT_MS,
  SyncService,
} from "./service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

const GERMAN = { id: 4, name: "German" };
const ENGLISH = { id: 1, name: "English" };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

class FakeSonarr implements SonarrSyncPort {
  seriesList: SonarrSeriesDto[] = [];
  episodesBySeries = new Map<number, SonarrEpisodeDto[]>();
  filesBySeries = new Map<number, SonarrEpisodeFileDto[]>();
  profiles: QualityProfileDto[] = [];
  history: ArrHistoryRecordDto[] = [];
  calls: string[] = [];

  async getSeries(): Promise<SonarrSeriesDto[]> {
    this.calls.push("getSeries");
    return this.seriesList;
  }
  async getEpisodes(seriesId: number): Promise<SonarrEpisodeDto[]> {
    this.calls.push(`getEpisodes:${seriesId}`);
    return this.episodesBySeries.get(seriesId) ?? [];
  }
  async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFileDto[]> {
    this.calls.push(`getEpisodeFiles:${seriesId}`);
    return this.filesBySeries.get(seriesId) ?? [];
  }
  async getQualityProfiles(): Promise<QualityProfileDto[]> {
    this.calls.push("getQualityProfiles");
    return this.profiles;
  }
  async getHistoryPage(opts: { page: number; pageSize: number }): Promise<ArrHistoryPageDto> {
    this.calls.push(`getHistoryPage:${opts.page}`);
    const sorted = [...this.history].sort((a, b) => b.id - a.id);
    const start = (opts.page - 1) * opts.pageSize;
    return {
      page: opts.page,
      pageSize: opts.pageSize,
      totalRecords: sorted.length,
      records: sorted.slice(start, start + opts.pageSize),
    };
  }
}

class FakeRadarr implements RadarrSyncPort {
  moviesList: RadarrMovieDto[] = [];
  profiles: QualityProfileDto[] = [];
  history: ArrHistoryRecordDto[] = [];
  calls: string[] = [];

  async getMovies(): Promise<RadarrMovieDto[]> {
    this.calls.push("getMovies");
    return this.moviesList;
  }
  async getMovie(id: number): Promise<RadarrMovieDto> {
    this.calls.push(`getMovie:${id}`);
    const found = this.moviesList.find((m) => m.id === id);
    if (!found) throw new Error(`movie ${id} not found`);
    return found;
  }
  async getQualityProfiles(): Promise<QualityProfileDto[]> {
    this.calls.push("getQualityProfiles");
    return this.profiles;
  }
  async getHistoryPage(opts: { page: number; pageSize: number }): Promise<ArrHistoryPageDto> {
    this.calls.push(`getHistoryPage:${opts.page}`);
    const sorted = [...this.history].sort((a, b) => b.id - a.id);
    const start = (opts.page - 1) * opts.pageSize;
    return {
      page: opts.page,
      pageSize: opts.pageSize,
      totalRecords: sorted.length,
      records: sorted.slice(start, start + opts.pageSize),
    };
  }
}

function fakeLog(): FastifyBaseLogger {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: "silent",
    child: () => log,
  };
  return log as unknown as FastifyBaseLogger;
}

function seriesDto(over: Partial<SonarrSeriesDto> = {}): SonarrSeriesDto {
  return {
    id: 1,
    title: "Dark Matters",
    monitored: true,
    originalLanguage: ENGLISH,
    qualityProfileId: 10,
    status: "continuing",
    ...over,
  };
}

function episodeDto(over: Partial<SonarrEpisodeDto> = {}): SonarrEpisodeDto {
  return {
    id: 101,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: 1,
    monitored: true,
    hasFile: false,
    airDateUtc: iso(T0 - 30 * DAY),
    ...over,
  };
}

function fileDto(over: Partial<SonarrEpisodeFileDto> = {}): SonarrEpisodeFileDto {
  return {
    id: 5001,
    seriesId: 1,
    languages: [ENGLISH],
    quality: { quality: { id: 4, name: "WEBDL-1080p" } },
    qualityCutoffNotMet: false,
    languageCutoffNotMet: true,
    customFormatScore: 100,
    dateAdded: iso(T0 - DAY),
    ...over,
  };
}

function movieDto(over: Partial<RadarrMovieDto> = {}): RadarrMovieDto {
  return {
    id: 201,
    title: "Heat",
    year: 1995,
    monitored: true,
    hasFile: false,
    status: "released",
    isAvailable: true,
    qualityProfileId: 20,
    originalLanguage: ENGLISH,
    ...over,
  };
}

const cleanups: { sqlite: { close(): void }; dir: string }[] = [];

function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-sync-"));
  const { db, sqlite } = createDb(dir, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  const bus = new EventBus();
  const events: AppEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const sonarr = new FakeSonarr();
  const radarr = new FakeRadarr();
  const clock = { now: T0 };
  const svc = new SyncService(db, new SettingsService(db), sonarr, radarr, bus, fakeLog(), {
    paceMs: 0,
    now: () => clock.now,
  });
  const harness = {
    db,
    sqlite,
    dir,
    bus,
    events,
    sonarr,
    radarr,
    svc,
    clock,
    huntRow(source: "sonarr" | "radarr", kind: "episode" | "movie", targetId: number) {
      return db
        .select()
        .from(huntState)
        .where(
          and(
            eq(huntState.source, source),
            eq(huntState.targetKind, kind),
            eq(huntState.targetId, targetId),
          ),
        )
        .get();
    },
    cursor(key: string) {
      return db.select().from(syncState).where(eq(syncState.key, key)).get()?.value ?? null;
    },
  };
  cleanups.push({ sqlite, dir });
  return harness;
}

type Harness = ReturnType<typeof makeHarness>;

afterEach(() => {
  for (const h of cleanups.splice(0)) {
    h.sqlite.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/** Standard library: 4 episodes across states + 2 movies. */
function seedStandardFixture(h: Harness): void {
  h.sonarr.profiles = [
    { id: 10, name: "German TRaSH", upgradeAllowed: true, cutoffFormatScore: 10000 },
  ];
  h.sonarr.seriesList = [seriesDto()];
  h.sonarr.episodesBySeries.set(1, [
    episodeDto({ id: 101, episodeNumber: 1, hasFile: true, episodeFileId: 5001 }),
    episodeDto({ id: 102, episodeNumber: 2, hasFile: true, episodeFileId: 5002 }),
    episodeDto({ id: 103, episodeNumber: 3 }),
    episodeDto({ id: 104, episodeNumber: 4, airDateUtc: iso(T0 + 2 * DAY) }),
  ]);
  h.sonarr.filesBySeries.set(1, [
    fileDto({ id: 5001, languages: [GERMAN, ENGLISH] }),
    fileDto({ id: 5002, languages: [ENGLISH] }),
  ]);
  h.sonarr.history = [
    { id: 40, eventType: "grabbed", episodeId: 101, seriesId: 1, date: iso(T0 - 10 * DAY) },
  ];
  h.radarr.profiles = [{ id: 20, name: "Movie German", upgradeAllowed: true }];
  h.radarr.moviesList = [
    movieDto({
      id: 201,
      hasFile: true,
      movieFileId: 7001,
      movieFile: { id: 7001, languages: [GERMAN], dateAdded: iso(T0 - 3 * DAY) },
    }),
    movieDto({ id: 202, title: "Unreleased Thing", year: 2027, isAvailable: false }),
  ];
}

describe("fullReconcile", () => {
  it("initial import populates mirror + hunt_state and seeds cursors", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();

    expect(h.db.select().from(series).all()).toHaveLength(1);
    const eps = h.db.select().from(episodes).all();
    expect(eps).toHaveLength(4);
    const ep101 = eps.find((e) => e.id === 101);
    expect(ep101?.hasGerman).toBe(true);
    expect(ep101?.fileImportedAt).toBe(T0 - DAY);
    expect(eps.find((e) => e.id === 102)?.hasGerman).toBe(false);

    expect(h.huntRow("sonarr", "episode", 101)?.state).toBe("german");
    expect(h.huntRow("sonarr", "episode", 102)?.state).toBe("non_german");
    expect(h.huntRow("sonarr", "episode", 103)?.state).toBe("missing");
    expect(h.huntRow("sonarr", "episode", 104)?.state).toBe("unreleased");
    expect(h.huntRow("sonarr", "episode", 103)?.tier).toBe(0);
    expect(h.huntRow("sonarr", "episode", 103)?.seriesId).toBe(1);
    expect(h.huntRow("sonarr", "episode", 103)?.seasonNumber).toBe(1);

    expect(h.db.select().from(movies).all()).toHaveLength(2);
    expect(h.huntRow("radarr", "movie", 201)?.state).toBe("german");
    expect(h.huntRow("radarr", "movie", 202)?.state).toBe("unreleased");

    expect(h.cursor("sonarr.lastHistoryId")).toBe("40");
    expect(h.cursor("radarr.lastHistoryId")).toBe("0");
    expect(h.cursor("lastFullSyncAt")).toBe(String(T0));
    expect(h.cursor("sonarr.lastFullSyncAt")).toBe(String(T0));
  });

  it("preserves tier/searchCount on existing rows and only moves state", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    h.db
      .update(huntState)
      .set({ tier: 3, searchCount: 5, manualPriority: 2, userPaused: true })
      .where(and(eq(huntState.targetKind, "episode"), eq(huntState.targetId, 103)))
      .run();
    h.events.length = 0;

    // German file shows up for the previously-missing episode.
    h.sonarr.episodesBySeries.set(1, [
      episodeDto({ id: 101, episodeNumber: 1, hasFile: true, episodeFileId: 5001 }),
      episodeDto({ id: 102, episodeNumber: 2, hasFile: true, episodeFileId: 5002 }),
      episodeDto({ id: 103, episodeNumber: 3, hasFile: true, episodeFileId: 5003 }),
      episodeDto({ id: 104, episodeNumber: 4, airDateUtc: iso(T0 + 2 * DAY) }),
    ]);
    h.sonarr.filesBySeries.get(1)?.push(fileDto({ id: 5003, languages: [GERMAN] }));
    await h.svc.fullReconcile();

    const row = h.huntRow("sonarr", "episode", 103);
    expect(row?.state).toBe("german");
    expect(row?.tier).toBe(3);
    expect(row?.searchCount).toBe(5);
    expect(row?.manualPriority).toBe(2);
    expect(row?.userPaused).toBe(true);
    const updated = h.events.find((e) => e.type === "item.updated");
    expect(updated?.payload).toMatchObject({ targetId: 103, state: "german" });
  });

  it("prunes deleted series/movies including their hunt_state rows", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    h.sonarr.seriesList = [];
    h.sonarr.episodesBySeries.clear();
    h.radarr.moviesList = [];
    await h.svc.fullReconcile();

    expect(h.db.select().from(series).all()).toHaveLength(0);
    expect(h.db.select().from(episodes).all()).toHaveLength(0);
    expect(h.db.select().from(movies).all()).toHaveLength(0);
    expect(h.db.select().from(huntState).all()).toHaveLength(0);
  });

  it("skips missing arr clients gracefully", async () => {
    const h = makeHarness();
    const svc = new SyncService(h.db, new SettingsService(h.db), null, null, h.bus, fakeLog(), {
      paceMs: 0,
      now: () => h.clock.now,
    });
    await expect(svc.fullReconcile()).resolves.toBeUndefined();
    await expect(svc.incrementalSync()).resolves.toBeUndefined();
  });
});

describe("incrementalSync", () => {
  it("grabbed history sets awaitingImportSince and credits the search attempt", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    const hs103 = h.huntRow("sonarr", "episode", 103);
    expect(hs103).toBeDefined();
    if (!hs103) throw new Error("unreachable");
    h.db
      .insert(searchAttempts)
      .values({
        createdAt: T0 - HOUR,
        source: "sonarr",
        commandName: "EpisodeSearch",
        payload: { episodeIds: [103] },
        targetIds: [hs103.id],
        targetLabel: "Dark Matters S01E03",
        trigger: "scheduled",
        estimatedQueries: 4,
        status: "completed",
        dryRun: false,
      })
      .run();
    const grabAt = T0 + HOUR;
    h.sonarr.history.push({
      id: 41,
      eventType: "grabbed",
      episodeId: 103,
      seriesId: 1,
      date: iso(grabAt),
    });
    await h.svc.incrementalSync();

    expect(h.huntRow("sonarr", "episode", 103)?.awaitingImportSince).toBe(grabAt);
    const attempt = h.db.select().from(searchAttempts).all()[0];
    expect(attempt?.result).toBe("grabbed");
    expect(h.cursor("sonarr.lastHistoryId")).toBe("41");
  });

  it("import event triggers a targeted refresh and emits a german-achieved win", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    // Simulate a pending grab on the non-German episode 102.
    h.db
      .update(huntState)
      .set({ awaitingImportSince: T0 - HOUR })
      .where(and(eq(huntState.targetKind, "episode"), eq(huntState.targetId, 102)))
      .run();
    h.events.length = 0;

    // The upgrade import replaced 102's file with a German one.
    h.sonarr.episodesBySeries.set(1, [
      episodeDto({ id: 101, episodeNumber: 1, hasFile: true, episodeFileId: 5001 }),
      episodeDto({ id: 102, episodeNumber: 2, hasFile: true, episodeFileId: 5099 }),
      episodeDto({ id: 103, episodeNumber: 3 }),
      episodeDto({ id: 104, episodeNumber: 4, airDateUtc: iso(T0 + 2 * DAY) }),
    ]);
    h.sonarr.filesBySeries.set(1, [
      fileDto({ id: 5001, languages: [GERMAN, ENGLISH] }),
      fileDto({ id: 5099, languages: [GERMAN], dateAdded: iso(T0) }),
    ]);
    h.sonarr.history.push({
      id: 42,
      eventType: "downloadFolderImported",
      episodeId: 102,
      seriesId: 1,
      date: iso(T0 + HOUR),
    });
    await h.svc.incrementalSync();

    expect(h.sonarr.calls).toContain("getEpisodes:1");
    const row = h.huntRow("sonarr", "episode", 102);
    expect(row?.state).toBe("german");
    expect(row?.awaitingImportSince).toBeNull();
    const win = h.events.find((e) => e.type === "hunt.win");
    expect(win?.payload).toMatchObject({
      source: "sonarr",
      kind: "episode",
      targetId: 102,
      label: "Dark Matters S01E02",
    });
    const logRow = h.db.select().from(activityLog).where(eq(activityLog.type, "hunt.win")).all();
    expect(logRow).toHaveLength(1);
    expect(logRow[0]?.message).toContain("Dark Matters S01E02");
  });

  it("file deletion regresses german back to missing", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    expect(h.huntRow("sonarr", "episode", 101)?.state).toBe("german");
    h.events.length = 0;

    h.sonarr.episodesBySeries.set(1, [
      episodeDto({ id: 101, episodeNumber: 1 }),
      episodeDto({ id: 102, episodeNumber: 2, hasFile: true, episodeFileId: 5002 }),
      episodeDto({ id: 103, episodeNumber: 3 }),
      episodeDto({ id: 104, episodeNumber: 4, airDateUtc: iso(T0 + 2 * DAY) }),
    ]);
    h.sonarr.filesBySeries.set(1, [fileDto({ id: 5002, languages: [ENGLISH] })]);
    h.sonarr.history.push({
      id: 43,
      eventType: "episodeFileDeleted",
      episodeId: 101,
      seriesId: 1,
      date: iso(T0 + HOUR),
    });
    await h.svc.incrementalSync();

    expect(h.huntRow("sonarr", "episode", 101)?.state).toBe("missing");
    expect(h.db.select().from(episodes).where(eq(episodes.id, 101)).get()?.hasGerman).toBe(false);
    const updated = h.events.find((e) => e.type === "item.updated");
    expect(updated?.payload).toMatchObject({
      targetId: 101,
      state: "missing",
      previousState: "german",
    });
  });

  it("movie file deletion refreshes the movie and regresses state", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    expect(h.huntRow("radarr", "movie", 201)?.state).toBe("german");

    h.radarr.moviesList = [
      movieDto({ id: 201, hasFile: false }),
      h.radarr.moviesList[1] as RadarrMovieDto,
    ];
    h.radarr.history.push({
      id: 90,
      eventType: "movieFileDeleted",
      movieId: 201,
      date: iso(T0 + HOUR),
    });
    await h.svc.incrementalSync();

    expect(h.radarr.calls).toContain("getMovie:201");
    expect(h.huntRow("radarr", "movie", 201)?.state).toBe("missing");
  });

  it("advances the cursor and does not reprocess old events", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    h.sonarr.history.push({
      id: 41,
      eventType: "grabbed",
      episodeId: 103,
      seriesId: 1,
      date: iso(T0 + HOUR),
    });
    await h.svc.incrementalSync();
    expect(h.cursor("sonarr.lastHistoryId")).toBe("41");

    // Clear the flag; a second sync with no new history must not re-set it.
    h.db
      .update(huntState)
      .set({ awaitingImportSince: null })
      .where(and(eq(huntState.targetKind, "episode"), eq(huntState.targetId, 103)))
      .run();
    const callsBefore = h.sonarr.calls.length;
    await h.svc.incrementalSync();
    expect(h.huntRow("sonarr", "episode", 103)?.awaitingImportSince).toBeNull();
    expect(h.cursor("sonarr.lastHistoryId")).toBe("41");
    // Only the history poll itself — no refresh calls.
    expect(h.sonarr.calls.slice(callsBefore)).toEqual(["getHistoryPage:1"]);
  });

  it("flips unreleased to missing once the air date passes (no arr call)", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    expect(h.huntRow("sonarr", "episode", 104)?.state).toBe("unreleased");

    h.clock.now = T0 + 3 * DAY; // past episode 104's air date
    const callsBefore = h.sonarr.calls.length;
    await h.svc.incrementalSync();

    expect(h.huntRow("sonarr", "episode", 104)?.state).toBe("missing");
    expect(h.sonarr.calls.slice(callsBefore)).toEqual(["getHistoryPage:1"]);
  });

  it("clears awaitingImportSince after 48h and defers eligibility by a day", async () => {
    const h = makeHarness();
    seedStandardFixture(h);
    await h.svc.fullReconcile();
    h.db
      .update(huntState)
      .set({ awaitingImportSince: T0 })
      .where(and(eq(huntState.targetKind, "episode"), eq(huntState.targetId, 103)))
      .run();

    h.clock.now = T0 + AWAITING_IMPORT_TIMEOUT_MS + HOUR;
    await h.svc.incrementalSync();

    const row = h.huntRow("sonarr", "episode", 103);
    expect(row?.awaitingImportSince).toBeNull();
    expect(row?.nextEligibleAt).toBe(h.clock.now + AWAITING_IMPORT_RETRY_DELAY_MS);
    const warn = h.db.select().from(activityLog).where(eq(activityLog.level, "warn")).all();
    expect(warn.length).toBeGreaterThan(0);
  });
});
