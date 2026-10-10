import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sse } from "./events.js";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  /** What a browser does on a non-200 reply: fail the connection for good. */
  failPermanently(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  /** A network drop: the browser keeps the source and retries itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

describe("SSE client reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.instances = [];
  });
  afterEach(() => {
    sse.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens a new source after a reply that closed the old one", () => {
    const reconnected = vi.fn();
    const off = sse.onReconnect(reconnected);
    sse.connect();
    FakeEventSource.instances[0]?.open();

    FakeEventSource.instances[0]?.failPermanently();
    expect(sse.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(1_000);

    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]?.open();
    expect(sse.getStatus()).toBe("live");
    expect(reconnected).toHaveBeenCalledOnce();
    off();
  });

  it("backs off and keeps the down status while retrying", () => {
    sse.connect();
    for (const delay of [1_000, 2_000, 4_000]) {
      FakeEventSource.instances.at(-1)?.failPermanently();
      vi.advanceTimersByTime(delay - 1);
      const before = FakeEventSource.instances.length;
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(before + 1);
    }
    expect(sse.getStatus()).toBe("down");
  });

  it("leaves network drops to the browser's own retry", () => {
    sse.connect();
    FakeEventSource.instances[0]?.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
