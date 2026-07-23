import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
} from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  type AiVerdictValue,
  type ArrSource,
  type FileLanguage,
  type HuntState,
  hasGermanAudio,
  type TargetKind,
} from "../../shared/domain.js";
import type { AppSettings, SettingsService } from "../config/settings.js";
import type { Db } from "../db/index.js";
import {
  activityLog,
  aiVerdicts,
  episodes,
  huntState,
  itemOverrides,
  movies,
  qualityProfiles,
  searchAttempts,
  series,
  syncState,
} from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import {
  aiPausedUntilFor,
  type DeriveStateInput,
  deriveState,
  isAiVerdictValue,
  reconcileDerivedState,
} from "../hunt/state.js";
import type {
  ArrHistoryPager,
  ArrHistoryRecordDto,
  ArrImageDto,
  QualityProfileDto,
  RadarrMovieDto,
  RadarrSyncPort,
  SonarrEpisodeDto,
  SonarrEpisodeFileDto,
  SonarrSeriesDto,
  SonarrSyncPort,
} from "./arr-ports.js";

/** Grab seen but never imported: after this, clear the flag and retry later. */
export const AWAITING_IMPORT_TIMEOUT_MS = 48 * 60 * 60 * 1000;
export const AWAITING_IMPORT_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 10;
/** How far back a search attempt can be to still claim a grab. */
const GRAB_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SyncServiceOptions = {
  /** Delay between paced arr calls during reconcile (ms). Default 250 ≈ 2 req/s. Tests pass 0. */
  paceMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
};

type OverrideRow = typeof itemOverrides.$inferSelect;
type VerdictRow = typeof aiVerdicts.$inferSelect;
type ProfileLite = { upgradeAllowed: boolean | null; cutoffFormatScore: number | null };

type SourceCtx = {
  source: ArrSource;
  now: number;
  settings: AppSettings;
  profiles: Map<number, ProfileLite>;
  seriesOverrides: Map<number, OverrideRow>;
  seasonOverrides: Map<string, OverrideRow>;
  movieOverrides: Map<number, OverrideRow>;
  /** Latest non-superseded verdict per subjectKey ('sonarr:12' / 'radarr:9'). */
  verdicts: Map<string, VerdictRow>;
};

type SeriesMeta = {
  id: number;
  title: string;
  monitored: boolean;
  originalLanguage: string | null;
  qualityProfileId: number | null;
};

type EpisodeFacts = {
  seasonNumber: number;
  monitored: boolean;
  hasFile: boolean;
  hasGerman?: boolean | null;
  airDateUtc?: number | null;
  fileLanguages?: FileLanguage[] | null;
  qualityCutoffNotMet?: boolean | null;
  languageCutoffNotMet?: boolean | null;
  customFormatScore?: number | null;
};

type MovieFacts = {
  monitored: boolean;
  hasFile: boolean;
  hasGerman?: boolean | null;
  isAvailable?: boolean | null;
  status?: string | null;
  fileLanguages?: FileLanguage[] | null;
  qualityCutoffNotMet?: boolean | null;
  customFormatScore?: number | null;
  qualityProfileId?: number | null;
  originalLanguage?: string | null;
};

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function posterUrlFrom(images: ArrImageDto[] | null | undefined): string | null {
  const poster = images?.find((i) => i.coverType === "poster");
  return poster?.remoteUrl ?? poster?.url ?? null;
}

function episodeCode(seasonNumber: number, episodeNumber: number): string {
  const s = String(seasonNumber).padStart(2, "0");
  const e = String(episodeNumber).padStart(2, "0");
  return `S${s}E${e}`;
}

/**
 * Mirrors the arrs into SQLite and keeps hunt_state rows in step.
 * All arr access goes through the narrow ports in arr-ports.ts; a null port
 * (env not configured) skips that arr gracefully.
 */
export class SyncService {
  private readonly paceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly sonarr: SonarrSyncPort | null,
    private readonly radarr: RadarrSyncPort | null,
    private readonly bus: EventBus,
    private readonly log: FastifyBaseLogger,
    opts: SyncServiceOptions = {},
  ) {
    this.paceMs = opts.paceMs ?? 250;
    this.now = opts.now ?? Date.now;
  }

  // ============ full reconcile (nightly + initial import) ============

  async fullReconcile(signal?: AbortSignal): Promise<void> {
    let firstError: unknown = null;
    if (this.sonarr) {
      try {
        await this.reconcileSonarr(this.sonarr, signal);
      } catch (err) {
        firstError = err;
        this.log.error({ err }, "sonarr full reconcile failed");
      }
    }
    if (this.radarr) {
      try {
        await this.reconcileRadarr(this.radarr, signal);
      } catch (err) {
        firstError ??= err;
        this.log.error({ err }, "radarr full reconcile failed");
      }
    }
    this.setSyncStateValue("lastFullSyncAt", String(this.now()));
    if (firstError) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  }

  private async reconcileSonarr(sonarr: SonarrSyncPort, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const profiles = await sonarr.getQualityProfiles();
    this.upsertProfiles("sonarr", profiles, now);
    await this.pace();
    const seriesDtos = await sonarr.getSeries();

    // Prune deleted series: hunt_state first (no FK), then series (cascades episodes).
    const keepIds = seriesDtos.map((s) => s.id);
    const goneEpisodes = this.db
      .select({ id: episodes.id })
      .from(episodes)
      .where(notInArray(episodes.seriesId, keepIds))
      .all();
    if (goneEpisodes.length > 0) {
      this.db
        .delete(huntState)
        .where(
          and(
            eq(huntState.source, "sonarr"),
            eq(huntState.targetKind, "episode"),
            inArray(
              huntState.targetId,
              goneEpisodes.map((g) => g.id),
            ),
          ),
        )
        .run();
    }
    this.db.delete(series).where(notInArray(series.id, keepIds)).run();

    const ctx = this.loadSourceCtx("sonarr", now);
    for (const dto of seriesDtos) {
      if (signal?.aborted) return;
      const row = this.mapSeries(dto, now);
      this.db.insert(series).values(row).onConflictDoUpdate({ target: series.id, set: row }).run();
      await this.pace();
      const eps = await sonarr.getEpisodes(dto.id);
      await this.pace();
      const files = await sonarr.getEpisodeFiles(dto.id);
      const meta: SeriesMeta = {
        id: dto.id,
        title: dto.title,
        monitored: dto.monitored,
        originalLanguage: dto.originalLanguage?.name ?? null,
        qualityProfileId: dto.qualityProfileId ?? null,
      };
      this.syncSeriesEpisodes(ctx, meta, eps, files);
    }
    await this.seedHistoryCursor("sonarr", sonarr);
    this.setSyncStateValue("sonarr.lastFullSyncAt", String(now));
  }

  private async reconcileRadarr(radarr: RadarrSyncPort, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const profiles = await radarr.getQualityProfiles();
    this.upsertProfiles("radarr", profiles, now);
    await this.pace();
    const movieDtos = await radarr.getMovies();

    const keepIds = movieDtos.map((m) => m.id);
    this.db
      .delete(huntState)
      .where(
        and(
          eq(huntState.source, "radarr"),
          eq(huntState.targetKind, "movie"),
          notInArray(huntState.targetId, keepIds),
        ),
      )
      .run();
    this.db.delete(movies).where(notInArray(movies.id, keepIds)).run();

    const ctx = this.loadSourceCtx("radarr", now);
    for (const dto of movieDtos) {
      if (signal?.aborted) return;
      this.upsertMovie(ctx, dto);
    }
    await this.seedHistoryCursor("radarr", radarr);
    this.setSyncStateValue("radarr.lastFullSyncAt", String(now));
  }

  // ============ incremental sync (per-cycle history poll) ============

  async incrementalSync(signal?: AbortSignal): Promise<void> {
    let firstError: unknown = null;
    if (this.sonarr) {
      try {
        await this.incrementalForSource("sonarr", this.sonarr, signal);
      } catch (err) {
        firstError = err;
        this.log.error({ err }, "sonarr incremental sync failed");
      }
    }
    if (this.radarr) {
      try {
        await this.incrementalForSource("radarr", this.radarr, signal);
      } catch (err) {
        firstError ??= err;
        this.log.error({ err }, "radarr incremental sync failed");
      }
    }
    // Clock-driven passes need no arr calls — always run them.
    this.clockPassUnreleased();
    this.expireAwaitingImports();
    if (firstError) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  }

  private async incrementalForSource(
    source: ArrSource,
    port: ArrHistoryPager,
    signal?: AbortSignal,
  ): Promise<void> {
    const cursorKey = `${source}.lastHistoryId`;
    const stored = this.getSyncStateValue(cursorKey);
    const lastId = stored != null ? Number(stored) : null;
    let maxSeen = lastId ?? 0;
    const fresh: ArrHistoryRecordDto[] = [];
    let page = 1;

    paging: while (page <= MAX_HISTORY_PAGES) {
      if (signal?.aborted) return;
      const res = await port.getHistoryPage({ page, pageSize: HISTORY_PAGE_SIZE });
      if (res.records.length === 0) break;
      for (const rec of res.records) {
        if (rec.id > maxSeen) maxSeen = rec.id;
        if (lastId == null) continue; // first run: baseline the cursor, process nothing
        if (rec.id <= lastId) break paging;
        fresh.push(rec);
      }
      if (lastId == null || res.records.length < HISTORY_PAGE_SIZE) break;
      page += 1;
      await this.pace();
    }
    this.setSyncStateValue(cursorKey, String(maxSeen));
    if (lastId == null || fresh.length === 0) return;

    const refreshSeriesIds = new Set<number>();
    const refreshMovieIds = new Set<number>();
    for (const rec of fresh.reverse()) {
      // oldest first
      switch (rec.eventType) {
        case "grabbed":
          this.handleGrab(source, rec);
          break;
        case "downloadFolderImported":
        case "episodeFileDeleted":
        case "movieFileDeleted":
          if (source === "sonarr" && rec.seriesId != null) refreshSeriesIds.add(rec.seriesId);
          else if (source === "radarr" && rec.movieId != null) refreshMovieIds.add(rec.movieId);
          break;
        default:
          break;
      }
    }
    for (const seriesId of refreshSeriesIds) {
      if (signal?.aborted) return;
      await this.targetedRefreshSeries(seriesId);
    }
    for (const movieId of refreshMovieIds) {
      if (signal?.aborted) return;
      await this.targetedRefreshMovie(movieId);
    }
  }

  private handleGrab(source: ArrSource, rec: ArrHistoryRecordDto): void {
    const targetKind: TargetKind = source === "sonarr" ? "episode" : "movie";
    const targetId = targetKind === "episode" ? rec.episodeId : rec.movieId;
    if (targetId == null) return;
    const existing = this.getHuntStateRow(source, targetKind, targetId);
    if (!existing) return;
    const at = parseDateMs(rec.date) ?? this.now();
    this.db
      .update(huntState)
      .set({ awaitingImportSince: at })
      .where(eq(huntState.id, existing.id))
      .run();
    this.bus.emit("item.updated", {
      source,
      kind: targetKind,
      targetId,
      seriesId: existing.seriesId,
      state: existing.state,
      awaitingImportSince: at,
    });
    // Credit the grab to the most recent open search attempt covering this item.
    // The engine writes 'no_grab' right after command completion, so a grab that
    // only shows up on the next history poll must still be able to flip it.
    const windowStart = this.now() - GRAB_ATTEMPT_WINDOW_MS;
    const candidates = this.db
      .select()
      .from(searchAttempts)
      .where(
        and(
          eq(searchAttempts.source, source),
          gte(searchAttempts.createdAt, windowStart),
          or(isNull(searchAttempts.result), eq(searchAttempts.result, "no_grab")),
        ),
      )
      .orderBy(desc(searchAttempts.createdAt))
      .all();
    const match = candidates.find((a) => a.targetIds.includes(existing.id));
    if (match) {
      this.db
        .update(searchAttempts)
        .set({ result: "grabbed" })
        .where(eq(searchAttempts.id, match.id))
        .run();
    }
  }

  /** unreleased → missing purely by the clock once the air date passes (no arr call). */
  private clockPassUnreleased(): void {
    const now = this.now();
    const rows = this.db
      .select({ hs: huntState, ep: episodes })
      .from(huntState)
      .innerJoin(episodes, eq(huntState.targetId, episodes.id))
      .where(
        and(
          eq(huntState.source, "sonarr"),
          eq(huntState.targetKind, "episode"),
          eq(huntState.state, "unreleased"),
          isNotNull(episodes.airDateUtc),
          lte(episodes.airDateUtc, now),
        ),
      )
      .all();
    if (rows.length === 0) return;
    const ctx = this.loadSourceCtx("sonarr", now);
    const seriesIds = [...new Set(rows.map((r) => r.ep.seriesId))];
    const seriesRows = this.db.select().from(series).where(inArray(series.id, seriesIds)).all();
    const metaById = new Map<number, SeriesMeta>(
      seriesRows.map((s) => [
        s.id,
        {
          id: s.id,
          title: s.title,
          monitored: s.monitored,
          originalLanguage: s.originalLanguage,
          qualityProfileId: s.qualityProfileId,
        },
      ]),
    );
    for (const { ep } of rows) {
      const meta = metaById.get(ep.seriesId);
      if (!meta) continue;
      const derived = deriveState(this.episodeDeriveInput(ctx, meta, ep));
      this.applyHuntState({
        source: "sonarr",
        targetKind: "episode",
        targetId: ep.id,
        seriesId: ep.seriesId,
        seasonNumber: ep.seasonNumber,
        derived,
        hasFile: ep.hasFile,
        label: `${meta.title} ${episodeCode(ep.seasonNumber, ep.episodeNumber)}`,
        now,
      });
    }
  }

  /** Grabs that never imported within 48h: release the hold, retry in a day. */
  private expireAwaitingImports(): void {
    const now = this.now();
    const cutoff = now - AWAITING_IMPORT_TIMEOUT_MS;
    const rows = this.db
      .select()
      .from(huntState)
      .where(
        and(isNotNull(huntState.awaitingImportSince), lt(huntState.awaitingImportSince, cutoff)),
      )
      .all();
    for (const row of rows) {
      this.db
        .update(huntState)
        .set({ awaitingImportSince: null, nextEligibleAt: now + AWAITING_IMPORT_RETRY_DELAY_MS })
        .where(eq(huntState.id, row.id))
        .run();
      this.bus.emit("item.updated", {
        source: row.source,
        kind: row.targetKind,
        targetId: row.targetId,
        seriesId: row.seriesId,
        state: row.state,
        reason: "awaiting_import_timeout",
      });
      this.db
        .insert(activityLog)
        .values({
          at: now,
          level: "warn",
          type: "sync",
          message: `Grab never imported within 48h — releasing hold (${row.source} ${row.targetKind} ${row.targetId})`,
          data: { source: row.source, kind: row.targetKind, targetId: row.targetId },
        })
        .run();
    }
  }

  // ============ targeted refresh (2 calls) ============

  async targetedRefreshSeries(seriesId: number): Promise<void> {
    if (!this.sonarr) return;
    const seriesRow = this.db.select().from(series).where(eq(series.id, seriesId)).get();
    if (!seriesRow) {
      this.log.warn({ seriesId }, "targeted refresh skipped: series not mirrored yet");
      return;
    }
    let eps: SonarrEpisodeDto[];
    let files: SonarrEpisodeFileDto[];
    try {
      eps = await this.sonarr.getEpisodes(seriesId);
      await this.pace();
      files = await this.sonarr.getEpisodeFiles(seriesId);
    } catch (err) {
      this.log.warn({ err, seriesId }, "targeted series refresh failed");
      return;
    }
    const ctx = this.loadSourceCtx("sonarr", this.now());
    const meta: SeriesMeta = {
      id: seriesRow.id,
      title: seriesRow.title,
      monitored: seriesRow.monitored,
      originalLanguage: seriesRow.originalLanguage,
      qualityProfileId: seriesRow.qualityProfileId,
    };
    this.syncSeriesEpisodes(ctx, meta, eps, files);
  }

  async targetedRefreshMovie(movieId: number): Promise<void> {
    if (!this.radarr) return;
    let dto: RadarrMovieDto;
    try {
      dto = await this.radarr.getMovie(movieId);
    } catch (err) {
      this.log.warn({ err, movieId }, "targeted movie refresh failed");
      return;
    }
    const ctx = this.loadSourceCtx("radarr", this.now());
    this.upsertMovie(ctx, dto);
  }

  // ============ mirror upserts + state application ============

  private syncSeriesEpisodes(
    ctx: SourceCtx,
    meta: SeriesMeta,
    eps: SonarrEpisodeDto[],
    files: SonarrEpisodeFileDto[],
  ): void {
    const now = ctx.now;
    const fileById = new Map(files.map((f) => [f.id, f]));

    // Prune episodes removed from this series (and their hunt_state rows).
    const keepIds = eps.map((e) => e.id);
    const gone = this.db
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(eq(episodes.seriesId, meta.id), notInArray(episodes.id, keepIds)))
      .all();
    if (gone.length > 0) {
      const goneIds = gone.map((g) => g.id);
      this.db
        .delete(huntState)
        .where(
          and(
            eq(huntState.source, "sonarr"),
            eq(huntState.targetKind, "episode"),
            inArray(huntState.targetId, goneIds),
          ),
        )
        .run();
      this.db.delete(episodes).where(inArray(episodes.id, goneIds)).run();
    }

    for (const ep of eps) {
      const file = ep.episodeFileId != null ? fileById.get(ep.episodeFileId) : undefined;
      const row = this.mapEpisode(ep, file, meta, now);
      this.db
        .insert(episodes)
        .values(row)
        .onConflictDoUpdate({ target: episodes.id, set: row })
        .run();
      const derived = deriveState(this.episodeDeriveInput(ctx, meta, row));
      this.applyHuntState({
        source: "sonarr",
        targetKind: "episode",
        targetId: ep.id,
        seriesId: meta.id,
        seasonNumber: ep.seasonNumber,
        derived,
        hasFile: row.hasFile,
        label: `${meta.title} ${episodeCode(ep.seasonNumber, ep.episodeNumber)}`,
        now,
      });
    }
  }

  private upsertMovie(ctx: SourceCtx, dto: RadarrMovieDto): void {
    const now = ctx.now;
    const row = this.mapMovie(dto, now);
    this.db.insert(movies).values(row).onConflictDoUpdate({ target: movies.id, set: row }).run();
    const derived = deriveState(this.movieDeriveInput(ctx, dto.id, row));
    const label = dto.year != null ? `${dto.title} (${dto.year})` : dto.title;
    this.applyHuntState({
      source: "radarr",
      targetKind: "movie",
      targetId: dto.id,
      seriesId: null,
      seasonNumber: null,
      derived,
      hasFile: row.hasFile,
      label,
      now,
    });
  }

  /**
   * Create-or-reconcile a hunt_state row. New rows start at tier 0; on existing
   * rows ONLY state/stateChangedAt (+denorm series/season, awaiting flag) are
   * touched — tier, searchCount, manualPriority, userPaused belong to the hunt
   * engine and the user.
   */
  private applyHuntState(args: {
    source: ArrSource;
    targetKind: TargetKind;
    targetId: number;
    seriesId: number | null;
    seasonNumber: number | null;
    derived: HuntState;
    hasFile: boolean;
    label: string;
    now: number;
  }): void {
    const { source, targetKind, targetId, seriesId, seasonNumber, derived, hasFile, label, now } =
      args;
    const existing = this.getHuntStateRow(source, targetKind, targetId);
    if (!existing) {
      this.db
        .insert(huntState)
        .values({
          source,
          targetKind,
          targetId,
          seriesId,
          seasonNumber,
          state: derived,
          stateChangedAt: now,
        })
        .run();
      return;
    }
    const next = reconcileDerivedState(existing, derived);
    const stateChanged = next !== existing.state;
    const patch: Partial<typeof huntState.$inferInsert> = {};
    if (existing.seriesId !== seriesId || existing.seasonNumber !== seasonNumber) {
      patch.seriesId = seriesId;
      patch.seasonNumber = seasonNumber;
    }
    // A mirrored file means any pending grab has landed (or is moot).
    if (hasFile && existing.awaitingImportSince != null) patch.awaitingImportSince = null;
    if (stateChanged) {
      patch.state = next;
      patch.stateChangedAt = now;
    }
    if (Object.keys(patch).length > 0) {
      this.db.update(huntState).set(patch).where(eq(huntState.id, existing.id)).run();
    }
    if (!stateChanged) return;
    this.bus.emit("item.updated", {
      source,
      kind: targetKind,
      targetId,
      seriesId,
      state: next,
      previousState: existing.state,
    });
    if (next === "german") {
      this.bus.emit("hunt.win", {
        source,
        kind: targetKind,
        targetId,
        seriesId,
        seasonNumber,
        label,
        at: now,
      });
      this.db
        .insert(activityLog)
        .values({
          at: now,
          level: "info",
          type: "hunt.win",
          message: `German achieved: ${label}`,
          data: { source, kind: targetKind, targetId, seriesId, previousState: existing.state },
        })
        .run();
    }
  }

  private getHuntStateRow(source: ArrSource, targetKind: TargetKind, targetId: number) {
    return this.db
      .select()
      .from(huntState)
      .where(
        and(
          eq(huntState.source, source),
          eq(huntState.targetKind, targetKind),
          eq(huntState.targetId, targetId),
        ),
      )
      .get();
  }

  // ============ mapping ============

  private mapSeries(dto: SonarrSeriesDto, now: number): typeof series.$inferInsert {
    return {
      id: dto.id,
      title: dto.title,
      tvdbId: dto.tvdbId ?? null,
      imdbId: dto.imdbId ?? null,
      year: dto.year ?? null,
      status: dto.status ?? null,
      seriesType: dto.seriesType ?? null,
      originalLanguage: dto.originalLanguage?.name ?? null,
      monitored: dto.monitored,
      qualityProfileId: dto.qualityProfileId ?? null,
      tags: dto.tags ?? null,
      posterUrl: posterUrlFrom(dto.images),
      path: dto.path ?? null,
      lastSyncedAt: now,
    };
  }

  private mapEpisode(
    ep: SonarrEpisodeDto,
    file: SonarrEpisodeFileDto | undefined,
    meta: SeriesMeta,
    now: number,
  ): typeof episodes.$inferInsert & { hasFile: boolean; monitored: boolean } {
    const languages = file?.languages ?? null;
    return {
      id: ep.id,
      seriesId: ep.seriesId,
      seasonNumber: ep.seasonNumber,
      episodeNumber: ep.episodeNumber,
      absoluteEpisodeNumber: ep.absoluteEpisodeNumber ?? null,
      title: ep.title ?? null,
      airDateUtc: parseDateMs(ep.airDateUtc),
      // effective monitored = episode AND series
      monitored: ep.monitored && meta.monitored,
      hasFile: ep.hasFile,
      episodeFileId: ep.episodeFileId ?? null,
      fileLanguages: languages,
      hasGerman: ep.hasFile && hasGermanAudio(languages),
      quality: file?.quality?.quality?.name ?? null,
      qualityCutoffNotMet: file?.qualityCutoffNotMet ?? null,
      languageCutoffNotMet: file?.languageCutoffNotMet ?? null,
      customFormatScore: file?.customFormatScore ?? null,
      fileImportedAt: parseDateMs(file?.dateAdded),
      lastSyncedAt: now,
    };
  }

  private mapMovie(dto: RadarrMovieDto, now: number): typeof movies.$inferInsert {
    const file = dto.movieFile ?? null;
    const languages = file?.languages ?? null;
    return {
      id: dto.id,
      title: dto.title,
      tmdbId: dto.tmdbId ?? null,
      imdbId: dto.imdbId ?? null,
      year: dto.year ?? null,
      status: dto.status ?? null,
      isAvailable: dto.isAvailable ?? null,
      digitalRelease: parseDateMs(dto.digitalRelease),
      physicalRelease: parseDateMs(dto.physicalRelease),
      originalLanguage: dto.originalLanguage?.name ?? null,
      monitored: dto.monitored,
      hasFile: dto.hasFile,
      movieFileId: dto.movieFileId ?? file?.id ?? null,
      fileLanguages: languages,
      hasGerman: dto.hasFile && hasGermanAudio(languages),
      quality: file?.quality?.quality?.name ?? null,
      qualityCutoffNotMet: file?.qualityCutoffNotMet ?? null,
      customFormatScore: file?.customFormatScore ?? null,
      fileImportedAt: parseDateMs(file?.dateAdded),
      qualityProfileId: dto.qualityProfileId ?? null,
      tags: dto.tags ?? null,
      posterUrl: posterUrlFrom(dto.images),
      path: dto.path ?? null,
      lastSyncedAt: now,
    };
  }

  private upsertProfiles(source: ArrSource, dtos: QualityProfileDto[], now: number): void {
    for (const dto of dtos) {
      const row: typeof qualityProfiles.$inferInsert = {
        source,
        id: dto.id,
        name: dto.name ?? null,
        upgradeAllowed: dto.upgradeAllowed ?? null,
        cutoffFormatScore: dto.cutoffFormatScore ?? null,
        minFormatScore: dto.minFormatScore ?? null,
        raw: dto,
        lastSyncedAt: now,
      };
      this.db
        .insert(qualityProfiles)
        .values(row)
        .onConflictDoUpdate({ target: [qualityProfiles.source, qualityProfiles.id], set: row })
        .run();
    }
    this.db
      .delete(qualityProfiles)
      .where(
        and(
          eq(qualityProfiles.source, source),
          notInArray(
            qualityProfiles.id,
            dtos.map((d) => d.id),
          ),
        ),
      )
      .run();
  }

  // ============ derive-input assembly ============

  private loadSourceCtx(source: ArrSource, now: number): SourceCtx {
    const profileRows = this.db
      .select()
      .from(qualityProfiles)
      .where(eq(qualityProfiles.source, source))
      .all();
    const profiles = new Map<number, ProfileLite>(
      profileRows.map((r) => [
        r.id,
        { upgradeAllowed: r.upgradeAllowed, cutoffFormatScore: r.cutoffFormatScore },
      ]),
    );
    const overrideRows = this.db
      .select()
      .from(itemOverrides)
      .where(eq(itemOverrides.source, source))
      .all();
    const seriesOverrides = new Map<number, OverrideRow>();
    const seasonOverrides = new Map<string, OverrideRow>();
    const movieOverrides = new Map<number, OverrideRow>();
    for (const row of overrideRows) {
      if (row.subjectKind === "series") seriesOverrides.set(row.subjectId, row);
      else if (row.subjectKind === "season")
        seasonOverrides.set(`${row.subjectId}:${row.seasonNumber}`, row);
      else if (row.subjectKind === "movie") movieOverrides.set(row.subjectId, row);
    }
    const verdictRows = this.db
      .select()
      .from(aiVerdicts)
      .where(isNull(aiVerdicts.supersededBy))
      .all();
    const verdicts = new Map<string, VerdictRow>();
    for (const row of verdictRows) {
      const current = verdicts.get(row.subjectKey);
      if (!current || row.checkedAt > current.checkedAt) verdicts.set(row.subjectKey, row);
    }
    return {
      source,
      now,
      settings: this.settings.get(),
      profiles,
      seriesOverrides,
      seasonOverrides,
      movieOverrides,
      verdicts,
    };
  }

  private pickVerdict(
    ctx: SourceCtx,
    subjectKey: string,
    seasonNumber?: number,
  ): { verdict: AiVerdictValue; confidence: number; recheckAfter: number; until: number } | null {
    const row = ctx.verdicts.get(subjectKey);
    if (!row) return null;
    let value: AiVerdictValue = row.verdict;
    if (seasonNumber != null && row.perSeason) {
      const entry = row.perSeason.find((p) => p.season === seasonNumber);
      if (entry && isAiVerdictValue(entry.verdict)) value = entry.verdict;
    }
    return {
      verdict: value,
      confidence: row.confidence,
      recheckAfter: row.recheckAfter,
      until: aiPausedUntilFor(row),
    };
  }

  private episodeDeriveInput(ctx: SourceCtx, meta: SeriesMeta, ep: EpisodeFacts): DeriveStateInput {
    const season = ctx.seasonOverrides.get(`${meta.id}:${ep.seasonNumber}`);
    const seriesOverride = ctx.seriesOverrides.get(meta.id);
    const override = season ?? seriesOverride;
    const verdict = this.pickVerdict(ctx, `sonarr:${meta.id}`, ep.seasonNumber);
    return {
      kind: "episode",
      monitored: ep.monitored,
      hasFile: ep.hasFile,
      hasGerman: ep.hasGerman ?? false,
      airDateUtc: ep.airDateUtc ?? null,
      fileLanguages: ep.fileLanguages ?? null,
      qualityCutoffNotMet: ep.qualityCutoffNotMet ?? null,
      languageCutoffNotMet: ep.languageCutoffNotMet ?? null,
      customFormatScore: ep.customFormatScore ?? null,
      profile:
        meta.qualityProfileId != null ? (ctx.profiles.get(meta.qualityProfileId) ?? null) : null,
      override: override
        ? { targetMode: season?.targetMode ?? seriesOverride?.targetMode ?? null }
        : null,
      verdict: verdict
        ? {
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            recheckAfter: verdict.recheckAfter,
          }
        : null,
      aiPausedUntil: verdict?.until ?? null,
      aiPauseConfidence: ctx.settings.aiPauseConfidence,
      originalLanguage: meta.originalLanguage,
      acceptedOriginalLanguages: ctx.settings.acceptedOriginalLanguages,
      now: ctx.now,
    };
  }

  private movieDeriveInput(ctx: SourceCtx, movieId: number, m: MovieFacts): DeriveStateInput {
    const override = ctx.movieOverrides.get(movieId);
    const verdict = this.pickVerdict(ctx, `radarr:${movieId}`);
    return {
      kind: "movie",
      monitored: m.monitored,
      hasFile: m.hasFile,
      hasGerman: m.hasGerman ?? false,
      isAvailable: m.isAvailable ?? null,
      status: m.status ?? null,
      fileLanguages: m.fileLanguages ?? null,
      qualityCutoffNotMet: m.qualityCutoffNotMet ?? null,
      languageCutoffNotMet: null,
      customFormatScore: m.customFormatScore ?? null,
      profile: m.qualityProfileId != null ? (ctx.profiles.get(m.qualityProfileId) ?? null) : null,
      override: override ? { targetMode: override.targetMode ?? null } : null,
      verdict: verdict
        ? {
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            recheckAfter: verdict.recheckAfter,
          }
        : null,
      aiPausedUntil: verdict?.until ?? null,
      aiPauseConfidence: ctx.settings.aiPauseConfidence,
      originalLanguage: m.originalLanguage ?? null,
      acceptedOriginalLanguages: ctx.settings.acceptedOriginalLanguages,
      now: ctx.now,
    };
  }

  // ============ plumbing ============

  private async seedHistoryCursor(source: ArrSource, port: ArrHistoryPager): Promise<void> {
    if (this.getSyncStateValue(`${source}.lastHistoryId`) != null) return;
    const res = await port.getHistoryPage({ page: 1, pageSize: 1 });
    const newest = res.records[0]?.id ?? 0;
    this.setSyncStateValue(`${source}.lastHistoryId`, String(newest));
  }

  private getSyncStateValue(key: string): string | null {
    return this.db.select().from(syncState).where(eq(syncState.key, key)).get()?.value ?? null;
  }

  private setSyncStateValue(key: string, value: string): void {
    this.db
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value } })
      .run();
  }

  private pace(): Promise<void> {
    if (this.paceMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, this.paceMs);
      t.unref?.();
    });
  }
}
