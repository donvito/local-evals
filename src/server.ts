import http from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseStore } from "./storage/db.js";
import {
  datasetJsonl,
  generatedManifest,
  importManifest,
} from "./core/manifest.js";
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
  type ActiveRun = {
    controller: AbortController;
    runId?: string;
    phase: "starting" | "running" | "stopping";
    done: Promise<void>;
    finish: () => void;
  };
  let activeRun: ActiveRun | undefined;
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
      if (req.method === "POST" && url.pathname === "/api/setup/config") {
        const input = await body(),
          targets = db.listTargets(),
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
        validateRunConfig(config);
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
      if (req.method === "POST" && url.pathname === "/api/datasets/import") {
        const input = await body();
        const file = await projectFile(projectRoot, input.path);
        const dataset = await importManifest(
          file,
          path.join(storageRoot, "assets"),
          { allowMissingExpected: true },
        );
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
        const target = targetName ? db.getTarget(targetName, true) : undefined;
        if (!target)
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
        const schema = generatedDatasetSchema(taskKind);
        const prompt = [
          "You create synthetic evaluation datasets for a local-first model evaluation tool.",
          `Generate exactly ${count} independent cases for the ${taskKind === "tool-calling" ? "tool-calling" : "text-to-JSON"} workflow.`,
          "Return only one JSON object matching the supplied schema. Do not use Markdown fences.",
          "Every case must have a unique caseId, useful inputText, and the deterministic ideal expected output.",
          taskKind === "tool-calling"
            ? "For expected, return an array of function calls with name and JSON object arguments. These are expectations only; no tools will be executed."
            : "For expected, return the JSON object the model should produce from inputText.",
          "Use synthetic data only; never include real personal, financial, or secret information.",
          `Dataset brief: ${brief}`,
        ].join("\n\n");
        const response = await providers.callOpenAICompatible(target, prompt, {
          outputMode: target.supportsStructuredOutput
            ? "schema-constrained-json"
            : "prompted-json",
          schema,
          generation: { max_tokens: Math.min(12000, 1200 * count) },
          signal: AbortSignal.timeout(120000),
        });
        const dataset = generatedManifest(parseGeneratedJson(response.text), {
          taskKind,
          name,
        });
        db.saveDataset(dataset);
        json(dataset);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/runs/start") {
        const input = await body();
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
              ? "File not found. Build the dashboard with npm run build."
              : (error.message ?? String(error)),
        },
        error.code === "ENOENT" ? 404 : 400,
      );
    }
  });
  server.once("close", () => {
    const run = activeRun;
    run?.controller.abort();
    if (run) void run.done.finally(() => db.close());
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
  console.log("Local Evals dashboard: http://127.0.0.1:" + address.port);
  if (host === "0.0.0.0")
    for (const hostname of allowedHosts)
      if (hostname !== "127.0.0.1" && hostname !== "localhost")
        console.log(`Wi-Fi dashboard: http://${hostname}:${address.port}`);
  return server;
}
