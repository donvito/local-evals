import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = process.cwd();
const requestedDb = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.EVALFORGE_SMOKE_DB
    ? path.resolve(process.env.EVALFORGE_SMOKE_DB)
    : undefined;
const manifest = path.join(repo, "sample-data/manifest.jsonl");
const goodConfig = path.join(repo, "sample-data/config.json");
const badConfig = path.join(repo, "sample-data/config-regressed.json");
const temp = await mkdtemp(path.join(os.tmpdir(), "evalforge-smoke-"));
async function startMock(): Promise<{
  child: ReturnType<typeof spawn>;
  port: number;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/mock-provider.ts"],
    {
      cwd: repo,
      env: { ...process.env, EVALFORGE_MOCK_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    let output = "";
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(
        /listening at http:\/\/127\.0\.0\.1:(\d+)\/v1/,
      );
      if (match) resolve({ child, port: Number(match[1]) });
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Synthetic mock exited before startup (code ${code}).`)),
    );
  });
}
async function stopMock(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  await exited;
}
const mock = await startMock();
try {
  await writeFile(
    path.join(temp, "schema.json"),
    await readFile(path.join(repo, "sample-data/schema.json")),
  );
  const portConfig = async (source: string) => {
    const destination = path.join(temp, path.basename(source));
    const content = (await readFile(source, "utf8")).replaceAll(
      "127.0.0.1:8099",
      `127.0.0.1:${mock.port}`,
    );
    await writeFile(destination, content);
    return destination;
  };
  const good = await portConfig(goodConfig);
  const bad = await portConfig(badConfig);
  const run = async (config: string, db: string, threshold: string) =>
    (
      await exec(
        "npm",
        [
          "exec",
          "--",
          "tsx",
          "src/cli.ts",
          "run",
          manifest,
          config,
          "--db",
          db,
          "--threshold",
          threshold,
        ],
        { cwd: repo, maxBuffer: 10_000_000 },
      )
    ).stdout;
  const runRegressed = async (config: string, db: string) => {
    try {
      await run(config, db, "1");
      throw new Error("Regressed run unexpectedly met the threshold.");
    } catch (error: any) {
      if (error?.code !== 2) throw error;
      return String(error.stdout ?? "");
    }
  };
  const db = requestedDb ?? path.join(temp, "smoke.db");
  const leftOutput = await run(good, db, "1");
  const rightOutput = await runRegressed(bad, db);
  const leftRun = leftOutput.match(/"runId"\s*:\s*"([^"]+)"/)?.[1];
  const rightRun = rightOutput.match(/"runId"\s*:\s*"([^"]+)"/)?.[1];
  if (!leftRun || !rightRun)
    throw new Error("Could not read run IDs from CLI output.");
  const compare = await exec(
    "npm",
    [
      "exec",
      "--",
      "tsx",
      "src/cli.ts",
      "compare",
      leftRun,
      rightRun,
      "--db",
      db,
    ],
    { cwd: repo },
  );
  const exportPath = path.join(temp, "report.json");
  await exec(
    "npm",
    [
      "exec",
      "--",
      "tsx",
      "src/cli.ts",
      "export",
      leftRun,
      "--format",
      "json",
      "--out",
      exportPath,
      "--db",
      db,
    ],
    { cwd: repo },
  );
  const markdownPath = path.join(temp, "report.md");
  await exec(
    "npm",
    [
      "exec",
      "--",
      "tsx",
      "src/cli.ts",
      "export",
      leftRun,
      "--format",
      "markdown",
      "--out",
      markdownPath,
      "--db",
      db,
    ],
    { cwd: repo },
  );
  const report = JSON.parse(await readFile(exportPath, "utf8"));
  const markdown = await readFile(markdownPath, "utf8");
  if (
    report.metrics?.passRate !== 1 ||
    !JSON.parse(compare.stdout).regressed ||
    !markdown.includes(`# Local Evals run ${leftRun}`)
  )
    throw new Error("Smoke assertions failed.");
  console.log(
    `Smoke passed: ${report.metrics.sampleCount} cases, ${JSON.parse(compare.stdout).regressed} regression(s) detected.`,
  );
} finally {
  await stopMock(mock.child);
  if (!requestedDb) await rm(temp, { recursive: true, force: true });
}
