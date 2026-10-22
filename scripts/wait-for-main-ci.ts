import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type WorkflowRun = {
  id: number;
  event: string;
  head_branch: string;
  head_sha: string;
  path: string;
  status: string;
  conclusion: string | null;
};

export async function waitForMainCi({
  repository,
  sha,
  currentRunId,
  token,
  apiUrl = "https://api.github.com",
  timeoutMs = 30 * 60_000,
  intervalMs = 15_000,
  fetchImpl = fetch,
  now = Date.now,
  pause = sleep,
}: {
  repository: string;
  sha: string;
  currentRunId: number;
  token: string;
  apiUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pause?: (ms: number) => Promise<unknown>;
}): Promise<number> {
  const deadline = now() + timeoutMs;
  const url = new URL(`${apiUrl}/repos/${repository}/actions/workflows/ci.yaml/runs`);
  url.search = new URLSearchParams({
    event: "push",
    branch: "main",
    head_sha: sha,
    per_page: "100",
  }).toString();

  while (now() < deadline) {
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(10_000, deadline - now())),
    });
    if (response.status !== 200) throw new Error(`Main CI API returned HTTP ${response.status}`);
    const body = (await response.json()) as { workflow_runs?: WorkflowRun[] };
    if (!Array.isArray(body?.workflow_runs)) throw new Error("Malformed main CI API response");
    const run = body.workflow_runs
      .filter(
        (candidate) =>
          candidate &&
          candidate.event === "push" &&
          candidate.head_branch === "main" &&
          candidate.head_sha === sha &&
          candidate.path === ".github/workflows/ci.yaml" &&
          Number.isSafeInteger(candidate.id) &&
          candidate.id !== currentRunId,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`Main CI run ${run.id} did not succeed (${run.conclusion})`);
      }
      return run.id;
    }
    await pause(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
  throw new Error("Timed out waiting for successful main CI on the exact tag commit");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { GITHUB_REF, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN } = process.env;
    if (!GITHUB_REF?.startsWith("refs/tags/v") || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
      throw new Error("A v* tag, repository and GitHub token are required");
    }
    const sha = execFileSync("git", ["rev-parse", `${GITHUB_REF}^{commit}`], {
      encoding: "utf8",
    }).trim();
    if (
      !/^[a-f0-9]{40}$/.test(sha) ||
      !GITHUB_RUN_ID ||
      !Number.isSafeInteger(Number(GITHUB_RUN_ID))
    ) {
      throw new Error("Invalid peeled commit or current run ID");
    }
    const runId = await waitForMainCi({
      repository: GITHUB_REPOSITORY,
      sha,
      currentRunId: Number(GITHUB_RUN_ID),
      token: GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    process.stdout.write(`Reusing successful main CI run ${runId} for ${sha}\n`);
  } catch {
    process.stderr.write(
      "Main CI gate failed; an exact-commit successful main push run is required.\n",
    );
    process.exitCode = 1;
  }
}
