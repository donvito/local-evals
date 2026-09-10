import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { backupAppData, restoreAppData } from "../src/storage/backup.js";
import { CredentialVault } from "../src/core/vault.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "evalforge-backup-"));
  const source = join(root, "source"); await mkdir(source);
  const assets = join(source, "assets"); await mkdir(assets); await writeFile(join(assets, "a.png"), "asset");
  const dbPath = join(source, "source.db"), db = new Database(dbPath);
  db.exec("CREATE TABLE targets(name TEXT PRIMARY KEY, config_json TEXT NOT NULL); CREATE TABLE datasets(version TEXT PRIMARY KEY, manifest_json TEXT NOT NULL); CREATE TABLE runs(run_id TEXT PRIMARY KEY, status TEXT, owner_pid INTEGER, error TEXT, snapshot_json TEXT); CREATE TABLE case_results(run_id TEXT, result_json TEXT); CREATE TABLE dataset_jobs(job_id TEXT PRIMARY KEY, status TEXT, owner_pid INTEGER, error TEXT, updated_at TEXT)");
  const keyPath = `${dbPath}.credentials.key`; await writeFile(keyPath, randomBytes(32));
  const encrypted = new CredentialVault(keyPath).encrypt("secret-value");
  db.prepare("INSERT INTO targets VALUES (?,?)").run("x", JSON.stringify({ apiKeyEncrypted: encrypted }));
  db.prepare("INSERT INTO datasets VALUES (?,?)").run("v", JSON.stringify({ cases: [{ imagePath: join(assets, "a.png") }] }));
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run("r", "running", 2147483647, null, JSON.stringify({ imagePath: join(assets, "a.png") }));
  db.prepare("INSERT INTO case_results VALUES (?,?)").run("r", JSON.stringify({ imagePath: join(assets, "a.png"), originalImagePath: join(assets, "a.png") }));
  db.prepare("INSERT INTO dataset_jobs VALUES (?,?,?,?,?)").run("q", "queued", null, null, "now");
  db.close();
  return { root, source, dbPath, encrypted };
}

describe("app data backup", () => {
  it("round trips encrypted data, remaps assets, interrupts running work, and keeps queued work", async () => {
    const source = await fixture(), backup = join(source.root, "backup"), dest = join(source.root, "restored");
    try {
      await backupAppData(source.dbPath, backup); const { dbPath } = await restoreAppData(backup, dest);
      const db = new Database(dbPath, { readonly: true });
      try {
      const restored = new CredentialVault(`${dbPath}.credentials.key`);
      expect(restored.decrypt(JSON.parse(db.prepare("SELECT config_json FROM targets").get().config_json).apiKeyEncrypted)).toBe("secret-value");
      expect(db.prepare("SELECT status FROM runs").get()).toEqual({ status: "interrupted" });
      expect(db.prepare("SELECT status FROM dataset_jobs").get()).toEqual({ status: "queued" });
      expect(JSON.parse(db.prepare("SELECT manifest_json FROM datasets").get().manifest_json).cases[0].imagePath).toBe(join(dest, "assets", "a.png"));
      const result = JSON.parse(db.prepare("SELECT result_json FROM case_results").get().result_json);
      expect(result.imagePath).toBe(join(dest, "assets", "a.png"));
      expect(result.originalImagePath).toBe(join(source.source, "assets", "a.png"));
      } finally { db.close(); }
      await expect(restoreAppData(backup, dest)).rejects.toThrow(/already exists/);
    } finally { await rm(source.root, { recursive: true, force: true }); }
  });
  it("refuses corruption, overwrite, traversal, and symlink inputs", async () => {
    const source = await fixture(), backup = join(source.root, "backup"), dest = join(source.root, "dest");
    try {
      await backupAppData(source.dbPath, backup); await writeFile(join(backup, "manifest.json"), "{}");
      await expect(restoreAppData(backup, dest)).rejects.toThrow();
      await writeFile(join(backup, "manifest.json"), JSON.stringify({ formatVersion: 1, sourceAssetRoot: source.source, files: [{ path: "../escape", sha256: "00", size: 0 }] }));
      await expect(restoreAppData(backup, dest)).rejects.toThrow();
      await expect(backupAppData(source.dbPath, backup)).rejects.toThrow();
      const outside = join(source.root, "outside"); await mkdir(outside);
      const link = join(source.source, "assets", "linked"); await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      await expect(backupAppData(source.dbPath, join(source.root, "other"))).rejects.toThrow(/Symlinks/);
      await rm(link, { recursive: true, force: true });
      const live = new Database(source.dbPath); live.prepare("UPDATE runs SET owner_pid=? WHERE status='running'").run(process.pid); live.close();
      await expect(backupAppData(source.dbPath, join(source.root, "live-rejected"))).rejects.toThrow(/running/);
      const stale = new Database(source.dbPath); stale.prepare("UPDATE runs SET owner_pid=? WHERE status='running'").run(2147483647); stale.close();

      const abortBackup = join(source.root, "abort-backup"), abortDest = join(source.root, "abort-dest");
      const triggerDb = new Database(source.dbPath);
      triggerDb.exec("CREATE TRIGGER abort_relocation BEFORE UPDATE OF result_json ON case_results BEGIN SELECT RAISE(ABORT, 'relocation blocked'); END");
      triggerDb.close();
      await backupAppData(source.dbPath, abortBackup);
      await expect(restoreAppData(abortBackup, abortDest)).rejects.toThrow(/relocation blocked/);
      await expect(stat(abortDest)).rejects.toThrow();
    } finally { await rm(source.root, { recursive: true, force: true }); }
  });
});
