import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiboxRootUrl,
  authStoragePath,
  createPiRunner,
  FileCredentialStore,
  formatToolResult,
  getAuthStorage,
  InferenceTimeoutError,
  isRetryableProviderError,
  type PiRunnerDeps,
  type PiRunnerEnv,
  type PiSessionEvent,
  type PiSessionHandle,
  type PiSessionPlan,
  ProviderStallError,
  piSessionPlan,
  runPiSession,
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
    // Codex dropouts seen in prod on 2026-10-08.
    expect(
      isRetryableProviderError(
        new Error(
          "Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.",
        ),
      ),
    ).toBe(true);
    expect(isRetryableProviderError(new Error("WebSocket closed 1000"))).toBe(true);
    // Codex overload seen in prod on 2026-10-12 (6 runs failed without a retry).
    expect(
      isRetryableProviderError(
        new Error("Codex error: Our servers are currently overloaded. Please try again later."),
      ),
    ).toBe(true);
    expect(isRetryableProviderError(new Error("Model is over capacity"))).toBe(true);
    expect(isRetryableProviderError(new ProviderStallError(180_000))).toBe(true);
  });

  it("classifies auth/quota/config errors as terminal", () => {
    expect(isRetryableProviderError(new Error("invalid api key"))).toBe(false);
    expect(isRetryableProviderError(new Error("insufficient_quota"))).toBe(false);
    expect(isRetryableProviderError(new Error("429: The usage limit has been reached"))).toBe(
      false,
    );
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

  it("retries a Codex overload and succeeds", async () => {
    let attempts = 0;
    const result = await withProviderRetries(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(
            "Codex error: Our servers are currently overloaded. Please try again later.",
          );
        }
        return "ok";
      },
      { retryDelaysMs: [0] },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
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

  it("skips a retry whose wait would end past the deadline", async () => {
    let attempts = 0;
    const retries: number[] = [];
    await expect(
      withProviderRetries(
        async () => {
          attempts += 1;
          throw new Error("503 service unavailable");
        },
        {
          retryDelaysMs: [0, 60_000],
          deadline: 1_030_000,
          now: () => 1_000_000,
          onRetry: (attempt) => retries.push(attempt),
        },
      ),
    ).rejects.toThrow(/503/);
    expect(attempts).toBe(2);
    expect(retries).toEqual([1]);
  });

  it("aborts immediately while waiting for a provider retry", async () => {
    const controller = new AbortController();
    const task = withProviderRetries(
      async () => {
        throw new Error("503 service unavailable");
      },
      {
        signal: controller.signal,
        retryDelaysMs: [60_000],
        onRetry: () => controller.abort(new DOMException("cancelled", "AbortError")),
      },
    );

    await expect(task).rejects.toThrow(/cancelled/);
  });
});

type FakeSession = PiSessionHandle & { aborted: boolean; disposed: boolean };

/**
 * Scripted Pi session. Without a script, prompt() never emits and only ends
 * when abort() is called. With one, the script emits events, then the session
 * calls the terminating tool `finish` and answers "done".
 */
function fakeSession(
  script?: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
): FakeSession {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: unknown[] = [];
  let endPrompt = () => {};
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const session = {
    aborted: false,
    disposed: false,
    messages,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt() {
      const aborted = new Promise<"aborted">((resolve) => {
        endPrompt = () => resolve("aborted");
      });
      const work = script ? script(emit).then(() => "done" as const) : aborted;
      if ((await Promise.race([work, aborted])) === "aborted") return;
      emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "finish",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      } as AgentSessionEvent);
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 3, output: 2, cost: { total: 0.01 } },
      });
    },
    async abort() {
      session.aborted = true;
      endPrompt();
    },
    dispose() {
      session.disposed = true;
    },
  };
  return session as unknown as FakeSession;
}

function textDelta(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  } as AgentSessionEvent;
}

function sessionPlan(sessions: FakeSession[], overrides: Partial<PiSessionPlan> = {}) {
  let created = 0;
  const plan: PiSessionPlan = {
    provider: "codex",
    modelId: "test-model",
    timeoutMs: 900_000,
    stallTimeoutMs: 180_000,
    createSession: async () => {
      const session = sessions[created];
      created += 1;
      if (!session) throw new Error("no scripted session left");
      return session;
    },
    ...overrides,
  };
  return { plan, created: () => created };
}

describe("runPiSession stall timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const request = (events: PiSessionEvent[] = []) => ({
    system: "s",
    prompt: "p",
    tools: [],
    terminatingTool: "finish",
    onEvent: (event: PiSessionEvent) => events.push(event),
  });

  it("aborts a silent attempt after the stall timeout and retries it", async () => {
    vi.useFakeTimers();
    const silent = fakeSession();
    const healthy = fakeSession(async (emit) => emit(textDelta("thinking")));
    const { plan, created } = sessionPlan([silent, healthy]);
    const events: PiSessionEvent[] = [];
    const run = runPiSession(request(events), plan);

    await vi.advanceTimersByTimeAsync(179_999);
    expect(silent.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(silent.aborted).toBe(true);
    // First provider retry waits 2 s before the second attempt.
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await run;
    expect(result.text).toBe("done");
    expect(result.terminated).toBe(true);
    expect(created()).toBe(2);
    expect(healthy.aborted).toBe(false);
    expect(events.find((event) => event.type === "provider_retry")?.data).toMatchObject({
      attempt: 1,
      reason: "Provider stalled: no model output for 180 s.",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort an attempt that keeps emitting events", async () => {
    vi.useFakeTimers();
    const chatty = fakeSession(async (emit) => {
      for (let minute = 0; minute < 10; minute += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        emit(textDelta(`minute ${minute}`));
      }
    });
    const { plan, created } = sessionPlan([chatty]);
    const run = runPiSession(request(), plan);

    await vi.advanceTimersByTimeAsync(600_000);

    const result = await run;
    expect(result.text).toBe("done");
    expect(chatty.aborted).toBe(false);
    expect(created()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a stall when the retry wait would pass the shared deadline", async () => {
    vi.useFakeTimers();
    const silent = fakeSession();
    const { plan, created } = sessionPlan([silent, fakeSession(async () => {})], {
      timeoutMs: 181_000,
    });
    const settled = expect(runPiSession(request(), plan)).rejects.toBeInstanceOf(
      ProviderStallError,
    );

    await vi.advanceTimersByTimeAsync(180_000);

    await settled;
    expect(silent.aborted).toBe(true);
    expect(created()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a hung session creation as a stall and disposes the late session", async () => {
    vi.useFakeTimers();
    let finishHungCreation: (session: FakeSession) => void = () => {};
    const hung = new Promise<FakeSession>((resolve) => {
      finishHungCreation = resolve;
    });
    const healthy = fakeSession(async (emit) => emit(textDelta("thinking")));
    let created = 0;
    const { plan } = sessionPlan([], {
      createSession: async () => {
        created += 1;
        return created === 1 ? hung : healthy;
      },
    });
    const events: PiSessionEvent[] = [];
    const run = runPiSession(request(events), plan);

    await vi.advanceTimersByTimeAsync(180_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await run;
    expect(result.text).toBe("done");
    expect(created).toBe(2);
    expect(events.find((event) => event.type === "provider_retry")?.data).toMatchObject({
      reason: "Provider stalled: no model output for 180 s.",
    });
    const late = fakeSession();
    finishHungCreation(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("piSessionPlan", () => {
  const deps = (env: PiRunnerEnv): PiRunnerDeps => ({
    dataDir: "/unused",
    env,
    settings: { get: () => ({ aiProvider: "codex", aiModel: "gpt-5.5" }) },
  });
  const request = { system: "s", prompt: "p", tools: [], terminatingTool: "t" };

  it("wires PI_STALL_TIMEOUT_MS from env and defaults to 300 s", () => {
    expect(
      piSessionPlan(
        deps({ PI_INFERENCE_TIMEOUT_MS: 900_000, PI_STALL_TIMEOUT_MS: 60_000 }),
        request,
      ),
    ).toMatchObject({
      provider: "codex",
      modelId: "gpt-5.5",
      timeoutMs: 900_000,
      stallTimeoutMs: 60_000,
    });
    expect(piSessionPlan(deps({ PI_INFERENCE_TIMEOUT_MS: 900_000 }), request).stallTimeoutMs).toBe(
      300_000,
    );
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

describe("formatToolResult", () => {
  it("joins the text content parts of a Pi tool result", () => {
    expect(
      formatToolResult({
        content: [
          { type: "text", text: "line one" },
          { type: "image", data: "…", mimeType: "image/png" },
          { type: "text", text: "line two" },
        ],
        details: { ignored: true },
      }),
    ).toBe("line one\nline two");
  });

  it("falls back to JSON of details when there is no text content", () => {
    expect(formatToolResult({ content: [], details: { ok: true, id: 7 } })).toBe(
      '{"ok":true,"id":7}',
    );
    expect(formatToolResult(undefined)).toBeUndefined();
  });

  it("truncates long results with a marker naming the dropped length", () => {
    const text = formatToolResult({ content: [{ type: "text", text: "x".repeat(6_100) }] });
    expect(text).toBe(`${"x".repeat(6_000)}…[truncated 100 chars]`);
  });
});
