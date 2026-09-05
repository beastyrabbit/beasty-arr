import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ArrSource } from "../../shared/domain.js";
import type { Db, SqliteHandle } from "../db/index.js";
import { huntState, searchAttempts, statsDaily } from "../db/schema.js";

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Upserts today's per-source state counts + search spend into stats_daily. */
export function snapshotDailyStats(db: Db, now: number = Date.now()): void {
  const date = utcDate(now);
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  for (const source of ["sonarr", "radarr"] as ArrSource[]) {
    const stateCounts = db
      .select({ state: huntState.state, count: sql<number>`count(*)` })
      .from(huntState)
      .where(eq(huntState.source, source))
      .groupBy(huntState.state)
      .all();
    const byState = new Map(stateCounts.map((r) => [r.state, r.count]));
    const attempts = db
      .select({
        count: sql<number>`count(*)`,
        queries: sql<number>`coalesce(sum(case when dry_run = 0 then estimated_queries else 0 end), 0)`,
      })
      .from(searchAttempts)
      .where(and(eq(searchAttempts.source, source), gte(searchAttempts.createdAt, dayStart)))
      .get();
    const row = {
      date,
      source,
      german: byState.get("german") ?? 0,
      nonGerman: byState.get("non_german") ?? 0,
      missing: byState.get("missing") ?? 0,
      unreleased: byState.get("unreleased") ?? 0,
      aiPaused: byState.get("ai_paused") ?? 0,
      exhausted: byState.get("exhausted") ?? 0,
      searchesRun: attempts?.count ?? 0,
      queriesSpent: attempts?.queries ?? 0,
    };
    db.insert(statsDaily)
      .values(row)
      .onConflictDoUpdate({ target: [statsDaily.date, statsDaily.source], set: row })
      .run();
  }
}

/**
 * Nightly consistent copy via VACUUM INTO so every Longhorn snapshot contains
 * at least one backup that is valid regardless of WAL state.
 */
export function backupDatabase(
  sqlite: SqliteHandle,
  dataDir: string,
  log: FastifyBaseLogger,
): void {
  const backupDir = path.join(dataDir, "backup");
  mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, "beasty-arr.db");
  const temporary = path.join(backupDir, `.${randomUUID()}.db`);
  try {
    sqlite.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  log.info({ target }, "sqlite backup written");
}
