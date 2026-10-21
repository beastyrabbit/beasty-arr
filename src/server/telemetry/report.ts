import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { isProviderUsageLimit } from "../../shared/fixer-policy.js";

const reported = new WeakSet<object>();
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
  Sentry.captureException(error, { tags });
}
