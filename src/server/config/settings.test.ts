import { afterEach, describe, expect, it } from "vitest";
import { createDb, type SqliteHandle } from "../db/index.js";
import { settings as settingsTable } from "../db/schema.js";
import { SettingsService, settingsPatchSchema } from "./settings.js";

let sqlite: SqliteHandle | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe("settings", () => {
  it("parses config updates as genuinely sparse patches", () => {
    expect(
      settingsPatchSchema.parse({
        aiModel: "gpt-5.6-terra",
        aiThinkingLevel: "xhigh",
        fixerAutoRun: true,
      }),
    ).toEqual({ aiModel: "gpt-5.6-terra", aiThinkingLevel: "xhigh", fixerAutoRun: true });
  });

  it("migrates defaults reset by v0.2.3 exactly once", () => {
    const created = createDb(":memory:");
    sqlite = created.sqlite;
    sqlite.exec("CREATE TABLE settings (key text PRIMARY KEY NOT NULL, value text NOT NULL)");
    created.db
      .insert(settingsTable)
      .values([
        { key: "aiProvider", value: "aibox" },
        { key: "aiModel", value: "gpt-5.5" },
        { key: "fixerParallelism", value: 2 },
      ])
      .run();

    const service = new SettingsService(created.db);
    expect(service.get()).toMatchObject({
      aiProvider: "codex",
      aiModel: "gpt-5.6-terra",
      fixerParallelism: 5,
    });

    service.update({ aiModel: "gpt-5.5", fixerParallelism: 2 });
    service.invalidate();
    expect(service.get()).toMatchObject({ aiModel: "gpt-5.5", fixerParallelism: 2 });
  });
});
