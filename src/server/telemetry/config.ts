import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClientConfig } from "../../shared/telemetry.js";

const version = (
  JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  }
).version;
export const RELEASE = `beasty-arr@${version}`;
const DOMAIN = /^[a-z\d.-]+$/;
const PROJECT_PATH = /^\/\d+$/;
const TRAILING_SLASH = /\/$/;

export function ignoreIncomingRequest(urlPath: string): boolean {
  const pathname = urlPath.split("?", 1)[0];
  return pathname === "/api/health" || pathname === "/api/events";
}

function publicUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

export function telemetryConfig(env: NodeJS.ProcessEnv): ClientConfig {
  // pnpm dev can inherit the production secret set; it must never emit telemetry.
  if (env.NODE_ENV !== "production") return { umami: null, glitchtip: null };
  const origin = publicUrl(env.UMAMI_URL);
  const domains = (env.UMAMI_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => DOMAIN.test(domain));
  const dsn = env.GLITCHTIP_DSN;
  let validDsn = false;
  try {
    const url = new URL(dsn ?? "");
    validDsn =
      ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.username) &&
      !url.password &&
      PROJECT_PATH.test(url.pathname) &&
      !url.search &&
      !url.hash;
  } catch {
    /* Invalid optional telemetry disables that integration. */
  }
  return {
    umami:
      origin && env.UMAMI_WEBSITE_ID && domains.length
        ? {
            src: `${origin.toString().replace(TRAILING_SLASH, "")}/script.js`,
            websiteId: env.UMAMI_WEBSITE_ID,
            domains,
          }
        : null,
    glitchtip:
      validDsn && dsn
        ? {
            dsn,
            environment: env.GLITCHTIP_ENVIRONMENT || "production",
            release: RELEASE,
            tracesSampleRate: 0.1,
          }
        : null,
  };
}
