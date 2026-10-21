import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { buildApp } from "./app.js";
import { drainWithin } from "./lifecycle.js";
import { reconcileMirrorOnStartup } from "./sync/startup.js";
import { flushErrors, reportError } from "./telemetry/report.js";

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
  reportError(error, { job: "startup" });
  app.log.error(error);
  await flushErrors();
  process.exit(1);
}

// Populate a new mirror immediately. A schema upgrade that introduces mirrored
// metadata also gets one immediate reconcile instead of waiting for the nightly job.
startup = reconcileMirrorOnStartup(ctx.db, ctx.services.sync, {
  sonarr: Boolean(ctx.env.SONARR_URL && ctx.env.SONARR_API_KEY),
  radarr: Boolean(ctx.env.RADARR_URL && ctx.env.RADARR_API_KEY),
}).catch((err) => {
  reportError(err, { job: "sync.startup" });
  app.log.error({ err }, "startup full sync failed");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(
      async () => {
        await flushErrors();
        process.exit(0);
      },
      async (error) => {
        reportError(error, { job: "shutdown" });
        app.log.error(error, "shutdown drain failed");
        await flushErrors();
        process.exit(1);
      },
    );
  });
}
