import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import { expect, it, vi } from "vitest";
import { backupDatabase } from "./maintenance.js";

it("keeps the last completed backup through creation failure and replaces it atomically", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-test-"));
  const db = new Database(":memory:");
  const log = { info() {} } as unknown as FastifyBaseLogger;
  try {
    db.exec("create table example (value integer); insert into example values (1)");
    backupDatabase(db, dir, log);
    const target = path.join(dir, "backup/beasty-arr.db");
    const previous = readFileSync(target);
    const failure = vi.spyOn(db, "exec").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => backupDatabase(db, dir, log)).toThrow("disk full");
    expect(readFileSync(target)).toEqual(previous);
    failure.mockRestore();
    db.exec("insert into example values (2)");
    backupDatabase(db, dir, log);
    const restored = new Database(target, { readonly: true });
    expect(restored.prepare("select count(*) as n from example").get()).toEqual({ n: 2 });
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    restored.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
