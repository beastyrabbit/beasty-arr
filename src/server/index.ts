import { buildApp } from "./app.js";
import { schema } from "./db/index.js";

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

// First boot: populate the mirror right away instead of waiting for the nightly job.
const mirrorEmpty =
  ctx.db.select({ id: schema.series.id }).from(schema.series).limit(1).all().length === 0 &&
  ctx.db.select({ id: schema.movies.id }).from(schema.movies).limit(1).all().length === 0;
if (mirrorEmpty) {
  void ctx.services.sync
    .fullReconcile()
    .catch((err) => app.log.error({ err }, "initial full sync failed"));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
