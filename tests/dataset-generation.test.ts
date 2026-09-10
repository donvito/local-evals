import { it, expect } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { DatabaseStore } from "../src/storage/db.js";

async function waitForJob(url: string, jobId: string, status: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const job = await (await fetch(`${url}/api/dataset-jobs/${jobId}`)).json();
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job did not reach ${status}.`);
}

async function setup(providerPort: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-generation-api-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget({ name: "mock-provider", model: "mock-model", baseUrl: `http://127.0.0.1:${providerPort}/v1`, provider: "openai-compatible", supportsStructuredOutput: false });
  db.close();
  const server = await startServer(dbPath, 0, dir);
  return { dir, dbPath, server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

it("returns a durable running job before provider completion and exposes canonical JSONL", async () => {
  let resolveProvider!: () => void;
  const providerReady = new Promise<void>((resolve) => (resolveProvider = resolve));
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    expect(request.model).toBe("mock-model");
    expect(request.response_format).toBeUndefined();
    await providerReady;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cases: [{ caseId: "generated-001", inputText: "Name: Ada", expected: { name: "Ada" } }] }) } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { dir, server, url } = await setup((provider.address() as { port: number }).port);
  try {
    const response = await fetch(url + "/api/datasets/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetName: "mock-provider", taskKind: "text-json", name: "Generated text fixture", caseCount: 1, brief: "Extract names." }) });
    expect(response.status).toBe(202);
    const job = await response.json();
    expect(job).toMatchObject({ status: "queued", timeoutSeconds: 600, name: "Generated text fixture", taskKind: "text-json", targetName: "mock-provider", caseCount: 1 });
    expect((await (await fetch(url + "/api/dataset-jobs")).json())[0].jobId).toBe(job.jobId);
    resolveProvider();
    const completed = await waitForJob(url, job.jobId, "completed");
    const listed = await (await fetch(url + "/api/datasets")).json();
    expect(listed.some((item: any) => item.version === completed.datasetVersion)).toBe(true);
    const raw = await fetch(url + `/api/datasets/${encodeURIComponent(completed.datasetVersion)}/jsonl`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("application/jsonl");
    expect(await raw.text()).toContain('"caseId":"generated-001"');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("advances the FIFO queue after a provider failure", async () => {
  let calls = 0;
  let firstStarted!: () => void;
  const firstRequest = new Promise<void>((resolve) => (firstStarted = resolve));
  let releaseFailure!: () => void;
  const failureReleased = new Promise<void>((resolve) => (releaseFailure = resolve));
  const provider = http.createServer(async (_req, res) => {
    calls++;
    if (calls === 1) {
      firstStarted();
      await failureReleased;
      res.statusCode = 500;
      res.end("provider unavailable");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cases: [{ caseId: "second", inputText: "Name: Bob", expected: { name: "Bob" } }] }) } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { dir, server, url } = await setup((provider.address() as { port: number }).port);
  try {
    const payload = { targetName: "mock-provider", taskKind: "text-json", caseCount: 1, timeoutSeconds: 30 };
    const first = await fetch(url + "/api/datasets/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(first.status).toBe(202);
    const firstJob = await first.json();
    await firstRequest;
    const second = await fetch(url + "/api/datasets/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(second.status).toBe(202);
    const secondJob = await second.json();
    expect(await (await fetch(url + `/api/dataset-jobs/${secondJob.jobId}`)).json()).toMatchObject({ status: "queued", timeoutSeconds: 30 });
    releaseFailure();
    const failed = await waitForJob(url, firstJob.jobId, "failed");
    expect(failed.error).toBeTruthy();
    expect(failed.error).not.toContain("provider unavailable");
    expect((await waitForJob(url, secondJob.jobId, "completed")).datasetVersion).toBeTruthy();
    expect(calls).toBe(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects invalid generation timeouts", async () => {
  const provider = http.createServer((_req, res) => { res.statusCode = 500; res.end(); });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { dir, server, url } = await setup((provider.address() as { port: number }).port);
  try {
    const response = await fetch(url + "/api/datasets/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetName: "mock-provider", taskKind: "text-json", timeoutSeconds: 29 }) });
    expect(response.status).toBe(400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers orphaned generation jobs on startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-generation-recovery-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.createDatasetJob({ jobId: "orphaned-job", name: "Orphan", taskKind: "text-json", targetName: "mock-provider", caseCount: 1, brief: "Resume me." });
  let deadPid = process.pid + 1;
  while (true) {
    try {
      process.kill(deadPid, 0);
      deadPid++;
    } catch (error: any) {
      if (error.code === "ESRCH") break;
      deadPid++;
    }
  }
  db.db.prepare("UPDATE dataset_jobs SET status='running',owner_pid=? WHERE job_id=?").run(deadPid, "orphaned-job");
  db.close();
  const server = await startServer(dbPath, 0, dir);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await (await fetch(url + "/api/dataset-jobs/orphaned-job")).json()).toMatchObject({ status: "interrupted" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("resumes queued jobs after restart", async () => {
  const provider = http.createServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cases: [{ caseId: "resumed", inputText: "Name: Eve", expected: { name: "Eve" } }] }) } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-generation-restart-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget({ name: "mock-provider", model: "mock-model", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, provider: "openai-compatible", supportsStructuredOutput: false });
  db.createDatasetJob({ jobId: "queued-after-restart", name: "Queued", taskKind: "text-json", targetName: "mock-provider", caseCount: 1, brief: "Resume queued work.", timeoutSeconds: 45 });
  db.close();
  const server = await startServer(dbPath, 0, dir);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await waitForJob(url, "queued-after-restart", "completed")).status).toBe("completed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("stops queued and running jobs safely", async () => {
  let calls = 0;
  let firstStarted!: () => void;
  const firstRequest = new Promise<void>((resolve) => (firstStarted = resolve));
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
  const provider = http.createServer(async (req, res) => {
    calls++;
    if (calls === 1) {
      firstStarted();
      req.once("close", releaseFirst);
      await firstReleased;
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cases: [{ caseId: "after-stop", inputText: "Name: Zoe", expected: { name: "Zoe" } }] }) } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { dir, server, url } = await setup((provider.address() as { port: number }).port);
  try {
    const payload = { targetName: "mock-provider", taskKind: "text-json", caseCount: 1 };
    const first = await fetch(url + "/api/datasets/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const firstJob = await first.json();
    await firstRequest;
    const second = await fetch(url + "/api/datasets/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const secondJob = await second.json();
    const stoppedQueued = await fetch(url + `/api/dataset-jobs/${secondJob.jobId}/stop`, { method: "POST" });
    expect(stoppedQueued.status).toBe(200);
    expect(await stoppedQueued.json()).toMatchObject({ status: "interrupted", error: "Stopped by user." });
    expect(calls).toBe(1);

    const stoppedRunning = await fetch(url + `/api/dataset-jobs/${firstJob.jobId}/stop`, { method: "POST" });
    expect(stoppedRunning.status).toBe(200);
    expect(await stoppedRunning.json()).toMatchObject({ status: "interrupted", error: "Stopped by user." });
    expect(calls).toBe(1);
    expect((await (await fetch(url + "/api/datasets")).json()).some((item: any) => item.name === firstJob.name)).toBe(false);
    expect((await fetch(url + `/api/dataset-jobs/${firstJob.jobId}/stop`, { method: "POST" })).status).toBe(409);
    expect((await fetch(url + "/api/dataset-jobs/missing/stop", { method: "POST" })).status).toBe(404);
    releaseFirst();
  } finally {
    releaseFirst();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("deletes only failed and interrupted dataset jobs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-generation-delete-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  const savedDataset = { version: "saved-fixture", taskKind: "text-json", name: "Saved fixture", cases: [] };
  db.saveTarget({ name: "mock-provider", model: "mock-model", baseUrl: "http://127.0.0.1:1/v1", provider: "openai-compatible", supportsStructuredOutput: false });
  db.saveDataset(savedDataset);
  for (const jobId of ["queued-job", "running-job", "completed-job", "failed-job", "interrupted-job"])
    db.createDatasetJob({ jobId, name: jobId, taskKind: "text-json", targetName: "mock-provider", caseCount: 1, brief: "Fixture." });
  db.db.prepare("UPDATE dataset_jobs SET status='running',owner_pid=? WHERE job_id=?").run(process.pid, "running-job");
  db.db.prepare("UPDATE dataset_jobs SET status='completed',dataset_version=? WHERE job_id=?").run(savedDataset.version, "completed-job");
  db.db.prepare("UPDATE dataset_jobs SET status='failed',dataset_version=? WHERE job_id=?").run(savedDataset.version, "failed-job");
  db.db.prepare("UPDATE dataset_jobs SET status='interrupted' WHERE job_id=?").run("interrupted-job");
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const missing = await fetch(url + "/api/dataset-jobs/missing-job", { method: "DELETE" });
    expect(missing.status).toBe(404);

    for (const jobId of ["failed-job", "interrupted-job"]) {
      const response = await fetch(url + `/api/dataset-jobs/${jobId}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: true });
      expect((await fetch(url + `/api/dataset-jobs/${jobId}`)).status).toBe(404);
    }

    for (const jobId of ["queued-job", "running-job", "completed-job"]) {
      const response = await fetch(url + `/api/dataset-jobs/${jobId}`, { method: "DELETE" });
      expect(response.status).toBe(409);
      expect((await (await fetch(url + `/api/dataset-jobs/${jobId}`)).json()).jobId).toBe(jobId);
    }
    expect(await (await fetch(url + "/api/datasets")).json()).toEqual([savedDataset]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("retries only failed and interrupted dataset jobs with copied input", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-generation-retry-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.createDatasetJob({ jobId: "retry-blocker", name: "Blocker", taskKind: "text-json", targetName: "missing-provider", caseCount: 1, brief: "Block scheduling." });
  db.createDatasetJob({ jobId: "failed-retry", name: "Failed source", taskKind: "document-json", targetName: "missing-provider", caseCount: 3, brief: "Retry this failed job.", timeoutSeconds: 45 });
  db.createDatasetJob({ jobId: "interrupted-retry", name: "Interrupted source", taskKind: "tool-calling", targetName: "another-missing-provider", caseCount: 2, brief: "Retry this interrupted job.", timeoutSeconds: 90 });
  db.createDatasetJob({ jobId: "queued-retry", name: "Queued source", taskKind: "text-json", targetName: "missing-provider", caseCount: 1, brief: "Do not retry queued." });
  db.createDatasetJob({ jobId: "completed-retry", name: "Completed source", taskKind: "text-json", targetName: "missing-provider", caseCount: 1, brief: "Do not retry completed." });
  db.db.prepare("UPDATE dataset_jobs SET status='running',owner_pid=? WHERE job_id=?").run(process.pid, "retry-blocker");
  db.db.prepare("UPDATE dataset_jobs SET status='failed' WHERE job_id=?").run("failed-retry");
  db.db.prepare("UPDATE dataset_jobs SET status='interrupted' WHERE job_id=?").run("interrupted-retry");
  db.db.prepare("UPDATE dataset_jobs SET status='completed' WHERE job_id=?").run("completed-retry");
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const missing = await fetch(url + "/api/dataset-jobs/missing-retry/retry", { method: "POST" });
    expect(missing.status).toBe(404);

    for (const jobId of ["queued-retry", "retry-blocker", "completed-retry"]) {
      const response = await fetch(url + `/api/dataset-jobs/${jobId}/retry`, { method: "POST" });
      expect(response.status).toBe(409);
    }

    const expectedInputs = {
      "failed-retry": { name: "Failed source", taskKind: "document-json", targetName: "missing-provider", caseCount: 3, brief: "Retry this failed job.", timeoutSeconds: 45 },
      "interrupted-retry": { name: "Interrupted source", taskKind: "tool-calling", targetName: "another-missing-provider", caseCount: 2, brief: "Retry this interrupted job.", timeoutSeconds: 90 },
    };
    for (const [originalId, expectedInput] of Object.entries(expectedInputs)) {
      const response = await fetch(url + `/api/dataset-jobs/${originalId}/retry`, { method: "POST" });
      expect(response.status).toBe(202);
      const retry = await response.json();
      expect(retry).toMatchObject({ status: "queued", ...expectedInput });
      expect(retry.jobId).not.toBe(originalId);

      const reader = new DatabaseStore(dbPath);
      try {
        expect(reader.getDatasetJobInput(retry.jobId)).toEqual({ jobId: retry.jobId, ...expectedInput });
        expect(reader.getDatasetJobInput(originalId)).toEqual({ jobId: originalId, ...expectedInput });
      } finally {
        reader.close();
      }
      expect(await (await fetch(url + `/api/dataset-jobs/${originalId}`)).json()).toMatchObject({ jobId: originalId, status: originalId === "failed-retry" ? "failed" : "interrupted" });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
