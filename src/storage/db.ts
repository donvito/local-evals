import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
];

export class DatabaseStore {
  readonly db: SqliteDatabase;
  private readonly vault: CredentialVault;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.vault = new CredentialVault(
      path === ":memory:"
        ? join(tmpdir(), `evalforge-${randomUUID()}.credentials.key`)
        : `${path}.credentials.key`,
    );
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initializeMigrations();
  }

  close(): void {
    this.db.close();
  }

  createRun(
    runId: string,
    config: RunConfig,
    datasetVersion: string,
    snapshot: object = {},
  ): void {
    registerSecrets(
      [config.ocrTarget, config.extractionTarget, config.judgeTarget].filter(
        Boolean,
      ) as any,
    );
    const createdAt = new Date().toISOString();
    const insertRun = this.db.prepare(
      "INSERT INTO runs (run_id, dataset_version, created_at) VALUES (?, ?, ?)",
    );
    const insertConfig = this.db.prepare(
      "INSERT INTO config_snapshots (run_id, config_json) VALUES (?, ?)",
    );

    this.db.transaction(() => {
      insertRun.run(runId, datasetVersion, createdAt);
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
      SELECT r.run_id, r.dataset_version, r.created_at, COUNT(c.case_id) AS case_count,
        SUM(CASE WHEN json_extract(c.result_json, '$.grade.passed') = 1 THEN 1 ELSE 0 END) AS passed_count
      FROM runs r LEFT JOIN case_results c ON c.run_id = r.run_id GROUP BY r.run_id ORDER BY r.created_at DESC
    `,
      )
      .all() as Array<Record<string, any>>;
    return rows.map((row) => {
      const run = this.getRun(row.run_id)!;
      return {
        runId: row.run_id,
        datasetVersion: row.dataset_version,
        createdAt: row.created_at,
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
      SELECT r.*, c.config_json
      FROM runs r
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
    const cases = this.getRunCases(runId).map((item) => ({
      ...item.result,
      ocrGrade: item.ocrGrade,
    }));
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
      .map((r: any) => JSON.parse(r.manifest_json));
  }
  getDataset(version: string): any {
    const row = this.db
      .prepare("SELECT manifest_json FROM datasets WHERE version=?")
      .get(version) as any;
    return row ? JSON.parse(row.manifest_json) : undefined;
  }
  saveTarget(target: any, apiKey?: string) {
    const candidate = { ...target };
    const suppliedKey = apiKey ?? candidate.apiKey;
    delete candidate.apiKey;
    delete candidate.apiKeyEncrypted;
    delete candidate.hasApiKey;
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
    if (includeSecret && stored.apiKeyEncrypted)
      target.apiKey = this.vault.decrypt(stored.apiKeyEncrypted);
    return target;
  }
  resolveTarget(target: any): any {
    const stored = this.getTarget(target.name, true);
    if (!stored) return target;
    const current = { ...stored };
    delete current.hasApiKey;
    return { ...target, ...current };
  }
  clearTargetCredential(name: string): void {
    const target = this.getTarget(name);
    if (!target) return;
    const { hasApiKey, ...withoutFlag } = target;
    this.db
      .prepare("UPDATE targets SET config_json=? WHERE name=?")
      .run(JSON.stringify(withoutFlag), name);
  }
  private publicTarget(stored: any): any {
    const { apiKeyEncrypted, ...target } = stored;
    return { ...target, ...(apiKeyEncrypted ? { hasApiKey: true } : {}) };
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = this.db
      .prepare("SELECT version FROM schema_migrations")
      .all() as Array<{ version: number }>;
    const appliedVersions = new Set(applied.map(({ version }) => version));
    const insertMigration = this.db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    );

    const applyMigrations = this.db.transaction(() => {
      for (const [version, sql] of [...MIGRATIONS].sort(
        (a, b) => a[0] - b[0],
      )) {
        if (appliedVersions.has(version)) continue;
        this.db.exec(sql);
        insertMigration.run(version, new Date().toISOString());
      }
    });
    applyMigrations();
  }
}

type RunRow = {
  run_id: string;
  dataset_version: string;
  created_at: string;
  config_json: string;
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
