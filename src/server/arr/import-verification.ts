import type { ApplyResult } from "../../shared/fixer-types.js";
import type { ArrCommandResource } from "./sonarr-client.js";

export interface ImportVerificationInput {
  serviceName: "Sonarr" | "Radarr";
  commandId?: number;
  downloadId?: string;
  getCommand: (id: number) => Promise<ArrCommandResource>;
  getQueueDownloadIds: () => Promise<Set<string>>;
  attempts?: number;
  intervalMs?: number;
}

const TERMINAL_FAILURES = new Set(["aborted", "failed", "unsuccessful"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyManualImport(input: ImportVerificationInput): Promise<ApplyResult> {
  const attempts = input.attempts ?? 20;
  const intervalMs = input.intervalMs ?? 500;

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const command =
        input.commandId === undefined ? undefined : await input.getCommand(input.commandId);
      const status = command?.status?.trim().toLowerCase();
      const commandResult = command?.result?.trim().toLowerCase();
      if (
        (status && TERMINAL_FAILURES.has(status)) ||
        (commandResult && TERMINAL_FAILURES.has(commandResult))
      ) {
        return {
          ok: false,
          commandId: input.commandId,
          message: `${input.serviceName} ManualImport ${commandResult ?? status}: ${command?.message ?? "no error detail was returned"}.`,
        };
      }

      const queueIds = await input.getQueueDownloadIds();
      const commandCompleted = input.commandId === undefined || status === "completed";
      const downloadCleared = !input.downloadId || !queueIds.has(input.downloadId);
      if (commandCompleted && downloadCleared) {
        return {
          ok: true,
          commandId: input.commandId,
          message: `${input.serviceName} completed the ManualImport and removed the download from its queue.`,
        };
      }

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
