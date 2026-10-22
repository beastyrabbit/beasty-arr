import { readFileSync } from "node:fs";
import path from "node:path";

/** Read once at module load; cwd is the repo root (dev) or /app (container). */
export const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
