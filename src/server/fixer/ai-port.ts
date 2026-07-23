import type { MediaService } from "../../shared/fixer-types.js";

/**
 * Progress event streamed during a fixer analysis. Emitted by the resolver
 * (`step`) and by the Pi session runner (`tool-call`, `text`), persisted into
 * the analysis row and forwarded over the bus as `fixer.analysis.progress`.
 */
export type FixerAnalysisEvent =
  | {
      kind: "step";
      level: "info" | "warning" | "error";
      source: "fixer" | "pi" | "sonarr" | "radarr";
      message: string;
      ts: number;
      itemId?: number;
      details?: unknown;
    }
  | {
      kind: "tool-call";
      phase: "start" | "end";
      toolName: string;
      ts: number;
      itemId?: number;
      isError?: boolean;
      args?: unknown;
      result?: unknown;
    }
  | {
      kind: "text";
      delta: string;
      ts: number;
      itemId?: number;
    };

/**
 * One typed Pi analysis run. Contract for implementations (src/server/ai/):
 *
 * - Create ONE agent session with `systemPrompt` as the system prompt and
 *   exactly the custom tools in `tools` (built with pi-coding-agent's
 *   defineTool; `toolNames` is the session tool allowlist).
 * - Send `prompt`. When the session settles, evaluate `followUp?.when()`; if
 *   it returns true, send `followUp.prompt` in the SAME session (the typed
 *   proposal re-prompt retry). `when()` must be called at most once.
 * - `signal` aborts the session (session.abort()); the runner may then either
 *   resolve or reject — the caller checks `signal.aborted` afterwards.
 * - Emit `tool-call` events on tool execution start/end and `text` events for
 *   assistant text deltas via `onEvent`.
 * - Return every non-empty trimmed assistant text delta, in order, as `log`.
 */
export interface FixerPiRunRequest {
  service: MediaService;
  queueItemId: number;
  systemPrompt: string;
  prompt: string;
  followUp?: { prompt: string; when: () => boolean };
  /** Custom tools created with defineTool (lookup tools + terminating proposal tool). */
  tools: unknown[];
  /** Tool names to enable for the session, in order. */
  toolNames: string[];
  signal?: AbortSignal;
  onEvent?: (event: FixerAnalysisEvent) => void;
}

export interface FixerPiRunResult {
  /** Trimmed assistant text deltas, in order. */
  log: string[];
}

export type FixerPiRunner = (request: FixerPiRunRequest) => Promise<FixerPiRunResult>;
