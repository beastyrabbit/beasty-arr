import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { isNull } from "drizzle-orm";
import { buildApp } from "./app.js";
import { schema } from "./db/index.js";

if (existsSync(".env")) loadEnvFile(".env");

const { app, ctx } = await buildApp();

const port = ctx.env.API_PORT ?? ctx.env.PORT;
try {
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(
    { dryRun: ctx.settings.get().dryRun, dataDir: ctx.env.DATA_DIR },
    "beasty-arr started",
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Populate a new mirror immediately. A schema upgrade that introduces mirrored
// metadata also gets one immediate reconcile instead of waiting for the nightly job.
const mirrorEmpty =
  ctx.db.select({ id: schema.series.id }).from(schema.series).limit(1).all().length === 0 &&
  ctx.db.select({ id: schema.movies.id }).from(schema.movies).limit(1).all().length === 0;
const mirrorNeedsSlugBackfill =
  (Boolean(ctx.env.SONARR_URL && ctx.env.SONARR_API_KEY) &&
    ctx.db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(isNull(schema.series.titleSlug))
      .limit(1)
      .all().length > 0) ||
  (Boolean(ctx.env.RADARR_URL && ctx.env.RADARR_API_KEY) &&
    ctx.db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(isNull(schema.movies.titleSlug))
      .limit(1)
      .all().length > 0);
if (mirrorEmpty || mirrorNeedsSlugBackfill) {
  void ctx.services.sync
    .fullReconcile()
    .catch((err) => app.log.error({ err }, "startup full sync failed"));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
