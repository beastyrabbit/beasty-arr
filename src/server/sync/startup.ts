import { isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

type StartupSources = {
  sonarr: boolean;
  radarr: boolean;
};

type FullReconciler = {
  fullReconcile(): Promise<void>;
};

/**
 * Populate an empty mirror, or backfill metadata introduced by a schema upgrade.
 * Returns whether a reconcile ran so upgrade behavior can be verified directly.
 */
export async function reconcileMirrorOnStartup(
  db: Db,
  sync: FullReconciler,
  sources: StartupSources,
): Promise<boolean> {
  const mirrorEmpty =
    db.select({ id: schema.series.id }).from(schema.series).limit(1).all().length === 0 &&
    db.select({ id: schema.movies.id }).from(schema.movies).limit(1).all().length === 0;
  const mirrorNeedsSlugBackfill =
    (sources.sonarr &&
      db
        .select({ id: schema.series.id })
        .from(schema.series)
        .where(isNull(schema.series.titleSlug))
        .limit(1)
        .all().length > 0) ||
    (sources.radarr &&
      db
        .select({ id: schema.movies.id })
        .from(schema.movies)
        .where(isNull(schema.movies.titleSlug))
        .limit(1)
        .all().length > 0);

  if (!mirrorEmpty && !mirrorNeedsSlugBackfill) return false;
  await sync.fullReconcile();
  return true;
}
