import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import * as Sentry from "@sentry/node";
import { createTelemetryScrubber } from "../shared/telemetry.js";
import { ignoreIncomingRequest, telemetryConfig } from "./telemetry/config.js";

const SECRET_ENV_NAME = /API_KEY|TOKEN|SECRET|PASSWORD/;
if (existsSync(".env")) loadEnvFile(".env");
const config = telemetryConfig(process.env).glitchtip;
if (config) {
  const scrub = createTelemetryScrubber(
    Object.entries(process.env)
      .filter(([name]) => SECRET_ENV_NAME.test(name))
      .map(([, value]) => value ?? ""),
  );
  Sentry.init({
    ...config,
    sendDefaultPii: false,
    sendClientReports: false,
    traceLifecycle: "static",
    // Explicit integrations avoid capturing AI prompts, subprocess arguments, or local variables.
    defaultIntegrations: false,
    integrations: [
      Sentry.httpIntegration({ ignoreIncomingRequests: ignoreIncomingRequest }),
      Sentry.nativeNodeFetchIntegration(),
      Sentry.fastifyIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
    ],
    tracePropagationTargets: [],
    beforeSend: (event) => scrub(event),
    beforeSendTransaction: (event) => scrub(event),
    beforeSendSpan: (span) => scrub(span),
    beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
  });
}
