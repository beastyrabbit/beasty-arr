// biome-ignore-all lint/security/noSecrets: Synthetic credentials exercise scrubbing, not real accounts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const version = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const release = `beasty-arr@${version}`;
const website = "00000000-0000-4000-8000-000000000001";
const environment = "telemetry-fixture";
const secret = "fixture-should-never-leave-the-app";

/** Built-app flow, with the exact public Umami scripts served by an isolated local stub. */
export async function verifyTelemetry(page, baseUrl, requests) {
  await page.addInitScript(() => {
    window.__BEASTY_TELEMETRY_TEST__ = true;
  });
  const destinations = [];
  page.on("request", (request) => destinations.push(request.url()));
  // Check blocking in the initial snapshot as well as later rrweb mutations.
  await page.addInitScript((privateValue) => {
    document.addEventListener("DOMContentLoaded", () => {
      const region = document.createElement("div");
      region.setAttribute("data-telemetry-block", "");
      region.innerHTML = `<a href="http://initial-internal.example/?token=${privateValue}" title="${privateValue}">${privateValue}</a>`;
      document.body.append(region);
    });
  }, secret);
  const recorderPageUrl = `${baseUrl}/?q=recorder-title&id=123`;
  await page.goto(recorderPageUrl);
  await page.waitForFunction(() => Boolean(window.umami));
  // recorder.js bypasses beforeSend, including rrweb Meta href and heatmap URLs.
  await assertEventually(
    () =>
      requests.some(
        (request) =>
          request.json?.type === "record" &&
          request.json.payload.events.some(
            (event) => event.type === 4 && event.data?.href === recorderPageUrl,
          ),
      ),
    "Replay Meta must retain the app route query",
  );
  await page.getByRole("link", { name: "Hunt", exact: true }).first().click();
  await page
    .getByRole("button", { name: /Run (a )?cycle|Run now|Run cycle/i })
    .first()
    .click();
  await page.waitForFunction(() => document.querySelector("script[src$='/recorder.js']"));
  const recorderUrl = await page.locator("script[src$='/recorder.js']").getAttribute("src");
  const umamiOrigin = new URL(recorderUrl).origin;
  assert.notEqual(umamiOrigin, new URL(baseUrl).origin);
  assert(destinations.includes(`${umamiOrigin}/recorder.js`), "Recorder did not load from Umami");
  await page.evaluate((privateValue) => {
    const content = document.createElement("div");
    content.setAttribute("data-telemetry-block", "");
    content.textContent = privateValue;
    const input = document.createElement("input");
    input.value = privateValue;
    content.append(input);
    const external = document.createElement("a");
    external.href = `https://user:pass@sonarr.example/series/title?apikey=${privateValue}`;
    external.title = privateValue;
    external.textContent = privateValue;
    external.target = "_blank";
    external.addEventListener("click", (event) => event.preventDefault());
    content.append(external);
    document.body.append(content);
    external.click();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => {
      throw new Error(
        `telemetry-browser-error person@example.com Bearer fixture-bearer https://user:pass@arr.example/?token=${privateValue}`,
      );
    }, 0);
  }, secret);
  await assertEventually(
    () =>
      requests.some(
        (request) =>
          request.path.includes("/envelope/") && request.body.includes("telemetry-browser-error"),
      ),
    "Browser error envelope missing",
  );
  await assertEventually(
    () =>
      requests.filter(
        (request) =>
          request.path === "/api/send" &&
          request.json?.type === "event" &&
          !request.json.payload.name,
      ).length >= 2,
    "SPA route pageview missing",
  );
  await assertEventually(
    () => requests.some((request) => request.json?.payload?.name === "hunt_action"),
    "Custom hunt action missing",
  );
  await assertEventually(
    () =>
      requests.some((request) => request.path === "/api/record" && request.json?.type === "record"),
    "Session replay missing",
  );
  await assertEventually(
    () =>
      requests.some(
        (request) =>
          request.path === "/api/record" &&
          request.json?.type === "heatmap" &&
          request.json.payload.events.some(
            (event) => event.type === "click" && event.url === recorderPageUrl,
          ),
      ),
    "Heatmap clicks must retain the app route query",
  );
  await assertEventually(
    () =>
      requests.some(
        (request) => request.path === "/api/send" && request.json?.type === "performance",
      ),
    "Performance measurement missing",
  );
  assert(
    destinations.includes(`${umamiOrigin}/api/record`),
    "Recorder did not post directly to Umami",
  );
  // Settings contains connection URLs; the recorder must retain only its blocked placeholder.
  await page.goto(`${baseUrl}/settings/connections`);
  const settings = page.locator("[data-telemetry-block].rr-block");
  await settings.waitFor();
  await settings.evaluate((region, privateValue) => {
    const link = document.createElement("a");
    link.href = `http://settings-internal.example/?token=${privateValue}`;
    link.title = privateValue;
    region.append(link);
  }, secret);
  const recordingsBefore = requests.filter((request) => request.json?.type === "record").length;
  // An unblocked change proves recording continues after the blocked mutation.
  await page.evaluate(() => document.body.append(document.createElement("hr")));
  await assertEventually(
    () => requests.filter((request) => request.json?.type === "record").length > recordingsBefore,
    "Recording did not continue on Settings",
  );
  const events = requests
    .filter((request) => request.path === "/api/send")
    .map((request) => request.json);
  assert(!JSON.stringify(events).includes("recorder-title"), "Pageview query was not scrubbed");
  assert(
    events.every((event) => !new URL(event.payload.url).search),
    "Analytics URLs must exclude query strings",
  );
  assert(
    events.some((event) => !event.payload.name && new URL(event.payload.url).pathname === "/hunt"),
  );
  const envelope = requests.find(
    (request) =>
      request.path.includes("/envelope/") && request.body.includes("telemetry-browser-error"),
  )?.body;
  assert(envelope?.includes(release), "Wrong browser release");
  assert(envelope?.includes(environment), "Wrong browser environment");
  assert(envelope?.includes("telemetry-browser-error"), "Wrong browser error");
  assert(
    requests.some(
      (request) =>
        request.json?.payload?.name === "outbound_link" &&
        request.json.payload.data?.host === "sonarr.example",
    ),
    "Host-only outbound event missing",
  );
  const payloads = requests.map((request) => request.body).join("\n");
  for (const privateValue of [
    secret,
    "person@example.com",
    "fixture-bearer",
    "user:pass",
    "fixture-arr-secret",
    "initial-internal.example",
    "settings-internal.example",
  ])
    assert(!payloads.includes(privateValue), `Unscrubbed fixture data: ${privateValue}`);
  assert.equal((await page.context().cookies()).length, 0, "Telemetry set cookies");
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  assert.deepEqual(storage, { local: [], session: [] }, "Unexpected telemetry storage");
  return {
    pageviews: events.filter((event) => event.type === "event" && !event.payload.name).length,
    customEvents: events.filter((event) => event.payload.name).map((event) => event.payload.name),
    envelope: true,
    replay: true,
    heatmap: true,
    cookies: 0,
    storage,
    destinations: destinations.length,
  };
}

async function assertEventually(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function verifyUnhandledRejection(stubPort, requests) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./dist/server/server/instrument.js",
      "--input-type=module",
      "--eval",
      'Promise.reject(new Error("x")); setTimeout(() => process.exit(0), 4000);',
    ],
    {
      env: {
        NODE_ENV: "production",
        GLITCHTIP_DSN: `http://public@127.0.0.1:${stubPort}/1`,
      },
      stdio: "ignore",
      timeout: 5000,
    },
  );
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 1, signal: null }, "Unhandled rejection must exit with code 1");
  assert(
    requests.some(
      (request) => request.path.includes("/envelope/") && request.body.includes('"value":"x"'),
    ),
    "Unhandled rejection must flush its error envelope before exiting",
  );
}

async function startApp(dataDir, telemetry = {}) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      "--import",
      "./dist/server/server/instrument.js",
      "test/telemetry-server.mjs",
    ],
    {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        PORT: String(port),
        DATA_DIR: dataDir,
        LOG_LEVEL: "error",
        BEASTY_ARR_FORBID_LIVE_AI: "1",
        ...telemetry,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += String(data);
  });
  child.stderr.on("data", (data) => {
    output += String(data);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await assertEventually(async () => {
      if (child.exitCode !== null) throw new Error(`Fixture app exited: ${output}`);
      try {
        return (await fetch(`${baseUrl}/api/health`)).ok;
      } catch {
        return false;
      }
    }, "Fixture app did not start");
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return { child, baseUrl };
}

async function run() {
  const requests = [];
  const script = await readFile(new URL("./fixtures/umami-script.js", import.meta.url));
  const recorder = await readFile(new URL("./fixtures/umami-recorder.js", import.meta.url));
  const stub = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "content-type,x-umami-website-id,x-umami-hostname,x-umami-cache,sentry-trace,baggage",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/script.js" || request.url === "/recorder.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(request.url === "/script.js" ? script : recorder);
      return;
    }
    if (request.url?.endsWith("/recorder")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          enabled: true,
          replayEnabled: true,
          heatmapEnabled: true,
          sampleRate: 1,
          heatmapSampleRate: 1,
          maskLevel: "strict",
          blockSelector: "[data-telemetry-block]",
          maxDuration: 300_000,
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      /* Sentry envelopes use newline framing. */
    }
    requests.push({ path: request.url, body, json });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/send" ? { cache: "fixture-session" } : {}));
  });
  const stubPort = await listen(stub);
  const root = await mkdtemp(path.join(tmpdir(), "beasty-telemetry-"));
  const apps = [];
  let browser;
  try {
    await verifyUnhandledRejection(stubPort, requests);
    apps.push(
      await startApp(path.join(root, "enabled"), {
        UMAMI_URL: `http://127.0.0.1:${stubPort}`,
        UMAMI_WEBSITE_ID: website,
        UMAMI_DOMAINS: "127.0.0.1",
        GLITCHTIP_DSN: `http://public@127.0.0.1:${stubPort}/1`,
        GLITCHTIP_ENVIRONMENT: environment,
      }),
    );
    apps.push(await startApp(path.join(root, "disabled")));
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const context = await browser.newContext();
    const result = await verifyTelemetry(await context.newPage(), apps[0].baseUrl, requests);
    await context.close();
    const disabled = await browser.newContext();
    const disabledPage = await disabled.newPage();
    await disabledPage.addInitScript(() => {
      window.__BEASTY_TELEMETRY_TEST__ = true;
    });
    const unexpected = [];
    disabledPage.on("request", (request) => {
      if (new URL(request.url()).port === String(stubPort)) unexpected.push(request.url());
    });
    await disabledPage.goto(apps[1].baseUrl);
    await disabledPage.getByRole("link", { name: "Hunt", exact: true }).first().click();
    await disabledPage.waitForTimeout(1000);
    assert.deepEqual(unexpected, [], "Disabled app contacted telemetry host");
    assert.equal(await disabledPage.locator("script[data-beasty-umami]").count(), 0);
    assert.deepEqual(await disabledPage.evaluate(() => Object.keys(localStorage)), []);
    // Automation is excluded unless a loopback fixture explicitly opts in.
    const bot = await browser.newPage();
    const botRequests = [];
    bot.on("request", (request) => {
      if (new URL(request.url()).port === String(stubPort)) botRequests.push(request.url());
    });
    await bot.goto(apps[0].baseUrl);
    await bot.waitForTimeout(1000);
    assert.deepEqual(botRequests, []);
    process.stdout.write(
      `${JSON.stringify({ ...result, unhandledRejectionExit: 1, disabledRequests: 0, botRequests: 0, release, environment }, null, 2)}\n`,
    );
  } finally {
    await browser?.close();
    await Promise.all(
      apps.map(
        ({ child }) =>
          new Promise((resolve) => {
            if (child.exitCode !== null) resolve();
            else {
              child.once("exit", resolve);
              child.kill("SIGTERM");
            }
          }),
      ),
    );
    await new Promise((resolve) => stub.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await run();
