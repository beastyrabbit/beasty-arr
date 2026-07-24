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
    env: { NODE_ENV: "production", LOG_LEVEL: "error" },
    dataDir: testDir,
    serveStatic: false,
    registerJobs: false,
  });
});

afterAll(async () => {
  await built.app.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("app skeleton", () => {
  it("serves health with no extra fields", async () => {
    const res = await built.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("serves the API without credentials, including to remote peers", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not expose application login routes", async () => {
    const res = await built.app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("has dry-run enabled by default", () => {
    expect(built.ctx.settings.get().dryRun).toBe(true);
  });
});

describe("development safety", () => {
  it("restores dry-run when a development process opens a database saved in live mode", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "beasty-arr-dev-safety-"));
    const production = await buildApp({
      env: { NODE_ENV: "production", LOG_LEVEL: "error" },
      dataDir,
      serveStatic: false,
      registerJobs: false,
    });
    production.ctx.settings.update({ dryRun: false });
    await production.app.close();

    const development = await buildApp({
      env: { NODE_ENV: "development", LOG_LEVEL: "error" },
      dataDir,
      serveStatic: false,
      registerJobs: false,
    });
    expect(development.ctx.settings.get().dryRun).toBe(true);
    await development.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
