import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DatabaseStore } from "../src/storage/db.js";
import { startServer } from "../src/server.js";
import { runEvaluation } from "../src/core/runner.js";

const config: any = {
  datasetVersion: "fixture",
  schemaVersion: "v1",
  fieldRules: [],
  stagePrompts: { ocr: "ocr", extraction: "extract" },
  outputMode: "prompted-json",
  ocrTarget: { name: "test", model: "test", baseUrl: "http://localhost" },
  extractionTarget: {
    name: "test",
    model: "test",
    baseUrl: "http://localhost",
  },
};

describe("named experiments", () => {
  it("keeps a newly executed run in the selected experiment", async () => {
    const db = new DatabaseStore(":memory:");
    try {
      const experiment = db.createExperiment("Prompt trial");
      const result = await runEvaluation(
        { taskKind: "text-json", cases: [{ caseId: "one", inputText: "Avery ordered 3 notebooks." }] },
        {
          datasetVersion: "fixture",
          schemaVersion: "v1",
          taskKind: "text-json",
          stagePrompts: { extraction: "Return JSON." },
          outputMode: "prompted-json",
          extractionTarget: config.extractionTarget,
          fieldRules: [],
          inferenceOnly: true,
        },
        {
          db,
          experimentId: experiment.experimentId,
          provider: (async () => ({ text: '{"quantity":3}', raw: {} })) as any,
        },
      );
      expect(db.getRun(result.runId)).toMatchObject({
        experimentId: experiment.experimentId,
        experimentName: "Prompt trial",
      });
      expect(db.getExperiment(experiment.experimentId)?.runCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("enforces case-insensitive names and preserves run membership while renaming", () => {
    const db = new DatabaseStore(":memory:");
    try {
      const experiment = db.createExperiment("  Baseline  ");
      expect(experiment.name).toBe("Baseline");
      expect(() => db.createExperiment("baseline")).toThrow(
        "An experiment with that name already exists.",
      );

      const other = db.createExperiment("Candidate");
      expect(() => db.renameExperiment(other.experimentId, " BASELINE ")).toThrow(
        "An experiment with that name already exists.",
      );
      const renamed = db.renameExperiment(other.experimentId, " Improved ");
      expect(renamed.name).toBe("Improved");
      expect(db.listExperiments().map((item) => item.name).sort()).toEqual([
        "Baseline",
        "Improved",
      ]);
    } finally {
      db.close();
    }
  });

  it("supports legacy ungrouped runs, assignment, reassignment, and detachment", () => {
    const db = new DatabaseStore(":memory:");
    try {
      const first = db.createExperiment("First");
      const second = db.createExperiment("Second");
      db.createRun("legacy", config, "fixture", { totalCases: 0 });
      db.createRun("grouped", config, "fixture", { totalCases: 0 }, first.experimentId);

      expect(db.getRun("legacy")).toMatchObject({
        experimentId: null,
        experimentName: null,
      });
      expect(db.getExperiment(first.experimentId)?.runCount).toBe(1);

      const reassigned = db.setRunExperiment("grouped", second.experimentId);
      expect(reassigned).toMatchObject({
        experimentId: second.experimentId,
        experimentName: "Second",
      });
      expect(db.getExperiment(first.experimentId)?.runCount).toBe(0);
      expect(db.getExperiment(second.experimentId)?.runCount).toBe(1);

      const detached = db.setRunExperiment("grouped", null);
      expect(detached).toMatchObject({
        experimentId: null,
        experimentName: null,
      });
      expect(db.getExperiment(second.experimentId)?.runCount).toBe(0);
      expect(db.listRuns()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: "legacy", experimentId: null }),
          expect.objectContaining({ runId: "grouped", experimentId: null }),
        ]),
      );
      expect(() => db.setRunExperiment("missing", null)).toThrow("Run not found.");
      expect(() => db.setRunExperiment("legacy", "missing")).toThrow(
        "Experiment not found.",
      );
    } finally {
      db.close();
    }
  });

  it("deletes an experiment and leaves its runs ungrouped", () => {
    const db = new DatabaseStore(":memory:");
    try {
      const experiment = db.createExperiment("Disposable");
      db.createRun("member", config, "fixture", { totalCases: 0 }, experiment.experimentId);
      db.deleteExperiment(experiment.experimentId);
      expect(db.getExperiment(experiment.experimentId)).toBeUndefined();
      expect(db.getRun("member")).toMatchObject({ experimentId: null, experimentName: null });
      expect(() => db.deleteExperiment(experiment.experimentId)).toThrow("Experiment not found.");
    } finally {
      db.close();
    }
  });

  it("labels listed runs with dataset name, task kind, and model", () => {
    const db = new DatabaseStore(":memory:");
    try {
      db.saveDataset({ version: "fixture", name: "Receipts sample", cases: [] } as any);
      db.createRun("labelled", config, "fixture", { totalCases: 0 });
      db.createRun("orphan", config, "missing-dataset", { totalCases: 0 });
      const runs = db.listRuns();
      expect(runs.find((run) => run.runId === "labelled")).toMatchObject({
        datasetName: "Receipts sample",
        taskKind: "document-json",
        targetName: "test",
        modelName: "test",
      });
      expect(runs.find((run) => run.runId === "orphan")?.datasetName).toBeNull();
    } finally {
      db.close();
    }
  });

  it("adds nullable experiment membership when migrating a v6 database", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-experiments-migration-"));
    const dbPath = path.join(dir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, 'old'), (2, 'old'), (3, 'old'), (4, 'old'), (5, 'old'), (6, 'old');
      CREATE TABLE runs(
        run_id TEXT PRIMARY KEY, dataset_version TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed', snapshot_json TEXT NOT NULL DEFAULT '{}',
        error TEXT, owner_pid INTEGER, finished_at TEXT
      );
      CREATE TABLE config_snapshots(run_id TEXT PRIMARY KEY REFERENCES runs(run_id), config_json TEXT NOT NULL);
      CREATE TABLE case_results(run_id TEXT NOT NULL, case_id TEXT NOT NULL, result_json TEXT NOT NULL, ocr_grade_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(run_id, case_id));
      CREATE TABLE run_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE dataset_jobs(job_id TEXT PRIMARY KEY, status TEXT NOT NULL, name TEXT NOT NULL, task_kind TEXT NOT NULL, target_name TEXT NOT NULL, case_count INTEGER NOT NULL, dataset_version TEXT, error TEXT, owner_pid INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', timeout_seconds INTEGER NOT NULL DEFAULT 600);
      CREATE TABLE datasets(version TEXT PRIMARY KEY, manifest_json TEXT NOT NULL);
      CREATE TABLE targets(name TEXT PRIMARY KEY, config_json TEXT NOT NULL);
      CREATE TABLE attempts(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, case_id TEXT NOT NULL, stage TEXT NOT NULL, attempt_json TEXT NOT NULL);
    `);
    legacy
      .prepare("INSERT INTO runs(run_id,dataset_version,created_at) VALUES(?,?,?)")
      .run("old-run", "fixture", "2026-01-01T00:00:00.000Z");
    legacy
      .prepare("INSERT INTO config_snapshots(run_id,config_json) VALUES(?,?)")
      .run("old-run", JSON.stringify(config));
    legacy.close();

    const db = new DatabaseStore(dbPath);
    try {
      expect(db.getRun("old-run")).toMatchObject({
        runId: "old-run",
        experimentId: null,
        experimentName: null,
      });
      expect(db.listExperiments()).toEqual([]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes experiment CRUD, run assignment, and start validation over HTTP", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-experiments-api-"));
    const dbPath = path.join(dir, "app.db");
    const server = await startServer(dbPath, 0, dir);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (pathname: string, init?: RequestInit) =>
      fetch(url + pathname, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      });
    const json = (value: unknown) => JSON.stringify(value);
    try {
      const createdResponse = await request("/api/experiments", {
        method: "POST",
        body: json({ name: "HTTP baseline" }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json();
      expect(created).toMatchObject({ name: "HTTP baseline", runCount: 0 });

      expect(
        (
          await request("/api/experiments", {
            method: "POST",
            body: json({ name: "http BASELINE" }),
          })
        ).status,
      ).toBe(400);
      expect((await (await request("/api/experiments")).json()).map((item: any) => item.name)).toEqual([
        "HTTP baseline",
      ]);

      const renamedResponse = await request(`/api/experiments/${created.experimentId}`, {
        method: "PATCH",
        body: json({ name: "HTTP renamed" }),
      });
      expect(renamedResponse.status).toBe(200);
      expect((await renamedResponse.json()).name).toBe("HTTP renamed");

      const db = new DatabaseStore(dbPath);
      db.createRun("http-run", config, "fixture", { totalCases: 0 });
      db.finishRun("http-run", "completed");
      db.close();
      const assigned = await request("/api/runs/http-run/experiment", {
        method: "PUT",
        body: json({ experimentId: created.experimentId }),
      });
      expect(assigned.status).toBe(200);
      expect(await assigned.json()).toMatchObject({
        runId: "http-run",
        experimentId: created.experimentId,
        experimentName: "HTTP renamed",
      });
      expect((await (await request("/api/runs")).json())[0]).toMatchObject({
        runId: "http-run",
        experimentName: "HTTP renamed",
      });

      const unknownStart = await request("/api/runs/start", {
        method: "POST",
        body: json({ experimentId: "does-not-exist" }),
      });
      expect(unknownStart.status).toBe(400);
      expect((await unknownStart.json()).error).toBe("Experiment not found.");

      const acceptedExperimentButInvalidSetup = await request("/api/runs/start", {
        method: "POST",
        body: json({ experimentId: created.experimentId }),
      });
      expect(acceptedExperimentButInvalidSetup.status).toBe(404);
      expect((await acceptedExperimentButInvalidSetup.json()).error).toMatch(
        /File not found/,
      );

      const deleted = await request(`/api/experiments/${created.experimentId}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect((await (await request("/api/runs")).json())[0]).toMatchObject({
        runId: "http-run",
        experimentId: null,
      });
      expect(
        (await request(`/api/experiments/${created.experimentId}`, { method: "DELETE" })).status,
      ).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
