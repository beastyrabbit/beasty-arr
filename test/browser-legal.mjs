import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startApp } from "./browser-telemetry.mjs";

const LINKS = [
  ["Impressum", "/impressum", "Impressum", "impressum-beasty-arr@heerlab.com"],
  ["Datenschutz", "/datenschutz", "Datenschutzerklärung", "In der Anwendung gespeicherte Daten"],
  ["Legal notice", "/legal-notice", "Legal Notice (Impressum)", "impressum-beasty-arr@heerlab.com"],
  ["Privacy", "/privacy", "Privacy Policy", "Data stored in the application"],
];

async function blockExternalRequests(page, origin, externalRequests) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) {
      externalRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
}

async function monitorRequests(page, origin) {
  const monitor = { externalRequests: [], requests: [], pageErrors: [] };
  page.on("request", (request) => monitor.requests.push(request.url()));
  page.on("pageerror", (error) => monitor.pageErrors.push(error.message));
  await blockExternalRequests(page, origin, monitor.externalRequests);
  return monitor;
}

async function installEventSourceStub(page) {
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener() {
        // Fixture pages receive no server events, so listeners need not be registered.
      }
      close() {
        // The stub opens no connection, so there is nothing to close.
      }
    };
  });
}

async function waitForHeading(page, heading) {
  await page.getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
}

async function checkFooter(page, message) {
  assert.equal(await page.locator("footer a").count(), 4, message);
}

function collectStorage() {
  return {
    cookies: document.cookie,
    local: localStorage.length,
    session: sessionStorage.length,
  };
}

async function checkLegalDocument(page, link, response) {
  const [, path, heading, content] = link;
  await waitForHeading(page, heading);
  assert.equal(response.status(), 200, `Bad legal response: ${path}`);
  assert.equal(response.headers()["x-robots-tag"], "noindex", `Missing noindex header: ${path}`);
  const text = await page.locator("main").innerText();
  assert.ok(text.includes(content), `Missing content: ${path}`);
  if (["/datenschutz", "/privacy"].includes(path)) {
    const telemetry = page.locator('section[aria-labelledby="telemetry"]');
    assert.match(await telemetry.innerText(), /Umami 3\.4/);
    assert.match(await telemetry.innerText(), /GlitchTip 6\.2\.6/);
  }
  assert.ok(text.includes("Stettiner Str. 41"), "Missing operator address");
  assert.equal(
    await page.locator("script, img, link[rel=stylesheet]").count(),
    0,
    "Legal page depends on assets",
  );
  assert.equal(
    await page.locator('meta[name="robots"]').getAttribute("content"),
    "noindex",
    "Missing robots meta",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    `Horizontal page overflow: ${path}`,
  );
  assert.deepEqual(
    await page.evaluate(collectStorage),
    { cookies: "", local: 0, session: 0 },
    "Legal page wrote browser storage",
  );
}

async function checkPage(page, run, size, link) {
  const [label, path] = link;
  await page.goto(run.baseUrl);
  await page.getByText("Priority 1 indexer limits", { exact: true }).waitFor();
  await checkFooter(page, "Missing app footer links");
  const footer = page.getByRole("contentinfo");
  if (path === "/impressum") {
    await footer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run.evidenceDir}/${size}-home.png` });
  }
  const start = run.monitor.requests.length;
  const url = run.origin + path;
  const responsePromise = page.waitForResponse(
    (response) => response.url() === url && response.request().isNavigationRequest(),
  );
  await footer.getByRole("link", { name: label, exact: true }).click();
  await checkLegalDocument(page, link, await responsePromise);
  await page.screenshot({
    path: `${run.evidenceDir}/${size}-${path.slice(1)}.png`,
    fullPage: true,
  });
  const resources = run.monitor.requests.slice(start).filter((request) => request !== url);
  assert.deepEqual(resources, [], `Legal page requested resources: ${resources.join(", ")}`);
}

async function checkCrossLinks(page, baseUrl) {
  await page.goto(`${baseUrl}/impressum`);
  await page.getByRole("link", { name: "Datenschutzerklärung", exact: true }).click();
  await waitForHeading(page, "Datenschutzerklärung");
  await page.getByRole("link", { name: "English", exact: true }).click();
  await waitForHeading(page, "Privacy Policy");
  await page.getByRole("link", { name: "Legal notice", exact: true }).click();
  await waitForHeading(page, "Legal Notice (Impressum)");
}

async function checkErrorFooters(page, baseUrl) {
  await page.goto(`${baseUrl}/not-a-real-route`);
  await page.getByText("Nothing here.", { exact: true }).waitFor();
  await checkFooter(page, "Not-found footer missing or duplicated");
  await page.route("**/api/missing**", (route) =>
    route.fulfill({ status: 503, json: { error: "Synthetic unavailable library" } }),
  );
  await page.goto(`${baseUrl}/missing`);
  await page.getByRole("alert").filter({ hasText: "Could not load data" }).waitFor();
  await checkFooter(page, "Query-error footer missing");
  await page.unroute("**/api/missing**");
}

async function checkJsDisabled(page, run) {
  const context = await page.context().browser().newContext({ javaScriptEnabled: false });
  try {
    const noJsPage = await context.newPage();
    await blockExternalRequests(noJsPage, run.origin, run.monitor.externalRequests);
    for (const [, path, heading] of LINKS) {
      await noJsPage.goto(run.baseUrl + path);
      await waitForHeading(noJsPage, heading);
    }
  } finally {
    await context.close();
  }
}

async function checkRenderError(page, run) {
  // A fresh page forces a lazy route render failure outside AppLayout.
  const errorPage = await page.context().newPage();
  try {
    await blockExternalRequests(errorPage, run.origin, run.monitor.externalRequests);
    await errorPage.route("**/assets/Settings-*.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'export function SettingsPage() { throw new Error("Synthetic route render failure"); }',
      }),
    );
    await errorPage.goto(`${run.baseUrl}/settings/connections`);
    await errorPage.getByText("Could not load this page.", { exact: true }).waitFor();
    await errorPage.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await checkFooter(errorPage, "Route error boundary footer missing or duplicated");
  } finally {
    await errorPage.close();
  }
}

// Like browser-review.mjs, accepts a Page from a separately supplied Playwright runtime.
// Serve the production build with a fresh database, no integrations and registerJobs: false.
export async function verifyLegalPages(page, baseUrl, evidenceDir) {
  const origin = new URL(baseUrl).origin;
  const monitor = await monitorRequests(page, origin);
  const run = { baseUrl, evidenceDir, origin, monitor };
  await installEventSourceStub(page);
  for (const [size, width, height] of [
    ["desktop", 1280, 800],
    ["mobile", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const link of LINKS) await checkPage(page, run, size, link);
    await checkCrossLinks(page, baseUrl);
    await checkErrorFooters(page, baseUrl);
  }
  await checkJsDisabled(page, run);
  await checkRenderError(page, run);
  assert.deepEqual(monitor.externalRequests, [], "Unexpected external requests");
  assert.deepEqual(monitor.pageErrors, [], "Browser errors");
  return {
    desktop: true,
    mobile: true,
    noJavaScript: true,
    legalResourceRequests: 0,
    externalRequests: 0,
    errorFooters: true,
  };
}

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "beasty-legal-data-"));
  const evidenceDir = await mkdtemp(path.join(tmpdir(), "beasty-legal-evidence-"));
  let app;
  let browser;
  try {
    app = await startApp(dataDir);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = await verifyLegalPages(page, app.baseUrl, evidenceDir);
    process.stdout.write(`${JSON.stringify({ ...result, evidenceDir }, null, 2)}\n`);
  } finally {
    await browser?.close();
    if (app?.child.exitCode === null) {
      await new Promise((resolve) => {
        app.child.once("exit", resolve);
        app.child.kill("SIGTERM");
      });
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await run();
