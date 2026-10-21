// Like browser-review.mjs, accepts a Page from a separately supplied Playwright runtime.
// Serve the production build with a fresh database, no integrations and registerJobs: false.
export async function verifyLegalPages(page, baseUrl, evidenceDir) {
  const origin = new URL(baseUrl).origin;
  const externalRequests = [];
  const requests = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener() {}
      close() {}
    };
  });
  const links = [
    ["Impressum", "/impressum", "Impressum", "impressum-beasty-arr@heerlab.com"],
    ["Datenschutz", "/datenschutz", "Datenschutzerklärung", "In der Anwendung gespeicherte Daten"],
    [
      "Legal notice",
      "/legal-notice",
      "Legal Notice (Impressum)",
      "impressum-beasty-arr@heerlab.com",
    ],
    ["Privacy", "/privacy", "Privacy Policy", "Data stored in the application"],
  ];
  for (const [size, width, height] of [
    ["desktop", 1280, 800],
    ["mobile", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [label, path, heading, content] of links) {
      await page.goto(baseUrl);
      await page.getByText("Priority 1 indexer limits", { exact: true }).waitFor();
      const footer = page.getByRole("contentinfo");
      if ((await footer.getByRole("link").count()) !== 4)
        throw new Error("Missing app footer links");
      if (path === "/impressum") {
        await footer.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidenceDir}/${size}-home.png` });
      }
      const start = requests.length;
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url() === `${origin}${path}` && response.request().isNavigationRequest(),
      );
      await footer.getByRole("link", { name: label, exact: true }).click();
      const response = await responsePromise;
      await page.getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
      if (response.status() !== 200 || response.headers()["x-robots-tag"] !== "noindex")
        throw new Error(`Bad legal response: ${path}`);
      if (!(await page.locator("main").innerText()).includes(content))
        throw new Error(`Missing content: ${path}`);
      if (!(await page.locator("main").innerText()).includes("Stettiner Str. 41"))
        throw new Error("Missing operator address");
      if (await page.locator("script, img, link[rel=stylesheet]").count())
        throw new Error("Legal page depends on assets");
      if ((await page.locator('meta[name="robots"]').getAttribute("content")) !== "noindex")
        throw new Error("Missing robots meta");
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Horizontal page overflow: ${size} ${path}`);
      if (
        await page.evaluate(
          () => document.cookie !== "" || localStorage.length !== 0 || sessionStorage.length !== 0,
        )
      )
        throw new Error("Legal page wrote browser storage");
      await page.screenshot({
        path: `${evidenceDir}/${size}-${path.slice(1)}.png`,
        fullPage: true,
      });
      const resources = requests.slice(start).filter((url) => url !== `${origin}${path}`);
      if (resources.length)
        throw new Error(`Legal page requested resources: ${resources.join(", ")}`);
    }

    // Follow the legal-page cross links as well as each app-footer link.
    await page.goto(`${baseUrl}/impressum`);
    await page.getByRole("link", { name: "Datenschutzerklärung", exact: true }).click();
    await page
      .getByRole("heading", { name: "Datenschutzerklärung", exact: true, level: 1 })
      .waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Privacy Policy", exact: true, level: 1 }).waitFor();
    await page.getByRole("link", { name: "Legal notice", exact: true }).click();
    await page
      .getByRole("heading", { name: "Legal Notice (Impressum)", exact: true, level: 1 })
      .waitFor();

    await page.goto(`${baseUrl}/not-a-real-route`);
    await page.getByText("Nothing here.", { exact: true }).waitFor();
    if ((await page.locator("footer a").count()) !== 4)
      throw new Error("Not-found footer missing or duplicated");
    await page.route("**/api/missing**", (route) =>
      route.fulfill({ status: 503, json: { error: "Synthetic unavailable library" } }),
    );
    await page.goto(`${baseUrl}/missing`);
    await page.getByRole("alert").filter({ hasText: "Could not load data" }).waitFor();
    if ((await page.locator("footer a").count()) !== 4)
      throw new Error("Query-error footer missing");
    await page.unroute("**/api/missing**");
  }

  // Public policies also work when the browser has JavaScript disabled.
  const context = await page.context().browser().newContext({ javaScriptEnabled: false });
  try {
    const noJsPage = await context.newPage();
    await noJsPage.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    for (const [, path, heading] of links) {
      await noJsPage.goto(`${baseUrl}${path}`);
      await noJsPage.getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
    }
  } finally {
    await context.close();
  }
  // A fresh page forces a lazy route render failure, exercising the boundary that
  // replaces AppLayout rather than the in-layout QueryError banner above.
  const errorPage = await page.context().newPage();
  try {
    await errorPage.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await errorPage.route("**/assets/Settings-*.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'export function SettingsPage() { throw new Error("Synthetic route render failure"); }',
      }),
    );
    await errorPage.goto(`${baseUrl}/settings/connections`);
    await errorPage.getByText("Could not load this page.", { exact: true }).waitFor();
    if ((await errorPage.locator("footer a").count()) !== 4) {
      throw new Error("Route error boundary footer missing or duplicated");
    }
  } finally {
    await errorPage.close();
  }
  if (externalRequests.length)
    throw new Error(`Unexpected external requests: ${externalRequests.join(", ")}`);
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(", ")}`);
  return {
    desktop: true,
    mobile: true,
    noJavaScript: true,
    legalResourceRequests: 0,
    externalRequests: 0,
    errorFooters: true,
  };
}
