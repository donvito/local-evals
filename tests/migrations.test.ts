import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseStore } from "../src/storage/db.js";

const baseSchema = `
  CREATE TABLE runs (run_id TEXT PRIMARY KEY, dataset_version TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE config_snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE, config_json TEXT NOT NULL);
  CREATE TABLE case_results (run_id TEXT NOT NULL, case_id TEXT NOT NULL, result_json TEXT NOT NULL, ocr_grade_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (run_id, case_id));
  CREATE INDEX case_results_run_id_idx ON case_results(run_id);
`;

function makeSchema(version: number): string {
  let sql = `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1, 'old'); ${baseSchema}`;
  sql += "INSERT INTO runs VALUES('legacy', 'v1', 'old'); INSERT INTO config_snapshots VALUES('legacy', '{}'); INSERT INTO case_results VALUES('legacy', 'case-1', '{}', NULL, 'old');";
  if (version >= 2)
    sql += "ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'; ALTER TABLE runs ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE runs ADD COLUMN error TEXT; ALTER TABLE runs ADD COLUMN owner_pid INTEGER; ALTER TABLE runs ADD COLUMN finished_at TEXT; CREATE TABLE datasets(version TEXT PRIMARY KEY, manifest_json TEXT NOT NULL); CREATE TABLE targets(name TEXT PRIMARY KEY, config_json TEXT NOT NULL); CREATE TABLE attempts(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id), case_id TEXT NOT NULL, stage TEXT NOT NULL, attempt_json TEXT NOT NULL); INSERT INTO schema_migrations VALUES(2, 'old');";
  if (version >= 3)
    sql += "CREATE TABLE run_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX run_events_run_id_idx ON run_events(run_id); CREATE INDEX run_events_event_id_idx ON run_events(event_id); INSERT INTO schema_migrations VALUES(3, 'old');";
  if (version >= 4)
    sql += "CREATE TABLE dataset_jobs(job_id TEXT PRIMARY KEY, status TEXT NOT NULL, name TEXT NOT NULL, task_kind TEXT NOT NULL, target_name TEXT NOT NULL, case_count INTEGER NOT NULL, dataset_version TEXT, error TEXT, owner_pid INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX dataset_jobs_updated_at_idx ON dataset_jobs(updated_at DESC); INSERT INTO schema_migrations VALUES(4, 'old');";
  if (version >= 5)
    sql += "ALTER TABLE dataset_jobs ADD COLUMN brief TEXT NOT NULL DEFAULT ''; INSERT INTO schema_migrations VALUES(5, 'old');";
  return sql;
}

async function createOldDatabase(version: number) {
  const directory = await mkdtemp(path.join(tmpdir(), "evalforge-migrations-"));
  const file = path.join(directory, `v${version}.db`);
  const db = new Database(file);
  db.exec(makeSchema(version));
  db.close();
  return { directory, file };
}

function adjacentBackups(file: string, entries: string[]) {
  const name = path.basename(file);
  return entries.filter((entry) => entry.startsWith(`${name}.pre-migration-`));
}

describe("database migrations", () => {
  it.each([1, 4, 5])("retains real v%d data and applies pending migrations once", async (version) => {
    const { directory, file } = await createOldDatabase(version);
    try {
      const before = await readdir(directory);
      const store = new DatabaseStore(file);
      expect(store.getRun("legacy")?.runId).toBe("legacy");
      expect(store.getRunCases("legacy")).toHaveLength(1);
      expect(store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 7 });
      store.close();

      const after = await readdir(directory);
      expect(adjacentBackups(file, after)).toHaveLength(version < 6 ? 1 : 0);
      const reopened = new DatabaseStore(file);
      reopened.close();
      expect(adjacentBackups(file, await readdir(directory))).toEqual(adjacentBackups(file, after));
      expect(before).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("backs up the old schema and data before upgrading", async () => {
    const { directory, file } = await createOldDatabase(1);
    try {
      const store = new DatabaseStore(file);
      store.close();
      const backup = (await readdir(directory)).find((entry) => entry.includes(".pre-migration-"));
      expect(backup).toBeDefined();
      const old = new Database(path.join(directory, backup!));
      expect(old.prepare("SELECT run_id FROM runs").get()).toEqual({ run_id: "legacy" });
      expect(old.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name='status'").get()).toBeUndefined();
      expect(old.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 1 });
      old.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a failed migration while retaining the pre-upgrade backup", async () => {
    const { directory, file } = await createOldDatabase(1);
    const malformed = new Database(file);
    malformed.exec("ALTER TABLE runs ADD COLUMN status TEXT;");
    malformed.close();
    try {
      expect(() => new DatabaseStore(file)).toThrow();
      const check = new Database(file);
      expect(check.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 1 });
      expect(check.prepare("SELECT run_id FROM runs").get()).toEqual({ run_id: "legacy" });
      check.close();
      expect((await readdir(directory)).some((entry) => entry.includes(".pre-migration-"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a database newer than the supported schema before changing it", async () => {
    const { directory, file } = await createOldDatabase(5);
    const future = new Database(file);
    future.prepare("INSERT INTO schema_migrations VALUES(8, 'future')").run();
    future.close();
    try {
      expect(() => new DatabaseStore(file)).toThrow(/newer than supported/);
      expect(existsSync(`${file}.credentials.key`)).toBe(false);
      const check = new Database(file);
      expect(check.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
      expect(check.pragma("journal_mode", { simple: true })).toBe("delete");
      check.close();
      expect((await readdir(directory)).some((entry) => entry.includes(".pre-migration-"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
