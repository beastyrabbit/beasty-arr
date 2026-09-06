import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { buildApp } from "./app.js";
import { drainWithin } from "./lifecycle.js";
import { reconcileMirrorOnStartup } from "./sync/startup.js";

if (existsSync(".env")) loadEnvFile(".env");

const { app, ctx } = await buildApp();
let startup: Promise<unknown> = Promise.resolve();
app.addHook("preClose", async () => {
  await drainWithin(startup);
});

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
startup = reconcileMirrorOnStartup(ctx.db, ctx.services.sync, {
  sonarr: Boolean(ctx.env.SONARR_URL && ctx.env.SONARR_API_KEY),
  radarr: Boolean(ctx.env.RADARR_URL && ctx.env.RADARR_API_KEY),
}).catch((err) => app.log.error({ err }, "startup full sync failed"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(
      () => process.exit(0),
      (error) => {
        app.log.error(error, "shutdown drain failed");
        process.exit(1);
      },
    );
  });
}
