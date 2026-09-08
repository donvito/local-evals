import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = process.cwd();
const suites = [
  {
    name: "text-json",
    manifest: path.join(repo, "sample-data/text-json/manifest.json"),
    config: path.join(repo, "sample-data/text-json/config.json"),
  },
  {
    name: "tool-calling",
    manifest: path.join(repo, "sample-data/tool-calling/manifest.json"),
    config: path.join(repo, "sample-data/tool-calling/config.json"),
  },
] as const;

const temp = await mkdtemp(path.join(os.tmpdir(), "evalforge-mode-smoke-"));

async function startMock(): Promise<{
  child: ReturnType<typeof spawn>;
  port: number;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/mock-provider.ts"],
    {
      cwd: repo,
      env: {
        ...process.env,
        EVALFORGE_MOCK_PORT: "0",
        EVALFORGE_MOCK_MODEL: "mock-synthetic-modes",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(
        /listening at http:\/\/127\.0\.0\.1:(\d+)\/v1/,
      );
      if (match && !settled) {
        settled = true;
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Synthetic mode mock exited before startup (code ${code}).`,
          ),
        );
      }
    });
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

function summary(output: string): any {
  const marker = output.lastIndexOf('{\n  "runId"');
  if (marker < 0)
    throw new Error("Could not read run summary from CLI output.");
  return JSON.parse(output.slice(marker));
}

async function writePortConfig(
  source: string,
  destination: string,
  port: number,
  regressed: boolean,
) {
  const config = JSON.parse(await readFile(source, "utf8"));
  config.extractionTarget.baseUrl = `http://127.0.0.1:${port}/v1`;
  if (regressed)
    config.extractionTarget.model = `${config.extractionTarget.model}-regressed`;
  await writeFile(destination, JSON.stringify(config, null, 2) + "\n");
}

async function run(
  manifest: string,
  config: string,
  db: string,
  threshold: string,
) {
  return exec(
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
  );
}

async function runRegressed(
  manifest: string,
  config: string,
  db: string,
): Promise<any> {
  try {
    await run(manifest, config, db, "1");
    throw new Error("Regressed mode unexpectedly met the pass-rate threshold.");
  } catch (error: any) {
    if (error?.code !== 2)
      throw new Error(
        `Expected deliberate regression to exit 2, got ${String(error?.code)}.\n${String(error?.stdout ?? "")}${String(error?.stderr ?? "")}`,
      );
    return summary(String(error.stdout ?? ""));
  }
}

const mock = await startMock();
try {
  const results: Array<{ name: string; cases: number }> = [];
  for (const suite of suites) {
    const goodConfig = path.join(temp, `${suite.name}-config.json`);
    const badConfig = path.join(temp, `${suite.name}-regressed-config.json`);
    const db = path.join(temp, `${suite.name}.db`);
    await writePortConfig(suite.config, goodConfig, mock.port, false);
    await writePortConfig(suite.config, badConfig, mock.port, true);

    const passing = summary(
      (await run(suite.manifest, goodConfig, db, "1")).stdout,
    );
    if (passing.status !== "completed" || passing.metrics?.passRate !== 1)
      throw new Error(`Passing ${suite.name} smoke assertions failed.`);

    const regressed = await runRegressed(suite.manifest, badConfig, db);
    if (regressed.status !== "completed" || !(regressed.metrics?.passRate < 1))
      throw new Error(`Regression ${suite.name} smoke assertions failed.`);
    results.push({ name: suite.name, cases: passing.metrics.sampleCount });
  }
  console.log(
    `Mode smoke passed offline: ${results.map((result) => `${result.name} (${result.cases} cases)`).join(", ")}; deliberate regressions detected.`,
  );
} finally {
  await stopMock(mock.child);
  await rm(temp, { recursive: true, force: true });
}
