import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  MissingEpisodeItem,
  MissingEpisodesResponse,
  MissingForceResponse,
} from "../../../shared/api-types.js";
import type { AppContext } from "../../context.js";
import { episodes, huntState, searchAttempts, series } from "../../db/schema.js";
import { dryRunResult, pageOffset, parse, serviceUnavailable } from "./util.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_AGE_DAYS = 14;
const IN_FLIGHT_STATUSES = ["dispatched", "queued", "started"] as const;

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  minimumAgeDays: z.coerce.number().int().min(MINIMUM_AGE_DAYS).max(3650).default(MINIMUM_AGE_DAYS),
  maximumManualAttempts: z.coerce.number().int().min(0).max(100).optional(),
  gap: z.enum(["any", "previous", "next", "between"]).default("any"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const forceSchema = z.object({
  episodeIds: z.array(z.number().int().positive()).min(1).max(500),
});

function inFlightHuntStateIds(ctx: AppContext): Set<number> {
  const rows = ctx.db
    .select({ targetIds: searchAttempts.targetIds })
    .from(searchAttempts)
    .where(
      and(
        isNull(searchAttempts.completedAt),
        inArray(searchAttempts.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .all();
  return new Set(rows.flatMap((row) => row.targetIds));
}

function manualAttemptCount(): SQL<number> {
  return sql<number>`(
    SELECT count(*)
    FROM search_attempts AS manual_attempt
    JOIN json_each(manual_attempt.target_ids) AS manual_target
    WHERE manual_attempt.trigger = 'missing'
      AND manual_attempt.dry_run = 0
      AND CAST(manual_target.value AS INTEGER) IN (
        SELECT manual_hunt_state.id
        FROM hunt_state AS manual_hunt_state
        WHERE manual_hunt_state.source = 'sonarr'
          AND manual_hunt_state.target_kind = 'episode'
          AND manual_hunt_state.target_id = ${episodes.id}
      )
  )`;
}

function previousEpisodePresent(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM episodes AS previous_episode
    WHERE previous_episode.series_id = ${episodes.seriesId}
      AND previous_episode.season_number = ${episodes.seasonNumber}
      AND previous_episode.episode_number = ${episodes.episodeNumber} - 1
      AND previous_episode.has_file = 1
  )`;
}

function nextEpisodePresent(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM episodes AS next_episode
    WHERE next_episode.series_id = ${episodes.seriesId}
      AND next_episode.season_number = ${episodes.seasonNumber}
      AND next_episode.episode_number = ${episodes.episodeNumber} + 1
      AND next_episode.has_file = 1
  )`;
}

function missingConditions(input: z.infer<typeof listQuerySchema>): SQL[] {
  const cutoff = Date.now() - input.minimumAgeDays * DAY_MS;
  const conditions: SQL[] = [
    eq(episodes.hasFile, false),
    eq(episodes.monitored, true),
    eq(series.monitored, true),
    isNotNull(episodes.airDateUtc),
    lte(episodes.airDateUtc, cutoff),
  ];
  if (input.q) {
    const like = `%${input.q.replace(/[%_]/g, (value) => `\\${value}`)}%`;
    conditions.push(sql`${series.title} LIKE ${like} ESCAPE '\\'`);
  }
  if (input.year != null) {
    conditions.push(gte(episodes.airDateUtc, Date.UTC(input.year, 0, 1)));
    conditions.push(lt(episodes.airDateUtc, Date.UTC(input.year + 1, 0, 1)));
  }
  if (input.maximumManualAttempts != null) {
    conditions.push(lte(manualAttemptCount(), input.maximumManualAttempts));
  }
  if (input.gap === "previous" || input.gap === "between") {
    conditions.push(previousEpisodePresent());
  }
  if (input.gap === "next" || input.gap === "between") {
    conditions.push(nextEpisodePresent());
  }
  return conditions;
}

export function registerMissingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/missing/episodes", async (request, reply) => {
    const query = parse(reply, listQuerySchema, request.query);
    if (!query.ok) return;
    const where = and(...missingConditions(query.data));
    const total =
      ctx.db
        .select({ value: count() })
        .from(episodes)
        .innerJoin(series, eq(episodes.seriesId, series.id))
        .where(where)
        .get()?.value ?? 0;
    const rows = ctx.db
      .select({
        id: episodes.id,
        seriesId: episodes.seriesId,
        seriesTitle: series.title,
        seriesYear: series.year,
        seasonNumber: episodes.seasonNumber,
        episodeNumber: episodes.episodeNumber,
        episodeTitle: episodes.title,
        airDateUtc: episodes.airDateUtc,
        manualAttempts: manualAttemptCount(),
        previousEpisodePresent: previousEpisodePresent(),
        nextEpisodePresent: nextEpisodePresent(),
        huntStateId: huntState.id,
        manualPriority: huntState.manualPriority,
      })
      .from(episodes)
      .innerJoin(series, eq(episodes.seriesId, series.id))
      .leftJoin(
        huntState,
        and(
          eq(huntState.source, "sonarr"),
          eq(huntState.targetKind, "episode"),
          eq(huntState.targetId, episodes.id),
        ),
      )
      .where(where)
      .orderBy(desc(episodes.airDateUtc), desc(episodes.id))
      .limit(query.data.pageSize)
      .offset(pageOffset(query.data.page, query.data.pageSize))
      .all();
    const inFlight = inFlightHuntStateIds(ctx);
    const items: MissingEpisodeItem[] = rows.flatMap((row) =>
      row.airDateUtc == null
        ? []
        : [
            {
              id: row.id,
              seriesId: row.seriesId,
              seriesTitle: row.seriesTitle,
              seriesYear: row.seriesYear,
              seasonNumber: row.seasonNumber,
              episodeNumber: row.episodeNumber,
              episodeTitle: row.episodeTitle,
              airDateUtc: row.airDateUtc,
              manualAttempts: row.manualAttempts,
              previousEpisodePresent: Boolean(row.previousEpisodePresent),
              nextEpisodePresent: Boolean(row.nextEpisodePresent),
              queued: (row.manualPriority ?? 0) > 0,
              searching: row.huntStateId != null && inFlight.has(row.huntStateId),
            },
          ],
    );
    const yearValue = sql<number>`CAST(strftime('%Y', ${episodes.airDateUtc} / 1000, 'unixepoch') AS INTEGER)`;
    const availableYears = ctx.db
      .select({ year: yearValue, count: count() })
      .from(episodes)
      .innerJoin(series, eq(episodes.seriesId, series.id))
      .where(and(...missingConditions({ ...query.data, year: undefined })))
      .groupBy(yearValue)
      .orderBy(desc(yearValue))
      .all();
    const response: MissingEpisodesResponse = {
      items,
      page: query.data.page,
      pageSize: query.data.pageSize,
      total,
      minimumAgeDays: query.data.minimumAgeDays,
      availableYears,
    };
    return response;
  });

  app.post("/api/missing/force", async (request, reply) => {
    const body = parse(reply, forceSchema, request.body);
    if (!body.ok) return;
    if (!ctx.services.sonarr) return serviceUnavailable(reply, "sonarr is not configured");
    const cutoff = Date.now() - MINIMUM_AGE_DAYS * DAY_MS;
    const eligible = ctx.db
      .select({ id: episodes.id })
      .from(episodes)
      .innerJoin(series, eq(episodes.seriesId, series.id))
      .where(
        and(
          inArray(episodes.id, [...new Set(body.data.episodeIds)]),
          eq(episodes.hasFile, false),
          eq(episodes.monitored, true),
          eq(series.monitored, true),
          isNotNull(episodes.airDateUtc),
          lte(episodes.airDateUtc, cutoff),
        ),
      )
      .all();
    let accepted = 0;
    for (const episode of eligible) {
      const result = ctx.services.engine.forceSubject({
        source: "sonarr",
        kind: "episode",
        id: episode.id,
        withAiRecheck: false,
        trigger: "missing",
      });
      accepted += result.queuedTargets;
    }
    if (accepted > 0) void ctx.scheduler.trigger("hunt.cycle");
    if (ctx.settings.get().dryRun) {
      const response: MissingForceResponse = dryRunResult(
        `would search ${accepted} missing episode${accepted === 1 ? "" : "s"}`,
      );
      return response;
    }
    const response: MissingForceResponse = { accepted };
    return response;
  });
}
