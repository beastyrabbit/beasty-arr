import { buildApp } from "../dist/server/server/app.js";

const { app } = await buildApp({ registerJobs: false });
await app.listen({ port: Number(process.env.PORT), host: "127.0.0.1" });
process.on("SIGTERM", () => void app.close().then(() => process.exit(0)));
