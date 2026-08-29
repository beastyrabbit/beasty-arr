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

  it("uses the adaptive large-library hunt profile by default", () => {
    expect(built.ctx.settings.get()).toMatchObject({
      huntTickMinutes: 30,
      maxCommandsPerCycle: 20,
      queueGateEnabled: true,
      queueGateThreshold: 10,
      dubLagDaysDefault: 14,
      releasingSeasonRetryDays: 21,
      movieRetryDays: 30,
      budgetSafetyPct: 0.2,
      budgetHorizonHours: 12,
      budgetTrickleMinPerHour: 1,
      budgetPacingHorizonHours: 24,
      budgetBurstMaxDivisor: 24,
      aiProvider: "codex",
      aiModel: "gpt-5.6-terra",
      fixerParallelism: 5,
      fixerAutoRun: false,
    });
  });
});

describe("settings persistence", () => {
  it("reloads saved AI and Fixer settings from SQLite after a restart", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "beasty-arr-settings-"));
    const first = await buildApp({
      env: { NODE_ENV: "production", LOG_LEVEL: "error" },
      dataDir,
      serveStatic: false,
      registerJobs: false,
    });
    first.ctx.settings.update({
      aiModel: "gpt-5.6-sol",
      aiThinkingLevel: "xhigh",
      fixerParallelism: 8,
      fixerAutoRun: true,
      aiMaxChecksPerDay: 42,
    });
    await first.app.close();

    const reopened = await buildApp({
      env: { NODE_ENV: "production", LOG_LEVEL: "error" },
      dataDir,
      serveStatic: false,
      registerJobs: false,
    });
    expect(reopened.ctx.settings.get()).toMatchObject({
      aiModel: "gpt-5.6-sol",
      aiThinkingLevel: "xhigh",
      fixerParallelism: 8,
      fixerAutoRun: true,
      aiMaxChecksPerDay: 42,
    });
    await reopened.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("automatic Fixer scheduling", () => {
  it("registers the job and starts a skip-analyzed cycle when enabled", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "beasty-arr-fixer-auto-"));
    const scheduled = await buildApp({
      env: {
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        SONARR_URL: undefined,
        SONARR_API_KEY: undefined,
        RADARR_URL: undefined,
        RADARR_API_KEY: undefined,
      },
      dataDir,
      serveStatic: false,
      registerJobs: true,
    });
    scheduled.ctx.settings.update({ fixerAutoRun: true });

    expect(scheduled.ctx.scheduler.status().map((job) => job.name)).toContain("fixer.auto");
    expect(await scheduled.ctx.scheduler.trigger("fixer.auto")).toBe(true);
    expect(scheduled.ctx.services.fixerBulk.getStatus()).toMatchObject({
      running: false,
      total: 0,
    });

    await scheduled.app.close();
    rmSync(dataDir, { recursive: true, force: true });
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
