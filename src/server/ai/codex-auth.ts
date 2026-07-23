import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, CredentialStore } from "@earendil-works/pi-ai";
import { nanoid } from "nanoid";
import { createModelRuntime, getAuthStorage } from "./providers.js";

// ============ dev-only seeding from ~/.codex/auth.json ============

type CodexAuthJson = {
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    account_id?: string;
  };
};

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function accountIdFromAccessToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const authClaim = payload?.["https://api.openai.com/auth"];
  if (!authClaim || typeof authClaim !== "object") return undefined;
  const accountId = (authClaim as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  return typeof accountId === "string" ? accountId : undefined;
}

/**
 * Dev convenience: when the persistent store has no openai-codex credential,
 * copy the OAuth tokens from the Codex CLI's ~/.codex/auth.json.
 */
export async function seedOpenAICodexAuthFromCodex(
  authStorage: CredentialStore,
  codexAuthPath: string = join(homedir(), ".codex", "auth.json"),
): Promise<boolean> {
  if (await authStorage.read("openai-codex")) return false;
  if (!existsSync(codexAuthPath)) return false;
  try {
    const codexAuth = JSON.parse(readFileSync(codexAuthPath, "utf8")) as CodexAuthJson;
    const access = codexAuth.tokens?.access_token;
    const refresh = codexAuth.tokens?.refresh_token;
    if (!access || !refresh) return false;
    const accountId = codexAuth.tokens?.account_id ?? accountIdFromAccessToken(access);
    if (!accountId) return false;
    await authStorage.modify("openai-codex", async () => ({
      type: "oauth",
      access,
      refresh,
      expires: codexAuth.tokens?.expires_at ?? Date.now() + 30 * 60 * 1000,
      accountId,
    }));
    return true;
  } catch {
    return false;
  }
}

// ============ web device-login flow (qa-council pattern) ============

export type CodexLoginStatus = "pending" | "waiting_user" | "done" | "error";

export type CodexLoginState = {
  status: CodexLoginStatus;
  verificationUri?: string;
  userCode?: string;
  message?: string;
  error?: string;
};

/** Narrow structural port over ModelRuntime — tests inject a fake. */
export type CodexLoginRuntime = {
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<unknown>;
};

type LoginEntry = {
  state: CodexLoginState;
  controller: AbortController;
  startedAt: number;
  settled: boolean;
};

const MAX_TRACKED_LOGINS = 20;

export class CodexLoginService {
  private readonly logins = new Map<string, LoginEntry>();

  constructor(private readonly getRuntime: () => Promise<CodexLoginRuntime>) {}

  startCodexLogin(): { loginId: string } {
    this.prune();
    const loginId = nanoid();
    const controller = new AbortController();
    this.logins.set(loginId, {
      state: { status: "pending", message: "Preparing login…" },
      controller,
      startedAt: Date.now(),
      settled: false,
    });
    void this.run(loginId, controller);
    return { loginId };
  }

  getCodexLogin(loginId: string): CodexLoginState | undefined {
    return this.logins.get(loginId)?.state;
  }

  /** Abort a pending login flow. Returns false when the id is unknown or already settled. */
  cancelCodexLogin(loginId: string): boolean {
    const entry = this.logins.get(loginId);
    if (!entry || entry.settled) return false;
    entry.controller.abort();
    return true;
  }

  private async run(loginId: string, controller: AbortController): Promise<void> {
    try {
      const runtime = await this.getRuntime();
      await runtime.login("openai-codex", "oauth", {
        signal: controller.signal,
        notify: (event) => {
          if (event.type === "auth_url") {
            this.patch(loginId, {
              status: "waiting_user",
              verificationUri: event.url,
              message: event.instructions ?? "Open the login page.",
            });
          } else if (event.type === "device_code") {
            this.patch(loginId, {
              status: "waiting_user",
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              message: "Confirm the code on the OpenAI page.",
            });
          } else {
            this.patch(loginId, { message: event.message });
          }
        },
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            const first = prompt.options[0]?.id;
            if (first) return first;
          }
          throw new Error(
            "Interactive input required — this web login flow only supports the device-code path.",
          );
        },
      });
      this.settle(loginId, { status: "done", message: "Codex is signed in." });
    } catch (error) {
      const message = controller.signal.aborted
        ? "Login cancelled."
        : error instanceof Error
          ? error.message
          : String(error);
      this.settle(loginId, { status: "error", error: message });
    }
  }

  private patch(loginId: string, patch: Partial<CodexLoginState>): void {
    const entry = this.logins.get(loginId);
    if (!entry || entry.settled) return;
    entry.state = { ...entry.state, ...patch };
  }

  private settle(loginId: string, state: CodexLoginState): void {
    const entry = this.logins.get(loginId);
    if (!entry) return;
    entry.state = state;
    entry.settled = true;
  }

  /** Drop the oldest settled entries so the in-memory map stays bounded. */
  private prune(): void {
    if (this.logins.size < MAX_TRACKED_LOGINS) return;
    const settled = [...this.logins.entries()]
      .filter(([, entry]) => entry.settled)
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [id] of settled) {
      if (this.logins.size < MAX_TRACKED_LOGINS) break;
      this.logins.delete(id);
    }
  }
}

export function createCodexLoginService(dataDir: string): CodexLoginService {
  return new CodexLoginService(async () => await createModelRuntime(getAuthStorage(dataDir)));
}
