import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let testDir: string;
let built: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  testDir = mkdtempSync(path.join(tmpdir(), "beasty-arr-test-"));
  built = await buildApp({
    env: { NODE_ENV: "test", APP_API_KEY: "test-key-0123456789abcdef", LOG_LEVEL: "error" },
    dataDir: testDir,
    serveStatic: false,
  });
});

afterAll(async () => {
  await built.app.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("app skeleton", () => {
  it("serves unauthenticated health with no extra fields", async () => {
    const res = await built.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects unauthenticated API access", async () => {
    const res = await built.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the app API key header", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { "x-api-key": "test-key-0123456789abcdef" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ via: "api-key" });
  });

  it("logs in with the key and gets a session cookie", async () => {
    const login = await built.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { apiKey: "test-key-0123456789abcdef" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "beasty_session");
    expect(cookie).toBeDefined();
    const me = await built.app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { beasty_session: cookie?.value ?? "" },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ via: "session" });
  });

  it("rejects a wrong login and rate-limits", async () => {
    const bad = await built.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { apiKey: "wrong" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("has dry-run enabled by default", () => {
    expect(built.ctx.settings.get().dryRun).toBe(true);
  });
});
