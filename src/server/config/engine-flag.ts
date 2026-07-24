import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

// Global engine pause lives as a raw settings row outside the zod settings
// schema (SettingsService.get() strips unknown keys, so the two never collide).
const ENGINE_PAUSED_KEY = "enginePaused";

export function isEnginePaused(db: Db): boolean {
  const row = db.select().from(settings).where(eq(settings.key, ENGINE_PAUSED_KEY)).get();
  return row?.value === true;
}

export function setEnginePaused(db: Db, paused: boolean): void {
  db.insert(settings)
    .values({ key: ENGINE_PAUSED_KEY, value: paused as never })
    .onConflictDoUpdate({ target: settings.key, set: { value: paused as never } })
    .run();
}
