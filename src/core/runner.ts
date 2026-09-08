import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  DatasetManifest,
  Json,
  RunConfig,
  CaseResult,
  TargetConfig,
} from "./types.js";
import {
  callOpenAICompatible,
  discoverTargetMetadata,
  ProviderError,
  testTarget,
  PREFLIGHT_SCHEMA,
  type ModelResponse,
} from "./providers.js";
import {
  gradeJson,
  gradeOcr,
  GRADER_VERSION,
  validateSchemaDefinition,
} from "./grading.js";
import type { DatabaseStore } from "../storage/db.js";
import { registerSecrets, sanitize, validateTarget } from "./security.js";

type AttemptRecord = {
  attempt: number;
  stage?: string;
  status: "success" | "error";
  response?: unknown;
  error?: string;
  usage?: unknown;
  startedAt: string;
  elapsedMs: number;
};
type ExtendedDb = DatabaseStore & {
  createRun: (
    id: string,
    config: RunConfig,
    datasetVersion: string,
    snapshot?: unknown,
  ) => void;
  saveAttempt?: (
    runId: string,
    caseId: string,
    stage: string,
    attempt: AttemptRecord,
  ) => void;
  finishRun?: (id: string, status: string, error?: string) => void;
  updateRunSnapshot?: (id: string, snapshot: unknown) => void;
  appendRunEvent?: (runId: string, type: string, payload?: unknown) => unknown;
  resolveTarget?: (target: TargetConfig) => TargetConfig;
};
export type RunnerOptions = {
  db: DatabaseStore;
  schema?: object;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  onStarted?: (runId: string) => void;
  provider?: typeof callOpenAICompatible;
  runtimeTargets?: {
    ocr?: TargetConfig;
    extraction: TargetConfig;
    judge?: TargetConfig;
  };
};

function redacted<T>(value: T): T {
  return sanitize(value);
}
function diagnosticError(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error);
  const returned = message.match(/^(.+?) returned (\d+):/);
  if (returned) return `${returned[1]} returned ${returned[2]}.`;
  const transport = message.match(/^Transport error calling ([^:]+):/);
  if (transport) return `Transport error calling ${transport[1]}.`;
  const missing = message.match(
    /^Target ([^ ]+) requires environment variable /,
  );
  if (missing)
    return `Target ${missing[1]} is missing credential configuration.`;
  if (error instanceof ProviderError) return "Provider request failed.";
  return redacted(message).slice(0, error instanceof ProviderError ? 240 : 500);
}
function event(db: ExtendedDb, runId: string, type: string, payload?: unknown) {
  try {
    db.appendRunEvent?.(runId, type, payload);
  } catch {
    /* diagnostics must never change evaluation behavior */
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
async function hashAssets(manifest: DatasetManifest) {
  const hashes: Record<string, string> = {};
  await Promise.all(
    manifest.cases.map(async (item) => {
      try {
        hashes[item.caseId] = createHash("sha256")
          .update(await readFile(item.imagePath))
          .digest("hex");
        if (item.imageHash && item.imageHash !== hashes[item.caseId])
          throw new Error(
            `Asset hash mismatch for case ${item.caseId}: expected ${item.imageHash}, found ${hashes[item.caseId]}.`,
          );
      } catch (error) {
        if (item.imageHash)
          throw error instanceof Error
            ? error
            : new Error(`Asset ${item.caseId} is unavailable.`);
        hashes[item.caseId] = "unknown";
      }
    }),
  );
  return hashes;
}
async function requestStage(
  db: ExtendedDb,
  runId: string,
  caseId: string,
  stage: string,
  request: (signal: AbortSignal) => Promise<ModelResponse>,
  options: RunnerOptions,
  config: RunConfig,
): Promise<ModelResponse> {
  const timeoutMs = config.requestTimeoutMs ?? 60_000;
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (options.signal?.aborted)
      throw new ProviderError("Evaluation cancelled.", false);
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const timed = timeoutSignal(options.signal, timeoutMs);
    event(db, runId, "stage_started", { stage, attempt, caseId });
    db.beginAttempt?.(runId, caseId, stage, {
      attempt,
      stage,
      startedAt,
      elapsedMs: 0,
    });
    try {
      const response = await request(timed.signal);
      db.saveAttempt?.(runId, caseId, stage, {
        attempt,
        stage,
        status: "success",
        response: response.raw,
        usage: response.usage,
        startedAt,
        elapsedMs: Date.now() - started,
      });
      event(db, runId, "stage_finished", {
        stage,
        caseId,
        attempt,
        status: "success",
        elapsedMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      last = error;
      const retryable =
        error instanceof ProviderError &&
        error.transient &&
        !options.signal?.aborted;
      db.saveAttempt?.(runId, caseId, stage, {
        attempt,
        stage,
        status: "error",
        response: error instanceof ProviderError ? error.raw : undefined,
        error: redacted(String(error instanceof Error ? error.message : error)),
        startedAt,
        elapsedMs: Date.now() - started,
      });
      event(db, runId, "stage_finished", {
        stage,
        caseId,
        attempt,
        status: options.signal?.aborted ? "cancelled" : "error",
        elapsedMs: Date.now() - started,
        error: diagnosticError(error),
      });
      if (!retryable || attempt === 3) throw error;
      event(db, runId, "retry_scheduled", {
        stage,
        caseId,
        attempt,
        retryInMs: 200 * 2 ** (attempt - 1),
        reason: diagnosticError(error),
      });
      await new Promise((resolve) =>
        setTimeout(resolve, 200 * 2 ** (attempt - 1)),
      );
    } finally {
      timed.cleanup();
    }
  }
  throw last;
}
function generationFor(config: RunConfig, target: TargetConfig) {
  return { ...(config.generation ?? {}), ...(target.generation ?? {}) };
}
async function runCase(
  item: DatasetManifest["cases"][number],
  runId: string,
  config: RunConfig,
  options: RunnerOptions,
  db: ExtendedDb,
): Promise<CaseResult> {
  const caseStarted = Date.now();
  event(db, runId, "case_started", { caseId: item.caseId });
  const result: CaseResult & Record<string, unknown> = {
    caseId: item.caseId,
    imagePath: item.imagePath,
    ...(item.expected !== undefined ? { expected: item.expected } : {}),
    referenceTranscription: item.referenceTranscription,
    originalImagePath: item.originalImagePath,
    imageHash: item.imageHash,
    timings: {},
  };
  const provider = options.provider ?? callOpenAICompatible;
  const ocrTarget = options.runtimeTargets?.ocr ?? config.ocrTarget;
  const extractionTarget =
    options.runtimeTargets?.extraction ?? config.extractionTarget;
  const judgeTarget = options.runtimeTargets?.judge ?? config.judgeTarget;
  try {
    if (config.extractionSource !== "reference") {
      const started = Date.now();
      const ocr = await requestStage(
        db,
        runId,
        item.caseId,
        "ocr",
        (signal) =>
          provider(
            ocrTarget,
            config.stagePrompts.ocr,
            item.imagePath,
            "prompted-json",
            signal,
            undefined,
            generationFor(config, ocrTarget),
          ),
        options,
        config,
      );
      result.timings.ocrMs = Date.now() - started;
      result.ocrText = ocr.text;
      result.ocrUsage = ocr.usage;
      result.ocrRaw = ocr.raw;
    }
    const extractionText =
      config.extractionSource === "reference"
        ? item.referenceTranscription
        : result.ocrText;
    if (typeof extractionText !== "string")
      throw new Error(`Case ${item.caseId} cannot extract without OCR text.`);
    const schema = options.schema ?? config.schema;
    const schemaPrompt =
      config.outputMode === "prompted-json" && schema
        ? `\n\nSchema:\n${JSON.stringify(schema)}`
        : "";
    const started = Date.now();
    const extraction = await requestStage(
      db,
      runId,
      item.caseId,
      "extraction",
      (signal) =>
        provider(
          extractionTarget,
          `${config.stagePrompts.extraction}${schemaPrompt}\n\nTranscription:\n${extractionText}`,
          undefined,
          config.outputMode,
          signal,
          schema,
          generationFor(config, extractionTarget),
        ),
      options,
      config,
    );
    result.timings.extractionMs = Date.now() - started;
    result.rawExtraction = extraction.text;
    result.extractionUsage = extraction.usage;
    result.extractionRaw = extraction.raw;
    try {
      result.parsedJson = JSON.parse(extraction.text) as Json;
    } catch {
      result.parsedJson = undefined;
    }
    if (!config.inferenceOnly)
      result.grade = gradeJson(
        item.expected,
        result.parsedJson,
        schema,
        config.fieldRules,
        config.crossFieldRules,
      );
    if (!config.inferenceOnly && judgeTarget && config.judgeRubric)
      try {
        const judge = await requestStage(
          db,
          runId,
          item.caseId,
          "judge",
          (signal) =>
            provider(
              judgeTarget,
              `${config.judgeRubric}\n\nExpected:\n${JSON.stringify(item.expected)}\n\nActual:\n${extraction.text}`,
              undefined,
              "prompted-json",
              signal,
              undefined,
              generationFor(config, judgeTarget),
            ),
          options,
          config,
        );
        const parsed = JSON.parse(judge.text);
        const verdict = parsed?.verdict;
        const evidence = parsed?.evidence;
        if (
          !(
            typeof verdict === "boolean" ||
            verdict === "pass" ||
            verdict === "fail"
          ) ||
          typeof evidence !== "string" ||
          !evidence.trim()
        )
          throw new Error(
            "Judge response must contain a boolean/pass/fail verdict and non-empty evidence.",
          );
        result.judge = { raw: judge.text, evidence, verdict };
      } catch (error) {
        result.judge = {
          verdict: "ungraded",
          error: redacted(
            String(error instanceof Error ? error.message : error),
          ),
        };
      }
  } catch (error) {
    event(db, runId, "case_error", {
      caseId: item.caseId,
      status: "error",
      elapsedMs: Date.now() - caseStarted,
      error: diagnosticError(error),
    });
    result.error = redacted(
      String(error instanceof Error ? error.message : error),
    );
  }
  event(db, runId, "case_finished", {
    caseId: item.caseId,
    status: result.error ? "error" : "success",
    elapsedMs: Date.now() - caseStarted,
  });
  return result;
}
export async function runEvaluation(
  manifest: DatasetManifest,
  config: RunConfig,
  options: RunnerOptions,
) {
  const runId = randomUUID();
  const db = options.db as ExtendedDb;
  const extractionOnly = config.extractionSource === "reference";
  registerSecrets(
    [config.ocrTarget, config.extractionTarget, config.judgeTarget].filter(
      Boolean,
    ) as TargetConfig[],
  );
  if (!extractionOnly) validateTarget(config.ocrTarget);
  validateTarget(config.extractionTarget);
  if (config.judgeTarget) validateTarget(config.judgeTarget);
  if (
    !Number.isInteger(config.concurrency ?? 1) ||
    (config.concurrency ?? 1) < 1
  )
    throw new Error("Concurrency must be a positive integer.");
  if (
    config.requestTimeoutMs !== undefined &&
    (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
  )
    throw new Error("requestTimeoutMs must be positive.");
  const schema = options.schema ?? config.schema;
  if (schema && typeof schema === "object") validateSchemaDefinition(schema);
  if (
    config.outputMode === "schema-constrained-json" &&
    (!schema || typeof schema !== "object")
  )
    throw new Error("Schema-constrained mode requires an extraction schema.");
  if (
    extractionOnly &&
    manifest.cases.some(
      (item) => typeof item.referenceTranscription !== "string",
    )
  )
    throw new Error(
      "Extraction-only mode requires a reference transcription for every case.",
    );
  const runtimeTargets = {
    ocr: extractionOnly
      ? undefined
      : (db.resolveTarget?.(config.ocrTarget) ?? config.ocrTarget),
    extraction:
      db.resolveTarget?.(config.extractionTarget) ?? config.extractionTarget,
    judge: config.judgeTarget
      ? (db.resolveTarget?.(config.judgeTarget) ?? config.judgeTarget)
      : undefined,
  };
  const credentialFreeTarget = (target?: TargetConfig) => {
    if (!target) return undefined;
    const copy = { ...target };
    delete copy.apiKey;
    return copy;
  };
  const effectiveConfig: RunConfig = {
    ...config,
    ocrTarget: credentialFreeTarget(runtimeTargets.ocr ?? config.ocrTarget)!,
    extractionTarget: credentialFreeTarget(runtimeTargets.extraction)!,
    ...(runtimeTargets.judge || config.judgeTarget
      ? {
          judgeTarget: credentialFreeTarget(
            runtimeTargets.judge ?? config.judgeTarget,
          ),
        }
      : {}),
  };
  registerSecrets(
    [
      runtimeTargets.ocr,
      runtimeTargets.extraction,
      runtimeTargets.judge,
    ].filter(Boolean) as TargetConfig[],
  );
  if (
    !config.inferenceOnly &&
    manifest.cases.some((item) => item.expected === undefined)
  )
    throw new Error(
      "Evaluation mode requires expected JSON for every case. Set inferenceOnly to true for unlabeled data.",
    );
  const assetHashes = await hashAssets(manifest);
  const hash = (value: unknown) =>
    createHash("sha256").update(stable(value)).digest("hex");
  const targetSnapshot = (target?: TargetConfig) => ({
    model: target?.model ?? "unknown",
    server: target?.metadata?.server ?? "unknown",
    quantization: target?.metadata?.quantization ?? "unknown",
    routing: target?.metadata?.routing ?? "unknown",
  });
  const targets = options.provider
    ? {
        ocr: targetSnapshot(runtimeTargets.ocr),
        extraction: targetSnapshot(runtimeTargets.extraction),
        judge: targetSnapshot(runtimeTargets.judge),
      }
    : {
        ocr: extractionOnly
          ? targetSnapshot()
          : await discoverTargetMetadata(runtimeTargets.ocr!, options.signal),
        extraction: await discoverTargetMetadata(
          runtimeTargets.extraction,
          options.signal,
        ),
        judge: config.judgeTarget
          ? await discoverTargetMetadata(runtimeTargets.judge!, options.signal)
          : targetSnapshot(),
      };
  const snapshot = {
    totalCases: manifest.cases.length,
    manifest: {
      ...manifest,
      cases: manifest.cases.map((item) => ({
        ...item,
        imageHash: assetHashes[item.caseId],
      })),
    },
    assetHashes,
    config: sanitize(effectiveConfig),
    schema,
    schemaHash: hash(schema),
    configHash: hash(effectiveConfig),
    stagePromptsHash: hash(config.stagePrompts),
    fieldRulesHash: hash(config.fieldRules),
    judgeRubricHash: hash(config.judgeRubric),
    graderVersion: GRADER_VERSION,
    stagePrompts: config.stagePrompts,
    targets,
  };
  const finishSafely = (status: string, error?: string) => {
    if (finished) return;
    finished = true;
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    try {
      db.finishRun?.(runId, status, error);
    } catch {
      /* preserve the original failure */
    }
    event(db, runId, "run_finished", {
      status,
      error: error ? diagnosticError(error) : undefined,
      elapsedMs: Date.now() - runStarted,
    });
  };
  const runStarted = Date.now();
  let finished = false;
  let onAbort: (() => void) | undefined;
  const executionOptions: RunnerOptions = { ...options, runtimeTargets };
  try {
    db.createRun(
      runId,
      effectiveConfig,
      effectiveConfig.datasetVersion,
      snapshot,
    );
    db.updateRunSnapshot?.(runId, snapshot);
    event(db, runId, "run_started", {
      totalCases: manifest.cases.length,
      preflight: !options.provider,
    });
    onAbort = () => {
      if (!finished)
        event(db, runId, "cancellation_requested", { reason: "signal" });
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    options.onStarted?.(runId);
  } catch (error) {
    const message = redacted(
      String(error instanceof Error ? error.message : error),
    );
    finishSafely("failed", message);
    throw error;
  }
  try {
    if (!options.provider) {
      if (!extractionOnly)
        await requestStage(
          db,
          runId,
          "__preflight__",
          "ocr-preflight",
          (signal) =>
            testTarget(runtimeTargets.ocr!, { vision: true }, signal).then(
              (r) => r.response,
            ),
          executionOptions,
          config,
        );
      if (config.outputMode === "schema-constrained-json")
        await requestStage(
          db,
          runId,
          "__preflight__",
          "extraction-preflight",
          (signal) =>
            testTarget(
              runtimeTargets.extraction,
              { schema: PREFLIGHT_SCHEMA },
              signal,
            ).then((r) => r.response),
          executionOptions,
          config,
        );
    }
  } catch (error) {
    const message = redacted(
      String(error instanceof Error ? error.message : error),
    );
    finishSafely(options.signal?.aborted ? "cancelled" : "failed", message);
    throw new Error(message);
  }
  const results: CaseResult[] = [];
  let next = 0;
  let done = 0;
  let workerFailed = false;
  const concurrency = config.concurrency ?? 1;
  const worker = async () => {
    while (!options.signal?.aborted && !workerFailed) {
      const index = next++;
      if (index >= manifest.cases.length) return;
      try {
        const result = await runCase(
          manifest.cases[index],
          runId,
          config,
          executionOptions,
          db,
        );
        results[index] = result;
        db.saveCaseResult(
          runId,
          result,
          gradeOcr(
            manifest.cases[index].referenceTranscription,
            result.ocrText,
          ),
        );
        options.onProgress?.(++done, manifest.cases.length);
      } catch (error) {
        workerFailed = true;
        throw error;
      }
    }
  };
  try {
    const settled = await Promise.allSettled(
      Array.from(
        { length: Math.min(concurrency, manifest.cases.length) },
        worker,
      ),
    );
    const rejected = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (rejected) throw rejected.reason;
  } catch (error) {
    const message = redacted(
      String(error instanceof Error ? error.message : error),
    );
    finishSafely(options.signal?.aborted ? "cancelled" : "failed", message);
    throw error;
  }
  const cancelled = Boolean(options.signal?.aborted);
  finishSafely(
    cancelled ? "cancelled" : "completed",
    cancelled ? "Evaluation cancelled." : undefined,
  );
  return { runId, results };
}
