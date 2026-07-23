import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, buildQueryString, configureApi } from "./api.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  configureApi({ onUnauthorized: null, fetchFn: (...args) => fetch(...args) });
});

describe("api client", () => {
  it("parses JSON on success", async () => {
    configureApi({ fetchFn: vi.fn(async () => jsonResponse(200, { ok: true })) });
    await expect(api.get<{ ok: boolean }>("/api/status")).resolves.toEqual({ ok: true });
  });

  it("fires onUnauthorized and throws ApiError(401) on 401", async () => {
    const onUnauthorized = vi.fn();
    configureApi({
      onUnauthorized,
      fetchFn: vi.fn(async () => jsonResponse(401, { error: "unauthorized" })),
    });
    await expect(api.get("/api/dashboard/summary")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onUnauthorized for a failed login itself", async () => {
    const onUnauthorized = vi.fn();
    configureApi({
      onUnauthorized,
      fetchFn: vi.fn(async () => jsonResponse(401, { error: "invalid key" })),
    });
    await expect(api.post("/api/auth/login", { apiKey: "nope" })).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("surfaces the server error message on non-2xx", async () => {
    configureApi({ fetchFn: vi.fn(async () => jsonResponse(422, { error: "bad payload" })) });
    await expect(api.post("/api/config", {})).rejects.toMatchObject({
      status: 422,
      message: "bad payload",
    });
  });

  it("wraps network failures as status 0", async () => {
    configureApi({
      fetchFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(api.get("/api/status")).rejects.toMatchObject({ status: 0 });
  });

  it("serializes arrays as repeated query params and skips empties", () => {
    expect(buildQueryString({ q: "dark", "state[]": ["missing", "german"], page: 2 })).toBe(
      "?q=dark&state%5B%5D=missing&state%5B%5D=german&page=2",
    );
    expect(buildQueryString({ q: "", page: undefined })).toBe("");
    expect(buildQueryString(undefined)).toBe("");
  });
});
