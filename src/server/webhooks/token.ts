import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Dedicated capability token for arr webhook callbacks.
 * It is unrelated to user authentication and persists with the app data.
 */
export class WebhookTokenService {
  private readonly value: string;
  private readonly hash: Buffer;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "webhook-token");
    const stored = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    this.value = stored || randomBytes(32).toString("hex");
    if (!stored) writeFileSync(file, this.value, { mode: 0o600 });
    this.hash = sha256(this.value);
  }

  token(): string {
    return this.value;
  }

  verify(candidate: string | undefined): boolean {
    return candidate ? timingSafeEqual(sha256(candidate), this.hash) : false;
  }
}
