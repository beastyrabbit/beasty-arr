import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AssistantMessage,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type ProviderId = "codex" | "aibox";

/** Narrow structural view of SettingsService — only what the AI layer reads. */
export type AiSettingsSnapshot = {
  aiProvider: ProviderId | "off";
  aiModel: string;
};
export type AiSettingsPort = { get(): AiSettingsSnapshot };

export type PiRunnerEnv = {
  AIBOX_URL?: string;
  PI_INFERENCE_TIMEOUT_MS: number;
};

// ============ auth storage (persistent, DATA_DIR/pi/auth.json) ============

/**
 * File-backed pi-ai CredentialStore over Pi's auth.json format
 * (Record<providerId, Credential>). pi-coding-agent 0.80 no longer exports its
 * AuthStorage class, so this minimal store is ours: fresh disk reads per
 * operation, writes serialized through a promise chain (single-process app;
 * cross-process locking intentionally omitted). Pi's OAuth refresh runs
 * through `modify`, so rotated tokens land back in the file.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  private readAll(): Record<string, Credential> {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      return data && typeof data === "object" ? (data as Record<string, Credential>) : {};
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, Credential>): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => {});
    return next;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.enqueue(() => this.readAll()[providerId]);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.enqueue(() =>
      Object.entries(this.readAll()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const data = this.readAll();
      const next = await fn(data[providerId]);
      if (next !== undefined) {
        data[providerId] = next;
        this.writeAll(data);
      }
      return data[providerId];
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(() => {
      const data = this.readAll();
      if (providerId in data) {
        delete data[providerId];
        this.writeAll(data);
      }
    });
  }
}

const authStores = new Map<string, FileCredentialStore>();

export function authStoragePath(dataDir: string): string {
  return path.join(dataDir, "pi", "auth.json");
}

/** Persistent credential store under DATA_DIR/pi/ — Pi refreshes OAuth tokens in place. */
export function getAuthStorage(dataDir: string): FileCredentialStore {
  const authPath = authStoragePath(dataDir);
  let storage = authStores.get(authPath);
  if (!storage) {
    mkdirSync(path.dirname(authPath), { recursive: true });
    storage = new FileCredentialStore(authPath);
    authStores.set(authPath, storage);
  }
  return storage;
}

/**
 * Offline ModelRuntime over the built-in Pi catalog: no models.json on disk,
 * no network catalog refresh (deterministic, container-safe).
 */
export async function createModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
  return await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
}

// ============ aibox (Ollama OpenAI-compat) ============

/** AIBOX_URL with trailing slash and optional /v1 suffix stripped. */
export function aiboxRootUrl(aiboxUrl: string): string {
  return aiboxUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function registerAiboxProvider(runtime: ModelRuntime, aiboxUrl: string, modelId: string) {
  runtime.registerProvider("aibox", {
    name: "AI Box (Ollama)",
    baseUrl: `${aiboxRootUrl(aiboxUrl)}/v1`,
    apiKey: "ollama-local",
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 8_192,
      },
    ],
  });
}

// ============ error classification + retries (qa-council pattern) ============

export class InferenceTimeoutError extends Error {
  override name = "InferenceTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`Model inference exceeded the ${Math.round(timeoutMs / 60_000)} minute time limit.`);
  }
}

const TERMINAL_PROVIDER_ERROR =
  /(?:insufficient[_ -]?quota|out of budget|quota exceeded|billing|unauthori[sz]ed|forbidden|invalid api key|authentication|configuration)/i;
const RETRYABLE_PROVIDER_ERROR =
  /(?:\b408\b|\b429\b|\b5\d\d\b|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|upstream.?connect|reset before headers|socket hang up|websocket|timed? out|timeout|terminated|an error occurred while processing your request|you can retry your request)/i;

export function isRetryableProviderError(error: unknown): boolean {
  if (
    error instanceof InferenceTimeoutError ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return false;
  }
  if (
    error &&
    typeof error === "object" &&
    ("status" in error || "statusCode" in error) &&
    Number.isInteger(
      (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode,
    )
  ) {
    const status = Number(
      (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode,
    );
    const message = error instanceof Error ? error.message : String(error);
    if (TERMINAL_PROVIDER_ERROR.test(message)) return false;
    return status === 408 || status === 429 || status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  return !TERMINAL_PROVIDER_ERROR.test(message) && RETRYABLE_PROVIDER_ERROR.test(message);
}

const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [2_000, 8_000] as const;

async function waitForProviderRetry(delayMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function withProviderRetries<T>(
  task: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  } = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_PROVIDER_RETRY_DELAYS_MS;
  for (let retry = 0; ; retry += 1) {
    try {
      return await task();
    } catch (error) {
      options.signal?.throwIfAborted();
      const delayMs = retryDelaysMs[retry];
      if (delayMs === undefined || !isRetryableProviderError(error)) throw error;
      options.onRetry?.(retry + 1, error, delayMs);
      await waitForProviderRetry(delayMs, options.signal);
    }
  }
}

// ============ the single Pi session entry point ============

export type PiSessionEvent = { type: string; message: string; data?: unknown };

export type PiToolCall = { name: string; callId: string; args: unknown; isError: boolean };

export type PiSessionRequest = {
  system: string;
  prompt: string;
  /** Session tools; exactly one must be the terminating output tool named by `terminatingTool`. */
  tools: ToolDefinition[];
  /** Tool the model must call to finish. Runner re-prompts once when it was not called. */
  terminatingTool: string;
  /** Defaults to settings.aiProvider / settings.aiModel. */
  provider?: ProviderId;
  model?: string;
  signal?: AbortSignal;
  /** Defaults to env.PI_INFERENCE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Streamed step events (tool calls, retries, text deltas) for SSE forwarding. */
  onEvent?: (event: PiSessionEvent) => void;
};

export type PiSessionResult = {
  provider: ProviderId;
  model: string;
  text: string;
  toolCalls: PiToolCall[];
  /** Whether the terminating tool completed successfully at least once. */
  terminated: boolean;
  usage: { input: number; output: number; cost: number };
};

/** Injection seam: every AI feature takes a PiRunner so tests can script tool calls. */
export type PiRunner = (request: PiSessionRequest) => Promise<PiSessionResult>;

/** Hard guard: automated tests must never reach a live provider. */
export function assertLiveAiAllowed(): void {
  if (process.env.VITEST || process.env.BEASTY_ARR_FORBID_LIVE_AI) {
    throw new Error(
      "Live AI inference is forbidden in automated tests (VITEST/BEASTY_ARR_FORBID_LIVE_AI). Inject a fake PiRunner.",
    );
  }
}

export type PiRunnerDeps = {
  dataDir: string;
  env: PiRunnerEnv;
  settings: AiSettingsPort;
};

function resolveModel(
  registry: ModelRegistry,
  provider: ProviderId,
  modelId: string,
): Model<never> {
  const providerName = provider === "codex" ? "openai-codex" : "aibox";
  let model = registry.find(providerName, modelId);
  if (!model && provider === "codex") {
    // Unknown codex model id: clone a catalog entry as template (sonarr_fixer pattern).
    const template =
      registry.find("openai-codex", "gpt-5.5") ??
      registry.getAll().find((candidate) => candidate.provider === "openai-codex");
    if (template) model = { ...template, id: modelId, name: modelId };
  }
  if (!model) throw new Error(`Model not found: ${providerName}/${modelId} (configuration).`);
  return model as Model<never>;
}

async function runPiSessionAttempt(
  deps: PiRunnerDeps,
  request: PiSessionRequest,
  provider: ProviderId,
  modelId: string,
): Promise<PiSessionResult> {
  request.signal?.throwIfAborted();
  const authStorage = getAuthStorage(deps.dataDir);
  const runtime = await createModelRuntime(authStorage);
  if (provider === "aibox") {
    if (!deps.env.AIBOX_URL) throw new Error("AIBOX_URL is not set (configuration).");
    registerAiboxProvider(runtime, deps.env.AIBOX_URL, modelId);
  }
  const registry = new ModelRegistry(runtime);
  const model = resolveModel(registry, provider, modelId);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
    // We own one retry budget around fresh stateless sessions (withProviderRetries).
    retry: { enabled: false, provider: { maxRetries: 0 } },
    hideThinkingBlock: true,
  });
  const agentDir = path.dirname(authStoragePath(deps.dataDir));
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: request.system,
  });
  await resourceLoader.reload();
  request.signal?.throwIfAborted();

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: model.reasoning ? "high" : "off",
    tools: request.tools.map((tool) => tool.name),
    customTools: request.tools,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager,
    resourceLoader,
  });

  const toolCalls: PiToolCall[] = [];
  let terminated = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        request.onEvent?.({ type: "text_delta", message: event.assistantMessageEvent.delta });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      toolCalls.push({
        name: event.toolName,
        callId: event.toolCallId,
        args: event.args,
        isError: false,
      });
      request.onEvent?.({
        type: "tool_start",
        message: `AI tool: ${event.toolName}`,
        data: { name: event.toolName, callId: event.toolCallId, args: event.args },
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const call = toolCalls.find((entry) => entry.callId === event.toolCallId);
      if (call) call.isError = event.isError;
      if (event.toolName === request.terminatingTool && !event.isError) terminated = true;
      request.onEvent?.({
        type: "tool_end",
        message: `AI tool ${event.toolName} ${event.isError ? "failed" : "completed"}`,
        data: { name: event.toolName, callId: event.toolCallId, isError: event.isError },
      });
      return;
    }
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      request.onEvent?.({ type: event.type, message: `Pi: ${event.type}` });
    }
  });

  const timeoutMs = request.timeoutMs ?? deps.env.PI_INFERENCE_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = request.signal
    ? AbortSignal.any([request.signal, timeoutSignal])
    : timeoutSignal;
  const abortSession = () => {
    void session.abort().catch(() => {});
  };
  if (combinedSignal.aborted) abortSession();
  else combinedSignal.addEventListener("abort", abortSession, { once: true });

  try {
    let promptError: unknown;
    try {
      await session.prompt(request.prompt, { expandPromptTemplates: false, source: "rpc" });
      if (!terminated && !combinedSignal.aborted) {
        // pi-resolver pattern: one re-prompt when the forced terminating tool was skipped.
        request.onEvent?.({
          type: "terminating_tool_retry",
          message: `The model did not call ${request.terminatingTool}; re-prompting once.`,
        });
        await session.prompt(
          `You did not call ${request.terminatingTool}. Call it now with your final answer.`,
          { expandPromptTemplates: false, source: "rpc" },
        );
      }
    } catch (error) {
      promptError = error;
    }
    if (timeoutSignal.aborted && !request.signal?.aborted) {
      throw new InferenceTimeoutError(timeoutMs);
    }
    request.signal?.throwIfAborted();
    if (promptError) throw promptError;

    const message = [...session.messages].reverse().find((entry) => entry.role === "assistant") as
      | AssistantMessage
      | undefined;
    if (!message) throw new Error("The model returned no response.");
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The provider aborted the inference.");
    }
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n")
      .trim();
    return {
      provider,
      model: modelId,
      text,
      toolCalls,
      terminated,
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cost: message.usage.cost.total,
      },
    };
  } finally {
    combinedSignal.removeEventListener("abort", abortSession);
    unsubscribe();
    session.dispose();
  }
}

/**
 * Build the real PiRunner. The returned closure is the single entry point for
 * every AI feature (Dub Oracle, fixer resolver); tests inject a fake instead.
 */
export function createPiRunner(deps: PiRunnerDeps): PiRunner {
  return async (request) => {
    assertLiveAiAllowed();
    const snapshot = deps.settings.get();
    const provider = request.provider ?? snapshot.aiProvider;
    if (provider === "off") throw new Error("AI provider is disabled (aiProvider=off).");
    const modelId = request.model ?? snapshot.aiModel;
    return await withProviderRetries(() => runPiSessionAttempt(deps, request, provider, modelId), {
      signal: request.signal,
      onRetry: (attempt, error, delayMs) => {
        const reason = error instanceof Error ? error.message : String(error);
        request.onEvent?.({
          type: "provider_retry",
          message: `Retrying provider request in ${Math.round(delayMs / 1_000)}s after a transient error (${attempt}/2).`,
          data: { attempt, delayMs, reason },
        });
      },
    });
  };
}
