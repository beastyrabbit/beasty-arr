import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AssistantMessage,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  type AgentSessionEvent,
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
  aiThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
export type AiSettingsPort = { get(): AiSettingsSnapshot };

export type PiRunnerEnv = {
  AIBOX_URL?: string;
  PI_INFERENCE_TIMEOUT_MS: number;
  /** Defaults to DEFAULT_PI_STALL_TIMEOUT_MS. */
  PI_STALL_TIMEOUT_MS?: number;
};

/**
 * Longest silence allowed inside one attempt. Model output arrives every few
 * seconds, but a single media-inspection tool call can run about 3 minutes
 * without events; the longest successful prod run took 5.4 minutes in total.
 */
export const DEFAULT_PI_STALL_TIMEOUT_MS = 300_000;

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
 * ModelRuntime over the built-in Pi catalog plus Pi's pi.dev catalog overlay,
 * cached in DATA_DIR/pi/models-store.json. Only `refreshCatalog` runtimes (the
 * Settings model list) fetch pi.dev: at most every 4h after an HTTP answer, but
 * again on each call after a network error or timeout (Pi records no check
 * then). All others read the cached overlay offline, so newly released Codex
 * models resolve with their real metadata without a package bump.
 */
export async function createModelRuntime(
  dataDir: string,
  options: { refreshCatalog?: boolean } = {},
): Promise<ModelRuntime> {
  return await ModelRuntime.create({
    credentials: getAuthStorage(dataDir),
    // Pi keeps the refreshed catalog in models-store.json beside this (absent) models.json.
    modelsPath: path.join(path.dirname(authStoragePath(dataDir)), "models.json"),
    allowModelNetwork: options.refreshCatalog ?? false,
    modelRefreshTimeoutMs: 5_000,
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

/** One attempt saw no session event for the stall timeout; a fresh attempt may still succeed. */
export class ProviderStallError extends Error {
  override name = "ProviderStallError";
  constructor(readonly stallTimeoutMs: number) {
    super(`Provider stalled: no model output for ${Math.round(stallTimeoutMs / 1_000)} s.`);
  }
}

const TERMINAL_PROVIDER_ERROR =
  /(?:usage limit|insufficient[_ -]?quota|out of budget|quota exceeded|billing|unauthori[sz]ed|forbidden|invalid api key|authentication|configuration)/i;
const RETRYABLE_PROVIDER_ERROR =
  /(?:\b408\b|\b429\b|\b5\d\d\b|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|upstream.?connect|reset before headers|socket hang up|websocket|timed? out|timeout|terminated|overloaded|over capacity|try again later|an error occurred while processing your request|you can retry your request)/i;

export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof ProviderStallError) return true;
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

// Codex drops requests with a generic server error in bursts lasting minutes,
// so the budget spans ~4 minutes; cancel still aborts the wait immediately.
const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 120_000] as const;

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
    /** Epoch ms; a retry that could not start before it is skipped and the error rethrown. */
    deadline?: number;
    now?: () => number;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  } = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_PROVIDER_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  for (let retry = 0; ; retry += 1) {
    try {
      return await task();
    } catch (error) {
      options.signal?.throwIfAborted();
      const delayMs = retryDelaysMs[retry];
      if (delayMs === undefined || !isRetryableProviderError(error)) throw error;
      if (options.deadline !== undefined && now() + delayMs >= options.deadline) throw error;
      options.onRetry?.(retry + 1, error, delayMs);
      await waitForProviderRetry(delayMs, options.signal);
    }
  }
}

// ============ the single Pi session entry point ============

export type PiSessionEvent = { type: string; message: string; data?: unknown };

/** Upper bound for a tool result forwarded in a `tool_end` event (audit trail, not the model's view). */
export const TOOL_RESULT_MAX_CHARS = 6_000;

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Pi's tool_execution_end `result` is an AgentToolResult ({content, details}).
 * Returns the joined text content parts, else JSON of `details` (or of the
 * whole value), truncated to TOOL_RESULT_MAX_CHARS.
 */
export function formatToolResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return truncateText(result, TOOL_RESULT_MAX_CHARS);
  const { content, details } = result as { content?: unknown; details?: unknown };
  const texts = Array.isArray(content)
    ? content.flatMap((part) =>
        part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
          ? [part.text as string]
          : [],
      )
    : [];
  if (texts.length > 0) return truncateText(texts.join("\n"), TOOL_RESULT_MAX_CHARS);
  const payload = details === undefined ? result : details;
  return truncateText(safeJson(payload), TOOL_RESULT_MAX_CHARS);
}

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

/** Endpoint of Pi's built-in Codex provider; the Codex OAuth token is sent to model.baseUrl. */
const CODEX_BASE_URL = openaiCodexProvider().baseUrl ?? "https://chatgpt.com/backend-api";

export function resolveModel(
  registry: ModelRegistry,
  provider: ProviderId,
  modelId: string,
): Model<never> {
  const providerName = provider === "codex" ? "openai-codex" : "aibox";
  let model = registry.find(providerName, modelId);
  if (!model && provider === "codex") {
    // Unknown codex model id: clone a catalog entry as template (sonarr_fixer pattern).
    const template =
      registry.find("openai-codex", "gpt-5.6-terra") ??
      registry.find("openai-codex", "gpt-5.5") ??
      registry.getAll().find((candidate) => candidate.provider === "openai-codex");
    if (template) model = { ...template, id: modelId, name: modelId };
  }
  if (!model) throw new Error(`Model not found: ${providerName}/${modelId} (configuration).`);
  // pi.dev catalog entries may add metadata but never redirect the Codex token.
  if (provider === "codex") model = { ...model, baseUrl: CODEX_BASE_URL };
  return model as Model<never>;
}

function addAssistantUsage(total: PiSessionResult["usage"], message: { role?: unknown }): void {
  if (message.role !== "assistant") return;
  const turn = (message as AssistantMessage).usage;
  total.input += turn?.input ?? 0;
  total.output += turn?.output ?? 0;
  total.cost += turn?.cost?.total ?? 0;
}

/**
 * Collects tool calls, usage and the terminating-tool signal from one session
 * and forwards step events (tool calls, results, text and thinking deltas).
 */
function createSessionTracker(request: PiSessionRequest) {
  const tracker = {
    toolCalls: [] as PiToolCall[],
    terminated: false,
    // Summed over every assistant turn of this attempt (tool loops bill each turn).
    usage: { input: 0, output: 0, cost: 0 },
    listener: (event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_end":
          addAssistantUsage(tracker.usage, event.message);
          return;
        case "message_update":
          forwardDelta(request, event.assistantMessageEvent);
          return;
        case "tool_execution_start":
          tracker.toolCalls.push({
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
        case "tool_execution_end":
          recordToolEnd(request, tracker, event);
          return;
        case "compaction_start":
        case "compaction_end":
          request.onEvent?.({ type: event.type, message: `Pi: ${event.type}` });
          return;
        default:
          return;
      }
    },
  };
  return tracker;
}

function forwardDelta(
  request: PiSessionRequest,
  update: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
): void {
  if (update.type === "text_delta" || update.type === "thinking_delta") {
    request.onEvent?.({ type: update.type, message: update.delta });
  }
}

function recordToolEnd(
  request: PiSessionRequest,
  tracker: { toolCalls: PiToolCall[]; terminated: boolean },
  event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
): void {
  const call = tracker.toolCalls.find((entry) => entry.callId === event.toolCallId);
  if (call) call.isError = event.isError;
  if (event.toolName === request.terminatingTool && !event.isError) tracker.terminated = true;
  request.onEvent?.({
    type: "tool_end",
    message: `AI tool ${event.toolName} ${event.isError ? "failed" : "completed"}`,
    data: {
      name: event.toolName,
      callId: event.toolCallId,
      args: call?.args,
      result: formatToolResult(event.result),
      isError: event.isError,
    },
  });
}

/** The slice of a Pi AgentSession the runner drives; tests pass a scripted fake. */
export type PiSessionHandle = Pick<
  AgentSession,
  "messages" | "subscribe" | "prompt" | "abort" | "dispose"
>;

function finalAssistantMessage(session: PiSessionHandle): AssistantMessage | undefined {
  return [...session.messages].reverse().find((entry) => entry.role === "assistant") as
    | AssistantMessage
    | undefined;
}

/**
 * Sends the prompt and re-prompts once when the terminating tool was skipped
 * (pi-resolver pattern). Returns the prompt error instead of throwing so the
 * caller can classify timeouts and aborts first.
 */
async function promptUntilTerminated(
  session: PiSessionHandle,
  request: PiSessionRequest,
  tracker: { terminated: boolean },
  signal: AbortSignal,
): Promise<unknown> {
  try {
    await session.prompt(request.prompt, { expandPromptTemplates: false, source: "rpc" });
    const response = finalAssistantMessage(session);
    if (response?.stopReason === "error") {
      throw new Error(response.errorMessage || "The provider aborted the inference.");
    }
    if (tracker.terminated || signal.aborted) return undefined;
    request.onEvent?.({
      type: "terminating_tool_retry",
      message: `The model did not call ${request.terminatingTool}; re-prompting once.`,
    });
    await session.prompt(
      `You did not call ${request.terminatingTool}. Call it now with your final answer.`,
      { expandPromptTemplates: false, source: "rpc" },
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

/** One fresh, stateless Pi agent session with exactly the request's tools. */
async function createPiSession(
  deps: PiRunnerDeps,
  request: PiSessionRequest,
  provider: ProviderId,
  modelId: string,
): Promise<AgentSession> {
  request.signal?.throwIfAborted();
  const runtime = await createModelRuntime(deps.dataDir);
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
    thinkingLevel: model.reasoning ? (deps.settings.get().aiThinkingLevel ?? "high") : "off",
    tools: request.tools.map((tool) => tool.name),
    customTools: request.tools,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager,
    resourceLoader,
  });
  return session;
}

/** Everything one runner call needs besides the request; `createSession` is the test seam. */
export type PiSessionPlan = {
  provider: ProviderId;
  modelId: string;
  /** One inference limit shared by every attempt. */
  timeoutMs: number;
  /** An attempt that sees no session event for this long is aborted and retried. */
  stallTimeoutMs: number;
  createSession: () => Promise<PiSessionHandle>;
};

/**
 * Aborts its signal with a ProviderStallError once `stallTimeoutMs` passes
 * without `touch()`. Armed on creation; `stop()` clears the timer for good.
 */
function startStallWatch(stallTimeoutMs: number) {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new ProviderStallError(stallTimeoutMs));
    }, stallTimeoutMs);
  };
  arm();
  return {
    signal: controller.signal,
    touch: () => {
      if (!stopped && !controller.signal.aborted) arm();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Settles with `promise` unless `signal` aborts first; a value that arrives
 * after the abort is handed to `onLate` so it can be released.
 */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLate: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      promise.then(onLate, () => {});
      reject(signal.reason);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Abort state of one attempt: user cancel, shared deadline, and stall watch. */
type AttemptGuard = {
  deadline: number;
  signal: AbortSignal;
  stall: ReturnType<typeof startStallWatch>;
  /** Throws the classified abort error (timeout, cancel, stall) if any fired. */
  throwIfAborted: () => void;
};

async function runPiSessionAttempt(
  request: PiSessionRequest,
  plan: PiSessionPlan,
  deadline: number,
): Promise<PiSessionResult> {
  const { timeoutMs } = plan;
  if (Date.now() >= deadline) throw new InferenceTimeoutError(timeoutMs);
  // Armed before session creation so a hung model/session setup also counts as a stall.
  const stall = startStallWatch(plan.stallTimeoutMs);
  const timeoutSignal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const guard: AttemptGuard = {
    deadline,
    stall,
    signal: AbortSignal.any(
      request.signal
        ? [request.signal, timeoutSignal, stall.signal]
        : [timeoutSignal, stall.signal],
    ),
    throwIfAborted: () => {
      if (timeoutSignal.aborted && !request.signal?.aborted) {
        throw new InferenceTimeoutError(timeoutMs);
      }
      request.signal?.throwIfAborted();
      if (stall.signal.aborted) throw stall.signal.reason;
    },
  };
  let session: PiSessionHandle;
  try {
    session = await untilAborted(plan.createSession(), guard.signal, (late) => late.dispose());
  } catch (error) {
    stall.stop();
    guard.throwIfAborted();
    throw error;
  }
  return await promptPiSession(session, request, plan, guard);
}

async function promptPiSession(
  session: PiSessionHandle,
  request: PiSessionRequest,
  plan: PiSessionPlan,
  guard: AttemptGuard,
): Promise<PiSessionResult> {
  const { provider, modelId, timeoutMs } = plan;
  const { stall, signal: combinedSignal } = guard;
  const tracker = createSessionTracker(request);
  const { toolCalls, usage } = tracker;
  const unsubscribe = session.subscribe((event) => {
    stall.touch();
    tracker.listener(event);
  });
  const abortSession = () => {
    void session.abort().catch(() => {});
  };
  if (combinedSignal.aborted) abortSession();
  else combinedSignal.addEventListener("abort", abortSession, { once: true });

  try {
    // Session setup can itself outlast the deadline; never start prompting past it.
    if (Date.now() >= guard.deadline) throw new InferenceTimeoutError(timeoutMs);
    const promptError = await promptUntilTerminated(session, request, tracker, combinedSignal);
    guard.throwIfAborted();
    if (promptError) throw promptError;

    const message = finalAssistantMessage(session);
    if (!message) throw new Error("The model returned no response.");
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The provider aborted the inference.");
    }
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n")
      .trim();
    // Fall back to the final turn if no message_end was observed.
    const turnUsage = {
      input: message.usage.input,
      output: message.usage.output,
      cost: message.usage.cost.total,
    };
    return {
      provider,
      model: modelId,
      text,
      toolCalls,
      terminated: tracker.terminated,
      usage: usage.input + usage.output > 0 ? usage : turnUsage,
    };
  } finally {
    combinedSignal.removeEventListener("abort", abortSession);
    unsubscribe();
    stall.stop();
    session.dispose();
  }
}

/**
 * Runs fresh session attempts under one shared deadline, retrying transient
 * provider errors and stalls. Exported so tests can drive it with fake sessions.
 */
export async function runPiSession(
  request: PiSessionRequest,
  plan: PiSessionPlan,
): Promise<PiSessionResult> {
  // One inference limit across all attempts so retries cannot stack fresh limits.
  const deadline = Date.now() + plan.timeoutMs;
  return await withProviderRetries(() => runPiSessionAttempt(request, plan, deadline), {
    signal: request.signal,
    deadline,
    onRetry: (attempt, error, delayMs) => {
      const reason = error instanceof Error ? error.message : String(error);
      request.onEvent?.({
        type: "provider_retry",
        message: `Retrying provider request in ${Math.round(delayMs / 1_000)}s after a transient error (${attempt}/${DEFAULT_PROVIDER_RETRY_DELAYS_MS.length}).`,
        data: { attempt, delayMs, reason },
      });
    },
  });
}

/**
 * Build the real PiRunner. The returned closure is the single entry point for
 * every AI feature (Dub Oracle, fixer resolver); tests inject a fake instead.
 */
export function createPiRunner(deps: PiRunnerDeps): PiRunner {
  return async (request) => {
    assertLiveAiAllowed();
    return await runPiSession(request, piSessionPlan(deps, request));
  };
}

/** Resolves provider, model and limits for one request from settings and env. */
export function piSessionPlan(deps: PiRunnerDeps, request: PiSessionRequest): PiSessionPlan {
  const snapshot = deps.settings.get();
  const provider = request.provider ?? snapshot.aiProvider;
  if (provider === "off") throw new Error("AI provider is disabled (aiProvider=off).");
  const modelId = request.model ?? snapshot.aiModel;
  return {
    provider,
    modelId,
    timeoutMs: request.timeoutMs ?? deps.env.PI_INFERENCE_TIMEOUT_MS,
    stallTimeoutMs: deps.env.PI_STALL_TIMEOUT_MS ?? DEFAULT_PI_STALL_TIMEOUT_MS,
    createSession: () => createPiSession(deps, request, provider, modelId),
  };
}
