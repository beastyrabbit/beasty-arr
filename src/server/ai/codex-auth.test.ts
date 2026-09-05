import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexLoginRuntime,
  CodexLoginService,
  seedOpenAICodexAuthFromCodex,
} from "./codex-auth.js";
import { createModelRuntime, FileCredentialStore } from "./providers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-codex-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(): FileCredentialStore {
  return new FileCredentialStore(path.join(tempDir(), "auth.json"));
}

function writeCodexAuth(tokens: Record<string, unknown>): string {
  const file = path.join(tempDir(), "codex-auth.json");
  writeFileSync(file, JSON.stringify({ tokens }));
  return file;
}

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

describe("seedOpenAICodexAuthFromCodex", () => {
  it("seeds oauth tokens from ~/.codex/auth.json into an empty store", async () => {
    const store = makeStore();
    const file = writeCodexAuth({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: 1234567890,
      account_id: "acct-1",
    });
    expect(await seedOpenAICodexAuthFromCodex(store, file)).toBe(true);
    expect(await store.read("openai-codex")).toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 1234567890,
      accountId: "acct-1",
    });
  });

  it("derives the account id from the access-token JWT when absent", async () => {
    const store = makeStore();
    const access = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
    });
    const file = writeCodexAuth({ access_token: access, refresh_token: "r" });
    expect(await seedOpenAICodexAuthFromCodex(store, file)).toBe(true);
    expect(await store.read("openai-codex")).toMatchObject({ accountId: "acct-jwt" });
  });

  it("never overwrites an existing credential", async () => {
    const store = makeStore();
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "keep",
      refresh: "keep",
      expires: 1,
    }));
    const file = writeCodexAuth({ access_token: "new", refresh_token: "new", account_id: "a" });
    expect(await seedOpenAICodexAuthFromCodex(store, file)).toBe(false);
    expect(await store.read("openai-codex")).toMatchObject({ access: "keep" });
  });

  it("returns false for a missing or unusable auth file", async () => {
    const store = makeStore();
    expect(await seedOpenAICodexAuthFromCodex(store, path.join(tempDir(), "nope.json"))).toBe(
      false,
    );
    const noAccount = writeCodexAuth({ access_token: "not-a-jwt", refresh_token: "r" });
    expect(await seedOpenAICodexAuthFromCodex(store, noAccount)).toBe(false);
  });
});

type FakeLogin = {
  interaction?: AuthInteraction;
  resolve: (credential: Credential) => void;
  reject: (error: unknown) => void;
};

function fakeRuntime(): { runtime: { login: never }; login: FakeLogin } {
  const login: FakeLogin = { resolve: () => {}, reject: () => {} };
  const runtime = {
    login: (_provider: string, _type: "oauth", interaction: AuthInteraction) => {
      login.interaction = interaction;
      return new Promise<Credential>((resolve, reject) => {
        login.resolve = resolve;
        login.reject = reject;
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
  };
  return { runtime: runtime as never, login };
}

describe("CodexLoginService", () => {
  it("drives the installed Pi provider into its device-code flow", async () => {
    const requestedUrls: string[] = [];
    let pollingSignal: AbortSignal | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requestedUrls.push(url);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(
          JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 60 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        pollingSignal = init?.signal ?? null;
        return new Response(null, { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const runtime = await createModelRuntime(makeStore());
    const service = new CodexLoginService(async () => runtime);

    const { loginId } = service.startCodexLogin();
    await vi.waitFor(() => expect(service.getCodexLogin(loginId)?.status).not.toBe("pending"));
    expect(service.getCodexLogin(loginId)).toEqual({
      status: "waiting_user",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      message: "Confirm the code on the OpenAI page.",
    });
    expect(requestedUrls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
    ]);
    expect((pollingSignal as AbortSignal | null)?.aborted).toBe(false);

    expect(service.cancelCodexLogin(loginId)).toBe(true);
    await vi.waitFor(() => expect(service.getCodexLogin(loginId)?.status).toBe("error"));
    expect((pollingSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("walks the device-login flow: pending → waiting_user → done", async () => {
    const { runtime, login } = fakeRuntime();
    const service = new CodexLoginService(async () => runtime);
    const { loginId } = service.startCodexLogin();
    expect(service.getCodexLogin(loginId)?.status).toBe("pending");

    await vi.waitFor(() => expect(login.interaction).toBeDefined());
    login.interaction?.notify({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://auth.openai.com/device",
    });
    expect(service.getCodexLogin(loginId)).toMatchObject({
      status: "waiting_user",
      verificationUri: "https://auth.openai.com/device",
      userCode: "ABCD-1234",
    });

    login.resolve({ type: "oauth", access: "a", refresh: "r", expires: 1 });
    await vi.waitFor(() => expect(service.getCodexLogin(loginId)?.status).toBe("done"));
  });

  it("reports auth_url events and login failures", async () => {
    const { runtime, login } = fakeRuntime();
    const service = new CodexLoginService(async () => runtime);
    const { loginId } = service.startCodexLogin();
    await vi.waitFor(() => expect(login.interaction).toBeDefined());
    login.interaction?.notify({ type: "auth_url", url: "https://login", instructions: "Open it" });
    expect(service.getCodexLogin(loginId)).toMatchObject({
      status: "waiting_user",
      verificationUri: "https://login",
    });
    login.reject(new Error("device code expired"));
    await vi.waitFor(() =>
      expect(service.getCodexLogin(loginId)).toMatchObject({
        status: "error",
        error: "device code expired",
      }),
    );
  });

  it("selects device-code login even when browser login is the first option", async () => {
    const { runtime, login } = fakeRuntime();
    const service = new CodexLoginService(async () => runtime);
    service.startCodexLogin();
    await vi.waitFor(() => expect(login.interaction).toBeDefined());
    await expect(
      login.interaction?.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      }),
    ).resolves.toBe("device_code");
  });

  it("handles later select prompts after choosing the device-code login method", async () => {
    const { runtime, login } = fakeRuntime();
    const service = new CodexLoginService(async () => runtime);
    service.startCodexLogin();
    await vi.waitFor(() => expect(login.interaction).toBeDefined());
    await expect(
      login.interaction?.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login" },
          { id: "device_code", label: "Device code login" },
        ],
      }),
    ).resolves.toBe("device_code");
    await expect(
      login.interaction?.prompt({
        type: "select",
        message: "Select a workspace:",
        options: [{ id: "first", label: "First" }],
      }),
    ).resolves.toBe("first");
    await expect(
      login.interaction?.prompt({ type: "text", message: "enter something" }),
    ).rejects.toThrow(/Interactive input/);
  });

  it("surfaces a terminal service error when device-code login is unavailable", async () => {
    const runtime: CodexLoginRuntime = {
      login: async (_providerId, _type, interaction) => {
        await interaction.prompt({
          type: "select",
          message: "Select OpenAI Codex login method:",
          options: [{ id: "browser", label: "Browser login" }],
        });
      },
    };
    const service = new CodexLoginService(async () => runtime);
    const { loginId } = service.startCodexLogin();

    await vi.waitFor(() =>
      expect(service.getCodexLogin(loginId)).toEqual({
        status: "error",
        error:
          "The installed Codex provider does not offer device-code login. Update the provider and try again.",
      }),
    );
  });

  it("cancel aborts the flow and settles as error", async () => {
    const { runtime, login } = fakeRuntime();
    const service = new CodexLoginService(async () => runtime);
    const { loginId } = service.startCodexLogin();
    await vi.waitFor(() => expect(login.interaction).toBeDefined());
    expect(service.cancelCodexLogin(loginId)).toBe(true);
    await vi.waitFor(() =>
      expect(service.getCodexLogin(loginId)).toMatchObject({
        status: "error",
        error: "Login cancelled.",
      }),
    );
    expect(service.cancelCodexLogin(loginId)).toBe(false);
    expect(service.getCodexLogin("unknown")).toBeUndefined();
  });
});
