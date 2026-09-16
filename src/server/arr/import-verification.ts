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
  attempts?: number;
  intervalMs?: number;
}

const TERMINAL_FAILURES = new Set(["aborted", "failed", "unsuccessful"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const attempts = input.attempts ?? 20;
  const intervalMs = input.intervalMs ?? 500;
  const state: PollState = { remainingHandled: false };

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await pollImport(input, state);
      if (result) return result;
      if (attempt + 1 < attempts && intervalMs > 0) {
        await sleep(intervalMs);
      }
    }
  } catch (error) {
    return {
      ok: false,
      commandId: input.commandId,
      message: `Could not verify the ${input.serviceName} ManualImport: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  return {
    ok: false,
    commandId: input.commandId,
    message: `${input.serviceName} accepted the ManualImport, but it did not complete and leave the queue within the verification window.`,
  };
}
