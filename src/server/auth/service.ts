import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import { sessions } from "../db/schema.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d sliding

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class AuthService {
  private readonly apiKeyHash: Buffer;
  private readonly webhookTokenValue: string;
  private readonly webhookTokenHash: Buffer;

  constructor(
    private readonly db: Db,
    apiKey: string,
  ) {
    this.apiKeyHash = sha256(apiKey);
    // Webhook-only capability token, derived so it never has to be stored.
    // The arrs can only carry it in the URL query, where it may leak into
    // logs/history — leaking it must not grant general API access.
    this.webhookTokenValue = createHmac("sha256", apiKey).update("webhook-token").digest("hex");
    this.webhookTokenHash = sha256(this.webhookTokenValue);
  }

  verifyApiKey(candidate: string | undefined): boolean {
    if (!candidate) return false;
    return timingSafeEqual(sha256(candidate), this.apiKeyHash);
  }

  /** Token for the arr Webhook connection URLs (?token=...). Webhook-only capability. */
  webhookToken(): string {
    return this.webhookTokenValue;
  }

  verifyWebhookToken(candidate: string | undefined): boolean {
    if (!candidate) return false;
    return timingSafeEqual(sha256(candidate), this.webhookTokenHash);
  }

  createSession(userAgent: string | undefined): { id: string; expiresAt: number } {
    const now = Date.now();
    const session = {
      id: nanoid(32),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.db
      .insert(sessions)
      .values({ ...session, userAgent: userAgent ?? null })
      .run();
    // opportunistic cleanup of expired sessions
    this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    return session;
  }

  verifySession(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return false;
    const now = Date.now();
    if (row.expiresAt < now) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return false;
    }
    // sliding expiry, refreshed at most once an hour to keep writes low
    if (now - row.lastSeenAt > 60 * 60 * 1000) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS })
        .where(eq(sessions.id, id))
        .run();
    }
    return true;
  }

  revokeSession(id: string): void {
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }
}

/** Cookie-signing secret persisted on the data volume — one less external secret. */
export function loadOrCreateSessionSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "session-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Dev convenience: generate a key once and log it. Production refuses to start without one. */
export function generateDevApiKey(): string {
  return `dev-${randomBytes(24).toString("hex")}`;
}
