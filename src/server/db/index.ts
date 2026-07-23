import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];
export type SqliteHandle = InstanceType<typeof Database>;

export function createDb(dataDir: string, opts: { migrationsFolder?: string } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = dataDir === ":memory:" ? ":memory:" : path.join(dataDir, "beasty-arr.db");
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  if (opts.migrationsFolder) {
    migrate(db, { migrationsFolder: opts.migrationsFolder });
  }
  return { db, sqlite };
}

export { schema };
