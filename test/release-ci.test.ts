import { describe, expect, it, vi } from "vitest";
import { deploymentSmoke } from "../scripts/deployment-smoke.js";
import { waitForMainCi } from "../scripts/wait-for-main-ci.js";

const SHA = "a".repeat(40);
const run = {
  id: 20,
  event: "push",
  head_branch: "main",
  head_sha: SHA,
  path: ".github/workflows/ci.yaml",
  status: "completed",
  conclusion: "success",
};

function clock() {
  let time = 0;
  return {
    now: () => time,
    pause: async (ms: number) => {
      time += ms;
    },
    timeoutMs: 30,
    intervalMs: 10,
  };
}

function gate(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  return {
    fetchImpl,
    result: waitForMainCi({
      repository: "owner/repo",
      sha: SHA,
      currentRunId: 99,
      token: "synthetic-test-token",
      fetchImpl,
      ...clock(),
    }),
  };
}

describe("tag main CI gate", () => {
  it("accepts an exact main push match and queries only ci.yaml", async () => {
    const { result, fetchImpl } = gate([Response.json({ workflow_runs: [run] })]);
    await expect(result).resolves.toBe(run.id);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/repos/owner/repo/actions/workflows/ci.yaml/runs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      event: "push",
      branch: "main",
      head_sha: SHA,
      per_page: "100",
    });
  });

  it.each([
    ["wrong SHA", { head_sha: "b".repeat(40) }],
    ["tag push", { head_branch: "v0.8.0" }],
    ["PR", { event: "pull_request" }],
    ["dispatch", { event: "workflow_dispatch" }],
    ["another workflow", { path: ".github/workflows/other.yaml" }],
    ["tag run itself", { id: 99 }],
  ])("rejects %s", async (_name, overrides) => {
    const { result } = gate(
      Array.from({ length: 3 }, () => Response.json({ workflow_runs: [{ ...run, ...overrides }] })),
    );
    await expect(result).rejects.toThrow("Timed out");
  });

  it.each(["failure", "cancelled", "skipped", "timed_out", null])(
    "rejects a completed run with conclusion %s",
    async (conclusion) => {
      const { result } = gate([Response.json({ workflow_runs: [{ ...run, conclusion }] })]);
      await expect(result).rejects.toThrow("did not succeed");
    },
  );

  it("waits for a missing run to appear, then for completion", async () => {
    const { result, fetchImpl } = gate([
      Response.json({ workflow_runs: [] }),
      Response.json({ workflow_runs: [{ ...run, status: "in_progress", conclusion: null }] }),
      Response.json({ workflow_runs: [run] }),
    ]);
    await expect(result).resolves.toBe(run.id);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("times out when no matching run appears", async () => {
    const { result } = gate(Array.from({ length: 3 }, () => Response.json({ workflow_runs: [] })));
    await expect(result).rejects.toThrow("Timed out");
  });

  it("requires the newest matching run, even when an older run succeeded", async () => {
    const { result } = gate([
      Response.json({ workflow_runs: [run, { ...run, id: 21, conclusion: "failure" }] }),
    ]);
    await expect(result).rejects.toThrow("run 21 did not succeed");
  });

  it.each([401, 403, 429, 500])("fails closed on API HTTP %s", async (status) => {
    const { result } = gate([new Response("not logged", { status })]);
    await expect(result).rejects.toThrow(`HTTP ${status}`);
  });

  it("fails closed on malformed API JSON", async () => {
    await expect(gate([Response.json({})]).result).rejects.toThrow("Malformed");
    await expect(gate([new Response("not json")]).result).rejects.toThrow();
  });

  it("fails closed on transport errors", async () => {
    await expect(gate([]).result).rejects.toThrow("Unexpected request");
  });
});

function rollout(
  versions: unknown[],
  overrides: Record<string, Response> = {},
  expected = "0.8.0",
) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (overrides[pathname]) return overrides[pathname].clone();
    if (pathname === "/api/health") return Response.json({ status: "ok" });
    if (pathname === "/") return new Response("<!doctype html><html></html>");
    if (pathname !== "/api/version") throw new Error("Unexpected endpoint");
    const version = versions.shift();
    if (version === undefined) throw new Error("Unexpected version request");
    return Response.json(version);
  });
  return {
    fetchImpl,
    result: deploymentSmoke({ expectedVersion: expected, fetchImpl, ...clock() }),
  };
}

describe("deployment smoke", () => {
  it("checks reachability, expected version, root and health in order", async () => {
    const { result, fetchImpl } = rollout([{ version: "0.8.0" }]);
    await expect(result).resolves.toEqual({ status: "deployed", version: "0.8.0" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      ["/api/health", "/api/version", "/", "/api/health"].map(
        (pathname) => `http://beasty-arr.media.svc.cluster.local:9898${pathname}`,
      ),
    );
  });

  it("waits for older versions and compares numeric components", async () => {
    await expect(
      rollout([{ version: "0.8.0" }, { version: "0.9.0" }, { version: "0.10.0" }], {}, "0.10.0")
        .result,
    ).resolves.toEqual({ status: "deployed", version: "0.10.0" });
  });

  it("reports a newer version as superseded", async () => {
    await expect(rollout([{ version: "0.9.0" }]).result).resolves.toEqual({
      status: "superseded",
      version: "0.9.0",
    });
  });

  it.each([
    ["0.8.0-rc.2", "0.8.0-rc.10", "deployed"],
    ["0.8.0-rc.10", "0.8.0", "deployed"],
    ["0.8.0-a.2", "0.8.0-a.2.1", "deployed"],
    ["0.8.0-2", "0.8.0-a", "deployed"],
  ])("orders prereleases %s before %s", async (older, expected, status) => {
    await expect(
      rollout([{ version: older }, { version: expected }], {}, expected).result,
    ).resolves.toEqual({
      status,
      version: expected,
    });
  });

  it("ignores semver build metadata", async () => {
    await expect(rollout([{ version: "0.8.0+build.1" }]).result).resolves.toEqual({
      status: "deployed",
      version: "0.8.0+build.1",
    });
  });

  it.each([
    null,
    {},
    [],
    { version: 8 },
    { version: "garbage" },
    { version: "01.8.0" },
    { version: "0.8.0\n" },
    { version: "0.8.0-01" },
    { version: "0.8.0", unexpected: "field" },
  ])("rejects malformed version body %j", async (body) => {
    await expect(rollout([body]).result).rejects.toThrow("Malformed");
  });

  it("rejects invalid JSON", async () => {
    await expect(
      rollout([], { "/api/version": new Response("not json") }).result,
    ).rejects.toThrow();
  });

  it("times out on an older deployment", async () => {
    await expect(
      rollout(Array.from({ length: 3 }, () => ({ version: "0.7.0" }))).result,
    ).rejects.toThrow("timed out");
  });

  it.each(["/api/health", "/api/version", "/"])("fails on HTTP errors at %s", async (endpoint) => {
    const { result } = rollout([{ version: "0.8.0" }], {
      [endpoint]: new Response("not logged", { status: 503 }),
    });
    await expect(result).rejects.toThrow("HTTP 503");
  });

  it("fails reachability before polling", async () => {
    const { result, fetchImpl } = rollout([], {
      "/api/health": new Response("not logged", { status: 503 }),
    });
    await expect(result).rejects.toThrow("HTTP 503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed health response or empty page", async () => {
    await expect(
      rollout([], { "/api/health": Response.json({ status: "failed" }) }).result,
    ).rejects.toThrow("Malformed health");
    await expect(rollout([{ version: "0.8.0" }], { "/": new Response("") }).result).rejects.toThrow(
      "Empty application page",
    );
  });
});
