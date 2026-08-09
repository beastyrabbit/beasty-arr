import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "./index.js";

const log = {
  error: () => {},
} as unknown as FastifyBaseLogger;

afterEach(() => {
  vi.useRealTimers();
});

describe("Scheduler", () => {
  it("applies an updated interval without restarting the process", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler(log);
    const run = vi.fn(async () => {});
    scheduler.registerJob({ name: "hunt.cycle", intervalMs: 60_000, jitter: 0, run });

    expect(scheduler.updateInterval("hunt.cycle", 2_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("returns false for an unknown job", () => {
    const scheduler = new Scheduler(log);
    expect(scheduler.updateInterval("missing", 1_000)).toBe(false);
    scheduler.stop();
  });
});
