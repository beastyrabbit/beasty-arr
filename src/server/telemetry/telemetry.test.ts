// biome-ignore-all lint/security/noSecrets: Synthetic credentials exercise scrubbing, not real accounts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryScrubber } from "../../shared/telemetry.js";
import { buildApp } from "../app.js";
import { registerTelemetryRoutes } from "../http/routes/telemetry.js";
import { Scheduler } from "../scheduler/index.js";
import { RELEASE, telemetryConfig } from "./config.js";
import { reportError, setupErrorHandler } from "./report.js";

const env = {
  NODE_ENV: "production",
  UMAMI_URL: "https://analytics.example",
  UMAMI_WEBSITE_ID: "fixture-website",
  UMAMI_DOMAINS: "app.example",
  GLITCHTIP_DSN: "https://public@errors.example/1",
} as const;

afterEach(async () => {
  await Sentry.close();
  Sentry.getCurrentScope().setClient(undefined);
});

describe("runtime config", () => {
  it("is disabled by default, in development with inherited production values, and with invalid config", () => {
    expect(telemetryConfig({})).toEqual({ umami: null, glitchtip: null });
    expect(telemetryConfig({ ...env, NODE_ENV: "development" })).toEqual({
      umami: null,
      glitchtip: null,
    });
    expect(
      telemetryConfig({
        ...env,
        UMAMI_URL: "https://user:pass@analytics.example",
        GLITCHTIP_DSN: "invalid",
      }),
    ).toEqual({ umami: null, glitchtip: null });
    expect(telemetryConfig({ ...env, UMAMI_DOMAINS: "" }).umami).toBeNull();
    expect(telemetryConfig({ ...env, UMAMI_DOMAINS: undefined }).umami).toBeNull();
    expect(telemetryConfig({ ...env, UMAMI_URL: undefined }).umami).toBeNull();
    expect(telemetryConfig({ ...env, UMAMI_WEBSITE_ID: undefined }).umami).toBeNull();
    expect(telemetryConfig(env).glitchtip).toMatchObject({
      release: RELEASE,
      environment: "production",
      tracesSampleRate: 0.1,
    });
    expect(
      telemetryConfig({ ...env, GLITCHTIP_ENVIRONMENT: "fixture" }).glitchtip?.environment,
    ).toBe("fixture");
  });

  it("returns only public config through the real app", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "beasty-config-"));
    const { app } = await buildApp({
      env: { ...env, LOG_LEVEL: "error" },
      dataDir,
      registerJobs: false,
      serveStatic: false,
    });
    try {
      const response = await app.inject("/api/client-config");
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(telemetryConfig(env));
      expect(Object.keys(response.json())).toEqual(["umami", "glitchtip"]);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns null integrations without configuration", async () => {
    const app = Fastify();
    registerTelemetryRoutes(app, { NODE_ENV: "production" });
    try {
      expect((await app.inject("/api/client-config")).json()).toEqual({
        umami: null,
        glitchtip: null,
      });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

it("sends route failures and tagged background failures through a fake Sentry transport", async () => {
  const envelopes: unknown[] = [];
  Sentry.init({
    dsn: env.GLITCHTIP_DSN,
    release: RELEASE,
    environment: "fixture",
    sendDefaultPii: false,
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    integrations: [Sentry.fastifyIntegration()],
    beforeSend: createTelemetryScrubber(["fixture-arr-secret"]),
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  const app = Fastify();
  setupErrorHandler(app);
  app.get("/boom", () => {
    throw new Error("route fixture-arr-secret person@example.com");
  });
  await app.inject("/boom?token=capability");
  const error = new Error("background fixture-arr-secret");
  const scheduler = new Scheduler(app.log);
  scheduler.registerJob({
    name: "fixture.backup",
    intervalMs: 60_000,
    run: async () => {
      throw error;
    },
  });
  await scheduler.trigger("fixture.backup");
  scheduler.stop();
  reportError(error, { job: "duplicate" });
  reportError(new Error("Provider usage limit reached"), { job: "expected" });
  await Sentry.flush(1000);
  await app.close();
  const serialized = JSON.stringify(envelopes);
  expect(serialized).toContain('"job":"fixture.backup"');
  expect(serialized).toContain(RELEASE);
  expect(serialized).toContain('"environment":"fixture"');
  expect(serialized).not.toMatch(
    /fixture-arr-secret|person@example.com|capability|duplicate|Provider usage limit/,
  );
  expect(envelopes).toHaveLength(2);
});
