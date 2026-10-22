import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
const NUMERIC = /^\d+$/;

class DeploymentError extends Error {}
class TransportError extends DeploymentError {}

function parseVersion(value: unknown): string[] {
  if (typeof value !== "string") throw new DeploymentError("Malformed version response");
  const match = SEMVER.exec(value);
  if (
    !match ||
    match[0] !== value ||
    match[4]?.split(".").some((id) => NUMERIC.test(id) && id.length > 1 && id[0] === "0")
  ) {
    throw new DeploymentError("Malformed version response");
  }
  return [match[1], match[2], match[3], ...(match[4]?.split(".") ?? [])];
}

function compareIdentifiers(actual: string, expected: string): number {
  const aNumeric = NUMERIC.test(actual);
  const bNumeric = NUMERIC.test(expected);
  if (aNumeric && bNumeric) return BigInt(actual) > BigInt(expected) ? 1 : -1;
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return actual > expected ? 1 : -1;
}

function compareVersions(actual: string[], expected: string[]): number {
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== expected[i]) return compareIdentifiers(actual[i], expected[i]);
  }
  if (actual.length === 3 || expected.length === 3) {
    return actual.length === expected.length ? 0 : actual.length === 3 ? 1 : -1;
  }
  for (let i = 3; i < Math.max(actual.length, expected.length); i++) {
    if (actual[i] === undefined || expected[i] === undefined)
      return actual[i] === undefined ? -1 : 1;
    if (actual[i] === expected[i]) continue;
    return compareIdentifiers(actual[i], expected[i]);
  }
  return 0;
}

export async function deploymentSmoke({
  expectedVersion,
  baseUrl = "http://beasty-arr.media.svc.cluster.local:9898",
  timeoutMs = 30 * 60_000,
  intervalMs = 10_000,
  fetchImpl = fetch,
  now = Date.now,
  pause = sleep,
}: {
  expectedVersion: string;
  baseUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pause?: (ms: number) => Promise<unknown>;
}): Promise<{ status: "deployed" | "superseded"; version: string }> {
  const expected = parseVersion(expectedVersion);
  const deadline = now() + timeoutMs;
  async function request(endpoint: string): Promise<Response> {
    if (now() >= deadline) throw new DeploymentError("Deployment check timed out");
    let response: Response;
    try {
      response = await fetchImpl(new URL(endpoint, baseUrl), {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(10_000, deadline - now())),
      });
    } catch {
      throw new TransportError(`${endpoint} request failed before receiving an HTTP response`);
    }
    if (response.status !== 200)
      throw new DeploymentError(`${endpoint} returned HTTP ${response.status}`);
    return response;
  }
  async function readJson(response: Response, kind: string) {
    try {
      return await response.json();
    } catch {
      throw new DeploymentError(`Malformed ${kind} response`);
    }
  }
  async function checkHealth(): Promise<void> {
    const body = await readJson(await request("/api/health"), "health");
    if (body?.status !== "ok" || Object.keys(body).length !== 1) {
      throw new DeploymentError("Malformed health response");
    }
  }

  // Verify in-cluster DNS, routing and HTTP before waiting for Flux to reconcile.
  await checkHealth();
  while (now() < deadline) {
    let response: Response;
    try {
      response = await request("/api/version");
    } catch (error) {
      // Recreate rollouts briefly leave the Service without endpoints.
      if (!(error instanceof TransportError)) throw error;
      await pause(Math.max(0, Math.min(intervalMs, deadline - now())));
      continue;
    }
    const body = await readJson(response, "version");
    if (!body || Object.keys(body).length !== 1)
      throw new DeploymentError("Malformed version response");
    const comparison = compareVersions(parseVersion(body.version), expected);
    if (comparison >= 0) {
      const root = await request("/");
      if (!(await root.text()).trim()) throw new DeploymentError("Empty application page");
      await checkHealth();
      return { status: comparison === 0 ? "deployed" : "superseded", version: body.version };
    }
    await pause(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
  throw new DeploymentError("Deployment check timed out");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tag = process.env.GITHUB_REF_NAME;
    if (!tag?.startsWith("v")) throw new DeploymentError("A v* release tag is required");
    const result = await deploymentSmoke({ expectedVersion: tag.slice(1) });
    process.stdout.write(`Release ${tag}: ${result.status} (running ${result.version})\n`);
  } catch (error) {
    const reason = error instanceof DeploymentError ? error.message : "Unexpected deployment error";
    process.stderr.write(`Deployment smoke failed: ${reason}.\n`);
    process.exitCode = 1;
  }
}
