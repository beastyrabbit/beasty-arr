import { ModelRegistry, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  type AiSettingsPort,
  aiboxRootUrl,
  authStoragePath,
  createModelRuntime,
  getAuthStorage,
  type ProviderId,
} from "./providers.js";

export type AiModelInfo = {
  id: string;
  name: string;
  provider: ProviderId;
  contextWindow?: number;
  supportsReasoning?: boolean;
  available: boolean;
};

export type AiStatus = {
  provider: ProviderId | "off";
  model: string;
  status: "configured" | "unauthenticated" | "unavailable" | "off";
  detail?: string;
};

export type ModelCatalogDeps = {
  dataDir: string;
  env: { AIBOX_URL?: string };
  settings: AiSettingsPort;
  /** Injected for tests; only the aibox listing performs network I/O. */
  fetchImpl?: typeof fetch;
};

/**
 * Models per provider. Codex comes from the built-in Pi catalog (offline — no
 * codex app-server child process); aibox from the Ollama /api/tags endpoint.
 */
export async function listModels(
  provider: ProviderId,
  deps: ModelCatalogDeps,
): Promise<AiModelInfo[]> {
  if (provider === "aibox") {
    if (!deps.env.AIBOX_URL) return [];
    const fetchImpl = deps.fetchImpl ?? fetch;
    const root = aiboxRootUrl(deps.env.AIBOX_URL);
    try {
      const response = await fetchImpl(`${root}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Ollama model list failed (${response.status}).`);
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? [])
        .filter((model): model is { name: string } => typeof model.name === "string")
        .map((model) => ({
          id: model.name,
          name: model.name,
          provider: "aibox" as const,
          available: true,
        }));
    } catch {
      const fallback = deps.settings.get().aiModel;
      return [
        {
          id: fallback,
          name: `${fallback} (unreachable)`,
          provider: "aibox",
          available: false,
        },
      ];
    }
  }

  const runtime = await createModelRuntime(getAuthStorage(deps.dataDir));
  const registry = new ModelRegistry(runtime);
  return registry
    .getAll()
    .filter((model) => model.provider === "openai-codex")
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: "codex" as const,
      contextWindow: model.contextWindow,
      supportsReasoning: model.reasoning,
      available: true,
    }));
}

/** Synchronous status snapshot for /api/ai/status and the homepage widget. */
export function aiStatus(deps: ModelCatalogDeps): AiStatus {
  const snapshot = deps.settings.get();
  if (snapshot.aiProvider === "off") {
    return { provider: "off", model: snapshot.aiModel, status: "off" };
  }
  if (snapshot.aiProvider === "aibox") {
    if (!deps.env.AIBOX_URL) {
      return {
        provider: "aibox",
        model: snapshot.aiModel,
        status: "unavailable",
        detail: "AIBOX_URL is not set.",
      };
    }
    return { provider: "aibox", model: snapshot.aiModel, status: "configured" };
  }
  const credential = readStoredCredential("openai-codex", authStoragePath(deps.dataDir));
  if (!credential) {
    return {
      provider: "codex",
      model: snapshot.aiModel,
      status: "unauthenticated",
      detail: "Codex OAuth is not connected — run the device login from Settings → AI.",
    };
  }
  return { provider: "codex", model: snapshot.aiModel, status: "configured" };
}
