import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseStore } from "./storage/db.js";
import { importManifest } from "./core/manifest.js";
import { importDatasetZip } from "./core/dataset-zip.js";
import { runEvaluation } from "./core/runner.js";
import { loadConfig, saveJson } from "./core/project.js";
import { sanitize, registerSecrets } from "./core/security.js";
import { compareRuns, markdownReport } from "./core/reports.js";
import { startServer } from "./server.js";
import * as providers from "./core/providers.js";
import { backupAppData, restoreAppData } from "./storage/backup.js";
import { CLI_PREFIX, DEFAULT_DB_PATH, formatCommandHelp, formatHelp } from "./cli-help.js";

function parse(args: string[]) {
  const positionals: string[] = [],
    flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("Missing value for --" + key);
      flags[key] = args[++i];
    } else positionals.push(args[i]);
  }
  return { positionals, flags };
}
const isHelpFlag = (value: string) => value === "--help" || value === "-h";
function printHelp(topic?: string) {
  if (!topic) return console.log(formatHelp());
  const help = formatCommandHelp(topic);
  if (!help) throw new Error(`Unknown command: ${topic}. Run "${CLI_PREFIX} help" to see all commands.`);
  console.log(help);
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === "help" || isHelpFlag(command)) return printHelp(rest[0]);
  if (rest.some(isHelpFlag)) return printHelp(command);
  const { positionals: p, flags: f } = parse(rest);
  const dbPath = path.resolve(f.db ?? DEFAULT_DB_PATH),
    assetRoot = path.join(path.dirname(dbPath), "assets");
  if (command === "serve") {
    await startServer(
      dbPath,
      Number(f.port ?? 4173),
      process.cwd(),
      f.host ?? "127.0.0.1",
    );
    return;
  }
  if (command === "backup") {
    if (!f.out) throw new Error("Usage: backup --out <new-backup-directory> [--db <path>]");
    const result = await backupAppData(dbPath, path.resolve(f.out));
    console.log("Backup created: " + result.directory);
    console.log("This backup includes the credential key. Keep it private.");
    return;
  }
  if (command === "restore") {
    if (!p[0] || !f.to) throw new Error("Usage: restore <backup-directory> --to <new-data-directory>");
    const result = await restoreAppData(path.resolve(p[0]), path.resolve(f.to));
    console.log("Restored database: " + result.dbPath);
    console.log("Start the app with --db " + result.dbPath);
    return;
  }
  const db = new DatabaseStore(dbPath);
  try {
    if (command === "init") {
      console.log("Initialized " + dbPath);
      return;
    }
    if (command === "import") {
      if (!p[0]) throw new Error("Provide a manifest or dataset ZIP path.");
      const m = /\.zip$/i.test(p[0])
        ? await importDatasetZip(await readFile(p[0]), assetRoot, {
            allowMissingExpected: true,
            name: path.basename(p[0]).replace(/\.zip$/i, ""),
          })
        : await importManifest(p[0], assetRoot, { allowMissingExpected: true });
      db.saveDataset(m);
      console.log(
        JSON.stringify({ version: m.version, cases: m.cases.length }, null, 2),
      );
      return;
    }
    if (command === "target") {
      if (p[0] === "add") {
        db.saveTarget(JSON.parse(await readFile(p[1], "utf8")));
        console.log("Target saved.");
        return;
      }
      if (p[0] === "list") {
        console.log(JSON.stringify(db.listTargets(), null, 2));
        return;
      }
      if (p[0] === "test") {
        const target = db.getTarget(p[1], true);
        if (!target) throw new Error("Unknown target. Add it first.");
        registerSecrets([target]);
        const test = (providers as any).testTarget;
        console.log(
          JSON.stringify(
            await test(target, { vision: f.vision === "true" }),
            null,
            2,
          ),
        );
        return;
      }
      throw new Error("Use target add, list, or test.");
    }
    if (command === "inspect") {
      const value = p[0] ? db.getRun(p[0]) : db.listRuns();
      if (!value) throw new Error("Run not found.");
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    if (command === "compare") {
      console.log(
        JSON.stringify(compareRuns(db.getRun(p[0]), db.getRun(p[1])), null, 2),
      );
      return;
    }
    if (command === "export") {
      const run = db.getRun(p[0]);
      if (!run) throw new Error("Run not found.");
      if (f.format && !["json", "markdown"].includes(f.format))
        throw new Error("Format must be json or markdown.");
      const output =
        f.format === "markdown"
          ? markdownReport(run)
          : JSON.stringify(run, null, 2);
      if (f.out) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(f.out, output + "\n", { flag: "wx" });
        console.log("Exported " + f.out);
      } else console.log(output);
      return;
    }
    if (command === "run") {
      if (!p[0] || !p[1])
        throw new Error(
          "Usage: run <manifest-or-dataset-version> <config.json>",
        );
      const config = await loadConfig(p[1]);
      if (f.concurrency) config.concurrency = Number(f.concurrency);
      if (
        !Number.isInteger(config.concurrency ?? 1) ||
        (config.concurrency ?? 1) < 1 ||
        (config.concurrency ?? 1) > 32
      )
        throw new Error("Concurrency must be 1–32.");
      const threshold =
        f.threshold === undefined ? undefined : Number(f.threshold);
      if (
        threshold !== undefined &&
        (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      )
        throw new Error("Threshold must be between 0 and 1.");
      if (config.inferenceOnly && threshold !== undefined)
        throw new Error(
          "Thresholds apply only to graded evaluations, not inference-only runs.",
        );
      const manifest =
        db.getDataset(p[0]) ??
        (await importManifest(p[0], assetRoot, {
          allowMissingExpected: config.inferenceOnly === true,
        }));
      db.saveDataset(manifest);
      config.datasetVersion = manifest.version;
      registerSecrets(
        [config.ocrTarget, config.extractionTarget, config.judgeTarget].filter(
          Boolean,
        ) as any,
      );
      for (const [stage, target] of [
        [
          "OCR",
          (config.taskKind && config.taskKind !== "document-json") ||
          config.extractionSource === "reference"
            ? undefined
            : config.ocrTarget,
        ],
        ["Extraction", config.extractionTarget],
        ["Judge", config.judgeTarget],
      ] as const)
        if (target)
          console.log(stage + ": " + target.baseUrl + " / " + target.model);
      console.log(
        config.taskKind === "tool-calling"
          ? "Tool-call evaluation sends text and tool definitions; proposed tools are never executed. Remote endpoints receive this content."
          : config.taskKind === "text-json"
            ? "Text-to-JSON evaluation sends input text. Remote endpoints receive this content."
            : config.extractionSource === "reference"
              ? "Extraction consumes reference transcription."
              : "OCR receives document image bytes. Remote/cloud endpoints receive document content.",
      );
      const controller = new AbortController();
      const cancel = () => {
        console.log("\nCancelling active requests…");
        controller.abort();
      };
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const result = await runEvaluation(manifest, config, {
          db,
          schema: config.schema,
          signal: controller.signal,
          onProgress: (done, total) =>
            console.log(done + "/" + total + " cases persisted"),
        });
        const run = db.getRun(result.runId)!;
        console.log(
          JSON.stringify(
            { runId: run.runId, status: run.status, metrics: run.metrics },
            null,
            2,
          ),
        );
        if (controller.signal.aborted) process.exitCode = 130;
        else if (run.status === "failed" || run.status === "interrupted")
          process.exitCode = 1;
        else if (
          threshold !== undefined &&
          run.metrics.passRate != null &&
          run.metrics.passRate < threshold
        )
          process.exitCode = 2;
      } catch (error) {
        if (controller.signal.aborted) {
          process.exitCode = 130;
          console.error("Evaluation cancelled.");
        } else throw error;
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
      return;
    }
    throw new Error(`Unknown command: ${command}. Run "${CLI_PREFIX} help" to see all commands.`);
  } finally {
    db.close();
  }
}
main().catch((error) => {
  console.error(
    sanitize(error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
