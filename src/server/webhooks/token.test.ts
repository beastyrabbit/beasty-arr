import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebhookTokenService } from "./token.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "beasty-webhook-token-"));
  dirs.push(dir);
  return dir;
}

describe("WebhookTokenService", () => {
  it("creates a token that only authorizes webhook callbacks", () => {
    const service = new WebhookTokenService(tempDir());
    expect(service.token()).toHaveLength(64);
    expect(service.verify(service.token())).toBe(true);
    expect(service.verify("wrong")).toBe(false);
    expect(service.verify(undefined)).toBe(false);
  });

  it("reuses the persisted token after restart", () => {
    const dir = tempDir();
    const first = new WebhookTokenService(dir);
    const reopened = new WebhookTokenService(dir);
    expect(reopened.token()).toBe(first.token());
  });
});
