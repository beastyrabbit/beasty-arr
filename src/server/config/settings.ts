import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

const settingValidators = {
  dryRun: z.boolean(),
  huntTickMinutes: z.number().int().min(1).max(120),
  maxCommandsPerCycle: z.number().int().min(1).max(10),
  queueGateThreshold: z.number().int().min(1),
  missingToUpgradeRatio: z.string(),
  huntSpecials: z.boolean(),
  dubLagDaysDefault: z.number().int().min(0),
  releasingSeasonRetryDays: z.number().int().min(1).max(180),
  movieRetryDays: z.number().int().min(1).max(365),
  acceptedOriginalLanguages: z.array(z.string()),
  budgetSafetyPct: z.number().min(0).max(0.9),
  budgetHorizonHours: z.number().int().min(1).max(24),
  budgetTrickleMinPerHour: z.number().min(0),
  budgetPacingHorizonHours: z.number().int().min(1).max(24),
  budgetBurstMaxDivisor: z.number().int().min(1),
  excludeIndexerIds: z.array(z.number().int()),
  aiProvider: z.enum(["codex", "aibox", "off"]),
  aiModel: z.string(),
  aiThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  aiMaxChecksPerDay: z.number().int().min(0).max(500),
  aiPauseConfidence: z.number().min(0).max(1),
  aiMinSearchesBeforeCheck: z.number().int().min(1).max(20),
  aiExistsRetryDays: z.number().int().min(1).max(365),
  aiUnlikelyRetryDays: z.number().int().min(30).max(730),
  fixerAutoImportConfidence: z.number().min(0).max(1),
  fixerAutoRemoveConfidence: z.number().min(0).max(1),
  fixerParallelism: z.number().int().min(1).max(10),
  fixerAutoApply: z.boolean(),
} satisfies z.ZodRawShape;

/**
 * Sparse updates must use validators without defaults. Calling `.partial()` on
 * `settingsSchema` applies every field default and silently resets omitted
 * settings whenever one control is saved.
 */
export const settingsPatchSchema = z.object(settingValidators).partial().strict();

/** Behavior settings live in the DB (GUI-editable). Identity/secrets/endpoints are env-only. */
export const settingsSchema = z.object({
  dryRun: settingValidators.dryRun.default(true), // default ON at first boot — flip in GUI (type "live")
  // Large-library profile: four commands/hour, split evenly between missing
  // media and German upgrades. Season/movie grouping keeps useful throughput high.
  huntTickMinutes: settingValidators.huntTickMinutes.default(30),
  maxCommandsPerCycle: settingValidators.maxCommandsPerCycle.default(2),
  queueGateThreshold: settingValidators.queueGateThreshold.default(10),
  missingToUpgradeRatio: settingValidators.missingToUpgradeRatio.default("1:1"),
  huntSpecials: settingValidators.huntSpecials.default(false),
  dubLagDaysDefault: settingValidators.dubLagDaysDefault.default(14),
  releasingSeasonRetryDays: settingValidators.releasingSeasonRetryDays.default(21),
  movieRetryDays: settingValidators.movieRetryDays.default(30),
  acceptedOriginalLanguages: settingValidators.acceptedOriginalLanguages.default([]),

  // Budget controller. A full-day pace and 20% reserve absorb organic RSS use
  // and Sonarr anime searches that may fan out into many indexer queries.
  budgetSafetyPct: settingValidators.budgetSafetyPct.default(0.2),
  budgetHorizonHours: settingValidators.budgetHorizonHours.default(12),
  budgetTrickleMinPerHour: settingValidators.budgetTrickleMinPerHour.default(1),
  budgetPacingHorizonHours: settingValidators.budgetPacingHorizonHours.default(24),
  budgetBurstMaxDivisor: settingValidators.budgetBurstMaxDivisor.default(24), // burstMax = cap / divisor
  excludeIndexerIds: settingValidators.excludeIndexerIds.default([]),

  // AI / oracle
  aiProvider: settingValidators.aiProvider.default("codex"),
  aiModel: settingValidators.aiModel.default("gpt-5.6-terra"),
  aiThinkingLevel: settingValidators.aiThinkingLevel.default("high"),
  aiMaxChecksPerDay: settingValidators.aiMaxChecksPerDay.default(20),
  aiPauseConfidence: settingValidators.aiPauseConfidence.default(0.7),
  aiMinSearchesBeforeCheck: settingValidators.aiMinSearchesBeforeCheck.default(1),
  aiExistsRetryDays: settingValidators.aiExistsRetryDays.default(30),
  aiUnlikelyRetryDays: settingValidators.aiUnlikelyRetryDays.default(365),

  // Fixer
  fixerAutoImportConfidence: settingValidators.fixerAutoImportConfidence.default(0.8),
  fixerAutoRemoveConfidence: settingValidators.fixerAutoRemoveConfidence.default(0.95),
  fixerParallelism: settingValidators.fixerParallelism.default(5),
  fixerAutoApply: settingValidators.fixerAutoApply.default(false),
});

export type AppSettings = z.infer<typeof settingsSchema>;

const DEFAULTS_V024_MIGRATION_KEY = "migration.defaults.v0.2.4";

export class SettingsService {
  private cache: AppSettings | null = null;

  constructor(private readonly db: Db) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const rows = this.db.select().from(settings).all();
    const raw: Record<string, unknown> = {};
    for (const row of rows) raw[row.key] = row.value;
    if (raw[DEFAULTS_V024_MIGRATION_KEY] !== true) {
      // v0.2.3's non-sparse config parser wrote these old defaults whenever
      // any unrelated setting (including auto-apply) was changed.
      if (raw.aiProvider !== undefined && raw.aiProvider !== "codex") {
        raw.aiProvider = "codex";
        this.persist("aiProvider", raw.aiProvider);
      }
      if (raw.aiModel === "gpt-5.5") {
        raw.aiModel = "gpt-5.6-terra";
        this.persist("aiModel", raw.aiModel);
      }
      if (raw.fixerParallelism === 2) {
        raw.fixerParallelism = 5;
        this.persist("fixerParallelism", raw.fixerParallelism);
      }
      this.persist(DEFAULTS_V024_MIGRATION_KEY, true);
    }
    this.cache = settingsSchema.parse(raw);
    return this.cache;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = settingsSchema.parse({ ...this.get(), ...patch });
    for (const [key, value] of Object.entries(patch)) {
      this.persist(key, value);
    }
    this.cache = next;
    return next;
  }

  private persist(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, value: value as never })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as never } })
      .run();
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
