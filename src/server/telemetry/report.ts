import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { isProviderUsageLimit } from "../../shared/fixer-policy.js";
import { createTelemetryScrubber } from "../../shared/telemetry.js";

const reported = new WeakSet<object>();
const recentErrors = new Map<string, number>();
const REPORT_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_RECENT_ERRORS = 1000;
const scrub = createTelemetryScrubber();
const EXPECTED_FAILURE =
  /dry-run was enabled|auto-apply was disabled|shutting down|download is still in progress|no change made/i;

export async function flushErrors(): Promise<void> {
  if (Sentry.isInitialized()) await Sentry.flush(2000);
}

export function setupErrorHandler(app: FastifyInstance): void {
  if (Sentry.isInitialized()) Sentry.setupFastifyErrorHandler(app);
}

export function reportError(error: unknown, tags: { job: string }): void {
  if (!Sentry.isInitialized()) return;
  const message = error instanceof Error ? error.message : String(error);
  if (
    (error instanceof Error && error.name === "AbortError") ||
    isProviderUsageLimit(message) ||
    EXPECTED_FAILURE.test(message)
  )
    return;
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  const signature = JSON.stringify([
    tags.job,
    scrub(error instanceof Error ? error.name : typeof error).slice(0, 200),
    scrub(message).slice(0, 200),
  ]);
  const now = Date.now();
  const lastReport = recentErrors.get(signature);
  if (lastReport !== undefined && now - lastReport < REPORT_COOLDOWN_MS) return;
  recentErrors.delete(signature);
  if (recentErrors.size >= MAX_RECENT_ERRORS) {
    const oldest = recentErrors.keys().next().value;
    if (oldest !== undefined) recentErrors.delete(oldest);
  }
  recentErrors.set(signature, now);
  Sentry.captureException(error, { tags });
}
