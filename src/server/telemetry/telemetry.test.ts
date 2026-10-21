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
import { drainWithin } from "../lifecycle.js";
import { Scheduler } from "../scheduler/index.js";
import { ignoreIncomingRequest, RELEASE, telemetryConfig } from "./config.js";
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
  it.each([
    "https://public@errors.example/1",
    "https://public@errors.example/glitchtip/1",
    "http://public@errors.example/tools/glitchtip/42",
  ])("accepts a DSN with a numeric project id: %s", (dsn) => {
    expect(telemetryConfig({ ...env, GLITCHTIP_DSN: dsn }).glitchtip?.dsn).toBe(dsn);
  });

  it.each([
    "invalid",
    "ftp://public@errors.example/glitchtip/1",
    "https://errors.example/glitchtip/1",
    "https://public:password@errors.example/glitchtip/1",
    "https://public@errors.example/",
    "https://public@errors.example/glitchtip",
    "https://public@errors.example/glitchtip/project",
    "https://public@errors.example/glitchtip/1/",
    "https://public@errors.example//1",
    "https://public@errors.example/glitchtip//1",
    "https://public@errors.example/glitchtip/1?query=1",
    "https://public@errors.example/glitchtip/1#fragment",
  ])("disables error reporting for an invalid DSN: %s", (dsn) => {
    expect(telemetryConfig({ ...env, GLITCHTIP_DSN: dsn }).glitchtip).toBeNull();
  });

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

it("excludes health probes and SSE from incoming traces, including query strings", () => {
  for (const path of ["/api/health", "/api/events", "/api/health?probe=1", "/api/events?last=1"])
    expect(ignoreIncomingRequest(path)).toBe(true);
  for (const path of ["/api/healthcheck", "/api/events/history", "/api/library", "/hunt"])
    expect(ignoreIncomingRequest(path)).toBe(false);
});

function captureReports() {
  const capture = vi.fn(async () => ({ statusCode: 200 }));
  Sentry.init({
    dsn: env.GLITCHTIP_DSN,
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    transport: () => ({ send: capture, flush: async () => true }),
  });
  return capture;
}

it("reports shutdown drain timeouts while ignoring expected in-flight cancellations", async () => {
  const capture = captureReports();
  await drainWithin(new Promise(() => {}), 1).catch((error) => {
    reportError(error, { job: "shutdown" });
  });
  reportError(new Error("Service is shutting down"), { job: "fixture.cancelled" });
  reportError(new DOMException("Operation aborted", "AbortError"), { job: "fixture.aborted" });
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledOnce();
  const serialized = JSON.stringify(capture.mock.calls);
  expect(serialized).toContain("Background work did not drain before shutdown deadline");
  expect(serialized).toContain('"job":"shutdown"');
});

it("limits fresh errors by job and scrubbed signature for one hour", async () => {
  const capture = captureReports();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const tags = { job: "fixture.cooldown" };
  reportError(new Error("upstream unavailable https://arr.example/?token=first"), tags);
  reportError(new Error("upstream unavailable https://arr.example/?token=second"), tags);
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledTimes(1);
  reportError(new Error("different failure"), tags);
  reportError(new TypeError("different failure"), tags);
  reportError(new Error("different failure"), { job: "fixture.other" });
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledTimes(4);
  now.mockReturnValue(1_000_000 + 59 * 60 * 1000);
  reportError(new Error("upstream unavailable https://arr.example/?token=third"), tags);
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledTimes(4);
  now.mockReturnValue(1_000_000 + 60 * 60 * 1000);
  reportError(new Error("upstream unavailable https://arr.example/?token=fourth"), tags);
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledTimes(5);
});

it("bounds the cooldown cache by evicting old signatures", async () => {
  const capture = captureReports();
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const tags = { job: "fixture.bounded" };
  for (let i = 0; i <= 1000; i++) {
    reportError(new Error(`failure variant${i}end`), tags);
    await Sentry.flush(1000);
  }
  expect(capture).toHaveBeenCalledTimes(1001);
  reportError(new Error("failure variant1000end"), tags);
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledTimes(1001);
  reportError(new Error("failure variant0end"), tags);
  await Sentry.flush(1000);
  expect(capture).toHaveBeenCalledTimes(1002);
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
