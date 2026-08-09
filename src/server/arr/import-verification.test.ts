import { describe, expect, it, vi } from "vitest";
import { verifyManualImport } from "./import-verification.js";

describe("verifyManualImport", () => {
  it("waits for both command completion and queue removal", async () => {
    const getCommand = vi
      .fn()
      .mockResolvedValueOnce({ status: "started" })
      .mockResolvedValueOnce({ status: "completed" });
    const getQueueDownloadIds = vi
      .fn()
      .mockResolvedValueOnce(new Set(["download-1"]))
      .mockResolvedValueOnce(new Set());

    const result = await verifyManualImport({
      serviceName: "Sonarr",
      commandId: 7,
      downloadId: "download-1",
      getCommand,
      getQueueDownloadIds,
      attempts: 2,
      intervalMs: 0,
    });

    expect(result).toMatchObject({ ok: true, commandId: 7 });
    expect(getCommand).toHaveBeenCalledTimes(2);
    expect(getQueueDownloadIds).toHaveBeenCalledTimes(2);
  });

  it("reports a failed command instead of treating acceptance as success", async () => {
    const result = await verifyManualImport({
      serviceName: "Radarr",
      commandId: 8,
      downloadId: "download-2",
      getCommand: async () => ({ status: "failed", message: "Import rejected" }),
      getQueueDownloadIds: async () => new Set(),
      attempts: 1,
      intervalMs: 0,
    });

    expect(result).toMatchObject({ ok: false, commandId: 8 });
    expect(result.message).toContain("Import rejected");
  });

  it("reports an unsuccessful completed command as a failure", async () => {
    const result = await verifyManualImport({
      serviceName: "Sonarr",
      commandId: 10,
      downloadId: "download-4",
      getCommand: async () => ({
        status: "completed",
        result: "unsuccessful",
        message: "File was not imported",
      }),
      getQueueDownloadIds: async () => new Set(),
      attempts: 1,
      intervalMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("File was not imported");
  });

  it("fails when the command completes but the download remains queued", async () => {
    const result = await verifyManualImport({
      serviceName: "Sonarr",
      commandId: 9,
      downloadId: "download-3",
      getCommand: async () => ({ status: "completed" }),
      getQueueDownloadIds: async () => new Set(["download-3"]),
      attempts: 1,
      intervalMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not complete and leave the queue");
  });
});
