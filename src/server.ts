import http from "node:http";
import { networkInterfaces } from "node:os";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { DatabaseStore } from "./storage/db.js";
import {
  datasetJsonl,
  generatedManifest,
  importManifest,
} from "./core/manifest.js";
import {
  exampleDatasetZip,
  importDatasetZip,
  MAX_DATASET_ZIP_BYTES,
} from "./core/dataset-zip.js";
import { compareRuns, markdownReport } from "./core/reports.js";
import { runEvaluation } from "./core/runner.js";
import {
  loadConfig,
  projectFile,
  saveJson,
  shellQuote,
  validateRunConfig,
} from "./core/project.js";
import {
  createModelCatalog,
  fetchTargetModelCatalog,
} from "./core/model-catalog.js";
import { registerSecrets, sanitize } from "./core/security.js";
import { checkExtractionSchema, checkToolDefinitions, type SchemaCheck } from "./core/schema-check.js";
import * as providers from "./core/providers.js";
import type { TaskKind } from "./core/types.js";

const generatedDatasetSchema = (taskKind: "text-json" | "tool-calling") => ({
  type: "object",
  properties: {
    cases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          inputText: { type: "string" },
          expected:
            taskKind === "tool-calling"
              ? {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      arguments: { type: "object" },
                    },
                    required: ["name", "arguments"],
                    additionalProperties: false,
                  },
                }
              : { type: "object" },
          referenceTranscription: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["caseId", "inputText", "expected"],
        additionalProperties: false,
      },
    },
  },
  required: ["cases"],
  additionalProperties: false,
});

function parseGeneratedJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("The provider did not return a JSON dataset.");
  }
}

export async function startServer(
  dbPath: string,
  port: number,
  projectRoot = process.cwd(),
  host = "127.0.0.1",
) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be 0–65535.");
  if (!["127.0.0.1", "0.0.0.0"].includes(host))
    throw new Error(
      "Use --host 127.0.0.1 for local access or --host 0.0.0.0 for Wi-Fi access.",
    );
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  if (host === "0.0.0.0") {
    for (const entries of Object.values(networkInterfaces()))
      for (const entry of entries ?? [])
        if (entry.family === "IPv4" && !entry.internal)
          allowedHosts.add(entry.address);
  }
  const db = new DatabaseStore(dbPath),
    storageRoot = path.dirname(path.resolve(dbPath));
  db.recoverDatasetJobs();
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const dashboardRoot = sourceDir.includes(path.sep + "dist" + path.sep)
    ? path.resolve(sourceDir, "../dashboard")
    : path.resolve(sourceDir, "../dist/dashboard");
  const configPath = path.join(storageRoot, "dashboard-config.json");
  const modelCatalog = createModelCatalog();
  const configSummary = (config: any) => ({
    taskKind: config.taskKind ?? "document-json",
    baseConfigPath: config.baseConfigPath,
    datasetVersion: config.datasetVersion,
    ocrTarget: config.ocrTarget?.name,
    extractionTarget: config.extractionTarget?.name,
    judgeTarget: config.judgeTarget?.name ?? "",
    inferenceOnly: config.inferenceOnly === true,
    extractionSource: config.extractionSource ?? "ocr",
    outputMode: config.outputMode,
    judgeRubric: config.judgeRubric ?? "",
    generation: config.generation,
    schema: config.schema,
    fieldRules: config.fieldRules,
    stagePrompts: config.stagePrompts,
    tools: config.tools ?? [],
    toolChoice: config.toolChoice ?? "auto",
    toolCallOrder: config.toolCallOrder ?? "ordered",
  });
  /** Credential-free run configuration, suitable for showing or writing to a file. */
  const portableConfig = (config: any) => {
    const target = (value: any) =>
      value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([key]) => !/^(apiKey|apiKeyEncrypted|hasApiKey)$/.test(key),
            ),
          )
        : value;
    const { baseConfigPath: _base, schemaPath, ...rest } = config;
    return {
      ...rest,
      ...(schemaPath && !rest.schema ? { schemaPath } : {}),
      ...(rest.ocrTarget ? { ocrTarget: target(rest.ocrTarget) } : {}),
      ...(rest.extractionTarget ? { extractionTarget: target(rest.extractionTarget) } : {}),
      ...(rest.judgeTarget ? { judgeTarget: target(rest.judgeTarget) } : {}),
    };
  };
  const command = (version?: string) => {
    const dataset = version ? db.getDataset(version) : db.listDatasets()[0];
    return (
      "npm run localevals -- run " +
      shellQuote(dataset?.version ?? "sample-data/manifest.json") +
      " " +
      shellQuote(configPath) +
      " --db " +
      shellQuote(path.resolve(dbPath))
    );
  };
  const buildSetupConfig = async (input: any) => {
    const targets = db.listTargets(),
      pick = (name: string) => targets.find((t) => t.name === name);
    const extractionTarget = pick(input.extractionTarget),
      ocrTarget = pick(input.ocrTarget),
      judgeTarget = input.judgeTarget ? pick(input.judgeTarget) : undefined;
    const taskKind = input.taskKind ?? "document-json";
    if (!["document-json", "text-json", "tool-calling"].includes(taskKind))
      throw new Error("Choose a valid evaluation type.");
    if (
      !extractionTarget ||
      (taskKind === "document-json" &&
        input.extractionSource !== "reference" &&
        !ocrTarget)
    )
      throw new Error("Select configured OCR and extraction targets.");
    if (
      !["ocr", "reference"].includes(input.extractionSource) ||
      !["prompted-json", "schema-constrained-json"].includes(
        input.outputMode,
      )
    )
      throw new Error("Choose extraction source and output mode.");
    let base: any;
    let existing: any;
    try {
      existing = await loadConfig(configPath);
    } catch {
      existing = undefined;
    }
    const requestedBasePath =
      typeof input.baseConfigPath === "string"
        ? input.baseConfigPath.trim()
        : "";
    const baseConfigPath = Object.hasOwn(input, "baseConfigPath")
      ? requestedBasePath || undefined
      : existing?.baseConfigPath;
    if (baseConfigPath) {
      if (
        existing &&
        baseConfigPath === existing.baseConfigPath &&
        !requestedBasePath
      )
        base = existing;
      else
        base = await loadConfig(
          await projectFile(projectRoot, baseConfigPath),
        );
    } else if (existing && !requestedBasePath) {
      base = existing;
    } else {
      try {
        base = JSON.parse(await readFile(configPath, "utf8"));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        try {
          base = JSON.parse(
            await readFile(
              path.join(projectRoot, "sample-data/config.json"),
              "utf8",
            ),
          );
          base.schema = JSON.parse(
            await readFile(
              path.join(projectRoot, "sample-data/schema.json"),
              "utf8",
            ),
          );
        } catch (sampleError: any) {
          if (sampleError.code !== "ENOENT") throw sampleError;
          base = { schemaVersion: "app-settings-v1", stagePrompts: { extraction: "" }, fieldRules: [] };
        }
      }
    }
    const datasetVersion = input.datasetVersion ?? base.datasetVersion;
    const dataset = datasetVersion
      ? db.getDataset(datasetVersion)
      : undefined;
    if (!dataset) throw new Error("Selected dataset not found.");
    if (dataset && (dataset.taskKind ?? "document-json") !== taskKind)
      throw new Error(
        "The dataset does not match this evaluation type. Choose a matching dataset.",
      );
    if (input.judgeTarget && (!judgeTarget || !input.judgeRubric?.trim()))
      throw new Error("A configured judge and rubric are required.");
    const config = {
      ...base,
      schemaVersion: base.schemaVersion ?? "app-settings-v1",
      taskKind,
      baseConfigPath,
      ocrTarget,
      extractionTarget,
      judgeTarget,
      datasetVersion,
      inferenceOnly:
        typeof input.inferenceOnly === "boolean"
          ? input.inferenceOnly
          : base.inferenceOnly,
      extractionSource: input.extractionSource,
      outputMode: input.outputMode,
      generation: input.generation ?? base.generation,
      judgeRubric: input.judgeRubric ?? base.judgeRubric,
      schema: baseConfigPath ? base.schema : (input.schema ?? base.schema),
      fieldRules: baseConfigPath
        ? (base.fieldRules ?? [])
        : (input.fieldRules ?? base.fieldRules ?? []),
      crossFieldRules:
        (base.taskKind ?? "document-json") === taskKind
          ? base.crossFieldRules
          : [],
      stagePrompts: baseConfigPath
        ? base.stagePrompts
        : (input.stagePrompts ?? base.stagePrompts),
      tools:
        taskKind === "tool-calling"
          ? baseConfigPath
            ? base.tools
            : (input.tools ?? base.tools)
          : undefined,
      toolChoice:
        taskKind === "tool-calling"
          ? (input.toolChoice ?? base.toolChoice ?? "auto")
          : undefined,
      toolCallOrder:
        taskKind === "tool-calling"
          ? (input.toolCallOrder ?? base.toolCallOrder ?? "ordered")
          : undefined,
    };
    const firstError = (check: SchemaCheck) => check.issues.find((issue) => issue.severity === "error");
    const schemaProblem =
      config.schema && typeof config.schema === "object"
        ? firstError(checkExtractionSchema(JSON.stringify(config.schema)))
        : undefined;
    if (schemaProblem)
      throw new Error(
        `The schema isn't valid${schemaProblem.path === "/" ? "" : ` at ${schemaProblem.path}`}: ${schemaProblem.message}`,
      );
    const toolProblem =
      taskKind === "tool-calling" && Array.isArray(config.tools) && config.tools.length
        ? firstError(checkToolDefinitions(JSON.stringify(config.tools)))
        : undefined;
    if (toolProblem)
      throw new Error(`The tool definitions aren't valid at ${toolProblem.path}: ${toolProblem.message}`);
    validateRunConfig(config);
    return config;
  };
  type ActiveRun = {
    controller: AbortController;
    runId?: string;
    phase: "starting" | "running" | "stopping";
    done: Promise<void>;
    finish: () => void;
  };
  let activeRun: ActiveRun | undefined;
  type ActiveGeneration = {
    controller: AbortController;
    jobId: string;
    done: Promise<void>;
    stopRequested: boolean;
  };
  let activeGeneration: ActiveGeneration | undefined;
  let generationClosing = false;
  let generationPoll: NodeJS.Timeout | undefined;
  const pumpGeneration = async (): Promise<void> => {
    if (generationClosing || activeGeneration) return;
    try {
      db.recoverDatasetJobs();
    } catch {
      return;
    }
    let job;
    try {
      job = db.claimNextDatasetJob();
    } catch {
      return;
    }
    if (!job) return;
    let input;
    try {
      input = db.getDatasetJobInput(job.jobId);
    } catch {
      db.failDatasetJob(job.jobId, "Dataset generation job metadata is unavailable.");
      void pumpGeneration().catch(() => undefined);
      return;
    }
    if (!input) {
      db.failDatasetJob(job.jobId, "Dataset generation job metadata is unavailable.");
      void pumpGeneration().catch(() => undefined);
      return;
    }
    let target;
    try {
      target = db.getTarget(input.targetName, true);
    } catch {
      db.failDatasetJob(job.jobId, "Configured provider target is unavailable.");
      void pumpGeneration().catch(() => undefined);
      return;
    }
    if (!target) {
      db.failDatasetJob(job.jobId, "Configured provider target is unavailable.");
      void pumpGeneration().catch(() => undefined);
      return;
    }
    const schema = generatedDatasetSchema(input.taskKind as "text-json" | "tool-calling");
    const prompt = [
      "You create synthetic evaluation datasets for a local-first model evaluation tool.",
      `Generate exactly ${input.caseCount} independent cases for the ${input.taskKind === "tool-calling" ? "tool-calling" : "text-to-JSON"} workflow.`,
      "Return only one JSON object matching the supplied schema. Do not use Markdown fences.",
      "Every case must have a unique caseId, useful inputText, and the deterministic ideal expected output.",
      input.taskKind === "tool-calling"
        ? "For expected, return an array of function calls with name and JSON object arguments. These are expectations only; no tools will be executed."
        : "For expected, return the JSON object the model should produce from inputText.",
      "Use synthetic data only; never include real personal, financial, or secret information.",
      `The required JSON schema is: ${JSON.stringify(schema)}`,
      `Dataset brief: ${input.brief}`,
    ].join("\n\n");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
    const done = (async () => {
      try {
        const response = await providers.callOpenAICompatible(target, prompt, {
          outputMode: target.supportsStructuredOutput ? "schema-constrained-json" : "prompted-json",
          schema,
          generation: { max_tokens: Math.min(12000, 1200 * input.caseCount) },
          signal: controller.signal,
        });
        if (controller.signal.aborted || (activeGeneration as ActiveGeneration | undefined)?.stopRequested)
          throw new Error("Stopped by user.");
        db.completeDatasetJob(input.jobId, generatedManifest(parseGeneratedJson(response.text), {
          taskKind: input.taskKind,
          name: input.name,
        }));
      } catch {
        const stopped = (activeGeneration as ActiveGeneration | undefined)?.stopRequested === true;
        db.failDatasetJob(input.jobId, stopped ? "Stopped by user." : controller.signal.aborted ? `Dataset generation exceeded its ${input.timeoutSeconds}-second timeout.` : "Provider request failed.", stopped ? "interrupted" : "failed");
      } finally {
        clearTimeout(timeout);
        const runningGeneration = activeGeneration as ActiveGeneration | undefined;
        if (runningGeneration?.jobId === input.jobId) activeGeneration = undefined;
        void pumpGeneration().catch(() => undefined);
      }
    })();
    activeGeneration = { controller, jobId: input.jobId, done, stopRequested: false };
  };
  const server = http.createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(sanitize(value)));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );
    try {
      const hostname = req.headers.host?.split(":")[0];
      if (!allowedHosts.has(hostname ?? "")) {
        json({ error: "Invalid host" }, 403);
        return;
      }
      const origin = req.headers.origin;
      if (origin && origin !== "http://" + req.headers.host) {
        json({ error: "Cross-origin requests are not allowed" }, 403);
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1"),
        parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const body = async () => {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new Error("Use application/json.");
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1024 * 1024)
            throw new Error("Request exceeds 1MB.");
        }
        return JSON.parse(text || "{}");
      };
      if (req.method === "GET" && url.pathname === "/api/models/openrouter") {
        json(await modelCatalog());
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "models" &&
        parts[2] === "target" &&
        parts[3]
      ) {
        const target = db.getTarget(parts[3], true);
        if (!target) {
          json({ error: "Provider target not found." }, 404);
          return;
        }
        if (target.provider === "openrouter") {
          json(await modelCatalog());
          return;
        }
        json(await fetchTargetModelCatalog(target));
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "examples" &&
        parts.length === 3
      ) {
        const examples: Record<string, string> = {
          "document-json": "sample-data/config.json",
          "text-json": "sample-data/text-json/config.json",
          "tool-calling": "sample-data/tool-calling/config.json",
        };
        const file = examples[parts[2]];
        if (!file) {
          json({ error: "Example not found" }, 404);
          return;
        }
        const config = await loadConfig(await projectFile(projectRoot, file));
        json(configSummary({ ...config, baseConfigPath: file }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/setup") {
        let configured: any;
        try {
          configured = await loadConfig(configPath);
        } catch {
          configured = undefined;
        }
        json({
          dbPath: path.resolve(dbPath),
          projectRoot,
          configPath,
          runCommand: command(configured?.datasetVersion),
          config: configured ? configSummary(configured) : undefined,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/schema-check") {
        const input = await body();
        const text = typeof input.text === "string" ? input.text : "";
        if (text.length > 1_000_000) throw new Error("That JSON is too large to check.");
        json(
          input.kind === "tools"
            ? checkToolDefinitions(text)
            : checkExtractionSchema(text, { fieldRules: input.fieldRules, required: input.required !== false }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config-file") {
        const requested = url.searchParams.get("path")?.trim();
        if (!requested) throw new Error("Enter a configuration file path.");
        const file = await projectFile(projectRoot, requested);
        const config = await loadConfig(file);
        json({
          path: path.relative(await realpath(projectRoot), file),
          summary: configSummary({ ...config, baseConfigPath: requested }),
          content: portableConfig(config),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/config-file") {
        const input = await body();
        const requested = typeof input.path === "string" ? input.path.trim() : "";
        if (!requested.toLowerCase().endsWith(".json"))
          throw new Error("Configuration files must end in .json.");
        if (path.isAbsolute(requested))
          throw new Error("Use a path inside the project folder, such as configs/receipts.json.");
        const config = await buildSetupConfig({ ...(input.setup ?? {}), baseConfigPath: "" });
        const root = await realpath(projectRoot);
        const file = path.resolve(root, requested);
        const relative = path.relative(root, file);
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          relative.split(path.sep).some((part) => part === "node_modules" || part === ".git")
        )
          throw new Error("Use a path inside the project folder, such as configs/receipts.json.");
        let ancestor = path.dirname(file);
        for (;;) {
          try {
            ancestor = await realpath(ancestor);
            break;
          } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
            ancestor = path.dirname(ancestor);
          }
        }
        if (ancestor !== root && !ancestor.startsWith(root + path.sep))
          throw new Error("Use a path inside the project folder, such as configs/receipts.json.");
        await mkdir(path.dirname(file), { recursive: true });
        let exists = false;
        try {
          await stat(file);
          exists = true;
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (exists && input.overwrite !== true) {
          json({ error: `${relative} already exists.`, exists: true }, 409);
          return;
        }
        await saveJson(file, portableConfig(config));
        json({ path: relative, overwritten: exists });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/setup/config") {
        const config = await buildSetupConfig(await body());
        await saveJson(configPath, config);
        json({
          runCommand: command(config.datasetVersion),
          config: configSummary(config),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/targets") {
        json(db.listTargets());
        return;
      }
      if (parts[0] === "api" && parts[1] === "targets" && parts[2]) {
        if (req.method === "PUT" && parts.length === 3) {
          const input = await body();
          const { apiKey, clearApiKey, ...value } = input;
          if (clearApiKey) {
            db.clearTargetCredential?.(parts[2]);
          }
          db.saveTarget(
            { ...value, name: parts[2] },
            typeof apiKey === "string" ? apiKey : undefined,
          );
          json(db.getTarget(parts[2]) ?? { error: "Target not found." });
          return;
        }
        if (req.method === "DELETE" && parts.length === 3) {
          if (!db.getTarget(parts[2])) {
            json({ error: "Target not found." }, 404);
            return;
          }
          db.deleteTarget(parts[2]);
          json({ deleted: true });
          return;
        }
        if (req.method === "POST" && parts[3] === "test") {
          const target = db.getTarget(parts[2], true);
          if (!target) throw new Error("Target not found.");
          const input = await body();
          registerSecrets([target]);
          json(
            await (providers as any).testTarget(
              target,
              { vision: !!input.vision },
              AbortSignal.timeout(15000),
            ),
          );
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/datasets") {
        json(db.listDatasets());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/dataset-jobs") {
        json(db.listDatasetJobs());
        return;
      }
      if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "datasets" && parts.length === 3) {
        const input = await body();
        if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 120) {
          json({ error: "Dataset name must contain 1 to 120 characters." }, 400);
          return;
        }
        const dataset = db.renameDataset(parts[2], input.name);
        if (!dataset) json({ error: "Dataset not found." }, 404);
        else json(dataset);
        return;
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "datasets" && parts[3] === "duplicate" && parts.length === 4) {
        const source = db.getDataset(parts[2]);
        if (!source) {
          json({ error: "Dataset not found." }, 404);
          return;
        }
        const newVersion = createHash("sha256").update(randomUUID()).digest("hex");
        json(db.duplicateDataset(parts[2], newVersion), 201);
        return;
      }
      if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "datasets" && parts.length === 3) {
        if (!db.deleteDataset(parts[2])) {
          json({ error: "Dataset not found." }, 404);
          return;
        }
        json({ deleted: true });
        return;
      }
      if (
        req.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "dataset-jobs" &&
        parts[2] &&
        parts[3] === "stop" &&
        parts.length === 4
      ) {
        const control = db.getDatasetJobControl(parts[2]);
        if (!control) {
          json({ error: "Dataset job not found." }, 404);
          return;
        }
        if (["completed", "failed", "interrupted"].includes(control.status)) {
          json({ error: "Dataset job is already finished." }, 409);
          return;
        }
        if (control.status === "queued") {
          const stopped = db.stopDatasetJob(parts[2]);
          if (!stopped) {
            json({ error: "Dataset job changed state. Refresh and try stopping it again." }, 409);
            return;
          }
          json(stopped, 200);
          void pumpGeneration().catch(() => undefined);
          return;
        }
        if (activeGeneration?.jobId !== parts[2]) {
          json({ error: "Dataset job is running in another server process." }, 409);
          return;
        }
        activeGeneration.stopRequested = true;
        activeGeneration.controller.abort();
        await activeGeneration.done;
        json(db.getDatasetJob(parts[2]), 200);
        return;
      }
      if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "dataset-jobs" && parts.length === 3) {
        if (!db.getDatasetJob(parts[2])) {
          json({ error: "Dataset job not found." }, 404);
        } else if (!db.deleteFailedDatasetJob(parts[2])) {
          json({ error: "Only failed or interrupted generation jobs can be deleted." }, 409);
        } else {
          json({ deleted: true });
        }
        return;
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "dataset-jobs" && parts.length === 4 && parts[3] === "retry") {
        const previous = db.getDatasetJob(parts[2]);
        if (!previous) {
          json({ error: "Dataset job not found." }, 404);
          return;
        }
        if (previous.status !== "failed" && previous.status !== "interrupted") {
          json({ error: "Only failed or interrupted generation jobs can be retried." }, 409);
          return;
        }
        const input = db.getDatasetJobInput(previous.jobId);
        if (!input) {
          json({ error: "Original generation settings are unavailable." }, 409);
          return;
        }
        const job = db.createDatasetJob({ ...input, jobId: randomUUID() });
        json(job, 202);
        void pumpGeneration().catch(() => undefined);
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "dataset-jobs" &&
        parts.length === 3
      ) {
        const job = db.getDatasetJob(parts[2]);
        if (!job) {
          json({ error: "Dataset job not found." }, 404);
          return;
        }
        json(job);
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "datasets" &&
        parts[2] &&
        parts.length === 4 &&
        parts[3] === "jsonl"
      ) {
        const dataset = db.getDataset(parts[2]);
        if (!dataset) {
          json({ error: "Dataset not found" }, 404);
          return;
        }
        res.setHeader("content-type", "application/jsonl; charset=utf-8");
        res.setHeader(
          "content-disposition",
          `attachment; filename="${(dataset.name || "dataset").replace(/[^a-z0-9._-]+/gi, "-")}.jsonl"`,
        );
        res.end(datasetJsonl(dataset));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/datasets/example.zip") {
        const zip = await exampleDatasetZip(path.join(projectRoot, "sample-data"));
        res.setHeader("content-type", "application/zip");
        res.setHeader(
          "content-disposition",
          'attachment; filename="localevals-example-dataset.zip"',
        );
        res.end(zip);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/datasets/import") {
        const input = await body();
        const file = await projectFile(projectRoot, input.path);
        const dataset = /\.zip$/i.test(file)
          ? await importDatasetZip(await readFile(file), path.join(storageRoot, "assets"), {
              allowMissingExpected: true,
              name: path.basename(file).replace(/\.zip$/i, ""),
            })
          : await importManifest(file, path.join(storageRoot, "assets"), {
              allowMissingExpected: true,
            });
        db.saveDataset(dataset);
        json(dataset);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/datasets/import-zip") {
        if (!/^application\/(zip|x-zip-compressed|octet-stream)\b/.test(req.headers["content-type"] ?? ""))
          throw new Error("Upload the ZIP with content-type application/zip.");
        const tooLarge = `The ZIP is larger than ${MAX_DATASET_ZIP_BYTES / 1024 ** 2} MB.`;
        if (Number(req.headers["content-length"] ?? 0) > MAX_DATASET_ZIP_BYTES) {
          json({ error: tooLarge }, 413);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > MAX_DATASET_ZIP_BYTES) {
            json({ error: tooLarge }, 413);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const name = (url.searchParams.get("name") ?? "").replace(/\.zip$/i, "").trim().slice(0, 120);
        const dataset = await importDatasetZip(Buffer.concat(chunks), path.join(storageRoot, "assets"), {
          allowMissingExpected: true,
          name: name || "Uploaded dataset",
        });
        db.saveDataset(dataset);
        json(dataset);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/datasets/generate") {
        const input = await body();
        const taskKind = input.taskKind as TaskKind;
        if (taskKind !== "text-json" && taskKind !== "tool-calling")
          throw new Error(
            "Provider-generated datasets currently support Text → JSON and Tool calling. Import image documents as JSONL.",
          );
        const targetName =
          typeof input.targetName === "string" ? input.targetName.trim() : "";
        if (!targetName || !db.getTarget(targetName))
          throw new Error("Choose a configured provider and model first.");
        const name =
          typeof input.name === "string" && input.name.trim()
            ? input.name.trim().slice(0, 120)
            : `Generated ${taskKind === "tool-calling" ? "tool-calling" : "text-to-JSON"} dataset`;
        const count = Number(input.caseCount ?? 5);
        if (!Number.isInteger(count) || count < 1 || count > 50)
          throw new Error("Case count must be a whole number from 1 to 50.");
        const brief =
          typeof input.brief === "string" && input.brief.trim()
            ? input.brief.trim().slice(0, 4000)
            : "Create varied, realistic examples with a mix of normal and edge cases.";
        const timeoutSeconds = input.timeoutSeconds === undefined ? 600 : Number(input.timeoutSeconds);
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600)
          throw new Error("Timeout must be a whole number from 30 to 3600 seconds.");
        const jobId = randomUUID();
        const job = db.createDatasetJob({
          jobId,
          name,
          taskKind,
          targetName,
          caseCount: count,
          brief,
          timeoutSeconds,
        });
        json(job, 202);
        void pumpGeneration().catch(() => undefined);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/experiments") {
        json(db.listExperiments());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/experiments") {
        const input = await body();
        if (typeof input.name !== "string") throw new Error("Experiment name is required.");
        json(db.createExperiment(input.name), 201);
        return;
      }
      if (
        req.method === "PATCH" &&
        parts[0] === "api" &&
        parts[1] === "experiments" &&
        parts[2] &&
        parts.length === 3
      ) {
        const input = await body();
        if (typeof input.name !== "string") throw new Error("Experiment name is required.");
        json(db.renameExperiment(parts[2], input.name));
        return;
      }
      if (
        req.method === "DELETE" &&
        parts[0] === "api" &&
        parts[1] === "experiments" &&
        parts[2] &&
        parts.length === 3
      ) {
        if (!db.getExperiment(parts[2])) {
          json({ error: "Experiment not found." }, 404);
          return;
        }
        db.deleteExperiment(parts[2]);
        json({ deleted: true });
        return;
      }
      if (
        req.method === "PUT" &&
        parts[0] === "api" &&
        parts[1] === "runs" &&
        parts[2] &&
        parts[3] === "experiment" &&
        parts.length === 4
      ) {
        const input = await body();
        if (input.experimentId !== null && typeof input.experimentId !== "string")
          throw new Error("experimentId must be a string or null.");
        json(db.setRunExperiment(parts[2], input.experimentId ?? null));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/runs/start") {
        const input = await body();
        if (input.experimentId !== undefined && input.experimentId !== null && typeof input.experimentId !== "string")
          throw new Error("experimentId must be a string or null.");
        if (input.experimentId !== undefined && input.experimentId !== null && !db.getExperiment(input.experimentId))
          throw new Error("Experiment not found.");
        const persisted = db
          .listRuns()
          .find((run: any) => ["running", "pending"].includes(run.status));
        if (activeRun || persisted) {
          json(
            {
              error: "An evaluation is already running.",
              runId: activeRun?.runId ?? persisted?.runId,
            },
            409,
          );
          return;
        }
        let finishRun!: () => void;
        const run: ActiveRun = {
          controller: new AbortController(),
          phase: "starting",
          done: new Promise<void>((resolve) => {
            finishRun = resolve;
          }),
          finish: () => finishRun(),
        };
        activeRun = run;
        let started = false;
        let resolveStarted!: () => void;
        let rejectStarted!: (error: unknown) => void;
        const startedPromise = new Promise<void>((resolve, reject) => {
          resolveStarted = resolve;
          rejectStarted = reject;
        });
        try {
          const config: any = await loadConfig(configPath),
            datasetVersion = input.datasetVersion ?? config.datasetVersion,
            manifest: any = datasetVersion
              ? db.getDataset(datasetVersion)
              : undefined;
          if (!manifest)
            throw new Error("Save a valid run configuration before starting.");
          config.datasetVersion = manifest.version;
          if (
            !config.inferenceOnly &&
            manifest.cases.some((item: any) => item.expected === undefined)
          )
            throw new Error(
              "This dataset has unlabeled cases. Choose inference-only in Setup before starting.",
            );
          void (run.done = runEvaluation(manifest, config, {
            db,
            schema: config.schema,
            signal: run.controller.signal,
            onStarted: (runId) => {
              run.runId = runId;
              run.phase = "running";
              started = true;
              resolveStarted();
            },
            onProgress: () => undefined,
            experimentId: input.experimentId ?? null,
          })
            .then((result) => {
              run.runId ??= result.runId;
              if (!started) {
                started = true;
                resolveStarted();
              }
            })
            .catch((error) => {
              if (!started) rejectStarted(error);
            })
            .finally(() => {
              run.finish();
              if (activeRun === run) activeRun = undefined;
            }));
          await startedPromise;
          json({ status: "started", runId: run.runId }, 202);
        } catch (error) {
          if (activeRun === run) activeRun = undefined;
          run.finish();
          throw error;
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/runs/active") {
        const persisted = db
          .listRuns()
          .find((run: any) => ["running", "pending"].includes(run.status));
        json(
          activeRun
            ? {
                active: true,
                ownedByDashboard: true,
                canStop: true,
                phase: activeRun.phase,
                runId: activeRun.runId,
              }
            : persisted
              ? {
                  active: true,
                  ownedByDashboard: false,
                  canStop: false,
                  phase: "external",
                  runId: persisted.runId,
                }
              : { active: false, ownedByDashboard: false, canStop: false },
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/runs/stop") {
        if (!activeRun) {
          const persisted = db
            .listRuns()
            .find((run: any) => ["running", "pending"].includes(run.status));
          if (persisted) {
            json(
              {
                status: "not-owned",
                canStop: false,
                runId: persisted.runId,
                error: "This run was started from the terminal.",
              },
              409,
            );
            return;
          }
          json({ status: "idle", canStop: false });
          return;
        }
        activeRun.phase = "stopping";
        activeRun.controller.abort();
        json({ status: "stopping", canStop: true, runId: activeRun.runId });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/runs") {
        json(db.listRuns());
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "runs" &&
        parts[2] &&
        parts[3] === "events" &&
        parts.length === 4
      ) {
        if (!db.getRun(parts[2])) {
          json({ error: "Run not found" }, 404);
          return;
        }
        const parsedAfter = Number(url.searchParams.get("after") ?? "0");
        const parsedLimit = Number(url.searchParams.get("limit") ?? "100");
        if (
          !Number.isInteger(parsedAfter) ||
          parsedAfter < 0 ||
          !Number.isInteger(parsedLimit) ||
          parsedLimit < 1
        ) {
          json({ error: "after and limit must be positive integers." }, 400);
          return;
        }
        const events = db.listRunEvents(parts[2], parsedAfter, parsedLimit);
        json({
          events: events.map(({ eventId, type, createdAt, payload }) => ({
            eventId,
            type,
            createdAt,
            payload,
          })),
          nextAfter: events.length
            ? events[events.length - 1].eventId
            : parsedAfter,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/compare") {
        json(
          compareRuns(
            db.getRun(url.searchParams.get("left") ?? ""),
            db.getRun(url.searchParams.get("right") ?? ""),
          ),
        );
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "runs" &&
        parts[2] &&
        parts.length === 3
      ) {
        const run = db.getRun(parts[2]);
        json(run ?? { error: "Run not found" }, run ? 200 : 404);
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "runs" &&
        parts[3] === "export"
      ) {
        const run = db.getRun(parts[2]);
        if (!run) {
          json({ error: "Run not found" }, 404);
          return;
        }
        const markdown = url.searchParams.get("format") === "markdown";
        res.setHeader(
          "content-type",
          markdown ? "text/markdown; charset=utf-8" : "application/json",
        );
        res.setHeader(
          "content-disposition",
          'attachment; filename="localevals-' +
            run.runId +
            "." +
            (markdown ? "md" : "json") +
            '"',
        );
        res.end(
          markdown
            ? markdownReport(run)
            : JSON.stringify(sanitize(run), null, 2),
        );
        return;
      }
      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        ["runs", "datasets"].includes(parts[1]) &&
        parts[3] === "cases" &&
        parts[5] === "image"
      ) {
        const collection =
          parts[1] === "runs" ? db.getRun(parts[2]) : db.getDataset(parts[2]);
        const item = collection?.cases.find((c: any) => c.caseId === parts[4]);
        if (!item || !item.imagePath) {
          json(
            { error: item ? "This case has no image" : "Case not found" },
            404,
          );
          return;
        }
        const file = await realpath(item.imagePath),
          assetBase = await realpath(path.join(storageRoot, "assets"));
        if (!file.startsWith(assetBase + path.sep))
          throw new Error(
            "Image was not imported into project storage. Import and rerun this legacy dataset.",
          );
        res.setHeader(
          "content-type",
          file.endsWith(".png") ? "image/png" : "image/jpeg",
        );
        res.end(await readFile(file));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json({ error: "Endpoint not found" }, 404);
        return;
      }
      if (req.method !== "GET") {
        json({ error: "Method not allowed" }, 405);
        return;
      }
      const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const file = path.resolve(dashboardRoot, relative);
      if (!file.startsWith(dashboardRoot + path.sep))
        throw new Error("Invalid asset path.");
      const resolved = await realpath(file);
      if (!resolved.startsWith(dashboardRoot + path.sep))
        throw new Error("Invalid asset path.");
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      res.setHeader(
        "content-type",
        types[path.extname(file)] ?? "application/octet-stream",
      );
      res.end(await readFile(file));
    } catch (error: any) {
      json(
        {
          error:
            error.code === "ENOENT"
              ? typeof error.path === "string" && !error.path.startsWith(dashboardRoot)
                ? `File not found: ${path.relative(projectRoot, error.path) || error.path}`
                : "File not found. Build the dashboard with npm run build."
              : (error.message ?? String(error)),
        },
        error.code === "ENOENT" ? 404 : 400,
      );
    }
  });
  server.once("close", () => {
    generationClosing = true;
    if (generationPoll) clearInterval(generationPoll);
    const run = activeRun;
    const generation = activeGeneration;
    run?.controller.abort();
    if (generation) {
      db.failDatasetJob(
        generation.jobId,
        "Generation process stopped before completion.",
        "interrupted",
      );
      generation.controller.abort();
    }
    const waits = [run?.done, generation?.done].filter(Boolean) as Promise<void>[];
    if (waits.length) void Promise.allSettled(waits).finally(() => db.close());
    else db.close();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error: any) {
    db.close();
    throw new Error(
      error.code === "EADDRINUSE"
        ? "Port " + port + " is already in use. Choose --port <other-port>."
        : error.message,
    );
  }
  const address = server.address() as { port: number };
  generationPoll = setInterval(() => void pumpGeneration().catch(() => undefined), 1000);
  void pumpGeneration().catch(() => undefined);
  console.log("Local Evals dashboard: http://127.0.0.1:" + address.port);
  if (host === "0.0.0.0")
    for (const hostname of allowedHosts)
      if (hostname !== "127.0.0.1" && hostname !== "localhost")
        console.log(`Wi-Fi dashboard: http://${hostname}:${address.port}`);
  return server;
}
