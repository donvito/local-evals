import Database from "better-sqlite3";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type InventoryEntry = { path: string; sha256: string; size: number };
type BackupManifest = {
  formatVersion: 1;
  sourceAssetRoot: string;
  sourceDbFilename: string;
  files: InventoryEntry[];
};

const DB_NAME = "app.db";
const KEY_NAME = "app.db.credentials.key";

function fail(message: string): never {
  throw new Error(message);
}

function normalized(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function portableAbsolute(value: string): boolean {
  return isAbsolute(value) || /^\/|^[A-Za-z]:[\\/]/.test(value);
}

function inside(root: string, candidate: string): boolean {
  const r = normalized(resolve(root));
  const c = normalized(resolve(candidate));
  return c === r || c.startsWith(`${r}/`);
}

async function ensureNoSymlink(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) fail("Symlinks are not allowed in app data bundles.");
}

async function ensureNewDirectory(dir: string): Promise<string> {
  const absolute = resolve(dir);
  try {
    await lstat(absolute);
    fail(`Destination already exists: ${dir}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = await realpath(dirname(absolute));
  return join(parent, basename(absolute));
}

async function assertNoOverlap(a: string, b: string): Promise<void> {
  const ar = await realpath(dirname(a));
  const br = await realpath(dirname(b));
  const aa = join(ar, basename(a));
  const bb = join(br, basename(b));
  if (inside(aa, bb) || inside(bb, aa)) fail("Source and destination paths overlap.");
}

async function digest(file: string): Promise<{ sha256: string; size: number }> {
  const bytes = await readFile(file);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const file = join(current, entry.name);
    await ensureNoSymlink(file);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, file)));
    else if (entry.isFile()) result.push(relative(root, file).split(sep).join("/"));
    else fail("Unsupported file type in app data.");
  }
  return result;
}

async function copyTree(source: string, target: string): Promise<void> {
  await ensureNoSymlink(source);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  for (const name of await readdir(source)) {
    const from = join(source, name), to = join(target, name);
    await ensureNoSymlink(from);
    const info = await lstat(from);
    if (info.isDirectory()) await copyTree(from, to);
    else if (info.isFile()) { await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, 0o600); }
    else fail("Unsupported file type in app data.");
  }
}

function sqliteHasEncryptedTargets(db: Database.Database): boolean {
  try {
    const rows = db.prepare("SELECT config_json FROM targets").all() as Array<{ config_json: string }>;
    return rows.some((row) => {
      try { return Boolean((JSON.parse(row.config_json) as any).apiKeyEncrypted); }
      catch { return false; }
    });
  } catch { return false; }
}

function validateKey(key: Buffer | undefined, encrypted: boolean): void {
  if (encrypted && (!key || key.length !== 32)) fail("Encrypted targets require a valid credentials key.");
  if (key && key.length !== 32) fail("Invalid credentials key.");
}

function hasLiveOwner(db: Database.Database, table: string): boolean {
  try {
    const rows = db.prepare(`SELECT owner_pid FROM ${table} WHERE status='running'`).all() as Array<{ owner_pid: number | null }>;
    return rows.some(({ owner_pid }) => {
      if (!owner_pid) return false;
      try { process.kill(owner_pid, 0); return true; }
      catch (error: any) { return error?.code === "EPERM"; }
    });
  } catch { return false; }
}

function assertNoLiveWork(db: Database.Database): void {
  if (hasLiveOwner(db, "runs") || hasLiveOwner(db, "dataset_jobs")) fail("Cannot back up while an evaluation or dataset job is running.");
}

function assertIntegrity(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (!check.some((row) => row.integrity_check === "ok")) fail("Database failed integrity_check.");
  } finally { db.close(); }
}

async function makeInventory(root: string): Promise<InventoryEntry[]> {
  const files = await collectFiles(root);
  return Promise.all(files.map(async (file) => ({ path: file, ...(await digest(join(root, file))) })));
}

async function verifyBundle(root: string, manifest: BackupManifest): Promise<void> {
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.files) || typeof manifest.sourceAssetRoot !== "string") fail("Invalid backup manifest.");
  if (!manifest.files.some((entry) => entry.path === DB_NAME)) fail("Backup database is missing.");
  const actual = (await collectFiles(root)).filter((file) => file !== "manifest.json").sort();
  const listed = manifest.files.map((entry) => entry.path).sort();
  if (actual.length !== listed.length || actual.some((value, i) => value !== listed[i])) fail("Backup inventory does not match bundle contents.");
  for (const entry of manifest.files) {
    if (!entry.path || portableAbsolute(entry.path) || entry.path.split("/").some((part) => part === ".." || part === "")) fail("Invalid backup path.");
    const got = await digest(join(root, entry.path));
    if (got.sha256 !== entry.sha256 || got.size !== entry.size) fail("Backup checksum verification failed.");
  }
}

function relocateImagePaths(value: unknown, sourceRoot: string, destinationRoot: string): unknown {
  if (Array.isArray(value)) return value.map((item) => relocateImagePaths(item, sourceRoot, destinationRoot));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "imagePath" && typeof child === "string" && portableAbsolute(child)) {
      const candidate = normalized(child);
      const source = normalized(sourceRoot);
      if (candidate === source || candidate.startsWith(`${source}/`)) {
        const suffix = candidate.slice(source.length).replace(/^\//, "");
        output[key] = join(destinationRoot, suffix.replaceAll("/", sep));
        continue;
      }
    }
    output[key] = relocateImagePaths(child, sourceRoot, destinationRoot);
  }
  return output;
}

async function rewriteDatabase(dbPath: string, sourceRoot: string, destinationRoot: string): Promise<void> {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    for (const table of ["datasets", "runs", "case_results", "config_snapshots", "targets", "attempts"]) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      for (const column of columns) {
        if (!column.name.endsWith("_json") && column.name !== "manifest_json") continue;
        const rows = db.prepare(`SELECT rowid, ${column.name} AS value FROM ${table}`).all() as Array<{ rowid: number; value: string }>;
        const update = db.prepare(`UPDATE ${table} SET ${column.name}=? WHERE rowid=?`);
        for (const row of rows) {
          let parsed: unknown;
          try { parsed = JSON.parse(row.value); } catch { continue; }
          update.run(JSON.stringify(relocateImagePaths(parsed, sourceRoot, destinationRoot)), row.rowid);
        }
      }
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").get())
      db.prepare("UPDATE runs SET status='interrupted', owner_pid=NULL, error='Restored from backup while running.' WHERE status='running'").run();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataset_jobs'").get())
      db.prepare("UPDATE dataset_jobs SET status='interrupted', owner_pid=NULL, error='Restored from backup while running.', updated_at=? WHERE status='running'").run(new Date().toISOString());
    const check = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (!check.some((row) => row.integrity_check === "ok")) fail("Restored database failed integrity_check.");
  } finally { db.close(); }
}

async function publishDirectory(stage: string, destination: string): Promise<void> {
  // Reserve exclusively: rename can replace an empty directory on POSIX.
  await mkdir(destination, { mode: 0o700 });
  try {
    await copyTree(stage, destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rm(stage, { recursive: true, force: true });
}

export async function backupAppData(dbPath: string, outDir: string): Promise<{ directory: string }> {
  const sourceDb = resolve(dbPath), sourceRoot = dirname(sourceDb), assets = join(sourceRoot, "assets");
  const output = await ensureNewDirectory(outDir);
  await assertNoOverlap(sourceRoot, output);
  await ensureNoSymlink(sourceDb);
  const keyPath = `${sourceDb}.credentials.key`;
  let key: Buffer | undefined;
  try { await ensureNoSymlink(keyPath); key = await readFile(keyPath); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try { assertNoLiveWork(source); validateKey(key, sqliteHasEncryptedTargets(source)); } finally { source.close(); }
  const stage = `${output}.staging-${randomUUID()}`;
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 }); await chmod(stage, 0o700);
    const snapshot = new Database(join(stage, DB_NAME));
    snapshot.close(); await rm(join(stage, DB_NAME));
    const readonly = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try { await readonly.backup(join(stage, DB_NAME)); } finally { readonly.close(); }
    await chmod(join(stage, DB_NAME), 0o600);
    assertIntegrity(join(stage, DB_NAME));
    if (key) { await writeFile(join(stage, KEY_NAME), key, { mode: 0o600 }); await chmod(join(stage, KEY_NAME), 0o600); }
    if (await stat(assets).then(() => true, () => false)) await copyTree(assets, join(stage, "assets"));
    const config = join(sourceRoot, "dashboard-config.json");
    if (await stat(config).then(() => true, () => false)) { await ensureNoSymlink(config); await copyFile(config, join(stage, "dashboard-config.json")); await chmod(join(stage, "dashboard-config.json"), 0o600); }
    const manifest: BackupManifest = { formatVersion: 1, sourceAssetRoot: normalized(await realpath(assets).catch(() => assets)), sourceDbFilename: sourceDb.slice(sourceDb.lastIndexOf(sep) + 1), files: await makeInventory(stage) };
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await chmod(join(stage, "manifest.json"), 0o600);
    await publishDirectory(stage, output);
    return { directory: output };
  } catch (error) { await rm(stage, { recursive: true, force: true }).catch(() => undefined); throw error; }
}

export async function restoreAppData(backupDir: string, destinationDir: string): Promise<{ dbPath: string }> {
  const bundle = resolve(backupDir), destination = await ensureNewDirectory(destinationDir);
  await assertNoOverlap(bundle, destination);
  await ensureNoSymlink(bundle);
  await ensureNoSymlink(join(bundle, "manifest.json"));
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")) as BackupManifest;
  await verifyBundle(bundle, manifest);
  const key = await readFile(join(bundle, KEY_NAME)).catch(() => undefined);
  const sourceDb = join(bundle, DB_NAME);
  const probe = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try { validateKey(key, sqliteHasEncryptedTargets(probe)); } finally { probe.close(); }
  const stage = `${destination}.staging-${randomUUID()}`;
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 }); await chmod(stage, 0o700);
    await copyFile(sourceDb, join(stage, DB_NAME)); await chmod(join(stage, DB_NAME), 0o600);
    if (key) { await writeFile(join(stage, KEY_NAME), key, { mode: 0o600 }); await chmod(join(stage, KEY_NAME), 0o600); }
    if (await stat(join(bundle, "assets")).then(() => true, () => false)) await copyTree(join(bundle, "assets"), join(stage, "assets"));
    if (await stat(join(bundle, "dashboard-config.json")).then(() => true, () => false)) { await copyFile(join(bundle, "dashboard-config.json"), join(stage, "dashboard-config.json")); await chmod(join(stage, "dashboard-config.json"), 0o600); }
    await rewriteDatabase(join(stage, DB_NAME), manifest.sourceAssetRoot, join(destination, "assets"));
    await publishDirectory(stage, destination);
    return { dbPath: join(destination, DB_NAME) };
  } catch (error) { await rm(stage, { recursive: true, force: true }).catch(() => undefined); throw error; }
}
