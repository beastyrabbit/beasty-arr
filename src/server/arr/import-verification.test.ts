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

  it("keeps the leftovers when dry-run was enabled while the import ran", async () => {
    const onRemaining = vi.fn(async () => "removed" as const);

    const result = await verifyManualImport({
      serviceName: "Sonarr",
      commandId: 9,
      downloadId: "pack",
      getCommand: async () => ({ status: "completed" }),
      getQueueDownloadIds: async () => new Set(["pack"]),
      onRemaining,
      mayMutate: () => false,
      attempts: 1,
      intervalMs: 0,
    });

    expect(onRemaining).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("stay in the queue for review");
  });

  it("backs off between polls up to the interval cap", async () => {
    vi.useFakeTimers();
    try {
      const getCommand = vi.fn(async () => ({ status: "started" }));
      const done = verifyManualImport({
        serviceName: "Radarr",
        commandId: 11,
        downloadId: "movie",
        getCommand,
        getQueueDownloadIds: async () => new Set(["movie"]),
        attempts: 6,
        intervalMs: 1_000,
      });
      // Delays 1 s, 2 s, 4 s, then 5 s twice (capped): 17 s before the sixth poll.
      await vi.advanceTimersByTimeAsync(16_999);
      expect(getCommand).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).ok).toBe(false);
      expect(getCommand).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
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

describe("verifyManualImport leftovers", () => {
  it("removes leftover rows once the command completes and keeps polling until they clear", async () => {
    const queues = [new Set(["download-3"]), new Set(["download-3"]), new Set<string>()];
    const onRemaining = vi.fn(async () => "removed" as const);

    const result = await verifyManualImport({
      serviceName: "Sonarr",
      commandId: 9,
      downloadId: "download-3",
      getCommand: async () => ({ status: "completed" }),
      getQueueDownloadIds: async () => queues.shift() ?? new Set(),
      onRemaining,
      attempts: 3,
      intervalMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("non-upgrade files were removed");
    expect(onRemaining).toHaveBeenCalledTimes(1);
  });

  it("accepts a completed partial import when the leftovers are kept for review", async () => {
    const result = await verifyManualImport({
      serviceName: "Sonarr",
      commandId: 10,
      downloadId: "download-4",
      getCommand: async () => ({ status: "completed" }),
      getQueueDownloadIds: async () => new Set(["download-4"]),
      onRemaining: async () => "kept",
      attempts: 1,
      intervalMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("stay in the queue for review");
  });
});
