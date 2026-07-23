import { buildApp } from "./app.js";

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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
