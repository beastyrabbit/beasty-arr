import path from "node:path";
import { count } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import type { ArrHealthValue, DryRunResult, StateCounts } from "../../../shared/api-types.js";
import { HUNT_STATES, type HuntState } from "../../../shared/domain.js";
import {
  isEnginePaused as isEnginePausedDb,
  setEnginePaused as setEnginePausedDb,
} from "../../config/engine-flag.js";
import type { AppContext } from "../../context.js";
import { huntState } from "../../db/schema.js";

// ============ validation ============

/**
 * safeParse `value`; on failure send a 400 with a readable detail and return a
 * failure result so the handler can `return`. Keeps every route's body/query
 * validation to two lines.
 */
export function parse<T>(
  reply: FastifyReply,
  schema: z.ZodType<T>,
  value: unknown,
): { ok: true; data: T } | { ok: false } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  reply.code(400).send({
    error: "invalid request",
    detail: parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  });
  return { ok: false };
}

// ============ common responses ============

export function serviceUnavailable(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(503).send({ error: message });
}

export function notFound(reply: FastifyReply, message = "not found"): FastifyReply {
  return reply.code(404).send({ error: message });
}

export function dryRunResult(wouldHave: string): DryRunResult {
  return { dryRun: true, wouldHave };
}

// ============ pagination ============

export function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

// ============ state counts ============

export function emptyStateCounts(): StateCounts {
  const out = {} as StateCounts;
  for (const s of HUNT_STATES) out[s] = 0;
  return out;
}

/** Precedence for the series badge (worst-first among "relevant" episode states). */
const RELEVANT_PRECEDENCE: HuntState[] = [
  "profile_blocked",
  "missing",
  "non_german",
  "exhausted",
  "ai_paused",
  "german",
];
/** Fallback badge when no relevant episodes exist (all unreleased/unmonitored/ignored). */
const FALLBACK_PRECEDENCE: HuntState[] = ["unreleased", "unmonitored", "ignored"];

/**
 * Aggregate a series badge from its episode state breakdown. `german` only when
 * every relevant episode is german; otherwise the worst relevant state present.
 * "relevant" excludes unreleased/unmonitored/ignored (surfaced only as fallback).
 */
export function aggregateSeriesState(counts: StateCounts): HuntState {
  for (const s of RELEVANT_PRECEDENCE) if (counts[s] > 0) return s;
  for (const s of FALLBACK_PRECEDENCE) if (counts[s] > 0) return s;
  return "unmonitored";
}

/** States excluded from the German-quota denominator (also the homepage/dashboard formula). */
const NON_QUOTA_STATES: HuntState[] = ["unreleased", "ai_paused", "unmonitored", "ignored"];

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** german / (total − unreleased − ai_paused − unmonitored − ignored), 0..100 one decimal. */
export function germanPct(counts: StateCounts): number {
  let denom = 0;
  for (const s of HUNT_STATES) if (!NON_QUOTA_STATES.includes(s)) denom += counts[s];
  if (denom === 0) return 0;
  return round1((counts.german / denom) * 100);
}

/** Secondary metric counting ai_paused as done (denominator keeps ai_paused). */
export function germanPctWithAiDone(counts: StateCounts): number {
  let denom = 0;
  for (const s of HUNT_STATES) {
    if (s === "unreleased" || s === "unmonitored" || s === "ignored") continue;
    denom += counts[s];
  }
  if (denom === 0) return 0;
  return round1(((counts.german + counts.ai_paused) / denom) * 100);
}

/** Episodes that count toward the German quota (excludes unreleased/unmonitored/ignored). */
export function consideredCount(counts: StateCounts): number {
  let n = 0;
  for (const s of HUNT_STATES) {
    if (s === "unreleased" || s === "unmonitored" || s === "ignored") continue;
    n += counts[s];
  }
  return n;
}

/** hunt_state grouped counts, per source and combined, with all states zero-filled. */
export function loadStateCounts(ctx: AppContext): {
  total: StateCounts;
  sonarr: StateCounts;
  radarr: StateCounts;
} {
  const rows = ctx.db
    .select({ source: huntState.source, state: huntState.state, n: count() })
    .from(huntState)
    .groupBy(huntState.source, huntState.state)
    .all();
  const total = emptyStateCounts();
  const sonarr = emptyStateCounts();
  const radarr = emptyStateCounts();
  for (const row of rows) {
    const state = row.state as HuntState;
    total[state] += row.n;
    (row.source === "sonarr" ? sonarr : radarr)[state] += row.n;
  }
  return { total, sonarr, radarr };
}

// ============ arr health ============

async function probe(
  client: { getSystemStatus(): Promise<unknown> } | null,
): Promise<ArrHealthValue> {
  if (!client) return "unknown";
  try {
    await client.getSystemStatus();
    return "up";
  } catch {
    return "down";
  }
}

export async function arrHealthAll(ctx: AppContext): Promise<{
  sonarr: ArrHealthValue;
  radarr: ArrHealthValue;
  prowlarr: ArrHealthValue;
}> {
  const [sonarr, radarr, prowlarr] = await Promise.all([
    probe(ctx.services.sonarr),
    probe(ctx.services.radarr),
    probe(ctx.services.prowlarr),
  ]);
  return { sonarr, radarr, prowlarr };
}

// ============ misc ============

export function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The real data directory (where DATA_DIR/pi/auth.json lives). Derived from the
 * open SQLite handle so it matches whatever dataDir buildApp actually used —
 * tests pass a temp dir that differs from env.DATA_DIR.
 */
export function dataDirOf(ctx: AppContext): string {
  const file = ctx.sqlite.name;
  return file && file !== ":memory:" ? path.dirname(file) : ctx.env.DATA_DIR;
}

// ============ engine pause flag ============
// Storage lives in config/engine-flag.ts; the hunt.cycle job in app.ts
// consults the same flag, so pausing actually halts hunting.

export function isEnginePaused(ctx: AppContext): boolean {
  return isEnginePausedDb(ctx.db);
}

export function setEnginePaused(ctx: AppContext, paused: boolean): void {
  setEnginePausedDb(ctx.db, paused);
}
