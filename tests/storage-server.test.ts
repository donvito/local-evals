import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { DatabaseStore } from "../src/storage/db.js";
import { importManifest } from "../src/core/manifest.js";
import { compareRuns } from "../src/core/reports.js";
import { startServer } from "../src/server.js";
const config: any = {
  datasetVersion: "same",
  schemaVersion: "v1",
  fieldRules: [],
  stagePrompts: { ocr: "ocr", extraction: "extract" },
  outputMode: "prompted-json",
  ocrTarget: { name: "x", model: "x", baseUrl: "http://localhost" },
  extractionTarget: {
    name: "x",
    model: "x",
    baseUrl: "http://localhost",
    apiKeyEnv: "EVALFORGE_TEST_KEY",
  },
};
describe("storage and server integration", () => {
  it("persists UI credentials encrypted and exposes only presence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-vault-db-"));
    const file = path.join(dir, "credentials.db");
    const db = new DatabaseStore(file);
    try {
      db.saveTarget(
        {
          name: "openrouter-ui",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "example/model",
          provider: "openrouter",
        },
        "sk-or-test-secret",
      );
      expect(db.listTargets()[0]).toMatchObject({ hasApiKey: true });
      expect(db.listTargets()[0].apiKey).toBeUndefined();
      expect(db.getTarget("openrouter-ui", true).apiKey).toBe(
        "sk-or-test-secret",
      );
      const resolvedBeforeEdit = db.resolveTarget({
        name: "openrouter-ui",
        baseUrl: "http://stale.example/v1",
        model: "stale/model",
      });
      expect(resolvedBeforeEdit).toMatchObject({
        baseUrl: "https://openrouter.ai/api/v1",
        model: "example/model",
        apiKey: "sk-or-test-secret",
      });
      db.saveTarget(
        {
          name: "openrouter-ui",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "local/vision",
          provider: "openai-compatible",
        },
        "local-secret",
      );
      expect(
        db.resolveTarget({
          name: "openrouter-ui",
          baseUrl: "old",
          model: "old",
        }),
      ).toMatchObject({
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local/vision",
        apiKey: "local-secret",
      });
      const stored = db.db
        .prepare("SELECT config_json FROM targets WHERE name=?")
        .get("openrouter-ui") as { config_json: string };
      expect(stored.config_json).not.toContain("sk-or-test-secret");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("migrates existing history, retains attempts, redacts secrets and excludes incompatible comparisons", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-db-"));
    const file = path.join(dir, "nested", "run.db");
    const db = new DatabaseStore(file);
    try {
      process.env.EVALFORGE_TEST_KEY = "sentinel-private-value";
      db.createRun("a", config, "same", { totalCases: 2, graderVersion: "v2" });
      db.saveAttempt("a", "one", "ocr", { error: "sentinel-private-value" });
      db.saveCaseResult(
        "a",
        {
          caseId: "one",
          imagePath: "x",
          timings: {},
          grade: {
            parseSuccess: true,
            schemaValid: true,
            fieldAccuracy: 1,
            passed: true,
            failures: [],
          },
        },
        null,
      );
      db.finishRun("a", "completed");
      const a = db.getRun("a")!;
      expect(a.metrics.passRate).toBe(0.5);
      expect(JSON.stringify(a)).not.toContain("sentinel-private-value");
      expect(a.config.extractionTarget.apiKeyEnv).toBe("EVALFORGE_TEST_KEY");
      db.createRun(
        "b",
        { ...config, datasetVersion: "different" },
        "different",
        { graderVersion: "v2" },
      );
      expect(() => compareRuns(a, db.getRun("b"))).toThrow(/incompatible/);
      db.db
        .prepare("UPDATE runs SET owner_pid=? WHERE run_id=?")
        .run(2147483647, "b");
      expect(db.getRun("b")?.status).toBe("interrupted");
      expect(db.getRun("b")?.error).toBe(
        "Foreground runner exited before completion.",
      );
      expect(
        db.listRunEvents("b").filter((event) => event.type === "run_finished"),
      ).toHaveLength(1);
      db.getRun("b");
      expect(
        db.listRunEvents("b").filter((event) => event.type === "run_finished"),
      ).toHaveLength(1);
    } finally {
      db.close();
      delete process.env.EVALFORGE_TEST_KEY;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("upgrades an original v1 database without losing rows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-migrate-")),
      file = path.join(dir, "v1.db");
    const old = new Database(file);
    old.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO schema_migrations VALUES(1,'old');CREATE TABLE runs(run_id TEXT PRIMARY KEY,dataset_version TEXT,created_at TEXT);CREATE TABLE config_snapshots(run_id TEXT PRIMARY KEY,config_json TEXT);CREATE TABLE case_results(run_id TEXT,case_id TEXT,result_json TEXT,ocr_grade_json TEXT,created_at TEXT,PRIMARY KEY(run_id,case_id));INSERT INTO runs VALUES('legacy','v1','old');",
    );
    old
      .prepare("INSERT INTO config_snapshots VALUES(?,?)")
      .run("legacy", JSON.stringify(config));
    old.close();
    const db = new DatabaseStore(file);
    try {
      expect(db.getRun("legacy")?.status).toBe("completed");
      expect(db.listRuns()).toHaveLength(1);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("persists compact allowlisted events and paginates them", async () => {
    const db = new DatabaseStore(":memory:");
    try {
      db.createRun("events", config, "same", { totalCases: 1 });
      db.appendRunEvent("events", "run_started", {
        totalCases: 1,
        prompt: "do not persist",
        apiKey: "secret",
        error: 'vision returned 400: {"prompt":"do not persist image bytes"}',
        metadata: { unsafe: true },
      });
      db.appendRunEvent("events", "case_finished", {
        caseId: "one",
        status: "success",
        elapsedMs: 12,
      });
      const first = db.listRunEvents("events", 0, 1);
      expect(first).toHaveLength(1);
      expect(first[0].eventId).toBeLessThan(
        db.listRunEvents("events", first[0].eventId, 10)[0].eventId,
      );
      expect(JSON.stringify(first)).not.toContain("do not persist");
      expect(JSON.stringify(first)).not.toContain("secret");
      expect(JSON.stringify(first)).toContain("Diagnostic payload redacted.");
      expect(() => db.appendRunEvent("events", "unknown" as any, {})).toThrow();
    } finally {
      db.close();
    }
  });
  it("serves shared metrics, images and JSON 404; blocks foreign origins and traversal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-server-")),
      file = path.join(dir, "data.db");
    const db = new DatabaseStore(file);
    db.createRun("a", config, "same", { totalCases: 1 });
    db.appendRunEvent("a", "run_started", { totalCases: 1 });
    db.finishRun("a", "failed", "Connection refused");
    const expected = db.getRun("a")!.metrics;
    db.saveTarget({ ...config.ocrTarget, supportsVision: true });
    db.saveDataset({
      version: "same",
      cases: [{ caseId: "a", imagePath: "unused.png", expected: {} }],
    });
    db.close();
    await writeFile(
      path.join(dir, "fixture.json"),
      JSON.stringify({
        ...config,
        schema: {
          type: "object",
          required: ["merchant", "date", "total"],
          properties: {
            merchant: { type: "string" },
            date: { type: "string" },
            total: { type: "number" },
          },
        },
      }),
    );
    const server = await startServer(file, 0, dir);
    const address = server.address() as { port: number };
    const url = "http://127.0.0.1:" + address.port;
    try {
      const setup = await fetch(url + "/api/setup/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseConfigPath: "fixture.json",
          datasetVersion: "same",
          ocrTarget: "x",
          extractionTarget: "x",
          extractionSource: "ocr",
          outputMode: "prompted-json",
        }),
      });
      expect(setup.status).toBe(200);
      const saved = JSON.parse(
        await readFile(path.join(dir, "dashboard-config.json"), "utf8"),
      );
      expect(saved.schema.required).toEqual(["merchant", "date", "total"]);
      expect(saved.extractionTarget.model).toBe("x");
      expect((await (await fetch(url + "/api/runs/a")).json()).metrics).toEqual(
        expected,
      );
      const events = await fetch(url + "/api/runs/a/events?after=0&limit=10");
      expect(events.status).toBe(200);
      expect((await events.json()).events).toHaveLength(1);
      expect((await fetch(url + "/api/runs/missing/events")).status).toBe(404);
      expect((await fetch(url + "/api/runs/missing")).status).toBe(404);
      expect(
        (
          await fetch(url + "/api/runs", {
            headers: { Origin: "https://untrusted.example" },
          })
        ).status,
      ).toBe(403);
      const traversal = await new Promise<number>((resolve, reject) => {
        http
          .get(
            {
              hostname: "127.0.0.1",
              port: address.port,
              path: "/assets/../../package.json",
            },
            (r) => {
              r.resume();
              resolve(r.statusCode!);
            },
          )
          .on("error", reject);
      });
      expect(traversal).not.toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("moved data folders", () => {
  it("resolves imported image paths from an old folder to this database's assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-moved-"));
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "assets", "abc.png"), "png");
    const oldPath = path.join(dir, "renamed-away", ".localevals", "assets", "abc.png");
    const db = new DatabaseStore(path.join(dir, "app.db"));
    try {
      db.saveDataset({
        version: "moved",
        name: "Moved",
        cases: [
          { caseId: "one", imagePath: oldPath, expected: {} },
          { caseId: "two", imagePath: path.join(dir, "elsewhere", "missing.png"), expected: {} },
        ],
      } as any);
      const [first, second] = db.getDataset("moved").cases;
      expect(first.imagePath).toBe(path.join(dir, "assets", "abc.png"));
      expect(second.imagePath).toBe(path.join(dir, "elsewhere", "missing.png"));
      expect(db.listDatasets()[0].cases[0].imagePath).toBe(path.join(dir, "assets", "abc.png"));
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
