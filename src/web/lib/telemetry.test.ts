// @vitest-environment jsdom
// biome-ignore-all lint/security/noSecrets: Synthetic credentials exercise scrubbing, not real accounts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createErrorBuffer,
  loadUmami,
  trackEvent,
  trackMutation,
  trackOutboundLink,
} from "./telemetry.js";

afterEach(() => {
  document.removeEventListener("click", trackOutboundLink, true);
  document.head.replaceChildren();
  document.body.replaceChildren();
  delete window.umami;
  delete window.beastyUmamiBeforeSend;
});

describe("analytics", () => {
  it("does nothing before Umami exists and only accepts approved scalar properties", () => {
    expect(() => trackEvent("hunt_action", { action: "pause" })).not.toThrow();
    window.umami = { track: vi.fn() };
    trackEvent("hunt_action", { action: "pause", title: "Private title", apiKey: "secret" });
    expect(window.umami.track).toHaveBeenCalledWith("hunt_action", { action: "pause" });
    trackEvent("outbound_link", { host: "https://user:pass@host/?token=secret" });
    expect(window.umami.track).toHaveBeenLastCalledWith("outbound_link", {});
    trackEvent("missing_search", { count: Number.NaN });
    expect(window.umami.track).toHaveBeenLastCalledWith("missing_search", {});
  });

  it("loads supported attributes once, gates by domain, and loads the direct recorder", () => {
    const config = {
      src: "https://analytics.example/script.js",
      websiteId: "fixture",
      domains: [location.hostname],
    };
    loadUmami({ ...config, domains: ["another.example"] });
    expect(document.scripts).toHaveLength(0);
    loadUmami(config);
    loadUmami(config);
    const script = document.scripts[0]!;
    expect(script.src).toBe(config.src);
    expect(script.dataset).toMatchObject({
      websiteId: "fixture",
      domains: location.hostname,
      excludeSearch: "true",
      excludeHash: "true",
      performance: "true",
      beforeSend: "beastyUmamiBeforeSend",
      doNotTrack: "true",
    });
    script.dispatchEvent(new Event("load"));
    const recorder = document.scripts[1]!;
    expect(recorder.src).toBe("https://analytics.example/recorder.js");
    expect(recorder.dataset.hostUrl).toBeUndefined();
    expect(
      window.beastyUmamiBeforeSend?.("event", {
        url: "https://u:p@app.example/library/series/12?q=title#secret",
        referrer: "https://u:p@arr.example?token=secret",
        title: "Private title",
      }),
    ).toMatchObject({
      title: "beasty-arr",
      url: "https://app.example/library/series/:id",
      referrer: "https://arr.example/",
    });
  });

  it("tracks outbound links using the host alone", () => {
    window.umami = { track: vi.fn() };
    const link = document.createElement("a");
    link.href = "https://user:pass@sonarr.example/series/title?apikey=secret";
    const span = document.createElement("span");
    link.append(span);
    document.body.append(link);
    span.addEventListener("click", trackOutboundLink);
    span.addEventListener("click", (event) => event.preventDefault());
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(window.umami.track).toHaveBeenCalledExactlyOnceWith("outbound_link", {
      host: "sonarr.example",
    });
  });

  it("records successful flow outcomes without bodies, IDs, or titles", () => {
    window.umami = { track: vi.fn() };
    trackMutation("POST", "/api/engine/cycle", {}, { ok: true });
    trackMutation(
      "POST",
      "/api/system/dry-run",
      { enabled: false, confirm: "live" },
      { dryRun: false },
    );
    trackMutation(
      "POST",
      "/api/fixer/analyses/opaque-private/apply",
      { candidateIds: ["private"] },
      { ok: true },
    );
    trackMutation("POST", "/api/missing/force", { episodeIds: [1, 2] }, { ok: true });
    trackMutation(
      "PUT",
      "/api/config",
      { fixerAutoRun: true, fixerAutoApply: false, apiKey: "secret" },
      {},
    );
    expect(window.umami.track).toHaveBeenCalledWith("hunt_action", { action: "cycle" });
    expect(window.umami.track).toHaveBeenCalledWith("dry_run_changed", { enabled: false });
    expect(window.umami.track).toHaveBeenCalledWith("fixer_action", { action: "apply" });
    expect(window.umami.track).toHaveBeenCalledWith("missing_search", { count: 2 });
    expect(window.umami.track).toHaveBeenCalledWith("fixer_automation_changed", {
      autoRun: true,
      autoApply: false,
    });
    const previous = vi.mocked(window.umami.track).mock.calls.length;
    trackMutation("POST", "/api/engine/cycle", {}, { ok: false });
    expect(window.umami.track).toHaveBeenCalledTimes(previous);
    expect(JSON.stringify(vi.mocked(window.umami.track).mock.calls)).not.toMatch(/private|secret/);
  });
});

it("buffers startup errors once, flushes to the SDK, bounds memory, and releases disabled buffers", () => {
  const buffer = createErrorBuffer();
  const first = new Error("early");
  buffer.report(first);
  buffer.report(first);
  const capture = vi.fn();
  buffer.flush(capture);
  expect(capture).toHaveBeenCalledExactlyOnceWith(first);
  buffer.report(new Error("later"));
  expect(capture).toHaveBeenCalledTimes(2);
  const bounded = createErrorBuffer();
  for (let i = 0; i < 100; i++) bounded.report(new Error(`startup ${i}`));
  const flush = vi.fn();
  bounded.flush(flush);
  expect(flush).toHaveBeenCalledTimes(20);
  buffer.disable();
  buffer.report(new Error("disabled"));
  expect(capture).toHaveBeenCalledTimes(2);
});
