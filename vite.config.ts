import { readFileSync } from "node:fs";
import path from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageVersion = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      telemetry: false,
      sourcemaps: { disable: "disable-upload" },
      release: {
        name: `beasty-arr@${packageVersion}`,
        create: false,
        finalize: false,
        inject: false,
      },
    }),
  ],
  define: { __APP_VERSION__: JSON.stringify(packageVersion) },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src/web") },
  },
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: "hidden" },
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
    },
  },
});
