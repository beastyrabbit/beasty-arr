import { expect, it, vi } from "vitest";
import { drainWithin } from "./lifecycle.js";

it("waits for work to finish and rejects a bounded drain without running the close continuation", async () => {
  vi.useFakeTimers();
  try {
    const close = vi.fn();
    let release = () => {};
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draining = drainWithin(work, 1000).then(close);
    expect(close).not.toHaveBeenCalled();
    release();
    await draining;
    expect(close).toHaveBeenCalledOnce();
    const timeout = expect(drainWithin(new Promise(() => {}), 1000)).rejects.toThrow(
      "shutdown deadline",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await timeout;
  } finally {
    vi.useRealTimers();
  }
});
