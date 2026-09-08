import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  DatasetManifest,
  Json,
  RunConfig,
  CaseResult,
  TargetConfig,
  TaskKind,
} from "./types.js";
import {
  callOpenAICompatible,
  discoverTargetMetadata,
  ProviderError,
  testTarget,
  testToolCallingTarget,
  PREFLIGHT_SCHEMA,
  type ModelResponse,
} from "./providers.js";
import {
  gradeJson,
  gradeOcr,
  GRADER_VERSION,
  validateSchemaDefinition,
} from "./grading.js";
import { gradeToolCalls } from "./tool-grading.js";
import { validateRunConfig } from "./project.js";
import type { DatabaseStore } from "../storage/db.js";
import { registerSecrets, sanitize } from "./security.js";

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

export function inferTaskKind(manifest: DatasetManifest): TaskKind {
  return (
    manifest.taskKind ??
    (manifest.cases.some((item) => item.inputText !== undefined)
      ? "text-json"
      : "document-json")
  );
}

export function resolveTaskKind(
  manifest: DatasetManifest,
  config: RunConfig,
): TaskKind {
  if (
    config.taskKind !== undefined &&
    manifest.taskKind !== undefined &&
    config.taskKind !== manifest.taskKind
  )
    throw new Error(
      `Run taskKind ${config.taskKind} does not match dataset taskKind ${manifest.taskKind}.`,
    );
  return config.taskKind ?? inferTaskKind(manifest);
}

/** Validate requirements that can only be checked once a dataset is present. */
export function validateRunRequirements(
  manifest: DatasetManifest,
  config: RunConfig,
  taskKind = resolveTaskKind(manifest, config),
): void {
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0)
    throw new Error("Manifest must contain a non-empty cases array.");
  for (const item of manifest.cases) {
    if (taskKind === "document-json" && typeof item.imagePath !== "string")
      throw new Error(`Case ${item.caseId}: document-json requires imagePath.`);
    if (
      (taskKind === "text-json" || taskKind === "tool-calling") &&
      typeof item.inputText !== "string"
    )
      throw new Error(`Case ${item.caseId}: ${taskKind} requires inputText.`);
    if (
      taskKind === "tool-calling" &&
      item.expected !== undefined &&
      (!Array.isArray(item.expected) ||
        item.expected.some(
          (call: any) =>
            !call ||
            typeof call.name !== "string" ||
            !call.name.trim() ||
            !call.arguments ||
            typeof call.arguments !== "object" ||
            Array.isArray(call.arguments),
        ))
    )
      throw new Error(
        `Case ${item.caseId}: tool-calling expected must be an array of name/arguments objects.`,
      );
    if (
      !config.inferenceOnly &&
      item.expected === undefined
    )
      throw new Error(
        "Evaluation mode requires expected JSON for every case. Set inferenceOnly to true for unlabeled data.",
      );
  }
  if (
    taskKind === "document-json" &&
    config.extractionSource === "reference" &&
    manifest.cases.some(
      (item) => typeof item.referenceTranscription !== "string",
    )
  )
    throw new Error(
      "Extraction-only mode requires a reference transcription for every case.",
    );
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
      if (!item.imagePath) {
        hashes[item.caseId] = item.imageHash ?? "not-applicable";
        return;
      }
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

function toolCallsFromResponse(response: ModelResponse): unknown[] {
  const responseRecord = response as unknown as Record<string, unknown>;
  const raw = response.raw as unknown;
  const rawRecord =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const message =
    Array.isArray(rawRecord?.choices) &&
    rawRecord.choices[0] !== null &&
    typeof rawRecord.choices[0] === "object" &&
    !Array.isArray(rawRecord.choices[0]) &&
    (rawRecord.choices[0] as Record<string, unknown>).message !== null &&
    typeof (rawRecord.choices[0] as Record<string, unknown>).message ===
      "object" &&
    !Array.isArray((rawRecord.choices[0] as Record<string, unknown>).message)
      ? ((rawRecord.choices[0] as Record<string, unknown>)
          .message as Record<string, unknown>)
      : undefined;
  const candidates: Array<{
    label: string;
    present: boolean;
    value: unknown;
  }> = [
    {
      label: "response.toolCalls",
      present: Object.hasOwn(responseRecord, "toolCalls"),
      value: responseRecord.toolCalls,
    },
    {
      label: "response.raw.toolCalls",
      present: rawRecord !== undefined && Object.hasOwn(rawRecord, "toolCalls"),
      value: rawRecord?.toolCalls,
    },
    {
      label: "response.raw.tool_calls",
      present: rawRecord !== undefined && Object.hasOwn(rawRecord, "tool_calls"),
      value: rawRecord?.tool_calls,
    },
    {
      label: "response.raw.choices[0].message.tool_calls",
      present: message !== undefined && Object.hasOwn(message, "tool_calls"),
      value: message?.tool_calls,
    },
  ];
  for (const candidate of candidates) {
    if (candidate.present && !Array.isArray(candidate.value))
      throw new Error(
        `Provider returned malformed ${candidate.label}; expected an array.`,
      );
  }
  const calls = candidates.find((candidate) => Array.isArray(candidate.value));
  return (calls?.value as unknown[] | undefined) ?? [];
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
  const taskKind = config.taskKind ?? "document-json";
  const result: CaseResult & Record<string, unknown> = {
    caseId: item.caseId,
    ...(item.imagePath !== undefined ? { imagePath: item.imagePath } : {}),
    ...(item.inputText !== undefined ? { inputText: item.inputText } : {}),
    ...(item.expected !== undefined ? { expected: item.expected } : {}),
    ...(item.referenceTranscription !== undefined
      ? { referenceTranscription: item.referenceTranscription }
      : {}),
    ...(item.originalImagePath !== undefined
      ? { originalImagePath: item.originalImagePath }
      : {}),
    ...(item.imageHash !== undefined ? { imageHash: item.imageHash } : {}),
    timings: {},
  };
  const provider = options.provider ?? callOpenAICompatible;
  const ocrTarget = options.runtimeTargets?.ocr ?? config.ocrTarget;
  const extractionTarget =
    options.runtimeTargets?.extraction ?? config.extractionTarget;
  const judgeTarget = options.runtimeTargets?.judge ?? config.judgeTarget;
  try {
    if (taskKind === "document-json" && config.extractionSource !== "reference") {
      const ocrPrompt = config.stagePrompts.ocr;
      if (!ocrTarget || !ocrPrompt)
        throw new Error("document-json OCR mode requires an OCR target and prompt.");
      const started = Date.now();
      const ocr = await requestStage(
        db,
        runId,
        item.caseId,
        "ocr",
        (signal) =>
          provider(
            ocrTarget,
            ocrPrompt,
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
      taskKind === "document-json"
        ? config.extractionSource === "reference"
          ? item.referenceTranscription
          : result.ocrText
        : item.inputText;
    if (typeof extractionText !== "string")
      throw new Error(
        taskKind === "document-json"
          ? `Case ${item.caseId} cannot extract without OCR text.`
          : `Case ${item.caseId} cannot extract without inputText.`,
      );
    const schema = options.schema ?? config.schema;
    const schemaPrompt =
      taskKind !== "tool-calling" &&
      (config.outputMode ?? "prompted-json") === "prompted-json" &&
      schema
        ? `\n\nSchema:\n${JSON.stringify(schema)}`
        : "";
    const extractionPrompt =
      taskKind === "document-json"
        ? `${config.stagePrompts.extraction}${schemaPrompt}\n\nTranscription:\n${extractionText}`
        : `${config.stagePrompts.extraction}${schemaPrompt}\n\nInput:\n${extractionText}`;
    const toolRequest =
      taskKind === "tool-calling"
        ? {
            tools: config.tools,
            toolChoice: config.toolChoice ?? "auto",
          }
        : undefined;
    const started = Date.now();
    const extraction = await requestStage(
      db,
      runId,
      item.caseId,
      "extraction",
        (signal) =>
          provider(
            extractionTarget,
            extractionPrompt,
            undefined,
            taskKind === "tool-calling"
              ? "prompted-json"
              : (config.outputMode ?? "prompted-json"),
            signal,
            taskKind === "tool-calling" ? undefined : schema,
            generationFor(config, extractionTarget),
            toolRequest,
          ),
      options,
      config,
    );
    result.timings.extractionMs = Date.now() - started;
    result.rawExtraction = extraction.text;
    result.extractionUsage = extraction.usage;
    result.extractionRaw = extraction.raw;
    if (taskKind === "tool-calling") {
      const toolCalls = toolCallsFromResponse(extraction);
      result.toolCalls = toolCalls;
      result.rawToolCalls = toolCalls;
      if (!config.inferenceOnly)
        result.grade = gradeToolCalls(
          item.expected,
          toolCalls,
          config.tools ?? [],
          config.toolCallOrder ?? "ordered",
        );
    } else {
      try {
        result.parsedJson = JSON.parse(extraction.text) as Json;
      } catch {
        result.parsedJson = undefined;
      }
      if (!config.inferenceOnly)
        result.grade = gradeJson(
          item.expected as Json,
          result.parsedJson,
          schema,
          config.fieldRules,
          config.crossFieldRules,
        );
    }
    if (
      taskKind !== "tool-calling" &&
      !config.inferenceOnly &&
      judgeTarget &&
      config.judgeRubric
    )
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
  const taskKind = resolveTaskKind(manifest, config);
  const suppliedSchema = options.schema ?? config.schema;
  const normalizedConfig = {
    ...config,
    taskKind,
    ...(suppliedSchema !== undefined ? { schema: suppliedSchema } : {}),
  } as RunConfig;
  validateRunConfig(normalizedConfig);
  config = normalizedConfig;
  validateRunRequirements(manifest, config, taskKind);
  const extractionOnly =
    taskKind === "document-json" && config.extractionSource === "reference";
  registerSecrets(
    [config.ocrTarget, config.extractionTarget, config.judgeTarget].filter(
      Boolean,
    ) as TargetConfig[],
  );
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
  const schema = config.schema;
  if (schema && typeof schema === "object") validateSchemaDefinition(schema);
  const runtimeTargets = {
    ocr:
      taskKind !== "document-json" || extractionOnly
      ? undefined
      : (db.resolveTarget?.(config.ocrTarget!) ?? config.ocrTarget),
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
    ...(config.ocrTarget
      ? {
          ocrTarget: credentialFreeTarget(
            runtimeTargets.ocr ?? config.ocrTarget,
          ),
        }
      : {}),
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
          : taskKind !== "document-json"
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
    taskKind,
    ...(taskKind === "tool-calling"
      ? {
          tools: config.tools,
          toolChoice: config.toolChoice ?? "auto",
          toolCallOrder: config.toolCallOrder ?? "ordered",
        }
      : {}),
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
      if (taskKind === "document-json" && !extractionOnly)
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
      if (
        taskKind !== "tool-calling" &&
        config.outputMode === "schema-constrained-json"
      )
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
      if (taskKind === "tool-calling")
        await requestStage(
          db,
          runId,
          "__preflight__",
          "tool-preflight",
          (signal) =>
            testToolCallingTarget(runtimeTargets.extraction, signal).then(
              (r) => r.response,
            ),
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
