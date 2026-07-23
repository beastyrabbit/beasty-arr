import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiboxRootUrl,
  authStoragePath,
  createPiRunner,
  FileCredentialStore,
  getAuthStorage,
  InferenceTimeoutError,
  isRetryableProviderError,
  withProviderRetries,
} from "./providers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-ai-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("isRetryableProviderError", () => {
  it("classifies transient errors as retryable", () => {
    expect(isRetryableProviderError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableProviderError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableProviderError(new Error("Request timed out"))).toBe(true);
  });

  it("classifies auth/quota/config errors as terminal", () => {
    expect(isRetryableProviderError(new Error("invalid api key"))).toBe(false);
    expect(isRetryableProviderError(new Error("insufficient_quota"))).toBe(false);
    expect(isRetryableProviderError(new Error("Unauthorized"))).toBe(false);
    expect(isRetryableProviderError(new Error("something unexpected"))).toBe(false);
  });

  it("never retries timeouts or aborts", () => {
    expect(isRetryableProviderError(new InferenceTimeoutError(1000))).toBe(false);
    expect(isRetryableProviderError(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  it("uses status codes when present", () => {
    expect(isRetryableProviderError(Object.assign(new Error("boom"), { status: 503 }))).toBe(true);
    expect(isRetryableProviderError(Object.assign(new Error("boom"), { status: 400 }))).toBe(false);
    expect(
      isRetryableProviderError(Object.assign(new Error("authentication"), { status: 500 })),
    ).toBe(false);
  });
});

describe("withProviderRetries", () => {
  it("retries transient failures and succeeds", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const result = await withProviderRetries(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("503 service unavailable");
        return "ok";
      },
      { retryDelaysMs: [0, 0], onRetry: (attempt) => retries.push(attempt) },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("does not retry terminal errors", async () => {
    let attempts = 0;
    await expect(
      withProviderRetries(
        async () => {
          attempts += 1;
          throw new Error("invalid api key");
        },
        { retryDelaysMs: [0, 0] },
      ),
    ).rejects.toThrow(/invalid api key/);
    expect(attempts).toBe(1);
  });

  it("gives up when the retry budget is exhausted", async () => {
    let attempts = 0;
    await expect(
      withProviderRetries(
        async () => {
          attempts += 1;
          throw new Error("rate limit");
        },
        { retryDelaysMs: [0] },
      ),
    ).rejects.toThrow(/rate limit/);
    expect(attempts).toBe(2);
  });
});

describe("createPiRunner live-AI guard", () => {
  it("throws before touching any provider when running under tests", async () => {
    const runner = createPiRunner({
      dataDir: tempDir(),
      env: { PI_INFERENCE_TIMEOUT_MS: 1000 },
      settings: { get: () => ({ aiProvider: "codex", aiModel: "gpt-5.5" }) },
    });
    await expect(
      runner({ system: "s", prompt: "p", tools: [], terminatingTool: "t" }),
    ).rejects.toThrow(/forbidden in automated tests/);
  });
});

describe("FileCredentialStore", () => {
  it("persists credentials to the auth.json path and reads them back", async () => {
    const dir = tempDir();
    const store = getAuthStorage(dir);
    expect(store.filePath).toBe(authStoragePath(dir));
    expect(await store.read("openai-codex")).toBeUndefined();
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 123,
    }));
    // A fresh store over the same file sees the write.
    const reopened = new FileCredentialStore(authStoragePath(dir));
    const credential = await reopened.read("openai-codex");
    expect(credential).toMatchObject({ type: "oauth", access: "a", refresh: "r" });
    expect(await reopened.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    await reopened.delete("openai-codex");
    expect(await reopened.read("openai-codex")).toBeUndefined();
  });

  it("leaves the entry unchanged when modify returns undefined", async () => {
    const store = new FileCredentialStore(path.join(tempDir(), "auth.json"));
    await store.modify("x", async () => ({ type: "api_key", key: "k" }));
    const result = await store.modify("x", async () => undefined);
    expect(result).toMatchObject({ type: "api_key", key: "k" });
  });
});

describe("aiboxRootUrl", () => {
  it("strips trailing slashes and /v1", () => {
    expect(aiboxRootUrl("http://192.168.10.120:11434")).toBe("http://192.168.10.120:11434");
    expect(aiboxRootUrl("http://192.168.10.120:11434/")).toBe("http://192.168.10.120:11434");
    expect(aiboxRootUrl("http://192.168.10.120:11434/v1")).toBe("http://192.168.10.120:11434");
    expect(aiboxRootUrl("http://aibox.lan:11434/v1/")).toBe("http://aibox.lan:11434");
  });
});
