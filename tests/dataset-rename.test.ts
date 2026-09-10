import { it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { DatabaseStore } from "../src/storage/db.js";

it("renames datasets without changing their contents or metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-dataset-rename-"));
  const dbPath = path.join(dir, "app.db");
  const original = {
    version: "fixture-v1",
    name: "Original dataset",
    taskKind: "text-json",
    schemaVersion: "schema-7",
    metadata: { source: "fixture", tags: ["stable", "reviewed"] },
    cases: [
      {
        caseId: "case-1",
        inputText: "Name: Ada",
        expected: { name: "Ada", confidence: 0.99 },
        metadata: { split: "validation" },
      },
    ],
  };
  const db = new DatabaseStore(dbPath);
  db.saveDataset(original);
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const patch = (version: string, name: unknown) =>
    fetch(url + `/api/datasets/${version}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

  try {
    const response = await patch(original.version, "  Renamed dataset  ");
    expect(response.status).toBe(200);
    const renamed = await response.json();
    expect(renamed).toEqual({ ...original, name: "Renamed dataset" });

    const { name: _originalName, ...originalWithoutName } = original;
    const { name: _renamedName, ...renamedWithoutName } = renamed;
    expect(renamedWithoutName).toEqual(originalWithoutName);
    expect((await (await fetch(url + "/api/datasets")).json())).toEqual([renamed]);

    for (const name of [undefined, null, 42, "", "   ", "x".repeat(121)]) {
      expect((await patch(original.version, name)).status).toBe(400);
    }
    expect((await patch("unknown-version", "Valid name")).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("duplicates with a new identity and deletes only the library record and completed job history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-dataset-copy-"));
  const dbPath = path.join(dir, "app.db");
  const original = {
    version: "fixture-v1",
    name: "Original dataset",
    taskKind: "text-json",
    metadata: { source: "fixture", tags: ["stable"] },
    cases: [{ caseId: "case-1", inputText: "Name: Ada", expected: { name: "Ada" }, metadata: { split: "validation" } }],
  };
  const db = new DatabaseStore(dbPath);
  db.saveDataset(original);
  db.db.prepare("INSERT INTO runs(run_id,dataset_version,created_at,status,snapshot_json,owner_pid) VALUES(?,?,?,?,?,?)").run("kept-run", original.version, new Date().toISOString(), "completed", "{}", null);
  db.db.prepare("INSERT INTO config_snapshots(run_id,config_json) VALUES(?,?)").run("kept-run", "{}");
  db.createDatasetJob({ jobId: "completed-source-job", name: original.name, taskKind: "text-json", targetName: "fixture", caseCount: 1, brief: "fixture" });
  db.db.prepare("UPDATE dataset_jobs SET status='completed',dataset_version=? WHERE job_id=?").run(original.version, "completed-source-job");
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "assets", "shared.bin"), "asset");
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const copiedResponse = await fetch(url + `/api/datasets/${original.version}/duplicate`, { method: "POST" });
    expect(copiedResponse.status).toBe(201);
    const copied = await copiedResponse.json();
    expect(copied).toMatchObject({ name: "Original dataset (copy)", taskKind: original.taskKind, metadata: original.metadata, cases: original.cases, duplicatedFrom: original.version });
    expect(copied.version).toMatch(/^[a-f0-9]{64}$/);
    expect(copied.version).not.toBe(original.version);

    const renamedCopy = await (await fetch(url + `/api/datasets/${copied.version}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Copy renamed" }) })).json();
    expect(renamedCopy.name).toBe("Copy renamed");
    expect((await (await fetch(url + `/api/datasets/${original.version}`)).json()).name).toBeUndefined();

    const jobs = new DatabaseStore(dbPath);
    jobs.createDatasetJob({ jobId: "queued-source-job", name: "Queued", taskKind: "text-json", targetName: "fixture", caseCount: 1, brief: "queued" });
    jobs.createDatasetJob({ jobId: "running-source-job", name: "Running", taskKind: "text-json", targetName: "fixture", caseCount: 1, brief: "running" });
    jobs.db.prepare("UPDATE dataset_jobs SET status='running',owner_pid=? WHERE job_id=?").run(process.pid, "running-source-job");
    jobs.close();

    expect((await fetch(url + `/api/datasets/${original.version}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(url + `/api/datasets/${original.version}`, { method: "DELETE" })).status).toBe(404);
    expect((await (await fetch(url + "/api/datasets")).json()).map((item: any) => item.version)).toEqual([copied.version]);
    const remaining = new DatabaseStore(dbPath);
    expect(remaining.getRun("kept-run")?.runId).toBe("kept-run");
    expect(remaining.getDatasetJob("completed-source-job")).toBeUndefined();
    expect(remaining.getDatasetJob("queued-source-job")?.status).toBe("queued");
    expect(remaining.getDatasetJob("running-source-job")?.status).toBe("running");
    remaining.close();
    expect(await (await import("node:fs/promises")).readFile(path.join(dir, "assets", "shared.bin"), "utf8")).toBe("asset");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
