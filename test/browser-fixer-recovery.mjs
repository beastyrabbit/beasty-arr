// Fixture-only browser verification; uses the same external Playwright runtime as browser-review.mjs.
export async function verifyFixerRecovery(page, baseUrl, evidenceDir) {
  await page.addInitScript(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
  });
  const items = [1, 2, 3].map((id) => ({
    id,
    service: "sonarr",
    title: `Recovery fixture ${id}`,
    episodeIds: [],
    absoluteEpisodeNumbers: [],
    episodeLabels: [],
    statusMessages: [],
    canAnalyze: true,
    issueType: "quality",
    analysisId: `recovery-${id}`,
    analysisState: id === 1 ? "apply_error" : id === 2 ? "proposal" : "error",
    confidence: id === 1 ? 0.99 : id === 2 ? 0.94 : null,
    applyError: id === 1 ? "Sonarr 404 Not Found" : null,
    waitingReason:
      id === 1
        ? "Apply failed: Sonarr 404 Not Found"
        : id === 2
          ? "94% confidence; removal requires 95%."
          : "Analysis failed: The usage limit has been reached",
    retryAt: Date.now() + 900_000,
  }));
  const requests = [];
  await page.route("**/api/fixer/queue", (route) =>
    route.fulfill({ json: { items, fetchedAt: Date.now() } }),
  );
  await page.route("**/api/fixer/bulk/status", (route) =>
    route.fulfill({
      json: {
        running: false,
        activeItemIds: [],
        autoApply: true,
        total: 0,
        completed: 0,
        failed: 0,
        pausedUntil: Date.now() + 3_600_000,
      },
    }),
  );
  await page.route("**/api/fixer/bulk/start", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/fixer/analyses/recovery-*", (route) => {
    const id = Number(route.request().url().split("-").pop());
    return route.fulfill({
      json: {
        id: `recovery-${id}`,
        service: "sonarr",
        queueItemId: id,
        itemLabel: `Recovery fixture ${id}`,
        status: id === 3 ? "failed" : "completed",
        createdAt: Date.now(),
        completedAt: Date.now(),
        error: id === 3 ? "The usage limit has been reached" : null,
        events: [],
        candidates: [],
        validation: { ok: true, issues: [] },
        proposal:
          id === 3
            ? null
            : {
                action: "remove_queue_item",
                confidence: id === 1 ? 0.99 : 0.94,
                selectedCandidateIds: [],
                selectedImports: [],
                sampleCandidateIds: [],
                reason: "Existing file is better.",
                evidence: [],
                warnings: [],
                queueRemovalOptions: {
                  removeFromClient: true,
                  blocklist: false,
                  skipRedownload: false,
                  changeCategory: false,
                },
              },
      },
    });
  });
  await page.goto(`${baseUrl}/fixer`);
  await page.getByText("APPLY FAILED", { exact: true }).waitFor();
  await page.getByText(/Provider usage limit reached/).waitFor();
  await page.getByRole("button", { name: "Review Recovery fixture 1", exact: true }).click();
  await page.getByText("Apply failed: Sonarr 404 Not Found", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reanalyze and retry", exact: true }).click();
  await page.getByRole("button", { name: "Review Recovery fixture 2", exact: true }).click();
  await page.getByText("94% confidence; removal requires 95%.", { exact: true }).waitFor();
  await page.getByText("Removal gate 95%", { exact: true }).waitFor();
  await page.screenshot({ path: `${evidenceDir}/fixer-recovery.png`, fullPage: true });
  await page.getByRole("button", { name: "Review Recovery fixture 3", exact: true }).click();
  await page.getByRole("button", { name: "Retry analysis", exact: true }).click();
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  if (
    JSON.stringify(requests) !==
    JSON.stringify([
      { targets: [{ service: "sonarr", queueItemId: 1 }] },
      { targets: [{ service: "sonarr", queueItemId: 3 }] },
      { skipAnalyzed: true },
    ])
  )
    throw new Error(`Unexpected retry requests: ${JSON.stringify(requests)}`);
}
