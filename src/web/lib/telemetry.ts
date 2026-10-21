import type { ClientConfig } from "../../shared/telemetry.js";
import { createTelemetryScrubber, scrubUrl, telemetryPath } from "../../shared/telemetry.js";

type SentryModule = typeof import("./glitchtip.js");
type Properties = Record<string, unknown>;
const SAFE_PROPERTY = /^[a-z\d_./:-]+$/i;
const SCRIPT_SUFFIX = /\/script\.js$/;
const ARR_SERVICE = /\/(sonarr|radarr)\//;
const BULK_ACTIONS: Record<string, string> = { start: "run_all", cancel: "cancel_all" };
const EVENT_PROPERTIES = {
  hunt_action: ["action"],
  dry_run_changed: ["enabled"],
  settings_saved: ["section"],
  fixer_action: ["action", "service"],
  fixer_automation_changed: ["autoRun", "autoApply"],
  oracle_recheck: [],
  missing_search: ["count"],
  item_action: ["action", "service", "kind"],
  query_retry: ["route"],
  api_failure: ["route", "status", "method"],
  outbound_link: ["host"],
} as const;
export type AnalyticsEvent = keyof typeof EVENT_PROPERTIES;

declare global {
  interface Window {
    __BEASTY_TELEMETRY_TEST__?: boolean;
    umami?: { track: (name: string, data?: Properties) => unknown };
    beastyUmamiBeforeSend?: (type: string, payload: Properties) => Properties;
  }
}

export function trackEvent(name: AnalyticsEvent, properties: Properties = {}): void {
  if (typeof window === "undefined" || !window.umami) return;
  const allowed: readonly string[] = EVENT_PROPERTIES[name];
  const data: Properties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.includes(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      data[key] = value;
    else if (typeof value === "string" && value.length <= 100 && SAFE_PROPERTY.test(value))
      data[key] = value;
  }
  try {
    void Promise.resolve(window.umami.track(name, data)).catch(() => undefined);
  } catch {
    /* Telemetry never interrupts an action. */
  }
}

export function trackOutboundLink(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(target instanceof HTMLAnchorElement)) return;
  try {
    const url = new URL(target.href);
    if (["https:", "http:"].includes(url.protocol) && url.origin !== location.origin)
      trackEvent("outbound_link", { host: url.hostname });
  } catch {
    /* Ignore non-HTTP links. */
  }
}

const scrub = createTelemetryScrubber();

export function loadUmami(config: NonNullable<ClientConfig["umami"]>): void {
  if (
    ["1", "yes"].includes(navigator.doNotTrack ?? "") ||
    !config.domains.includes(location.hostname) ||
    document.querySelector("script[data-beasty-umami]")
  )
    return;
  window.beastyUmamiBeforeSend = (_type, payload) => ({
    ...scrub(payload),
    title: "beasty-arr",
    url: scrubUrl(String(payload.url ?? location.href)),
    referrer: payload.referrer ? scrubUrl(String(payload.referrer)) : "",
  });
  const script = document.createElement("script");
  script.src = config.src;
  script.async = true;
  script.referrerPolicy = "no-referrer";
  script.dataset.beastyUmami = "true";
  script.dataset.websiteId = config.websiteId;
  script.dataset.domains = config.domains.join(",");
  script.dataset.excludeSearch = "true";
  script.dataset.excludeHash = "true";
  script.dataset.performance = "true";
  script.dataset.beforeSend = "beastyUmamiBeforeSend";
  script.dataset.doNotTrack = "true";
  script.addEventListener(
    "load",
    () => {
      // Masking and blocked regions are configured in the Umami website settings.
      const recorder = document.createElement("script");
      recorder.src = config.src.replace(SCRIPT_SUFFIX, "/recorder.js");
      recorder.async = true;
      recorder.referrerPolicy = "no-referrer";
      recorder.dataset.websiteId = config.websiteId;
      document.head.append(recorder);
    },
    { once: true },
  );
  document.head.append(script);
  document.addEventListener("click", trackOutboundLink, true);
}

/** Bounded bootstrap buffer installed before fetching runtime config or loading the SDK. */
export function createErrorBuffer() {
  let capture: ((error: unknown) => void) | undefined;
  let enabled = true;
  const pending: unknown[] = [];
  const seen = new WeakSet<object>();
  const report = (error: unknown) => {
    if (!enabled) return;
    if (error && typeof error === "object") {
      if (seen.has(error)) return;
      seen.add(error);
    }
    if (capture) capture(error);
    else if (pending.length < 20) pending.push(error);
  };
  return {
    report,
    flush(handler: (error: unknown) => void) {
      capture = handler;
      for (const error of pending.splice(0)) handler(error);
    },
    disable() {
      enabled = false;
      pending.length = 0;
    },
  };
}

const errors = createErrorBuffer();
export const captureBrowserError = errors.report;

export async function startTelemetry(
  options: { allowAutomation?: boolean; loadSentry?: () => Promise<SentryModule> } = {},
): Promise<void> {
  if (import.meta.env.DEV || (navigator.webdriver && !options.allowAutomation)) {
    errors.disable();
    return;
  }
  const onError = (event: ErrorEvent) => errors.report(event.error ?? new Error(event.message));
  const onRejection = (event: PromiseRejectionEvent) => errors.report(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const stopBuffering = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  try {
    const response = await fetch("/api/client-config", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Client config unavailable");
    const config = (await response.json()) as ClientConfig;
    if (config.umami) loadUmami(config.umami);
    if (!config.glitchtip) {
      errors.disable();
      stopBuffering();
      return;
    }
    const sentry = await (options.loadSentry ?? (() => import("./glitchtip.js")))();
    sentry.init({
      ...config.glitchtip,
      // No browser tracing integration: errors are enough for this internal SPA.
      tracesSampleRate: 0,
      sendDefaultPii: false,
      sendClientReports: false,
      integrations: (defaults) => [
        ...defaults.filter((integration) => integration.name !== "BrowserSession"),
        sentry.captureConsoleIntegration({ levels: ["error"] }),
      ],
      beforeSend: (event) => scrub(event),
      beforeSendTransaction: (event) => scrub(event),
      beforeBreadcrumb: (breadcrumb, hint) => {
        const target = hint?.event?.target;
        if (target instanceof Element && target.closest("[data-telemetry-block]")) return null;
        return scrub(breadcrumb);
      },
    });
    errors.flush((error) => sentry.captureException(error));
    stopBuffering();
  } catch {
    errors.disable();
    stopBuffering();
  }
}

/** API paths are generated by app code; strip all dynamic IDs before analytics. */
export function trackApiFailure(method: string, path: string, status: number): void {
  trackEvent("api_failure", { method, route: telemetryPath(path), status });
}

export function trackMutation(method: string, path: string, body: unknown, result: unknown): void {
  if (
    method === "GET" ||
    (result && typeof result === "object" && "ok" in result && result.ok === false)
  )
    return;
  const route = telemetryPath(path);
  const input = body && typeof body === "object" ? (body as Properties) : {};
  if (route.startsWith("/api/engine/"))
    trackEvent("hunt_action", { action: path.split("/").pop() });
  else if (route === "/api/system/dry-run")
    trackEvent("dry_run_changed", { enabled: input.enabled });
  else if (route === "/api/config" || route === "/api/budget/settings") {
    trackEvent("settings_saved", { section: route === "/api/config" ? "app" : "budget" });
    if ("fixerAutoRun" in input || "fixerAutoApply" in input)
      trackEvent("fixer_automation_changed", {
        autoRun: input.fixerAutoRun,
        autoApply: input.fixerAutoApply,
      });
  } else if (route.startsWith("/api/fixer/")) {
    const action = path.split("/").pop();
    if (["analyze", "apply", "remove", "ignore", "start", "cancel"].includes(action ?? "")) {
      trackEvent("fixer_action", {
        action: route.includes("/bulk/") ? BULK_ACTIONS[String(action)] : action,
        service: ARR_SERVICE.exec(path)?.[1],
      });
    }
  } else if (route === "/api/ai/recheck" || route.startsWith("/api/verdicts/"))
    trackEvent("oracle_recheck");
  else if (route === "/api/missing/force")
    trackEvent("missing_search", {
      count: Array.isArray(input.episodeIds) ? input.episodeIds.length : 0,
    });
  else if (route.startsWith("/api/items/"))
    trackEvent("item_action", {
      action: path.split("/").pop(),
      service: path.split("/")[3],
      kind: path.split("/")[4],
    });
}
