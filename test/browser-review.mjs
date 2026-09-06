// Run against a locally built fixture app with no integrations or background jobs.
// Pass a Playwright Page; all mutation responses below are synthetic.
export async function verifyReviewFlows(page, baseUrl, evidenceDir) {
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        window.fixtureSse = this;
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener() {}
      close() {}
    };
  });
  const items = [1, 2].map((id) => ({
    id,
    service: "sonarr",
    title: `Sample series ${id === 1 ? "A" : "B"}`,
    episodeIds: [],
    absoluteEpisodeNumbers: [],
    episodeLabels: [],
    statusMessages: [],
    canAnalyze: true,
    issueType: "Import blocked",
    analysisId: `review-${id}`,
    analysisState: "proposal",
    confidence: 0.95,
  }));
  let queueFails = false;
  let missingFails = true;
  let submitted;
  await page.route("**/api/fixer/queue", (route) =>
    route.fulfill(
      queueFails
        ? { status: 503, json: { error: "Synthetic unavailable queue" } }
        : { json: { items, fetchedAt: Date.now() } },
    ),
  );
  await page.route("**/api/fixer/analyses/review-*", (route) => {
    const id = route.request().url().split("/").pop();
    return route.fulfill({
      json: {
        id,
        createdAt: Date.now(),
        service: "sonarr",
        queueItemId: id === "review-1" ? 1 : 2,
        downloadId: null,
        itemLabel: id === "review-1" ? "Sample series A" : "Sample series B",
        status: "completed",
        proposal: {
          action: "import_candidates",
          confidence: 0.95,
          reason: "Exact episode mappings verified against the library.",
          evidence: ["Two complete episode files matched."],
          warnings: [],
          selectedCandidateIds: ["candidate_1", "candidate_2"],
          selectedImports: [
            { candidateId: "candidate_1", episodeIds: [101] },
            { candidateId: "candidate_2", episodeIds: [102] },
          ],
        },
        validation: { ok: true, issues: [] },
        candidates: [1, 2].map((n) => ({
          id: `candidate_${n}`,
          service: "sonarr",
          path: `Episode ${n}.mkv`,
          relativePath: `Episode ${n}.mkv`,
          size: 1000000000,
          episodeIds: [100 + n],
          episodeLabels: [`S01E0${n}`],
          absoluteEpisodeNumbers: [],
          languages: [{ id: 4, name: "German" }],
          languageLabels: ["German"],
          rejections: [],
          isLikelySample: false,
        })),
        events: [],
        error: null,
        completedAt: Date.now(),
      },
    });
  });
  await page.route("**/api/fixer/analyses/review-2/apply", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: { ok: true, dryRun: true, message: "Synthetic import verified" },
    });
  });
  await page.route("**/api/missing**", (route) =>
    route.fulfill(
      missingFails
        ? { status: 403, json: { error: "Synthetic access-layer denial" } }
        : { json: { items: [], total: 0, page: 1, pageSize: 50, availableYears: [] } },
    ),
  );
  await page.goto(`${baseUrl}/fixer`);
  for (const title of ["Sample series B", "Sample series A"]) {
    await page.getByRole("button", { name: `Review ${title}`, exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Apply import (2)", exact: true }).waitFor();
  }
  await page.getByRole("checkbox", { name: "Include Episode 2.mkv" }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Apply import (1)", exact: true }).waitFor();
  await page.getByRole("button", { name: "Review Sample series B", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Apply import (2)", exact: true }).waitFor();
  if ((await page.locator("table input:checked").count()) !== 2)
    throw new Error("Proposal selection leaked");
  await page.screenshot({ path: `${evidenceDir}/fixer-review.png`, fullPage: true });
  await page.getByRole("button", { name: "Apply import (2)", exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/fixer/analyses/review-2/apply"),
    ),
    page.getByRole("dialog").getByRole("button", { name: "Apply import", exact: true }).click(),
  ]);
  if (JSON.stringify(submitted?.candidateIds) !== JSON.stringify(["candidate_1", "candidate_2"]))
    throw new Error("Incorrect apply subset");

  queueFails = true;
  // A refocus refetch preserves cached queue rows on failure.
  await page.evaluate(() => {
    window.fixtureSse.onerror();
    window.fixtureSse.onopen();
  });
  await page.getByRole("alert").filter({ hasText: "Refresh failed" }).waitFor();
  await page.getByRole("button", { name: "Review Sample series A", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "Could not load data" }).waitFor();
  if (await page.getByText("Nothing stuck. The import queues are clean.").count())
    throw new Error("Failure shown as empty");
  queueFails = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Review Sample series A", exact: true }).waitFor();

  await page.goto(`${baseUrl}/missing`);
  await page.getByRole("alert").filter({ hasText: "Could not load data" }).waitFor();
  await page.screenshot({ path: `${evidenceDir}/missing-error.png`, fullPage: true });
  missingFails = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("No missing episodes match these filters.").waitFor();
  return {
    keyboardReview: true,
    proposalIsolation: true,
    exactApplySubset: submitted,
    errorsAndRetry: true,
  };
}
