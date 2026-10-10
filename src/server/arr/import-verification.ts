import type { ApplyResult } from "../../shared/fixer-types.js";
import type { ArrCommandResource } from "./sonarr-client.js";

export interface ImportVerificationInput {
  serviceName: "Sonarr" | "Radarr";
  commandId?: number;
  downloadId?: string;
  getCommand: (id: number) => Promise<ArrCommandResource>;
  getQueueDownloadIds: () => Promise<Set<string>>;
  /**
   * Called once when the command completed but the download is still queued
   * (a partial season-pack import). Return "removed" after removing the
   * leftover download so polling continues until Sonarr drops it, or "kept" to
   * accept the import and leave the remaining rows for a human.
   */
  onRemaining?: () => Promise<"removed" | "kept">;
  /**
   * Checked right before onRemaining. Dry-run or a disabled auto-apply can be
   * switched on while the import runs; the leftovers then stay for review.
   */
  mayMutate?: () => boolean;
  /** Shutdown: stop polling so the drain does not wait for a slow import. */
  signal?: AbortSignal;
  attempts?: number;
  /** First poll delay; it doubles per poll up to MAX_INTERVAL_MS. */
  intervalMs?: number;
}

/** Options the arr clients pass through to verifyManualImport. */
export type ImportVerificationOptions = Pick<ImportVerificationInput, "mayMutate" | "signal">;

const TERMINAL_FAILURES = new Set(["aborted", "failed", "unsuccessful"]);
// 30 polls from 500 ms, capped at 5 s, wait about two minutes: a season pack
// that is copied or moved across filesystems rarely finishes in ten seconds.
const DEFAULT_ATTEMPTS = 30;
const DEFAULT_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 5_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Settles with undefined as soon as the signal aborts. An arr request can hang
 * for its 30 s timeout plus retries; shutdown must not wait for it.
 */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => resolve(undefined);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** The command's failure label when Sonarr/Radarr reports a terminal failure. */
function terminalFailure(command: ArrCommandResource | undefined): string | undefined {
  const status = command?.status?.trim().toLowerCase();
  const result = command?.result?.trim().toLowerCase();
  if ((status && TERMINAL_FAILURES.has(status)) || (result && TERMINAL_FAILURES.has(result))) {
    return result ?? status;
  }
  return undefined;
}

type PollState = { remainingHandled: boolean };

/** One verification poll: a result ends the wait, undefined keeps polling. */
async function pollImport(
  input: ImportVerificationInput,
  state: PollState,
): Promise<ApplyResult | undefined> {
  const command =
    input.commandId === undefined ? undefined : await input.getCommand(input.commandId);
  const failure = terminalFailure(command);
  if (failure) {
    return {
      ok: false,
      commandId: input.commandId,
      message: `${input.serviceName} ManualImport ${failure}: ${command?.message ?? "no error detail was returned"}.`,
    };
  }
  const queueIds = await input.getQueueDownloadIds();
  const commandCompleted =
    input.commandId === undefined || command?.status?.trim().toLowerCase() === "completed";
  if (!commandCompleted) return undefined;
  if (!input.downloadId || !queueIds.has(input.downloadId)) {
    return {
      ok: true,
      commandId: input.commandId,
      message: state.remainingHandled
        ? `${input.serviceName} completed the ManualImport; the remaining non-upgrade files were removed with the download.`
        : `${input.serviceName} completed the ManualImport and removed the download from its queue.`,
    };
  }
  if (input.onRemaining && !state.remainingHandled) {
    state.remainingHandled = true;
    if (input.mayMutate && !input.mayMutate()) {
      return {
        ok: true,
        commandId: input.commandId,
        message: `${input.serviceName} completed the ManualImport. Dry-run or a disabled auto-apply now blocks changes, so the files that were not selected stay in the queue for review.`,
      };
    }
    if ((await input.onRemaining()) === "kept") {
      return {
        ok: true,
        commandId: input.commandId,
        message: `${input.serviceName} completed the ManualImport. Files that were not selected stay in the queue for review.`,
      };
    }
  }
  return undefined;
}

export async function verifyManualImport(input: ImportVerificationInput): Promise<ApplyResult> {
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const state: PollState = { remainingHandled: false };

  try {
    for (let attempt = 0; attempt < attempts && !input.signal?.aborted; attempt += 1) {
      const result = await untilAborted(pollImport(input, state), input.signal);
      if (result) return result;
      if (attempt + 1 < attempts && intervalMs > 0) {
        await sleep(Math.min(MAX_INTERVAL_MS, intervalMs * 2 ** attempt), input.signal);
      }
    }
  } catch (error) {
    return {
      ok: false,
      commandId: input.commandId,
      message: `Could not verify the ${input.serviceName} ManualImport: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  const stopped = input.signal?.aborted
    ? "verification stopped for shutdown"
    : "it did not complete and leave the queue within the verification window";
  return {
    ok: false,
    commandId: input.commandId,
    message: `${input.serviceName} accepted the ManualImport, but ${stopped}; check the ${input.serviceName} queue before retrying.`,
  };
}
