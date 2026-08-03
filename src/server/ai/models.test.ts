import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiStatus, listModels } from "./models.js";
import { getAuthStorage } from "./providers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-models-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function settings(aiProvider: "codex" | "aibox" | "off", aiModel = "model-1") {
  return { get: () => ({ aiProvider, aiModel }) };
}

describe("aiStatus", () => {
  it("reports off, missing aibox configuration, and configured aibox", () => {
    const dataDir = tempDir();
    expect(aiStatus({ dataDir, env: {}, settings: settings("off") })).toMatchObject({
      provider: "off",
      status: "off",
    });
    expect(aiStatus({ dataDir, env: {}, settings: settings("aibox") })).toMatchObject({
      provider: "aibox",
      status: "unavailable",
    });
    expect(
      aiStatus({
        dataDir,
        env: { AIBOX_URL: "http://aibox.local:11434" },
        settings: settings("aibox"),
      }),
    ).toMatchObject({ provider: "aibox", status: "configured" });
  });

  it("reports Codex as unauthenticated until a credential exists", async () => {
    const dataDir = tempDir();
    expect(aiStatus({ dataDir, env: {}, settings: settings("codex") })).toMatchObject({
      provider: "codex",
      status: "unauthenticated",
    });
    await getAuthStorage(dataDir).modify("openai-codex", async () => ({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    }));
    expect(aiStatus({ dataDir, env: {}, settings: settings("codex") })).toMatchObject({
      provider: "codex",
      status: "configured",
    });
  });
});

describe("listModels aibox", () => {
  it("returns only valid model names from the Ollama catalog", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ models: [{ name: "qwen3:latest" }, {}, { name: 7 }] }),
    ) as unknown as typeof fetch;
    const models = await listModels("aibox", {
      dataDir: tempDir(),
      env: { AIBOX_URL: "http://aibox.local:11434/v1/" },
      settings: settings("aibox"),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://aibox.local:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(models).toEqual([
      {
        id: "qwen3:latest",
        name: "qwen3:latest",
        provider: "aibox",
        available: true,
      },
    ]);
  });

  it("returns a clearly unavailable fallback when the catalog request fails", async () => {
    const models = await listModels("aibox", {
      dataDir: tempDir(),
      env: { AIBOX_URL: "http://aibox.local:11434" },
      settings: settings("aibox", "fallback-model"),
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });

    expect(models).toEqual([
      {
        id: "fallback-model",
        name: "fallback-model (unreachable)",
        provider: "aibox",
        available: false,
      },
    ]);
  });

  it("does not attempt a request when AIBOX_URL is absent", async () => {
    const fetchImpl = vi.fn();
    expect(
      await listModels("aibox", {
        dataDir: tempDir(),
        env: {},
        settings: settings("aibox"),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
