import { describe, expect, it, vi } from "vitest";
import { arrFetch, type FetchImpl, isRetryableStatus } from "./http-util.js";

function response(status: number, body = ""): Response {
  // Response() forbids some status codes (1xx); all used here are valid.
  return new Response(body, { status, statusText: `status-${status}` });
}

const fastOpts = { retryDelayMs: 0 };

describe("isRetryableStatus", () => {
  it("marks 408, 429, and 5xx retryable and 2xx/4xx not", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("arrFetch", () => {
  it("returns the first successful response without retrying", async () => {
    const fetchMock = vi.fn(async () => response(200, "ok"));

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, ...fastOpts },
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes method, headers, and a timeout signal through to fetch", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => response(200));

    await arrFetch(
      "http://arr.local/api",
      { method: "POST", headers: { "X-Api-Key": "k" }, body: "{}" },
      { fetchImpl: fetchMock, ...fastOpts },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://arr.local/api");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "X-Api-Key": "k" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries retryable statuses and returns the eventual success", async () => {
    const fetchMock = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, "ok"));

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, ...fastOpts },
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured retries and returns the last response", async () => {
    const fetchMock = vi.fn(async () => response(500));

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, ...fastOpts },
    );

    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries (default)
  });

  it("does not retry non-retryable statuses", async () => {
    const fetchMock = vi.fn(async () => response(404));

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, ...fastOpts },
    );

    expect(result.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and succeeds when the connection recovers", async () => {
    const fetchMock = vi
      .fn<FetchImpl>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(200, "ok"));

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, ...fastOpts },
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the last network error once retries are exhausted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      arrFetch("http://arr.local/api", {}, { fetchImpl: fetchMock, retries: 1, ...fastOpts }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a custom retry count of zero", async () => {
    const fetchMock = vi.fn(async () => response(500));

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, retries: 0, ...fastOpts },
    );

    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a hanging request after timeoutMs and retries it", async () => {
    let hangs = 0;
    const fetchMock = vi.fn<FetchImpl>((_url, init) => {
      hangs += 1;
      if (hangs <= 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        });
      }
      return Promise.resolve(response(200, "ok"));
    });

    const result = await arrFetch(
      "http://arr.local/api",
      {},
      { fetchImpl: fetchMock, timeoutMs: 20, ...fastOpts },
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects with a timeout error when every attempt hangs", async () => {
    const fetchMock = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    );

    await expect(
      arrFetch(
        "http://arr.local/api",
        {},
        { fetchImpl: fetchMock, timeoutMs: 10, retries: 1, ...fastOpts },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the caller's own signal aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    );

    const pending = arrFetch(
      "http://arr.local/api",
      { signal: controller.signal },
      { fetchImpl: fetchMock, ...fastOpts },
    );
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow("caller cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("does not replay a mutation accepted before its response was lost", async () => {
  const accepted: string[] = [];
  const transport: FetchImpl = async (_url, init) => {
    accepted.push(String(init?.body));
    throw new Error("response lost");
  };
  await expect(
    arrFetch(
      "http://arr.test/command",
      { method: "POST", body: "{}" },
      { fetchImpl: transport, retries: 3, retryDelayMs: 0 },
    ),
  ).rejects.toThrow("response lost");
  expect(accepted).toHaveLength(1);
});
