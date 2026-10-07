import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CaseResult, RunConfig } from "../core/types.js";
import { sanitize, registerSecrets, validateTarget } from "../core/security.js";
import { metrics } from "../core/reports.js";
import { CredentialVault } from "../core/vault.js";

export type SqliteDatabase = Database.Database;

export type StoredRun = {
  runId: string;
  datasetVersion: string;
  config: RunConfig;
  createdAt: string;
};

export type StoredCaseResult = {
  runId: string;
  result: CaseResult;
  ocrGrade: unknown;
  createdAt: string;
};

export type RunEventType =
  | "preflight_warning"
  | "run_started"
  | "stage_started"
  | "stage_finished"
  | "retry_scheduled"
  | "case_started"
  | "case_finished"
  | "case_error"
  | "cancellation_requested"
  | "run_finished";

export type RunEvent = {
  eventId: number;
  runId: string;
  type: RunEventType;
  createdAt: string;
  payload: Record<string, unknown>;
};

const RUN_EVENT_TYPES = new Set<RunEventType>([
  "preflight_warning",
  "run_started",
  "stage_started",
  "stage_finished",
  "retry_scheduled",
  "case_started",
  "case_finished",
  "case_error",
  "cancellation_requested",
  "run_finished",
]);
const RUN_EVENT_KEYS = new Set([
  "requestedOutputMode",
  "outputMode",
  "phase",
  "stage",
  "caseId",
  "attempt",
  "status",
  "elapsedMs",
  "error",
  "reason",
  "retryInMs",
  "totalCases",
  "preflight",
  "completedCases",
]);

function eventPayload(value: unknown): Record<string, unknown> {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const output: Record<string, unknown> = {};
  for (const key of RUN_EVENT_KEYS) {
    const child = input[key];
    if (child === undefined || child === null) continue;
    if (key === "error" || key === "reason") {
      const message = String(sanitize(String(child)));
      const returned = message.match(/^(.+?) returned (\d+):/);
      const transport = message.match(/^Transport error calling ([^:]+):/);
      const containsPayload =
        /(?:prompt|image|messages|content|authorization|api[_-]?key|token)\s*[":=]/i.test(
          message,
        );
      output[key] = containsPayload
        ? "Diagnostic payload redacted."
        : returned
          ? `${returned[1]} returned ${returned[2]}.`
          : transport
            ? `Transport error calling ${transport[1]}.`
            : message.slice(0, 500);
    } else if (
      key === "caseId" ||
      key === "stage" ||
      key === "status" ||
      key === "phase" ||
      key === "requestedOutputMode" ||
      key === "outputMode"
    ) {
      output[key] = String(child).slice(0, 120);
    } else if (typeof child === "boolean" || typeof child === "number") {
      output[key] = child;
    } else if (key === "preflight") {
      output[key] = Boolean(child);
    }
  }
  return output;
}

const MIGRATIONS: Array<[number, string]> = [
  [
    2,
    `
    ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
    ALTER TABLE runs ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE runs ADD COLUMN error TEXT;
    ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
    ALTER TABLE runs ADD COLUMN finished_at TEXT;
    CREATE TABLE datasets(version TEXT PRIMARY KEY, manifest_json TEXT NOT NULL);
    CREATE TABLE targets(name TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(run_id),case_id TEXT NOT NULL,stage TEXT NOT NULL,attempt_json TEXT NOT NULL);
  `,
  ],
  [
    1,
    `
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        dataset_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_results (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        case_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        ocr_grade_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, case_id)
      );

      CREATE INDEX IF NOT EXISTS case_results_run_id_idx ON case_results(run_id);
    `,
  ],
  [
    3,
    `
      CREATE TABLE IF NOT EXISTS run_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id);
      CREATE INDEX IF NOT EXISTS run_events_event_id_idx ON run_events(event_id);
    `,
  ],
  [
    4,
    `
      CREATE TABLE IF NOT EXISTS dataset_jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        name TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        target_name TEXT NOT NULL,
        case_count INTEGER NOT NULL,
        dataset_version TEXT,
        error TEXT,
        owner_pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dataset_jobs_updated_at_idx ON dataset_jobs(updated_at DESC);
    `,
  ],
  [
    5,
    `
      ALTER TABLE dataset_jobs ADD COLUMN brief TEXT NOT NULL DEFAULT '';
    `,
  ],
  [
    6,
    `
      ALTER TABLE dataset_jobs ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 600;
    `,
  ],
  [
    7,
    `
      CREATE TABLE experiments (
        experiment_id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE runs ADD COLUMN experiment_id TEXT REFERENCES experiments(experiment_id) ON DELETE SET NULL;
      CREATE INDEX runs_experiment_id_idx ON runs(experiment_id);
    `,
  ],
  [
    8,
    `
      CREATE TABLE provider_keys (
        base_url TEXT PRIMARY KEY,
        key_encrypted TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  ],
];

/** Provider keys are shared by every model whose server URL matches after normalizing. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = String(value ?? "").trim();
  try {
    const url = new URL(trimmed);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export class DatabaseStore {
  readonly db: SqliteDatabase;
  private readonly vault: CredentialVault;
  private readonly assetRoot: string | null;

  constructor(path: string) {
    this.assetRoot = path === ":memory:" ? null : join(dirname(resolve(path)), "assets");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    if (path !== ":memory:" && existsSync(path)) {
      const probe = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const hasMigrationTable = Boolean(
          probe
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            )
            .get(),
        );
        if (hasMigrationTable) {
          const versions = probe
            .prepare("SELECT version FROM schema_migrations")
            .all() as Array<{ version: number }>;
          const latestApplied = Math.max(
            0,
            ...versions.map(({ version }) => version),
          );
          const latestKnown = Math.max(...MIGRATIONS.map(([version]) => version));
          if (latestApplied > latestKnown)
            throw new Error(
              `Database schema version ${latestApplied} is newer than supported version ${latestKnown}.`,
            );
        }
      } finally {
        probe.close();
      }
    }
    this.vault = new CredentialVault(
      path === ":memory:"
        ? join(tmpdir(), `evalforge-${randomUUID()}.credentials.key`)
        : `${path}.credentials.key`,
    );
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.initializeMigrations();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createRun(
    runId: string,
    config: RunConfig,
    datasetVersion: string,
    snapshot: object = {},
    experimentId: string | null = null,
  ): void {
    registerSecrets(
      [config.ocrTarget, config.extractionTarget, config.judgeTarget].filter(
        Boolean,
      ) as any,
    );
    const createdAt = new Date().toISOString();
    const insertRun = this.db.prepare(
      "INSERT INTO runs (run_id, dataset_version, created_at, experiment_id) VALUES (?, ?, ?, ?)",
    );
    const insertConfig = this.db.prepare(
      "INSERT INTO config_snapshots (run_id, config_json) VALUES (?, ?)",
    );

    this.db.transaction(() => {
      insertRun.run(runId, datasetVersion, createdAt, experimentId);
      insertConfig.run(runId, serializeConfig(config));
      this.db
        .prepare(
          "UPDATE runs SET status=?,snapshot_json=?,owner_pid=? WHERE run_id=?",
        )
        .run("running", JSON.stringify(sanitize(snapshot)), process.pid, runId);
    })();
  }

  saveCaseResult(runId: string, result: CaseResult, ocrGrade: unknown): void {
    this.db
      .prepare(
        `
      INSERT INTO case_results (run_id, case_id, result_json, ocr_grade_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, case_id) DO UPDATE SET
        result_json = excluded.result_json,
        ocr_grade_json = excluded.ocr_grade_json,
        created_at = excluded.created_at
    `,
      )
      .run(
        runId,
        result.caseId,
        JSON.stringify(sanitize(result)),
        ocrGrade == null ? null : JSON.stringify(ocrGrade),
        new Date().toISOString(),
      );
  }

  listRuns() {
    const rows = this.db
      .prepare(
      `
      SELECT r.run_id, r.dataset_version, r.created_at, r.experiment_id, e.name AS experiment_name, COUNT(c.case_id) AS case_count,
        SUM(CASE WHEN json_extract(c.result_json, '$.grade.passed') = 1 THEN 1 ELSE 0 END) AS passed_count,
        json_extract(d.manifest_json, '$.name') AS dataset_name
      FROM runs r LEFT JOIN experiments e ON e.experiment_id = r.experiment_id LEFT JOIN datasets d ON d.version = r.dataset_version LEFT JOIN case_results c ON c.run_id = r.run_id GROUP BY r.run_id ORDER BY r.created_at DESC
    `,
      )
      .all() as Array<Record<string, any>>;
    return rows.map((row) => {
      const run = this.getRun(row.run_id)!;
      return {
        runId: row.run_id,
        datasetVersion: row.dataset_version,
        datasetName: row.dataset_name ?? null,
        taskKind: run.config.taskKind ?? "document-json",
        targetName: run.config.extractionTarget?.name ?? null,
        modelName: run.config.extractionTarget?.model ?? null,
        createdAt: row.created_at,
        experimentId: row.experiment_id ?? null,
        experimentName: row.experiment_name ?? null,
        caseCount: row.case_count,
        passedCount: run.config.inferenceOnly ? null : (row.passed_count ?? 0),
        inferenceOnly: run.config.inferenceOnly === true,
        status: run.status,
        totalCases: run.metrics.sampleCount,
        metrics: run.metrics,
      };
    });
  }

  getRun(runId: string) {
    const row = this.db
      .prepare(
        `
      SELECT r.*, e.name AS experiment_name, c.config_json
      FROM runs r
      LEFT JOIN experiments e ON e.experiment_id = r.experiment_id
      JOIN config_snapshots c ON c.run_id = r.run_id
      WHERE r.run_id = ?
    `,
      )
      .get(runId) as
      | (RunRow & {
          status: string;
          snapshot_json: string;
          error: string;
          owner_pid: number;
        })
      | undefined;
    if (!row) return undefined;
    const config = JSON.parse(row.config_json) as RunConfig;
    const cases = this.relocateCases({
      cases: this.getRunCases(runId).map((item) => ({
        ...item.result,
        ocrGrade: item.ocrGrade,
      })),
    }).cases;
    const snapshot = JSON.parse(row.snapshot_json);
    let status = row.status;
    let error = row.error;
    if (status === "running" && row.owner_pid) {
      try {
        process.kill(row.owner_pid, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") {
          status = "interrupted";
          error = "Foreground runner exited before completion.";
          const now = new Date().toISOString();
          this.db.transaction(() => {
            const changed = this.db
              .prepare(
                "UPDATE runs SET status=?,error=?,finished_at=? WHERE run_id=? AND status=?",
              )
              .run(status, error, now, runId, "running").changes;
            if (changed)
              this.appendRunEvent(runId, "run_finished", {
                status,
                error,
                reason: "owner_process_missing",
              });
          })();
        }
      }
    }
    const total =
      snapshot.totalCases ??
      snapshot.manifest?.cases?.length ??
      snapshot.cases?.length ??
      cases.length;
    return {
      runId: row.run_id,
      datasetVersion: row.dataset_version,
      createdAt: row.created_at,
      experimentId: row.experiment_id ?? null,
      experimentName: row.experiment_name ?? null,
      config,
      cases,
      snapshot,
      status,
      error,
      metrics: metrics(cases, total, config.inferenceOnly === true),
      attempts: this.db
        .prepare(
          "SELECT case_id,stage,attempt_json FROM attempts WHERE run_id=? ORDER BY id",
        )
        .all(runId)
        .map((a: any) => ({
          caseId: a.case_id,
          stage: a.stage,
          ...JSON.parse(a.attempt_json),
        })),
    };
  }

  /** Imported images keep absolute paths. If the data folder was moved or the
   * project renamed, point them at the same file in this database's assets. */
  private relocateAsset(file: string) {
    if (!this.assetRoot || !isAbsolute(file) || existsSync(file)) return file;
    const parts = file.split(/[\\/]/);
    if (parts[parts.length - 2] !== "assets") return file;
    const candidate = join(this.assetRoot, parts[parts.length - 1]);
    return existsSync(candidate) ? candidate : file;
  }
  private relocateCases<T>(value: T): T {
    const cases = (value as { cases?: unknown })?.cases;
    if (Array.isArray(cases))
      for (const item of cases)
        if (item && typeof item.imagePath === "string") item.imagePath = this.relocateAsset(item.imagePath);
    return value;
  }

  private normalizeExperimentName(name: string): string {
    if (typeof name !== "string") throw new Error("Experiment name is required.");
    const normalized = name.trim();
    if (!normalized) throw new Error("Experiment name cannot be empty.");
    if (normalized.length > 120) throw new Error("Experiment name must be 120 characters or fewer.");
    return normalized;
  }

  listExperiments() {
    return (this.db.prepare(`
      SELECT e.experiment_id, e.name, e.created_at, e.updated_at, COUNT(r.run_id) AS run_count
      FROM experiments e LEFT JOIN runs r ON r.experiment_id = e.experiment_id
      GROUP BY e.experiment_id ORDER BY e.created_at DESC
    `).all() as Array<any>).map((row) => ({
      experimentId: row.experiment_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      runCount: Number(row.run_count ?? 0),
    }));
  }

  createExperiment(name: string) {
    const normalized = this.normalizeExperimentName(name);
    const experimentId = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO experiments(experiment_id,name,created_at,updated_at) VALUES(?,?,?,?)").run(experimentId, normalized, now, now);
    } catch (error: any) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") throw new Error("An experiment with that name already exists.");
      throw error;
    }
    return this.getExperiment(experimentId)!;
  }

  getExperiment(experimentId: string) {
    const row = this.db.prepare(`SELECT e.experiment_id, e.name, e.created_at, e.updated_at, COUNT(r.run_id) AS run_count FROM experiments e LEFT JOIN runs r ON r.experiment_id=e.experiment_id WHERE e.experiment_id=? GROUP BY e.experiment_id`).get(experimentId) as any;
    return row ? { experimentId: row.experiment_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, runCount: Number(row.run_count ?? 0) } : undefined;
  }

  renameExperiment(experimentId: string, name: string) {
    if (!this.getExperiment(experimentId)) throw new Error("Experiment not found.");
    const normalized = this.normalizeExperimentName(name);
    try {
      this.db.prepare("UPDATE experiments SET name=?,updated_at=? WHERE experiment_id=?").run(normalized, new Date().toISOString(), experimentId);
    } catch (error: any) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") throw new Error("An experiment with that name already exists.");
      throw error;
    }
    return this.getExperiment(experimentId)!;
  }

  deleteExperiment(experimentId: string) {
    if (!this.getExperiment(experimentId)) throw new Error("Experiment not found.");
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET experiment_id=NULL WHERE experiment_id=?").run(experimentId);
      this.db.prepare("DELETE FROM experiments WHERE experiment_id=?").run(experimentId);
    })();
  }

  setRunExperiment(runId: string, experimentId: string | null) {
    if (!this.getRun(runId)) throw new Error("Run not found.");
    if (experimentId !== null && !this.getExperiment(experimentId)) throw new Error("Experiment not found.");
    this.db.prepare("UPDATE runs SET experiment_id=? WHERE run_id=?").run(experimentId, runId);
    return this.getRun(runId)!;
  }

  updateRunSnapshot(runId: string, snapshot: object) {
    const row = this.db
      .prepare("SELECT snapshot_json FROM runs WHERE run_id=?")
      .get(runId) as any;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE runs SET snapshot_json=? WHERE run_id=?")
        .run(
          JSON.stringify(
            sanitize({ ...JSON.parse(row?.snapshot_json ?? "{}"), ...snapshot }),
          ),
          runId,
        );
      const config = (snapshot as { config?: RunConfig }).config;
      if (config) {
        this.db
          .prepare("UPDATE config_snapshots SET config_json=? WHERE run_id=?")
          .run(serializeConfig(config), runId);
      }
    })();
  }
  finishRun(runId: string, status: string, error?: string) {
    this.db
      .prepare("UPDATE runs SET status=?,error=?,finished_at=? WHERE run_id=?")
      .run(status, sanitize(error ?? null), new Date().toISOString(), runId);
  }
  appendRunEvent(
    runId: string,
    type: RunEventType,
    payload: unknown = {},
  ): RunEvent {
    if (!RUN_EVENT_TYPES.has(type))
      throw new Error("Unsupported run event type.");
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO run_events(run_id,event_type,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run(runId, type, JSON.stringify(eventPayload(payload)), createdAt);
    return {
      eventId: Number(result.lastInsertRowid),
      runId,
      type,
      createdAt,
      payload: eventPayload(payload),
    };
  }
  listRunEvents(runId: string, after = 0, limit = 100): RunEvent[] {
    const safeAfter = Number.isInteger(after) && after >= 0 ? after : 0;
    const safeLimit = Math.min(
      500,
      Math.max(1, Number.isInteger(limit) ? limit : 100),
    );
    return (
      this.db
        .prepare(
          "SELECT event_id,run_id,event_type,payload_json,created_at FROM run_events WHERE run_id=? AND event_id>? ORDER BY event_id ASC LIMIT ?",
        )
        .all(runId, safeAfter, safeLimit) as Array<any>
    ).map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      type: row.event_type as RunEventType,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload_json),
    }));
  }
  saveAttempt(runId: string, caseId: string, stage: string, attempt: any) {
    const row =
      attempt?.attempt === undefined
        ? undefined
        : (this.db
            .prepare(
              "SELECT id FROM attempts WHERE run_id=? AND case_id=? AND stage=? AND json_extract(attempt_json,'$.attempt')=?",
            )
            .get(runId, caseId, stage, attempt.attempt) as any);
    if (row)
      this.db
        .prepare("UPDATE attempts SET attempt_json=? WHERE id=?")
        .run(JSON.stringify(sanitize(attempt)), row.id);
    else
      this.db
        .prepare(
          "INSERT INTO attempts(run_id,case_id,stage,attempt_json) VALUES(?,?,?,?)",
        )
        .run(runId, caseId, stage, JSON.stringify(sanitize(attempt)));
  }
  beginAttempt(runId: string, caseId: string, stage: string, attempt: any) {
    this.saveAttempt(runId, caseId, stage, { ...attempt, status: "running" });
  }
  saveDataset(manifest: any) {
    this.db
      .prepare("INSERT OR IGNORE INTO datasets VALUES(?,?)")
      .run(manifest.version, JSON.stringify(manifest));
  }
  listDatasets(): any[] {
    return this.db
      .prepare("SELECT manifest_json FROM datasets ORDER BY rowid DESC")
      .all()
      .map((r: any) => this.relocateCases(JSON.parse(r.manifest_json)));
  }
  getDataset(version: string): any {
    const row = this.db
      .prepare("SELECT manifest_json FROM datasets WHERE version=?")
      .get(version) as any;
    return row ? this.relocateCases(JSON.parse(row.manifest_json)) : undefined;
  }
  renameDataset(version: string, name: string): any {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120)
      throw new Error("Dataset name must contain 1 to 120 characters.");
    const changed = this.db.prepare(
      "UPDATE datasets SET manifest_json=json_set(manifest_json, '$.name', ?) WHERE version=?",
    ).run(trimmed, version).changes;
    return changed ? this.getDataset(version) : undefined;
  }
  duplicateDataset(version: string, newVersion: string): any {
    const source = this.getDataset(version);
    if (!source) return undefined;
    const name = `${typeof source.name === "string" ? source.name : "Dataset"} (copy)`.slice(0, 120);
    const duplicate = { ...source, version: newVersion, name, duplicatedFrom: version };
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO datasets(version,manifest_json) VALUES(?,?)")
        .run(newVersion, JSON.stringify(duplicate));
    })();
    return duplicate;
  }
  deleteDataset(version: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare("DELETE FROM datasets WHERE version=?")
        .run(version).changes;
      if (!changed) return false;
      this.db
        .prepare("DELETE FROM dataset_jobs WHERE dataset_version=? AND status='completed'")
        .run(version);
      return true;
    })();
  }
  createDatasetJob(job: {
    jobId: string;
    name: string;
    taskKind: string;
    targetName: string;
    caseCount: number;
    brief: string;
    timeoutSeconds?: number;
  }) {
    const now = new Date().toISOString();
    const row = {
      jobId: job.jobId,
      status: "queued" as const,
      name: job.name,
      taskKind: job.taskKind,
      targetName: job.targetName,
      caseCount: job.caseCount,
      brief: job.brief,
      timeoutSeconds: job.timeoutSeconds ?? 600,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO dataset_jobs(job_id,status,name,task_kind,target_name,case_count,brief,timeout_seconds,owner_pid,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?, ?,?)",
        )
        .run(
          row.jobId,
          row.status,
          row.name,
          row.taskKind,
          row.targetName,
          row.caseCount,
          row.brief,
          row.timeoutSeconds,
          null,
          row.createdAt,
          row.updatedAt,
        );
      return row;
    })();
    return result;
  }
  claimNextDatasetJob(): ReturnType<DatabaseStore["getDatasetJob"]> {
    return this.db.transaction(() => {
      const running = this.db
        .prepare("SELECT job_id FROM dataset_jobs WHERE status='running' LIMIT 1")
        .get();
      if (running) return undefined;
      const next = this.db
        .prepare("SELECT job_id FROM dataset_jobs WHERE status='queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get() as { job_id?: string } | undefined;
      if (!next?.job_id) return undefined;
      const changed = this.db
        .prepare("UPDATE dataset_jobs SET status='running',owner_pid=?,updated_at=? WHERE job_id=? AND status='queued'")
        .run(process.pid, new Date().toISOString(), next.job_id).changes;
      return changed ? this.getDatasetJob(next.job_id) : undefined;
    }).immediate();
  }
  getDatasetJobInput(jobId: string) {
    const row = this.db
      .prepare("SELECT job_id,name,task_kind,target_name,case_count,brief,timeout_seconds FROM dataset_jobs WHERE job_id=?")
      .get(jobId) as any;
    return row
      ? { jobId: row.job_id, name: row.name, taskKind: row.task_kind, targetName: row.target_name, caseCount: row.case_count, brief: row.brief, timeoutSeconds: row.timeout_seconds }
      : undefined;
  }
  getDatasetJobControl(jobId: string) {
    return this.db
      .prepare("SELECT job_id,status,owner_pid FROM dataset_jobs WHERE job_id=?")
      .get(jobId) as
      | { job_id: string; status: string; owner_pid: number | null }
      | undefined;
  }
  stopDatasetJob(jobId: string) {
    const changed = this.db
      .prepare("UPDATE dataset_jobs SET status='interrupted',error='Stopped by user.',updated_at=? WHERE job_id=? AND status='queued'")
      .run(new Date().toISOString(), jobId).changes;
    return changed ? this.getDatasetJob(jobId) : undefined;
  }
  getDatasetJob(jobId: string) {
    const row = this.db
      .prepare("SELECT * FROM dataset_jobs WHERE job_id=?")
      .get(jobId) as any;
    return row ? this.datasetJob(row) : undefined;
  }
  listDatasetJobs() {
    return (this.db
      .prepare("SELECT * FROM dataset_jobs ORDER BY created_at DESC LIMIT 50")
      .all() as any[]).map((row) => this.datasetJob(row));
  }
  completeDatasetJob(jobId: string, manifest: any) {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const changed = this.db
        .prepare("UPDATE dataset_jobs SET status='completed',dataset_version=?,error=NULL,updated_at=? WHERE job_id=? AND status='running'")
        .run(manifest.version, now, jobId).changes;
      if (!changed) return false;
      this.db
        .prepare("INSERT OR IGNORE INTO datasets(version,manifest_json) VALUES(?,?)")
        .run(manifest.version, JSON.stringify(manifest));
      return true;
    })();
  }
  failDatasetJob(jobId: string, error: string, status: "failed" | "interrupted" = "failed") {
    this.db
      .prepare("UPDATE dataset_jobs SET status=?,error=?,updated_at=? WHERE job_id=? AND status='running'")
      .run(status, safeJobError(error), new Date().toISOString(), jobId);
  }
  deleteFailedDatasetJob(jobId: string): boolean {
    return this.db.prepare(
      "DELETE FROM dataset_jobs WHERE job_id=? AND status IN ('failed','interrupted')",
    ).run(jobId).changes > 0;
  }
  recoverDatasetJobs() {
    const rows = this.db
      .prepare("SELECT job_id,owner_pid FROM dataset_jobs WHERE status='running'")
      .all() as Array<{ job_id: string; owner_pid: number | null }>;
    for (const row of rows) {
      if (row.owner_pid) {
        try {
          process.kill(row.owner_pid, 0);
          continue;
        } catch (error: any) {
          if (error.code !== "ESRCH") continue;
        }
      }
      this.failDatasetJob(row.job_id, "Generation process exited before completion.", "interrupted");
    }
  }
  private datasetJob(row: any) {
    return {
      jobId: row.job_id,
      status: row.status,
      name: row.name,
      taskKind: row.task_kind,
      targetName: row.target_name,
      caseCount: row.case_count,
      timeoutSeconds: row.timeout_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.dataset_version ? { datasetVersion: row.dataset_version } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }
  saveTarget(target: any, apiKey?: string) {
    const candidate = { ...target };
    const suppliedKey = apiKey ?? candidate.apiKey;
    delete candidate.apiKey;
    delete candidate.apiKeyEncrypted;
    delete candidate.hasApiKey;
    delete candidate.keySource;
    validateTarget(candidate);
    const existing = this.db
      .prepare("SELECT config_json FROM targets WHERE name=?")
      .get(candidate.name) as { config_json?: string } | undefined;
    const previous = existing?.config_json
      ? JSON.parse(existing.config_json)
      : undefined;
    const normalizedKey =
      typeof suppliedKey === "string" && suppliedKey.trim()
        ? suppliedKey.trim()
        : undefined;
    const encrypted = normalizedKey
      ? this.vault.encrypt(normalizedKey)
      : previous?.apiKeyEncrypted;
    const stored = {
      ...candidate,
      ...(encrypted ? { apiKeyEncrypted: encrypted } : {}),
    };
    this.db
      .prepare(
        "INSERT INTO targets VALUES(?,?) ON CONFLICT(name) DO UPDATE SET config_json=excluded.config_json",
      )
      .run(candidate.name, JSON.stringify(stored));
  }
  deleteTarget(name: string) {
    const result = this.db.prepare("DELETE FROM targets WHERE name=?").run(name);
    if (!result.changes) throw new Error("Target not found.");
  }
  listTargets(): any[] {
    return this.db
      .prepare("SELECT config_json FROM targets ORDER BY name")
      .all()
      .map((r: any) => this.publicTarget(JSON.parse(r.config_json)));
  }
  getTarget(name: string, includeSecret = false): any | undefined {
    const row = this.db
      .prepare("SELECT config_json FROM targets WHERE name=?")
      .get(name) as { config_json?: string } | undefined;
    if (!row?.config_json) return undefined;
    const stored = JSON.parse(row.config_json);
    const target = this.publicTarget(stored);
    if (includeSecret) {
      const encrypted = stored.apiKeyEncrypted ?? this.providerKeyEncrypted(stored.baseUrl);
      if (encrypted) target.apiKey = this.vault.decrypt(encrypted);
    }
    return target;
  }
  listProviderKeys(): Array<{ baseUrl: string; updatedAt: string }> {
    return (
      this.db
        .prepare("SELECT base_url, updated_at FROM provider_keys ORDER BY base_url")
        .all() as Array<{ base_url: string; updated_at: string }>
    ).map((row) => ({ baseUrl: row.base_url, updatedAt: row.updated_at }));
  }
  saveProviderKey(baseUrl: string, apiKey: string): void {
    const key = apiKey.trim();
    const url = normalizeBaseUrl(baseUrl);
    if (!url) throw new Error("A server URL is required.");
    if (!key) throw new Error("Paste an API key.");
    this.db
      .prepare(
        "INSERT INTO provider_keys VALUES(?,?,?) ON CONFLICT(base_url) DO UPDATE SET key_encrypted=excluded.key_encrypted, updated_at=excluded.updated_at",
      )
      .run(url, this.vault.encrypt(key), new Date().toISOString());
  }
  deleteProviderKey(baseUrl: string): boolean {
    return (
      this.db.prepare("DELETE FROM provider_keys WHERE base_url=?").run(normalizeBaseUrl(baseUrl)).changes > 0
    );
  }
  private providerKeyEncrypted(baseUrl: unknown): string | undefined {
    if (typeof baseUrl !== "string" || !baseUrl) return undefined;
    const row = this.db
      .prepare("SELECT key_encrypted FROM provider_keys WHERE base_url=?")
      .get(normalizeBaseUrl(baseUrl)) as { key_encrypted: string } | undefined;
    return row?.key_encrypted;
  }
  resolveTarget(target: any): any {
    const stored = this.getTarget(target.name, true);
    if (!stored) return target;
    const current = { ...stored };
    delete current.hasApiKey;
    delete current.keySource;
    return { ...target, ...current };
  }
  clearTargetCredential(name: string): void {
    const target = this.getTarget(name);
    if (!target) return;
    const { hasApiKey, keySource, ...withoutFlag } = target;
    this.db
      .prepare("UPDATE targets SET config_json=? WHERE name=?")
      .run(JSON.stringify(withoutFlag), name);
  }
  private publicTarget(stored: any): any {
    const { apiKeyEncrypted, ...target } = stored;
    const keySource = apiKeyEncrypted
      ? "model"
      : this.providerKeyEncrypted(stored.baseUrl)
        ? "provider"
        : undefined;
    return { ...target, ...(keySource ? { hasApiKey: true, keySource } : {}) };
  }
  /**
   * One-time move of per-model keys into shared provider keys: for each server
   * URL, the first model's key becomes the provider key, and models holding the
   * same key drop their copy. Models with a different key keep it as an override.
   */
  private promoteTargetKeys(): void {
    const rows = this.db.prepare("SELECT name, config_json FROM targets ORDER BY name").all() as Array<{
      name: string;
      config_json: string;
    }>;
    const update = this.db.prepare("UPDATE targets SET config_json=? WHERE name=?");
    const shared = new Map<string, string>();
    for (const row of rows) {
      const stored = JSON.parse(row.config_json);
      if (!stored.apiKeyEncrypted || typeof stored.baseUrl !== "string") continue;
      let key: string;
      try {
        key = this.vault.decrypt(stored.apiKeyEncrypted);
      } catch {
        continue;
      }
      const url = normalizeBaseUrl(stored.baseUrl);
      if (!shared.has(url) && !this.providerKeyEncrypted(url)) {
        this.saveProviderKey(url, key);
        shared.set(url, key);
      }
      if (shared.get(url) === key) {
        delete stored.apiKeyEncrypted;
        update.run(JSON.stringify(stored), row.name);
      }
    }
  }

  getRunCases(runId: string): StoredCaseResult[] {
    const rows = this.db
      .prepare(
        `
      SELECT run_id, result_json, ocr_grade_json, created_at
      FROM case_results
      WHERE run_id = ?
      ORDER BY created_at ASC, rowid ASC
    `,
      )
      .all(runId) as CaseResultRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      result: JSON.parse(row.result_json) as CaseResult,
      ocrGrade:
        row.ocr_grade_json == null ? null : JSON.parse(row.ocr_grade_json),
      createdAt: row.created_at,
    }));
  }

  private initializeMigrations(): void {
    const hasMigrationTable = Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .get(),
    );
    if (hasMigrationTable) {
      const versions = this.db
        .prepare("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>;
      const latestApplied = Math.max(0, ...versions.map(({ version }) => version));
      const latestKnown = Math.max(...MIGRATIONS.map(([version]) => version));
      if (latestApplied > latestKnown)
        throw new Error(
          `Database schema version ${latestApplied} is newer than supported version ${latestKnown}.`,
        );
      const pending = MIGRATIONS.some(
        ([version]) => !versions.some((applied) => applied.version === version),
      );
      if (pending && this.db.name !== ":memory:") this.backupBeforeMigrations();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const insertMigration = this.db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    );

    // Read the applied versions inside a write-locked transaction so another
    // process opening the same database can't apply the same migration twice.
    const applyMigrations = this.db.transaction(() => {
      const applied = this.db
        .prepare("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>;
      const appliedVersions = new Set(applied.map(({ version }) => version));
      for (const [version, sql] of [...MIGRATIONS].sort(
        (a, b) => a[0] - b[0],
      )) {
        if (appliedVersions.has(version)) continue;
        this.db.exec(sql);
        if (version === 8) this.promoteTargetKeys();
        insertMigration.run(version, new Date().toISOString());
      }
    });
    applyMigrations.immediate();
  }

  private backupBeforeMigrations(): void {
    const backupPath = join(
      dirname(this.db.name),
      `${basename(this.db.name)}.pre-migration-${Date.now()}-${randomUUID()}.db`,
    );
    this.db.prepare("VACUUM INTO ?").run(backupPath);
  }
}

function safeJobError(error: unknown): string {
  const message = String(sanitize(error ?? "Dataset generation failed."));
  if (/(?:prompt|image|messages|content|authorization|api[_-]?key|token)\s*[":=]/i.test(message))
    return "Diagnostic payload redacted.";
  const returned = message.match(/^(.+?) returned (\d+):/);
  const transport = message.match(/^Transport error calling ([^:]+):/);
  if (returned) return `${returned[1]} returned ${returned[2]}.`;
  if (transport) return `Transport error calling ${transport[1]}.`;
  return message.slice(0, 500);
}

type RunRow = {
  run_id: string;
  dataset_version: string;
  created_at: string;
  config_json: string;
  experiment_id?: string | null;
  experiment_name?: string | null;
};

type CaseResultRow = {
  run_id: string;
  result_json: string;
  ocr_grade_json: string | null;
  created_at: string;
};

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (normalizedKey === "apikeyenv" || normalizedKey === "apikey") continue;
    result[key] = withoutSecrets(child);
  }
  return result;
}

function serializeConfig(config: RunConfig): string {
  return JSON.stringify(sanitize(config));
}

function toStoredRun(row: RunRow): StoredRun {
  return {
    runId: row.run_id,
    datasetVersion: row.dataset_version,
    config: JSON.parse(row.config_json) as RunConfig,
    createdAt: row.created_at,
  };
}
