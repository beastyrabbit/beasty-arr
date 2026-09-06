import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("backfills and maintains indexed target membership without scanning unrelated attempts", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE search_attempts (id INTEGER PRIMARY KEY, target_ids TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO search_attempts VALUES (?, ?)");
    db.transaction(() => {
      for (let id = 1; id <= 20000; id++) insert.run(id, JSON.stringify([id, id + 20000]));
    })();
    db.exec(readFileSync("drizzle/0010_uneven_justin_hammer.sql", "utf8"));
    const query =
      "SELECT a.id FROM search_attempts a WHERE a.id IN (SELECT attempt_id FROM search_attempt_targets WHERE hunt_state_id = ?)";
    expect(db.prepare(query).all(1)).toEqual([{ id: 1 }]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("idx_attempt_targets_hunt_state"))).toBe(true);
    expect(plan.some((row) => /SCAN a\b/.test(row.detail))).toBe(false);
    insert.run(20001, "[1,1]");
    expect(db.prepare(query).all(1)).toHaveLength(2);
    db.prepare("UPDATE search_attempts SET target_ids = '[2]' WHERE id = 20001").run();
    expect(db.prepare(query).all(1)).toHaveLength(1);
    db.prepare("DELETE FROM search_attempts WHERE id=1").run();
    expect(db.prepare(query).all(1)).toEqual([]);
  } finally {
    db.close();
  }
});
