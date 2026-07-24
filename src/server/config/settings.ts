import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

/** Behavior settings live in the DB (GUI-editable). Identity/secrets/endpoints are env-only. */
export const settingsSchema = z.object({
  dryRun: z.boolean().default(true), // default ON at first boot — flip in GUI (type "live")
  huntTickMinutes: z.number().int().min(1).max(120).default(10),
  maxCommandsPerCycle: z.number().int().min(1).max(10).default(3),
  queueGateThreshold: z.number().int().min(1).default(15),
  missingToUpgradeRatio: z.string().default("1:2"),
  huntSpecials: z.boolean().default(false),
  dubLagDaysDefault: z.number().int().min(0).default(7),
  releasingSeasonRetryDays: z.number().int().min(1).max(180).default(14),
  movieRetryDays: z.number().int().min(1).max(365).default(30),
  acceptedOriginalLanguages: z.array(z.string()).default([]),

  // Budget controller
  budgetSafetyPct: z.number().min(0).max(0.9).default(0.1),
  budgetHorizonHours: z.number().int().min(1).max(24).default(6),
  budgetTrickleMinPerHour: z.number().min(0).default(2),
  budgetPacingHorizonHours: z.number().int().min(1).max(24).default(6),
  budgetBurstMaxDivisor: z.number().int().min(1).default(12), // burstMax = cap / divisor
  excludeIndexerIds: z.array(z.number().int()).default([]),

  // AI / oracle
  aiProvider: z.enum(["codex", "aibox", "off"]).default("codex"),
  aiModel: z.string().default("gpt-5.5"),
  aiThinkingLevel: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .default("high"),
  aiMaxChecksPerDay: z.number().int().min(0).max(500).default(20),
  aiPauseConfidence: z.number().min(0).max(1).default(0.7),
  aiMinSearchesBeforeCheck: z.number().int().min(1).max(20).default(1),
  aiExistsRetryDays: z.number().int().min(1).max(365).default(30),
  aiUnlikelyRetryDays: z.number().int().min(30).max(730).default(365),

  // Fixer
  fixerAutoImportConfidence: z.number().min(0).max(1).default(0.8),
  fixerAutoRemoveConfidence: z.number().min(0).max(1).default(0.95),
  fixerParallelism: z.number().int().min(1).max(10).default(2),
  fixerAutoApply: z.boolean().default(false),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export class SettingsService {
  private cache: AppSettings | null = null;

  constructor(private readonly db: Db) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const rows = this.db.select().from(settings).all();
    const raw: Record<string, unknown> = {};
    for (const row of rows) raw[row.key] = row.value;
    this.cache = settingsSchema.parse(raw);
    return this.cache;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = settingsSchema.parse({ ...this.get(), ...patch });
    for (const [key, value] of Object.entries(patch)) {
      this.db
        .insert(settings)
        .values({ key, value: value as never })
        .onConflictDoUpdate({ target: settings.key, set: { value: value as never } })
        .run();
    }
    this.cache = next;
    return next;
  }

  /** Test-only escape hatch. */
  invalidate(): void {
    this.cache = null;
  }
}

export function getSetting<K extends keyof AppSettings>(
  svc: SettingsService,
  key: K,
): AppSettings[K] {
  return svc.get()[key];
}

export { eq };
