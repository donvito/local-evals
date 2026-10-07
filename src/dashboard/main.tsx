import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { describeRunError } from "./errors.js";
import { HighlightedJson } from "./json-highlight.js";
import type { SchemaCheck } from "../core/schema-check.js";
import { CliHelp, Help } from "./help.js";
import { PageTitle } from "./page-title.js";
import {
  SETUP_STEPS,
  issuesForStep,
  validateSetup,
  type SetupStep,
} from "./setup-validation.js";
import { THEME_OPTIONS, applyTheme, readTheme, type ThemePreference } from "./theme.js";

type Json = unknown;
type TaskKind = "document-json" | "text-json" | "tool-calling";
type ToolChoice = "auto" | "required" | "none";
type ToolCallOrder = "ordered" | "unordered";
const DEFAULT_TASK_KIND: TaskKind = "document-json";
const TASK_KIND_LABELS: Record<TaskKind, string> = {
  "document-json": "Document → JSON",
  "text-json": "Text → JSON",
  "tool-calling": "Tool calling",
};
type ToolDefinition = {
  type?: "function" | string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Json;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
type ModelCatalogModel = {
  id: string;
  name: string;
  description?: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  capabilitiesKnown?: boolean;
};
type ModelCatalogResponse = {
  models: ModelCatalogModel[];
  cachedAt: string;
  stale?: boolean;
  source?: "openrouter" | "configured-endpoint";
};
type Run = {
  runId: string;
  createdAt: string;
  status?: string;
  caseCount: number;
  totalCases?: number;
  passedCount: number | null;
  inferenceOnly?: boolean;
  metrics?: Record<string, unknown>;
  experimentId?: string | null;
  experimentName?: string | null;
  datasetVersion?: string;
  datasetName?: string | null;
  taskKind?: TaskKind;
  targetName?: string | null;
  modelName?: string | null;
};
type Experiment = {
  experimentId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
};
type Target = {
  name: string;
  baseUrl: string;
  model: string;
  provider?: "openrouter" | "llama.cpp" | "openai-compatible";
  apiKeyEnv?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  keySource?: "model" | "provider";
  supportsVision?: boolean;
  supportsStructuredOutput?: boolean;
  supportsTools?: boolean;
};
type ProviderKey = { baseUrl: string; updatedAt: string; models: string[] };
type CaseResult = {
  caseId: string;
  imagePath?: string;
  inputText?: string;
  expected?: Json;
  referenceTranscription?: string;
  ocrText?: string;
  rawExtraction?: string;
  extractionRaw?: Json;
  parsedJson?: Json;
  toolCalls?: Json;
  rawToolCalls?: Json;
  proposedToolCalls?: Json;
  actualToolCalls?: Json;
  grade?: {
    passed?: boolean;
    parseSuccess?: boolean;
    schemaValid?: boolean;
    fieldAccuracy?: number;
    failures?: {
      path?: string;
      kind?: string;
      message?: string;
      expected?: Json;
      actual?: Json;
    }[];
  };
  ocrGrade?: Record<string, number | string | boolean>;
  timings?: Record<string, number>;
  error?: string;
  judge?: { verdict?: string | boolean; evidence?: string; error?: string };
};
type RunDetail = Run & {
  config?: Record<string, Json>;
  snapshot?: Json;
  error?: string;
  cases: CaseResult[];
  attempts?: Json[];
  events?: RunEvent[];
};
type RunEvent = {
  id?: string | number;
  eventId?: number;
  runId?: string;
  type?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
  createdAt?: string;
  time?: string;
  level?: string;
  status?: string;
  event?: string;
  stage?: string;
  message?: string;
  error?: string;
  caseId?: string;
  attempt?: number;
  retry?: number;
  elapsedMs?: number;
  elapsed?: number;
};
type RunEventsResponse =
  | RunEvent[]
  | {
      events?: RunEvent[];
      nextAfter?: number;
      nextCursor?: string | null;
      nextPageToken?: string | null;
      hasMore?: boolean;
    };
type Dataset = {
  version: string;
  name: string;
  taskKind?: TaskKind;
  cases: {
    caseId: string;
    imagePath?: string;
    inputText?: string;
    expected?: Json;
    referenceTranscription?: string;
    metadata?: Record<string, Json>;
    imageHash?: string;
    originalImagePath?: string;
  }[];
};
type DatasetJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";
type DatasetJob = {
  jobId: string;
  status: DatasetJobStatus;
  name: string;
  taskKind: TaskKind;
  targetName: string;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
  datasetVersion?: string;
  timeoutSeconds?: number;
  error?: string;
};
type GenerationDraft = {
  target: string;
  taskKind: "text-json" | "tool-calling";
  name: string;
  count: string;
  brief: string;
  timeoutMinutes: string;
};
const DATASET_GENERATION_DRAFT_KEY = "local-evals-dataset-generation-draft";
const validGenerationTimeoutMinutes = (value: string, fallback = "10") => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0.5 && minutes <= 60
    ? value
    : fallback;
};
const readGenerationDraft = (): GenerationDraft => {
  const fallback: GenerationDraft = {
    target: "",
    taskKind: "text-json",
    name: "",
    count: "5",
    brief: "",
    timeoutMinutes: "10",
  };
  try {
    const value = JSON.parse(
      window.localStorage.getItem(DATASET_GENERATION_DRAFT_KEY) || "null",
    ) as Partial<GenerationDraft> | null;
    if (!value || typeof value !== "object") return fallback;
    return {
      target: typeof value.target === "string" ? value.target : fallback.target,
      taskKind:
        value.taskKind === "tool-calling" ? "tool-calling" : "text-json",
      name: typeof value.name === "string" ? value.name : fallback.name,
      count: typeof value.count === "string" ? value.count : fallback.count,
      brief: typeof value.brief === "string" ? value.brief : fallback.brief,
      timeoutMinutes:
        typeof value.timeoutMinutes === "string"
          ? validGenerationTimeoutMinutes(value.timeoutMinutes)
          : fallback.timeoutMinutes,
    };
  } catch {
    return fallback;
  }
};
type SetupConfig = {
  baseConfigPath?: string;
  datasetVersion?: string;
  taskKind?: TaskKind;
  ocrTarget?: string;
  extractionTarget?: string;
  judgeTarget?: string;
  inferenceOnly?: boolean;
  extractionSource?: string;
  outputMode?: string;
  judgeRubric?: string;
  schema?: Json;
  stagePrompts?: {
    ocr?: string;
    extraction?: string;
    [key: string]: unknown;
  };
  fieldRules?: Json;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  toolCallOrder?: ToolCallOrder;
  generation?: {
    temperature?: number;
    maxTokens?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
  };
};
type Setup = {
  dbPath?: string;
  projectRoot?: string;
  runCommand?: string;
  configPath?: string;
  config?: SetupConfig;
};
type ActiveExecution = {
  active: boolean;
  ownedByDashboard: boolean;
  canStop: boolean;
  phase?: "starting" | "running" | "stopping" | "external";
  runId?: string;
};
type Tab = "overview" | "runs" | "experiments" | "datasets" | "targets" | "compare" | "setup" | "help" | "cli";
type CaseTab =
  | "transcription"
  | "input-output"
  | "json"
  | "execution"
  | "timing"
  | "metadata";
const TAB_VALUES: Tab[] = [
  "overview",
  "runs",
  "experiments",
  "datasets",
  "targets",
  "compare",
  "setup",
  "help",
  "cli",
];
const DOC_TABS: Tab[] = ["help", "cli"];
const NAV_GROUPS: { id: string; label?: string; tabs: Tab[] }[] = [
  { id: "home", tabs: ["overview"] },
  { id: "prepare", label: "Prepare", tabs: ["targets", "datasets"] },
  { id: "evaluate", label: "Evaluate", tabs: ["setup", "runs"] },
  { id: "analyze", label: "Analyze", tabs: ["compare", "experiments"] },
  { id: "resources", label: "Resources", tabs: DOC_TABS },
];
const MOBILE_PRIMARY_TABS: Tab[] = ["overview", "datasets", "setup", "runs"];
const tabLabel = (tab: Tab) =>
  tab === "targets" ? "Providers" : tab === "cli" ? "CLI" : tab[0].toUpperCase() + tab.slice(1);
const tabFromLocation = (): Tab => {
  const value = window.location.hash.replace(/^#/, "").split("/")[0] as Tab;
  return TAB_VALUES.includes(value) ? value : "overview";
};
type Notice = { message: string; kind: "success" | "error" };

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* text/download */
  }
  if (!response.ok)
    throw new Error(
      (body as { error?: string })?.error ||
        `Request failed (${response.status})`,
    );
  return body as T;
};
const pretty = (value: Json) =>
  value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
const DEFAULT_TEXT_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
    additionalProperties: false,
  },
  null,
  2,
);
const DEFAULT_TEXT_PROMPT =
  "Read the input text and return only a JSON object that matches the supplied schema.";
const DEFAULT_DOCUMENT_OCR_PROMPT =
  "Transcribe every visible word, number, and table value from the document. Return plain text only.";
const DEFAULT_DOCUMENT_EXTRACTION_PROMPT =
  "Extract the document from the transcription into JSON. Preserve null and empty-string optional values exactly.";
const DEFAULT_TOOLS = JSON.stringify(
  [
    {
      type: "function",
      function: {
        name: "lookup_order",
        description: "Look up an order by its identifier.",
        parameters: {
          type: "object",
          properties: {
            order_id: { type: "string", description: "The order identifier." },
          },
          required: ["order_id"],
          additionalProperties: false,
        },
      },
    },
  ],
  null,
  2,
);
const asTaskKind = (value: unknown): TaskKind =>
  value === "text-json" || value === "tool-calling" ? value : DEFAULT_TASK_KIND;
const datasetTaskKind = (dataset: Dataset): TaskKind =>
  asTaskKind(dataset.taskKind);
const taskKindDescription = (taskKind: TaskKind) => {
  if (taskKind === "text-json")
    return "Send plain input text to a model and grade its JSON output.";
  if (taskKind === "tool-calling")
    return "Ask the model to propose function calls; Local Evals never executes them.";
  return "Use a vision model to transcribe a document before grading JSON.";
};
const parseEditorJson = (value: string): Json | undefined => {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value) as Json;
  } catch {
    return undefined;
  }
};
const editorText = (value: Json | undefined, fallback = "") => {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? fallback : serialized;
};
const modelHasParameter = (model: ModelCatalogModel, ...names: string[]) => {
  const parameters = model.supportedParameters.map((value) =>
    value.toLowerCase(),
  );
  return names.some((name) =>
    parameters.some(
      (parameter) =>
        parameter === name ||
        parameter.includes(name) ||
        name.includes(parameter),
    ),
  );
};
const modelHasModality = (model: ModelCatalogModel, modality: string) =>
  model.inputModalities.some((value) => value.toLowerCase().includes(modality));
const modelCapabilities = (model: ModelCatalogModel) => ({
  vision:
    modelHasModality(model, "image") ||
    modelHasModality(model, "vision") ||
    modelHasModality(model, "multimodal"),
  structured:
    modelHasParameter(
      model,
      "response_format",
      "structured_outputs",
      "json_schema",
    ) || model.outputModalities.some((value) => /json|structured/i.test(value)),
  tools: modelHasParameter(model, "tools", "tool_choice", "function_call"),
  free:
    model.id.endsWith(":free") ||
    (model.promptPrice === 0 && model.completionPrice === 0),
  known: Boolean(
    model.capabilitiesKnown ??
    (model.inputModalities.length > 0 ||
      model.outputModalities.length > 0 ||
      model.supportedParameters.length > 0),
  ),
});
const modelContextLabel = (value: number | null) => {
  if (value == null) return "Context unknown";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M context`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k context`;
  return `${value} context`;
};
const modelPriceLabel = (value: number | null) => {
  if (value == null) return "price unknown";
  if (value === 0) return "free";
  const perMillion = value * 1_000_000;
  const amount =
    perMillion >= 10
      ? perMillion.toFixed(0)
      : perMillion >= 1
        ? perMillion.toFixed(2).replace(/\.?0+$/, "")
        : perMillion.toFixed(3).replace(/0+$/, "");
  return `$${amount}/M`;
};
const parsedToolCalls = (item: CaseResult): Json => {
  const candidate =
    item.proposedToolCalls ??
    item.actualToolCalls ??
    item.rawToolCalls ??
    item.toolCalls ??
    (Array.isArray(item.parsedJson) ? item.parsedJson : undefined);
  const parsed =
    candidate !== undefined
      ? candidate
      : item.rawExtraction
        ? (parseEditorJson(item.rawExtraction) ?? item.rawExtraction)
        : undefined;
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return parsed;
  const envelope = parsed as Record<string, unknown>;
  if (Array.isArray(envelope.toolCalls)) return envelope.toolCalls;
  if (Array.isArray(envelope.tool_calls)) return envelope.tool_calls;
  const choices = envelope.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  if (firstChoice && typeof firstChoice === "object") {
    const message = (firstChoice as Record<string, unknown>).message;
    if (message && typeof message === "object") {
      const calls = (message as Record<string, unknown>).tool_calls;
      if (Array.isArray(calls)) return calls;
    }
  }
  return parsed;
};
const normalizedToolCall = (value: Json): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const call = value as Record<string, unknown>;
  const functionValue = call.function;
  const fn =
    functionValue && typeof functionValue === "object"
      ? (functionValue as Record<string, unknown>)
      : call;
  if (typeof fn.name !== "string" || !Object.hasOwn(fn, "arguments"))
    return value;
  let args = fn.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as Json;
    } catch {
      /* Keep malformed argument strings readable in the normalized view. */
    }
  }
  return { name: fn.name, arguments: args };
};
const displayToolCalls = (item: CaseResult): Json => {
  const calls = parsedToolCalls(item);
  return Array.isArray(calls) ? calls.map(normalizedToolCall) : calls;
};
const rawToolResponse = (item: CaseResult): Json =>
  item.extractionRaw ??
  item.rawToolCalls ??
  item.toolCalls ??
  item.rawExtraction ??
  item.actualToolCalls;
const runTaskKind = (run: RunDetail): TaskKind =>
  asTaskKind(run.config?.taskKind);
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
const isTerminalRun = (status?: string) =>
  Boolean(
    status &&
    /^(complete|completed|failed|error|interrupted|stopped|cancelled|canceled|aborted)$/i.test(
      status,
    ),
  );
const eventTimestamp = (event: RunEvent) =>
  event.timestamp || event.createdAt || event.time;
const eventLabel = (event: RunEvent) =>
  event.event || event.stage || event.status || "activity";
const eventMessage = (event: RunEvent) => event.error || event.message;
const sanitizedEventMessage = (event: RunEvent) => {
  const value = eventMessage(event);
  return value
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/(bearer\s+|api[_ -]?key\s*[:=]\s*)\S+/gi, "$1[redacted]")
        .trim()
        .slice(0, 500)
    : "";
};
const eventElapsed = (event: RunEvent) => {
  const value = event.elapsedMs ?? event.elapsed;
  return typeof value === "number" ? `${Math.round(value)} ms` : undefined;
};
const normalizeEvent = (event: RunEvent): RunEvent => {
  const payload = event.payload || {};
  return {
    ...event,
    ...payload,
    id: event.id ?? event.eventId,
    timestamp: event.timestamp || event.createdAt,
    event: event.event || event.type,
  };
};
const legacyAttemptEvents = (attempts?: Json[]): RunEvent[] =>
  Array.isArray(attempts)
    ? attempts.flatMap((value, index) => {
        if (!value || typeof value !== "object") return [];
        const attempt = value as Record<string, unknown>;
        const error = typeof attempt.error === "string" ? attempt.error : "";
        const safeError =
          /(?:prompt|image|messages|content|authorization|api[_-]?key|token)\s*[":=]/i.test(
            error,
          )
            ? "Diagnostic payload redacted."
            : /^(.+?) returned (\d+):/.test(error)
              ? error.replace(/^(.+?) returned (\d+):.*/, "$1 returned $2.")
              : error.slice(0, 500);
        return [
          normalizeEvent({
            id: `attempt-${index}`,
            event: "stage attempt",
            createdAt:
              typeof attempt.startedAt === "string"
                ? attempt.startedAt
                : undefined,
            stage:
              typeof attempt.stage === "string" ? attempt.stage : undefined,
            caseId:
              typeof attempt.caseId === "string" ? attempt.caseId : undefined,
            attempt:
              typeof attempt.attempt === "number" ? attempt.attempt : undefined,
            status:
              typeof attempt.status === "string" ? attempt.status : undefined,
            elapsedMs:
              typeof attempt.elapsedMs === "number"
                ? attempt.elapsedMs
                : undefined,
            error: safeError,
          }),
        ];
      })
    : [];
const metric = (value?: number) =>
  value === undefined ? "—" : `${Math.round(value * 100)}%`;
const ocrSummary = (grade?: Record<string, number | string | boolean>) => {
  if (
    !grade ||
    grade.graded === false ||
    (grade.cer == null && grade.wer == null)
  )
    return "Ungraded";
  const parts = [
    `CER ${typeof grade.cer === "number" ? `${Math.round(grade.cer * 1000) / 10}%` : "—"}`,
    `WER ${typeof grade.wer === "number" ? `${Math.round(grade.wer * 1000) / 10}%` : "—"}`,
  ];
  return parts.join(" · ");
};
const metricValue = (
  key: string,
  value: unknown,
): {
  label: string;
  display: string;
  kind: "percent" | "count" | "ms" | "text";
} | null => {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "passed")
    return {
      label: "Passed cases",
      display: typeof value === "number" ? String(Math.round(value)) : "—",
      kind: "count",
    };
  if (["passrate", "caserate"].includes(normalized))
    return {
      label: "Pass rate",
      display: typeof value === "number" ? metric(value) : "—",
      kind: "percent",
    };
  if (normalized === "costobservations")
    return {
      label: "Cost observations",
      display: typeof value === "number" ? String(Math.round(value)) : "—",
      kind: "count",
    };
  if (["jsonparse", "parsesuccess", "parse"].includes(normalized))
    return {
      label: "JSON parse",
      display: typeof value === "number" ? metric(value) : "—",
      kind: "percent",
    };
  if (["schemacompliant", "schemavalid", "schema"].includes(normalized))
    return {
      label: "Schema compliant",
      display: typeof value === "number" ? metric(value) : "—",
      kind: "percent",
    };
  if (["fieldaccuracy", "accuracy"].includes(normalized))
    return {
      label: "Field accuracy",
      display: typeof value === "number" ? metric(value) : "—",
      kind: "percent",
    };
  if (["ocrcer", "cer"].includes(normalized))
    return {
      label: "OCR CER",
      display:
        typeof value === "number"
          ? `${Math.round(value * 1000) / 10}%`
          : "Ungraded",
      kind: "percent",
    };
  if (["ocrwer", "wer"].includes(normalized))
    return {
      label: "OCR WER",
      display:
        typeof value === "number"
          ? `${Math.round(value * 1000) / 10}%`
          : "Ungraded",
      kind: "percent",
    };
  if (normalized === "meanocrms")
    return {
      label: "Average OCR time",
      display: typeof value === "number" ? `${Math.round(value)} ms` : "—",
      kind: "ms",
    };
  if (normalized.includes("time") || normalized.includes("ms"))
    return {
      label: key
        .replace(/([A-Z])/g, " $1")
        .replace(/ms/i, "")
        .trim(),
      display: typeof value === "number" ? `${Math.round(value)} ms` : "—",
      kind: "ms",
    };
  if (normalized.includes("cost") && normalized.includes("known"))
    return {
      label: "Known cost",
      display:
        value == null
          ? "Unknown"
          : typeof value === "number"
            ? `$${value.toFixed(4)}`
            : "Unknown",
      kind: "text",
    };
  return null;
};
const numericRunMetric = (run: Run, key: string) => {
  const value = run.metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};
const runSampleCount = (run: Run) =>
  Math.max(
    0,
    Math.round(
      numericRunMetric(run, "sampleCount") ??
        run.totalCases ??
        run.caseCount ??
        0,
    ),
  );
const runPassedCount = (run: Run) =>
  Math.max(
    0,
    Math.round(numericRunMetric(run, "passed") ?? run.passedCount ?? 0),
  );
const runCompletedCount = (run: Run) =>
  Math.max(
    0,
    Math.round(
      numericRunMetric(run, "completed") ?? run.caseCount ?? 0,
    ),
  );
const runPassRate = (run: Run) => {
  const value = numericRunMetric(run, "passRate");
  if (value !== undefined) return Math.max(0, Math.min(1, value));
  if (run.inferenceOnly) return undefined;
  const total = runSampleCount(run);
  return total ? runPassedCount(run) / total : undefined;
};
const failedRunStatuses = new Set([
  "failed",
  "error",
  "interrupted",
  "stopped",
  "cancelled",
  "canceled",
  "aborted",
]);
const isOverviewScoredRun = (run: Run) => {
  const status = run.status?.toLowerCase();
  return (
    !run.inferenceOnly &&
    runSampleCount(run) > 0 &&
    runPassRate(run) !== undefined &&
    status !== "running" &&
    status !== "pending" &&
    !failedRunStatuses.has(status || "")
  );
};
const newestRuns = (runs: Run[]) =>
  runs
    .slice()
    .sort(
      (left, right) =>
        (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0),
    );
const runLabel = (run: Run) =>
  [run.datasetName || "Untitled dataset", run.modelName || run.targetName]
    .filter(Boolean)
    .join(" · ");
type RunTone = "pass" | "fail" | "running" | "neutral";
const runOutcome = (run: Run): { label: string; tone: RunTone } => {
  const status = run.status?.toLowerCase() || "";
  if (status === "running" || status === "pending") return { label: "Running", tone: "running" };
  if (failedRunStatuses.has(status))
    return { label: status[0].toUpperCase() + status.slice(1), tone: "fail" };
  if (run.inferenceOnly) return { label: "Outputs saved", tone: "neutral" };
  const rate = runPassRate(run);
  if (rate === undefined) return { label: "Complete", tone: "neutral" };
  return {
    label: `${metric(rate)} passed`,
    tone: rate >= 1 ? "pass" : rate === 0 ? "fail" : "neutral",
  };
};
function RunStatusBadge({ run }: { run: Run }) {
  const outcome = runOutcome(run);
  return <span className={`status-pill ${outcome.tone}`}>{outcome.label}</span>;
}
function AdvancedOptions({
  children,
  changed = 0,
  label = "Advanced options",
  defaultOpen = false,
}: {
  children: ReactNode;
  changed?: number;
  label?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className="advanced-options" open={defaultOpen || undefined}>
      <summary>
        {label}
        {changed > 0 && <span className="advanced-count">{changed} changed</span>}
      </summary>
      <div className="advanced-options-body">{children}</div>
    </details>
  );
}
const SAMPLE_DATASETS: Record<TaskKind, string> = {
  "document-json": "sample-data/manifest.json",
  "text-json": "sample-data/text-json/manifest.json",
  "tool-calling": "sample-data/tool-calling/manifest.json",
};
const importDatasetPath = (datasetPath: string) =>
  api<Dataset>("/api/datasets/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: datasetPath }),
  });
const ADD_DATASET_MODES = [
  ["sample", "⚡", "Quick sample", "One click. Best for learning."],
  ["import", "⇪", "Import a file", "A dataset ZIP, or a JSONL or JSON manifest."],
  ["generate", "✦", "Generate", "A model drafts text or tool-calling cases."],
] as const;
const importDatasetZipFile = (file: File) =>
  api<Dataset>(`/api/datasets/import-zip?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: file,
  });
const schemaFieldsMissing = (schemaText: string, dataset?: Dataset) => {
  const schema = parseEditorJson(schemaText) as { properties?: Record<string, unknown> } | undefined;
  const properties =
    schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties)
      : null;
  const expected = dataset?.cases.find(
    (item) => item.expected && typeof item.expected === "object" && !Array.isArray(item.expected),
  )?.expected as Record<string, unknown> | undefined;
  return properties && expected ? Object.keys(expected).filter((key) => !properties.includes(key)) : [];
};
const datasetHasExpected = (dataset?: Dataset) =>
  Boolean(dataset?.cases.length) && dataset!.cases.every((item) => item.expected !== undefined);
const deltaLabel = (key: string, left: unknown, right: unknown) => {
  if (typeof left !== "number" || typeof right !== "number")
    return "No baseline";
  const lowerIsBetter = /cer|wer|time|ms|cost/i.test(key);
  if (left === right) return "Unchanged";
  const improved = lowerIsBetter ? right < left : right > left;
  return improved ? "Improved" : "Regressed";
};

function App() {
  const [tab, setTab] = useState<Tab>(() => tabFromLocation());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      const preference = window.localStorage.getItem("local-evals-sidebar");
      return preference === "collapsed";
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const morePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    morePanel.current?.querySelector("button")?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButton.current?.focus();
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [moreOpen]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(() => {
    try { return window.localStorage.getItem("local-evals-selected-experiment"); } catch { return null; }
  });
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [comparePair, setComparePair] = useState<[string, string] | null>(null);
  const [selectedCase, setSelectedCase] = useState<CaseResult | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [setup, setSetup] = useState<Setup>({});
  const [activeExecution, setActiveExecution] = useState<ActiveExecution>({
    active: false,
    ownedByDashboard: false,
    canStop: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [runEventsLoading, setRunEventsLoading] = useState(false);
  const [runEventsHint, setRunEventsHint] = useState("");
  const eventCursor = useRef<number | null>(null);
  const openRunRequest = useRef(0);
  const eventRequest = useRef<{
    runId: string;
    generation: number;
    controller: AbortController;
    drain: boolean;
  } | null>(null);
  const eventGeneration = useRef(0);
  const eventRunId = useRef<string | null>(null);
  const fallbackEvents = useRef<RunEvent[]>([]);
  const liveEventsAvailable = useRef(false);
  useEffect(() => {
    const openHelpLink = () => {
      const next = tabFromLocation();
      if (DOC_TABS.includes(next)) setTab(next);
    };
    window.addEventListener("hashchange", openHelpLink);
    return () => window.removeEventListener("hashchange", openHelpLink);
  }, []);
  useEffect(() => {
    const nextHash = tab === "overview" ? "" : `#${tab}`;
    const currentHash = window.location.hash;
    if (
      currentHash !== nextHash &&
      !(DOC_TABS.includes(tab) && currentHash.startsWith(`${nextHash}/`))
    ) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${nextHash}`,
      );
    }
  }, [tab]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "local-evals-sidebar",
        sidebarCollapsed ? "collapsed" : "expanded",
      );
    } catch {
      /* Sidebar preference is best-effort. */
    }
  }, [sidebarCollapsed]);
  const loadRuns = useCallback(async () => {
    try {
      setRuns(await api<Run[]>("/api/runs"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load runs");
    } finally {
      setLoading(false);
    }
  }, []);
  const loadExperiments = useCallback(async () => {
    try {
      const next = await api<Experiment[]>('/api/experiments');
      setExperiments(next);
      setSelectedExperimentId((current) => current && next.some((item) => item.experimentId === current) ? current : null);
    } catch {
      // Older servers may not expose experiments yet.
    }
  }, []);
  useEffect(() => {
    try {
      if (selectedExperimentId) window.localStorage.setItem("local-evals-selected-experiment", selectedExperimentId);
      else window.localStorage.removeItem("local-evals-selected-experiment");
    } catch { /* best effort */ }
  }, [selectedExperimentId]);
  const stopActiveRun = async () => {
    try {
      await api("/api/runs/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await Promise.all([loadActiveExecution(), loadRuns()]);
    } catch (err) {
      setNotice({ message: err instanceof Error ? err.message : "Could not stop evaluation", kind: "error" });
    }
  };
  const loadActiveExecution = useCallback(async () => {
    try {
      setActiveExecution(await api<ActiveExecution>("/api/runs/active"));
    } catch {
      /* keep the last known execution state while the dashboard reconnects */
    }
  }, []);
  useEffect(() => {
    void loadRuns();
    void loadExperiments();
    void loadActiveExecution();
    void api<Dataset[]>("/api/datasets")
      .then(setDatasets)
      .catch(() => undefined);
    void api<Target[]>("/api/targets")
      .then(setTargets)
      .catch(() => undefined);
    void api<Setup>("/api/setup")
      .then(setSetup)
      .catch(() => undefined);
  }, [loadActiveExecution, loadExperiments, loadRuns]);
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadRuns();
      void loadExperiments();
      void loadActiveExecution();
    }, 2500);
    return () => window.clearInterval(id);
  }, [loadActiveExecution, loadExperiments, loadRuns]);
  useEffect(() => {
    const runId = selectedRun?.runId;
    if (!runId) return;
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const detail = await api<RunDetail>(
          `/api/runs/${encodeURIComponent(runId)}`,
        );
        if (stopped) return;
        setSelectedRun(detail);
        setSelectedCase(
          (previous) =>
            detail.cases.find((c) => c.caseId === previous?.caseId) ||
            detail.cases[0] ||
            null,
        );
        if (!isTerminalRun(detail.status))
          timer = window.setTimeout(() => void refresh(), 2500);
      } catch {
        if (!stopped) timer = window.setTimeout(() => void refresh(), 3500);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedRun?.runId]);
  const loadRunEvents = useCallback(
    async (runId: string, reset = false, drain = false) => {
      const previousRequest = eventRequest.current;
      if (previousRequest?.runId === runId) {
        if (drain) previousRequest.drain = true;
        return;
      }
      previousRequest?.controller.abort();
      const generation = ++eventGeneration.current;
      const controller = new AbortController();
      eventRequest.current = { runId, generation, controller, drain };
      if (eventRunId.current !== runId) {
        eventRunId.current = runId;
        eventCursor.current = null;
        liveEventsAvailable.current = false;
        setRunEvents([]);
      }
      if (reset) {
        eventCursor.current = null;
        liveEventsAvailable.current = false;
        setRunEvents([]);
      }
      setRunEventsLoading(true);
      try {
        let firstPage = true;
        let received = 0;
        do {
          const before = eventCursor.current;
          const requestDrain =
            eventRequest.current?.generation === generation &&
            eventRequest.current.drain;
          const query = new URLSearchParams({ limit: "100" });
          if (before !== null) query.set("after", String(before));
          const response = await api<RunEventsResponse>(
            `/api/runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
            { signal: controller.signal },
          );
          if (
            eventGeneration.current !== generation ||
            eventRunId.current !== runId
          )
            return;
          const rawEvents = Array.isArray(response)
            ? response
            : response.events || [];
          const events = rawEvents.map(normalizeEvent);
          received += events.length;
          if (events.length) liveEventsAvailable.current = true;
          const candidate = Array.isArray(response)
            ? events.length
              ? Number(events[events.length - 1].id)
              : before
            : (response.nextAfter ??
              (response.nextCursor || response.nextPageToken
                ? Number(response.nextCursor || response.nextPageToken)
                : events.length
                  ? Number(events[events.length - 1].id)
                  : before));
          const next = Number.isFinite(candidate as number)
            ? (candidate as number)
            : before;
          setRunEvents((previous) => {
            const incoming = events.length ? events : fallbackEvents.current;
            const combined =
              reset && firstPage ? incoming : [...previous, ...events];
            const seen = new Set<string>();
            return combined.filter((event) => {
              const key = String(
                event.id ??
                  `${eventTimestamp(event)}-${eventLabel(event)}-${event.caseId || ""}-${sanitizedEventMessage(event)}`,
              );
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          });
          eventCursor.current = next;
          firstPage = false;
          const shouldDrain =
            eventRequest.current?.generation === generation &&
            eventRequest.current.drain;
          const drainWasUpgraded = shouldDrain && !requestDrain;
          if (
            !shouldDrain ||
            (!events.length && !drainWasUpgraded) ||
            (next === before && !drainWasUpgraded)
          )
            break;
        } while (true);
        setRunEventsHint(
          received || liveEventsAvailable.current
            ? ""
            : fallbackEvents.current.length
              ? "Live event log unavailable; showing persisted attempt activity instead."
              : "No activity has been recorded yet.",
        );
      } catch (e) {
        if (controller.signal.aborted) return;
        if (fallbackEvents.current.length) setRunEvents(fallbackEvents.current);
        setRunEventsHint(
          liveEventsAvailable.current
            ? ""
            : fallbackEvents.current.length
              ? "Live event log unavailable; showing persisted attempt activity instead."
              : `Activity log unavailable: ${e instanceof Error ? e.message : "could not load events"}`,
        );
      } finally {
        if (eventRequest.current?.generation === generation) {
          eventRequest.current = null;
          setRunEventsLoading(false);
        }
      }
    },
    [],
  );
  useEffect(() => {
    if (!selectedRun) {
      setRunEvents([]);
      setRunEventsHint("");
      liveEventsAvailable.current = false;
      return;
    }
    if (selectedRun.events?.length) {
      fallbackEvents.current = selectedRun.events.map(normalizeEvent);
      setRunEvents(fallbackEvents.current);
      setRunEventsHint("");
    } else {
      fallbackEvents.current = legacyAttemptEvents(selectedRun.attempts);
      if (fallbackEvents.current.length) setRunEvents(fallbackEvents.current);
    }
    const runChanged = eventRunId.current !== selectedRun.runId;
    void loadRunEvents(
      selectedRun.runId,
      runChanged,
      isTerminalRun(selectedRun.status),
    );
    if (isTerminalRun(selectedRun.status)) return;
    const id = window.setInterval(
      () => void loadRunEvents(selectedRun.runId),
      2500,
    );
    return () => window.clearInterval(id);
  }, [loadRunEvents, selectedRun?.runId, selectedRun?.status]);
  const changeTab = (next: Tab) => {
    if (setupBusy && next !== "setup") return;
    openRunRequest.current += 1;
    setTab(next);
    setMoreOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(".content h2, .content [data-view-heading]")
        ?.focus(),
    );
  };
  const openRun = async (runId: string) => {
    const request = ++openRunRequest.current;
    try {
      const detail = await api<RunDetail>(
        `/api/runs/${encodeURIComponent(runId)}`,
      );
      if (request !== openRunRequest.current) return;
      setSelectedRun(detail);
      setSelectedCase(
        (previous) =>
          detail.cases.find((c) => c.caseId === previous?.caseId) ||
          detail.cases[0] ||
          null,
      );
      setTab("runs");
    } catch (e) {
      if (request !== openRunRequest.current) return;
      setError(e instanceof Error ? e.message : "Could not load run");
    }
  };
  const latest = newestRuns(runs)[0];
  const passRate =
    latest &&
    !latest.inferenceOnly &&
    latest.caseCount &&
    latest.passedCount != null
      ? latest.passedCount / latest.caseCount
      : undefined;
  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            LE
          </span>
          <h1>Local Evals</h1>
        </div>
        <div className="top-actions">
          <span className="connection">
            <i /> Local workspace
          </span>
          <div className="theme-toggle" role="radiogroup" aria-label="Color theme">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={theme === option.value}
                aria-label={option.label}
                title={option.label}
                onClick={() => setTheme(option.value)}
              >
                <span aria-hidden="true">{option.icon}</span>
              </button>
            ))}
          </div>
          <button
            className="icon-btn"
            aria-label="Refresh runs"
            onClick={() => {
              setLoading(true);
              void loadRuns();
            }}
          >
            ↻
          </button>
        </div>
      </header>
      <div className="layout">
        <nav id="workspace-sidebar" className="sidebar" aria-label="Workspace">
          <button
            className="sidebar-toggle sidebar-rail-toggle"
            type="button"
            aria-label={
              sidebarCollapsed ? "Show navigation" : "Hide navigation"
            }
            aria-expanded={!sidebarCollapsed}
            aria-controls="workspace-sidebar"
            title={sidebarCollapsed ? "Show navigation" : "Hide navigation"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{sidebarCollapsed ? "»" : "«"}</span>
            <span className="sr-only">
              {sidebarCollapsed ? "Show navigation" : "Hide navigation"}
            </span>
          </button>
          {NAV_GROUPS.map((group) => (
            <div
              key={group.id}
              className={`nav-group nav-group-${group.id}`}
              role="group"
              aria-labelledby={group.label ? `nav-group-${group.id}` : undefined}
              aria-label={group.label ? undefined : "Home"}
            >
              {group.label && (
                <div className="nav-label" id={`nav-group-${group.id}`}>
                  {group.label}
                </div>
              )}
              {group.tabs.map((item) => (
                <button
                  className={tab === item ? "nav-item active" : "nav-item"}
                  aria-current={tab === item ? "page" : undefined}
                  disabled={setupBusy && item !== "setup"}
                  onClick={() => changeTab(item)}
                  key={item}
                >
                  {tabLabel(item)}
                  {item === "runs" && runs.some((r) => r.status === "running") ? (
                    <b className="live-dot" />
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          <div className="sidebar-footer">
            <span className="version">
              LOCAL EVALS <b>V0.1</b>
            </span>
            <span>Local dashboard runner</span>
          </div>
        </nav>
        <main className={`content view-${tab}`}>
          {error && (
            <div className="alert error" role="alert" aria-live="assertive">
              <strong>Couldn’t load that view.</strong> {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div
              className={`alert ${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {notice.message}
              <button
                aria-label="Dismiss notice"
                onClick={() => setNotice(null)}
              >
                ×
              </button>
            </div>
          )}
          {activeExecution.active && (() => {
            const activeRun = runs.find((run) => run.runId === activeExecution.runId);
            const total = activeRun ? runSampleCount(activeRun) : 0;
            const done = activeRun ? runCompletedCount(activeRun) : 0;
            const viewing = tab === "runs" && selectedRun?.runId === activeExecution.runId;
            const title =
              activeExecution.phase === "starting"
                ? "Starting evaluation…"
                : activeExecution.phase === "stopping"
                  ? "Stopping evaluation…"
                  : activeExecution.ownedByDashboard
                    ? "Evaluation running"
                    : "Evaluation running from a terminal";
            return (
              <div className="alert running-banner" role="status" aria-live="polite">
                <span className="live-dot" aria-hidden="true" />
                <span className="running-banner-copy">
                  <strong>{title}</strong>
                  <span>
                    {activeRun ? runLabel(activeRun) : "Preparing cases"}
                    {total > 0 && ` · ${done} of ${total} cases`}
                    {!activeExecution.ownedByDashboard && " · stop it from that terminal"}
                  </span>
                </span>
                {total > 0 && (
                  <span className="running-banner-progress" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
                  </span>
                )}
                <span className="running-banner-actions">
                  {!viewing && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={setupBusy}
                      onClick={() => {
                        if (activeExecution.runId) void openRun(activeExecution.runId);
                        else changeTab("runs");
                      }}
                    >
                      View progress
                    </button>
                  )}
                  {activeExecution.canStop && (
                    <button
                      type="button"
                      className="text-button destructive"
                      disabled={activeExecution.phase === "stopping"}
                      onClick={() => void stopActiveRun()}
                    >
                      Stop
                    </button>
                  )}
                </span>
              </div>
            );
          })()}
          {tab === "overview" && (
            <Overview
              runs={runs}
              latest={latest}
              loading={loading}
              hasTargets={targets.length > 0}
              hasDatasets={datasets.length > 0}
              onRun={openRun}
              onTab={changeTab}
            />
          )}
          {tab === "runs" && (
            <Runs
              runs={runs}
              loading={loading}
              selected={selectedRun}
              selectedCase={selectedCase}
              events={runEvents}
              eventsLoading={runEventsLoading}
              eventsHint={runEventsHint}
              onOpen={openRun}
              onCase={setSelectedCase}
              onTab={changeTab}
            />
          )}
          {tab === "experiments" && (
            <Experiments
              experiments={experiments}
              runs={runs}
              selectedId={selectedExperimentId}
              onSelect={setSelectedExperimentId}
              onOpenRun={openRun}
              onRefresh={async () => { await Promise.all([loadExperiments(), loadRuns()]); }}
              onNotice={(message, kind = "success") => setNotice({ message, kind })}
              onNewRun={(experimentId) => {
                setSelectedExperimentId(experimentId);
                changeTab("setup");
              }}
              onCompare={(left, right) => {
                setComparePair([left, right]);
                changeTab("compare");
              }}
            />
          )}
          {tab === "datasets" && (
            <Datasets
              datasets={datasets}
              targets={targets}
              onRefresh={async () =>
                setDatasets(await api<Dataset[]>("/api/datasets"))
              }
            />
          )}
          {tab === "targets" && (
            <Targets
              targets={targets}
              setTargets={setTargets}
              onNotice={(message, kind = "success") =>
                setNotice({ message, kind })
              }
            />
          )}
          {tab === "compare" && (
            <Compare runs={runs} preferredRun={selectedRun?.runId} preferredPair={comparePair} />
          )}
          {tab === "help" && <Help onTab={changeTab} />}
          {tab === "cli" && <CliHelp onTab={changeTab} />}
          {tab === "setup" && (
            <SetupPanel
              setup={setup}
              experiments={experiments}
              selectedExperimentId={selectedExperimentId}
              onSelectExperiment={setSelectedExperimentId}
              onCreateExperiment={async (name) => {
                const created = await api<Experiment>('/api/experiments', {
                  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
                });
                setExperiments((current) => [...current, created]);
                setSelectedExperimentId(created.experimentId);
                return created;
              }}
              targets={targets}
              datasets={datasets}
              activeExecution={activeExecution}
              onRefreshRuns={async () => {
                await Promise.all([loadRuns(), loadActiveExecution()]);
              }}
              onSaved={setSetup}
              onNotice={(message, kind = "success") =>
                setNotice({ message, kind })
              }
              onOpenRun={openRun}
              onBusyChange={setSetupBusy}
              setTargets={setTargets}
              onRefreshDatasets={async () => setDatasets(await api<Dataset[]>("/api/datasets"))}
            />
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile workspace">
        {moreOpen && (
          <div className="mobile-more" id="mobile-more" ref={morePanel}>
            {NAV_GROUPS.map((group) => {
              const items = group.tabs.filter((item) => !MOBILE_PRIMARY_TABS.includes(item));
              return items.length ? (
                <div key={group.id} className="mobile-more-group">
                  <span className="eyebrow">{group.label}</span>
                  {items.map((value) => (
                    <button
                      key={value}
                      aria-current={tab === value ? "page" : undefined}
                      disabled={setupBusy}
                      onClick={() => changeTab(value)}
                    >
                      <span className={`nav-icon icon-${value}`} aria-hidden="true" />
                      {tabLabel(value)}
                    </button>
                  ))}
                </div>
              ) : null;
            })}
          </div>
        )}
        {MOBILE_PRIMARY_TABS.map((value) => (
          <button
            key={value}
            aria-current={tab === value ? "page" : undefined}
            disabled={setupBusy && value !== "setup"}
            onClick={() => changeTab(value)}
          >
            <span className={`nav-icon icon-${value}`} aria-hidden="true" />
            {tabLabel(value)}
          </button>
        ))}
        <button
          ref={moreButton}
          aria-expanded={moreOpen}
          aria-controls="mobile-more"
          aria-current={!MOBILE_PRIMARY_TABS.includes(tab) ? "page" : undefined}
          disabled={setupBusy}
          onClick={() => setMoreOpen(!moreOpen)}
        >
          <span className="nav-icon" aria-hidden="true">
            {moreOpen ? "×" : "•••"}
          </span>
          {moreOpen ? "Close" : "More"}
        </button>
      </nav>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function PassRateTrend({
  runs,
  onRun,
}: {
  runs: Run[];
  onRun: (id: string) => void;
}) {
  const width = 360;
  const height = 148;
  const left = 30;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const points = runs.map((run, index) => {
    const value = runPassRate(run) ?? 0;
    return {
      run,
      value,
      x:
        runs.length === 1
          ? left + plotWidth / 2
          : left + (plotWidth * index) / (runs.length - 1),
      y: top + (1 - value) * plotHeight,
    };
  });
  return (
    <>
      {points.length ? (
        <>
          <div className="analytics-chart-wrap">
            <svg
              className="analytics-chart"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="Pass rate by recent scored run"
            >
              <title>Pass rate by run</title>
              <desc>
                Recent scored runs shown as independent bars. Inference-only and
                failed runs are excluded.
              </desc>
              {[0, 0.5, 1].map((value) => {
                const y = top + (1 - value) * plotHeight;
                return (
                  <g key={value}>
                    <line
                      className="analytics-chart-grid"
                      x1={left}
                      x2={width - right}
                      y1={y}
                      y2={y}
                    />
                    <text className="analytics-chart-label" x="0" y={y + 4}>
                      {Math.round(value * 100)}%
                    </text>
                  </g>
                );
              })}
              {points.map((point) => (
                <g key={point.run.runId}>
                  <rect
                    className="analytics-chart-bar"
                    x={point.x - Math.min(16, plotWidth / Math.max(points.length * 2, 2))}
                    y={point.y}
                    width={Math.min(32, plotWidth / Math.max(points.length * 1.5, 1))}
                    height={top + plotHeight - point.y}
                    rx="1"
                    role="button"
                    tabIndex={0}
                    aria-label={`${runLabel(point.run)}, ${date(point.run.createdAt)}: ${metric(point.value)} passed`}
                    onClick={() => onRun(point.run.runId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRun(point.run.runId);
                      }
                    }}
                  />
                  <title>
                    {runLabel(point.run)} · {date(point.run.createdAt)} · {metric(point.value)}
                  </title>
                </g>
              ))}
            </svg>
          </div>
        </>
      ) : (
        <div className="analytics-empty">
          <strong>Scored run data will appear here</strong>
          <span>Inference-only and incomplete runs are excluded from this trend.</span>
        </div>
      )}
    </>
  );
}
function Overview({
  runs,
  latest,
  loading,
  hasTargets,
  hasDatasets,
  onRun,
  onTab,
}: {
  runs: Run[];
  latest?: Run;
  loading: boolean;
  hasTargets: boolean;
  hasDatasets: boolean;
  onRun: (id: string) => void;
  onTab: (tab: Tab) => void;
}) {
  const orderedRuns = newestRuns(runs);
  const trendRuns = orderedRuns.filter(isOverviewScoredRun).slice(0, 8).reverse();
  const latestRun = latest ?? orderedRuns[0];
  const steps: { done: boolean; title: string; text: string; tab: Tab; action: string }[] = [
    { done: hasTargets, title: "Connect a model", text: "A local server or a cloud provider.", tab: "targets", action: "Add model" },
    { done: hasDatasets, title: "Add a dataset", text: "Start with a sample, or import your cases.", tab: "datasets", action: "Add dataset" },
    { done: runs.length > 0, title: "Run an evaluation", text: "The guided setup walks you through it.", tab: "setup", action: "Set up a run" },
  ];
  const nextStep = steps.find((item) => !item.done);
  const outcome = latestRun ? runOutcome(latestRun) : undefined;
  const latestRate = latestRun ? runPassRate(latestRun) : undefined;
  return (
    <>
      <PageTitle
        eyebrow="OVERVIEW"
        title="Overview"
        sub="Your latest results at a glance."
        action={
          <button className="button primary" onClick={() => onTab("setup")}>
            New evaluation <span aria-hidden="true">→</span>
          </button>
        }
      />
      {loading ? (
        <Loading />
      ) : (
        <>
          {nextStep && (
            <section className="panel getting-started" aria-labelledby="getting-started-title">
              <div className="panel-head">
                <div>
                  <h3 id="getting-started-title">Get started</h3>
                  <p>Three steps to your first result.</p>
                </div>
              </div>
              <ol className="checklist">
                {steps.map((item) => (
                  <li key={item.title} className={item.done ? "done" : item === nextStep ? "current" : undefined}>
                    <span className="checklist-mark" aria-hidden="true">
                      {item.done ? "✓" : steps.indexOf(item) + 1}
                    </span>
                    <span className="checklist-copy">
                      <strong>{item.title}</strong>
                      <span>{item.done ? "Done" : item.text}</span>
                    </span>
                    {!item.done && (
                      <button
                        type="button"
                        className={item === nextStep ? "button primary" : "button secondary"}
                        onClick={() => onTab(item.tab)}
                      >
                        {item.action}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {latestRun && outcome && (
            <section className="overview-grid">
              <article className="panel latest-run" aria-labelledby="latest-run-title">
                <span className="eyebrow">LATEST RUN</span>
                <h3 id="latest-run-title">{runLabel(latestRun)}</h3>
                <p className="latest-run-meta">
                  {TASK_KIND_LABELS[asTaskKind(latestRun.taskKind)]} · {date(latestRun.createdAt)}
                  {latestRun.experimentName ? ` · ${latestRun.experimentName}` : ""}
                </p>
                <div className="latest-run-score">
                  <strong className={`tone-${outcome.tone}`}>
                    {latestRun.inferenceOnly || latestRate === undefined ? "—" : metric(latestRate)}
                  </strong>
                  <span>
                    {latestRun.inferenceOnly
                      ? `${runCompletedCount(latestRun)} outputs saved, not scored`
                      : latestRate === undefined
                        ? outcome.label
                        : `${runPassedCount(latestRun)} of ${runSampleCount(latestRun)} cases passed`}
                  </span>
                </div>
                <div className="latest-run-actions">
                  <RunStatusBadge run={latestRun} />
                  <button type="button" className="button secondary" onClick={() => onRun(latestRun.runId)}>
                    Open run
                  </button>
                </div>
              </article>
              <section className="panel trend-panel">
                <div className="panel-head">
                  <div>
                    <h3>Pass rate by run</h3>
                    <p>Recent graded runs. Select a bar to open it.</p>
                  </div>
                </div>
                {trendRuns.length ? (
                  <PassRateTrend runs={trendRuns} onRun={onRun} />
                ) : (
                  <div className="analytics-empty analytics-empty-compact">
                    <strong>No graded runs yet</strong>
                    <span>Runs with expected answers will appear here.</span>
                  </div>
                )}
              </section>
            </section>
          )}
          {runs.length > 0 && (
            <section className="panel recent">
              <div className="panel-head">
                <div>
                  <h3>Recent runs</h3>
                </div>
                <button className="text-button" onClick={() => onTab("runs")}>
                  View all runs →
                </button>
              </div>
              <div className="recent-runs">
                {orderedRuns.slice(0, 5).map((run) => (
                  <button key={run.runId} type="button" className="recent-run" onClick={() => onRun(run.runId)}>
                    <span>
                      <strong>{runLabel(run)}</strong>
                      <small>
                        {date(run.createdAt)}
                        {run.experimentName ? ` · ${run.experimentName}` : ""}
                      </small>
                    </span>
                    <RunStatusBadge run={run} />
                    <span className="row-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
function Runs({
  runs,
  loading,
  selected,
  selectedCase,
  events,
  eventsLoading,
  eventsHint,
  onOpen,
  onCase,
  onTab,
}: {
  runs: Run[];
  loading: boolean;
  selected: RunDetail | null;
  selectedCase: CaseResult | null;
  events: RunEvent[];
  eventsLoading: boolean;
  eventsHint: string;
  onOpen: (id: string) => void;
  onCase: (c: CaseResult | null) => void;
  onTab: (t: Tab) => void;
}) {
  return (
    <div className="runs-layout" tabIndex={-1} data-view-heading="runs">
      <section className="panel run-list" aria-label="Runs">
        <header className="run-list-header">
          <div>
            <span className="eyebrow">RUNS</span>
            <h2 tabIndex={-1}>{runs.length}</h2>
            <span className="run-list-count">
              run{runs.length === 1 ? "" : "s"}
            </span>
          </div>
          <button className="button secondary" onClick={() => onTab("setup")}>
            New run
          </button>
        </header>
        <div className="run-list-body">
          {loading ? (
            <Loading />
          ) : runs.length ? (
            <>
              <label className="mobile-run-picker">
                Select run
                <select
                  value={selected?.runId || ""}
                  onChange={(e) => {
                    if (e.target.value) onOpen(e.target.value);
                  }}
                >
                  <option value="">Select a run</option>
                  {runs.map((r) => (
                    <option key={r.runId} value={r.runId}>
                      {runLabel(r)} · {date(r.createdAt)} · {runOutcome(r).label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="run-history-items">
                {runs.map((r) => (
                  <button
                    type="button"
                    className={
                      selected?.runId === r.runId
                        ? "run-row selected"
                        : "run-row"
                    }
                    key={r.runId}
                    onClick={() => onOpen(r.runId)}
                    aria-pressed={selected?.runId === r.runId}
                  >
                    <span className="run-row-main">
                      <strong className="run-name" title={`Run ${r.runId}`}>
                        {runLabel(r)}
                      </strong>
                      {r.experimentName && <span className="run-row-experiment">{r.experimentName}</span>}
                      <time dateTime={r.createdAt}>{date(r.createdAt)}</time>
                    </span>
                    <span className={`run-row-status ${runOutcome(r).tone}`}>
                      {runOutcome(r).label}
                    </span>
                    <span className="run-count" title="Passed cases">
                      {r.inferenceOnly
                        ? "inference only"
                        : `${r.passedCount}/${r.caseCount}`}
                    </span>
                    <span className="row-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <Empty
              icon="◎"
              title="No runs"
              text="Open Setup to start your first evaluation."
            />
          )}
        </div>
      </section>
      {selected ? (
        <Inspector
          run={selected}
          item={selectedCase}
          events={events}
          eventsLoading={eventsLoading}
          eventsHint={eventsHint}
          onCase={onCase}
          onTab={onTab}
        />
      ) : (
        <section
          className="panel inspector-placeholder"
          aria-label="Run inspector"
        >
          <span className="placeholder-icon" aria-hidden="true">
            ⌁
          </span>
          <h3>Select a run</h3>
          <p>Open a run to inspect its cases, output, timing, and activity.</p>
        </section>
      )}
    </div>
  );
}

function caseStatus(caseResult: CaseResult): {
  label: string;
  tone: "pass" | "fail" | "error" | "neutral";
} {
  if (caseResult.error) return { label: "Error", tone: "error" };
  if (caseResult.grade?.passed === true)
    return { label: "Passed", tone: "pass" };
  if (caseResult.grade?.passed === false)
    return { label: "Failed", tone: "fail" };
  return { label: "Unscored", tone: "neutral" };
}

function Inspector({
  run,
  item,
  events,
  eventsLoading,
  eventsHint,
  onCase,
  onTab,
}: {
  run: RunDetail;
  item: CaseResult | null;
  events: RunEvent[];
  eventsLoading: boolean;
  eventsHint: string;
  onCase: (c: CaseResult | null) => void;
  onTab: (tab: Tab) => void;
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [caseQuery, setCaseQuery] = useState("");
  useEffect(() => {
    setCaseQuery("");
    setFailedOnly(false);
  }, [run.runId]);
  const visibleCases = run.cases.filter(
    (c) =>
      (!failedOnly || c.error || c.grade?.passed === false) &&
      c.caseId.toLowerCase().includes(caseQuery.trim().toLowerCase()),
  );
  const caseIndex = visibleCases.findIndex((c) => c.caseId === item?.caseId);
  useEffect(() => {
    if (!visibleCases.length) {
      if (item) onCase(null);
      return;
    }
    if (!item || !visibleCases.some((c) => c.caseId === item.caseId))
      onCase(visibleCases[0]);
  }, [failedOnly, item, onCase, visibleCases]);
  const selectedStatus = item ? caseStatus(item) : null;
  const previousCase = caseIndex > 0 ? visibleCases[caseIndex - 1] : null;
  const nextCase =
    caseIndex >= 0 && caseIndex < visibleCases.length - 1
      ? visibleCases[caseIndex + 1]
      : null;
  return (
    <section className="inspector">
      <div className="inspector-workspace">
        <aside className="case-picker" aria-label="Browse cases">
          <div className="case-picker-head">
            <div>
              <span className="eyebrow">CASES</span>
              <h3>{visibleCases.length}</h3>
            </div>
            <span
              className="case-result-count"
              role="status"
              aria-live="polite"
            >
              of {run.cases.length}
            </span>
          </div>
          <div className="case-filter-row">
            <label>
              <span className="sr-only">Find a case</span>
              <input
                type="search"
                value={caseQuery}
                onChange={(e) => setCaseQuery(e.target.value)}
                placeholder="Filter case IDs"
              />
            </label>
            <label className="case-failed-filter">
              <input
                type="checkbox"
                checked={failedOnly}
                onChange={(e) => setFailedOnly(e.target.checked)}
              />{" "}
              Failed (
              {
                run.cases.filter((c) => c.error || c.grade?.passed === false)
                  .length
              }
              )
            </label>
          </div>
          {visibleCases.length ? (
            <div className="case-browser">
              <div className="case-table-shell">
                <div
                  className="case-list"
                  role="list"
                  aria-label="Cases in this run"
                >
                  {visibleCases.map((candidate, index) => {
                    const status = caseStatus(candidate);
                    const selected = candidate.caseId === item?.caseId;
                    return (
                      <button
                        type="button"
                        id={`run-case-${candidate.caseId}`}
                        className={`case-list-item${selected ? " selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => onCase(candidate)}
                        key={candidate.caseId}
                      >
                        <span className="case-list-index">{index + 1}</span>
                        <span className="case-list-copy">
                          <strong title={candidate.caseId}>
                            {candidate.caseId}
                          </strong>
                          {candidate.error && (
                            <small title={candidate.error}>
                              {candidate.error}
                            </small>
                          )}
                        </span>
                        <span className={`case-status ${status.tone}`}>
                          {status.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="case-selection-controls">
                  <label className="case-select-fallback">
                    <span className="sr-only">Selected case</span>
                    <select
                      value={caseIndex >= 0 ? item!.caseId : ""}
                      disabled={!visibleCases.length}
                      onChange={(e) =>
                        onCase(
                          visibleCases.find(
                            (c) => c.caseId === e.target.value,
                          ) || null,
                        )
                      }
                    >
                      {visibleCases.map((c, i) => (
                        <option value={c.caseId} key={c.caseId}>
                          {i + 1}. {c.caseId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="case-pagination" role="status">
                    {caseIndex >= 0 ? caseIndex + 1 : 0} of{" "}
                    {visibleCases.length}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="case-filter-empty" role="status">
              {run.cases.length
                ? "No cases match the current filters."
                : "This run has not produced any case results yet."}
            </div>
          )}
        </aside>
        <div className="case-detail-pane">
          <header className="inspector-head case-detail-toolbar">
            <div>
              <span className="eyebrow">RUN {run.runId.slice(0, 12)}</span>
              <div className="case-detail-title">
                <h2 tabIndex={-1} title={item?.caseId}>
                  {item?.caseId || "Select a case"}
                </h2>
                {item?.error ? (
                  <FailureChip
                    key={`${run.runId}:${item.caseId}`}
                    error={item.error}
                    context="Case"
                    label="Error"
                  />
                ) : selectedStatus ? (
                  <span
                    className={`status-pill ${selectedStatus.tone === "error" ? "fail" : selectedStatus.tone}`}
                  >
                    {selectedStatus.label}
                  </span>
                ) : !run.error ? (
                  <span className="status-pill neutral">
                    {run.status || "Complete"}
                  </span>
                ) : null}
                {run.error && (
                  <FailureChip
                    key={run.runId}
                    error={run.error}
                    context="Run"
                    label={item ? "Run failed" : "Failed"}
                  />
                )}
              </div>
              <span className="case-detail-run-meta">
                {run.status || "Complete"} · {date(run.createdAt)}
              </span>
            </div>
            <div className="case-toolbar-actions">
              <div
                className="case-toolbar-navigation"
                aria-label="Case navigation"
              >
                <button
                  type="button"
                  className="button secondary"
                  disabled={!previousCase}
                  onClick={() => previousCase && onCase(previousCase)}
                >
                  ← Prev
                </button>
                <span
                  className="case-toolbar-position"
                  role="status"
                  aria-live="polite"
                >
                  {caseIndex >= 0 ? caseIndex + 1 : 0}/{visibleCases.length}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!nextCase}
                  onClick={() => nextCase && onCase(nextCase)}
                >
                  Next →
                </button>
              </div>
              <button className="text-button" onClick={() => onTab("setup")}>
                Setup
              </button>
              <a
                href={`/api/runs/${encodeURIComponent(run.runId)}/export?format=json`}
                download
                className="export-link"
              >
                JSON ↓
              </a>
              <a
                href={`/api/runs/${encodeURIComponent(run.runId)}/export?format=markdown`}
                download
                className="export-link"
              >
                Markdown ↓
              </a>
              <button
                className="button primary"
                onClick={() => onTab("compare")}
              >
                Compare
              </button>
            </div>
          </header>
          {item ? (
            <CaseView
              run={run}
              item={item}
              events={events}
              eventsLoading={eventsLoading}
              eventsHint={eventsHint}
            />
          ) : (
            <div className="case-detail-empty">
              <Empty
                icon="□"
                title={
                  run.cases.length ? "No matching cases" : "No case results"
                }
                text={
                  run.cases.length
                    ? "Clear the search or turn off Failed only to see more cases."
                    : "This run has not produced any case results yet."
                }
              />
              <RunActivity
                events={events}
                loading={eventsLoading}
                hint={eventsHint}
              />
              <details className="run-details empty-run-metadata">
                <summary>Metadata · snapshot & attempts</summary>
                <pre tabIndex={0} aria-label="Run snapshot and attempts">
                  <HighlightedJson
                    text={pretty({
                      snapshot: run.snapshot,
                      attempts: run.attempts,
                      config: run.config,
                    })}
                  />
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
function RunActivity({
  events,
  loading,
  hint,
}: {
  events: RunEvent[];
  loading: boolean;
  hint: string;
}) {
  return (
    <section className="run-activity" aria-label="Run activity">
      <div className="run-activity-head">
        <div>
          <h4>Execution log</h4>
          <p>Live runner activity and retry history</p>
        </div>
        {loading && <span className="activity-live">UPDATING</span>}
      </div>
      {hint && <p className="activity-hint">{hint}</p>}
      {events.length ? (
        <div
          className="activity-list"
          tabIndex={0}
          aria-label="Execution log entries"
        >
          {events.map((event, index) => {
            const level = (event.level || event.status || "info").toLowerCase();
            return (
              <div
                className={`activity-row activity-${level}`}
                key={String(event.id ?? index)}
              >
                <span className="activity-time">
                  {date(eventTimestamp(event))}
                </span>
                <span className="activity-dot" aria-hidden="true" />
                <div className="activity-content">
                  <div className="activity-meta">
                    <strong>{eventLabel(event)}</strong>
                    {event.caseId && <code>{event.caseId}</code>}
                    {event.attempt != null && (
                      <span>attempt {event.attempt}</span>
                    )}
                    {event.retry != null && <span>retry {event.retry}</span>}
                    {eventElapsed(event) && <span>{eventElapsed(event)}</span>}
                  </div>
                  {sanitizedEventMessage(event) && (
                    <p className="activity-message">
                      {sanitizedEventMessage(event)}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        !hint && (
          <p className="activity-hint">
            {loading
              ? "Loading activity…"
              : "No activity has been recorded yet."}
          </p>
        )
      )}
    </section>
  );
}
function FailureChip({
  error,
  context,
  label,
}: {
  error: string;
  context: string;
  label: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const friendly = describeRunError(error);
  return (
    <>
      <button
        type="button"
        className="status-pill fail failure-chip"
        aria-haspopup="dialog"
        aria-label={`Show ${context.toLowerCase()} failure details`}
        title={`Show ${context.toLowerCase()} failure details`}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        className="failure-dialog"
        aria-label={`${context} failure details`}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <header className="failure-dialog-head">
          <strong>
            {context}: {friendly.title}
          </strong>
          <button
            type="button"
            className="button secondary"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </header>
        <div className="run-error-notice">
          <p>{friendly.message}</p>
          <p>{friendly.action}</p>
          <details>
            <summary>Technical details</summary>
            <pre tabIndex={0} aria-label={`${context} error details`}>
              <HighlightedJson text={error} />
            </pre>
          </details>
        </div>
      </dialog>
    </>
  );
}

function ZoomableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setFailed(false);
    setOpen(false);
    setZoom(1);
  }, [src]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.current?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
  if (failed)
    return <span className="muted image-unavailable">Image unavailable</span>;
  return (
    <>
      <button
        type="button"
        className={`image-zoom-trigger ${className ? "thumbnail-trigger" : ""}`}
        aria-label={`Zoom ${alt}`}
        onClick={() => {
          setZoom(1);
          setOpen(true);
        }}
      >
        <img
          src={src}
          alt={alt}
          className={className}
          onError={() => {
            setFailed(true);
            setOpen(false);
          }}
        />
      </button>
      <dialog
        ref={dialog}
        className="image-zoom-dialog"
        aria-label={`Image viewer: ${alt}`}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="image-zoom-shell">
          <div className="image-zoom-toolbar">
            <strong>{alt}</strong>
            <div className="image-zoom-controls">
              <button
                type="button"
                className="button secondary"
                aria-label="Zoom out"
                disabled={zoom <= 1}
                onClick={() => setZoom(Math.max(1, zoom - 0.5))}
              >
                −
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setZoom(1)}
                aria-label="Reset image zoom"
              >
                {zoom === 1 ? "Fit" : `${zoom}×`}
              </button>
              <button
                type="button"
                className="button secondary"
                aria-label="Zoom in"
                disabled={zoom >= 4}
                onClick={() => setZoom(Math.min(4, zoom + 0.5))}
              >
                +
              </button>
              <button
                type="button"
                className="button secondary"
                autoFocus
                onClick={() => dialog.current?.close()}
              >
                Close
              </button>
            </div>
          </div>
          <p className="image-zoom-help">
            Zoom in for detail. Scroll to explore the enlarged image.
          </p>
          <div
            className="image-zoom-stage"
            tabIndex={0}
            aria-label="Zoomed document image"
          >
            {open && (
              <img
                src={src}
                alt={alt}
                style={{
                  width: zoom === 1 ? "auto" : `${zoom * 100}%`,
                  maxWidth: zoom === 1 ? "100%" : "none",
                  maxHeight: zoom === 1 ? "100%" : "none",
                  height: "auto",
                }}
              />
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}

function CaseView({
  run,
  item,
  events,
  eventsLoading,
  eventsHint,
}: {
  run: RunDetail;
  item: CaseResult;
  events: RunEvent[];
  eventsLoading: boolean;
  eventsHint: string;
}) {
  const image = `/api/runs/${encodeURIComponent(run.runId)}/cases/${encodeURIComponent(item.caseId)}/image`;
  const failures = item.grade?.failures || [];
  const taskKind = runTaskKind(run);
  const isDocumentWorkflow = taskKind === "document-json";
  const isToolWorkflow = taskKind === "tool-calling";
  const hasImage = isDocumentWorkflow && Boolean(item.imagePath);
  const proposedToolCalls = displayToolCalls(item);
  const actualOutput = isToolWorkflow
    ? proposedToolCalls
    : (item.parsedJson ?? item.rawExtraction);
  const firstTab: CaseTab = isDocumentWorkflow
    ? "transcription"
    : "input-output";
  const [activeTab, setActiveTab] = useState<CaseTab>(firstTab);
  useEffect(() => {
    setActiveTab(firstTab);
  }, [firstTab, run.runId]);
  const tabOptions: { id: CaseTab; label: string }[] = [
    {
      id: firstTab,
      label: isDocumentWorkflow ? "Transcription" : "Output",
    },
    { id: "json", label: "JSON" },
    { id: "execution", label: `Execution (${events.length})` },
    { id: "timing", label: "Timing & judge" },
    { id: "metadata", label: "Metadata" },
  ];
  const caseKey = item.caseId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const panelId = `case-panel-${caseKey}`;
  const tabId = (id: CaseTab) => `case-tab-${caseKey}-${id}`;
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ) || [],
    );
    const currentIndex = buttons.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (currentIndex +
              (event.key === "ArrowRight" ? 1 : -1) +
              buttons.length) %
            buttons.length;
    buttons[nextIndex]?.focus();
    const nextTab = tabOptions[nextIndex];
    if (nextTab) setActiveTab(nextTab.id);
  };
  const timingEntries = Object.entries(item.timings || {});
  const totalTiming = timingEntries.find(([key]) =>
    /total|duration/i.test(key),
  )?.[1];
  const timingSum = timingEntries.reduce(
    (total, [, value]) => total + value,
    0,
  );
  const duration =
    typeof totalTiming === "number"
      ? `${Math.round(totalTiming)} ms`
      : timingEntries.length
        ? `${Math.round(timingSum)} ms`
        : "—";
  const storedAttempts = (run.attempts || []).filter(
    (attempt) =>
      attempt &&
      typeof attempt === "object" &&
      !Array.isArray(attempt) &&
      (attempt as Record<string, unknown>).caseId === item.caseId,
  );
  const eventAttempts = new Set(
    events
      .filter(
        (event) =>
          event.caseId === item.caseId && typeof event.attempt === "number",
      )
      .map((event) => `${event.stage || "request"}:${event.attempt}`),
  );
  const attemptCount = storedAttempts.length || eventAttempts.size;
  const judgeSummary = isToolWorkflow
    ? "N/A"
    : !item.judge
      ? "Not used"
      : item.judge.verdict === "ungraded"
        ? "Couldn't grade"
        : item.judge.verdict === true || item.judge.verdict === "pass"
          ? "Pass"
          : "Fail";
  const expectedLabel = isToolWorkflow
    ? "Expected tool calls"
    : "Expected JSON";
  const actualLabel = isToolWorkflow ? "Proposed tool calls" : "Actual JSON";
  const renderCaseContent = () => {
    if (activeTab === firstTab) {
      return isDocumentWorkflow ? (
        <div className="case-tab-content">
          <div className="transcription">
            {item.referenceTranscription ? (
              <CompareText
                title="Reference transcription"
                value={item.referenceTranscription}
                muted=""
              />
            ) : (
              <p className="missing-data-line">REFERENCE · not supplied</p>
            )}
            <CompareText
              title="Model transcription"
              value={item.ocrText}
              muted="OCR did not return text"
            />
          </div>
        </div>
      ) : (
        <div className="case-tab-content">
          <CodeCard
            title={actualLabel}
            value={actualOutput}
            details={isToolWorkflow ? rawToolResponse(item) : undefined}
          />
        </div>
      );
    }
    if (activeTab === "json") {
      return (
        <div className="case-json-panel case-tab-content">
          <div
            className={`json-grid${item.expected === undefined ? " unlabeled-output" : ""}`}
          >
            {item.expected !== undefined ? (
              <CodeCard title={expectedLabel} value={item.expected} />
            ) : (
              <p className="missing-data-line">
                {expectedLabel.toUpperCase()} · not labeled for this case
              </p>
            )}
            <CodeCard
              title={actualLabel}
              value={actualOutput}
              details={isToolWorkflow ? rawToolResponse(item) : undefined}
            />
          </div>
        </div>
      );
    }
    if (activeTab === "execution") {
      return (
        <div className="case-execution-panel case-tab-content">
          <RunActivity
            events={events}
            loading={eventsLoading}
            hint={eventsHint}
          />
        </div>
      );
    }
    if (activeTab === "metadata") {
      return (
        <div className="metadata-grid case-tab-content">
          <CodeCard title="Run snapshot" value={run.snapshot} />
          <CodeCard title="Attempts" value={run.attempts} />
          <CodeCard title="Run config" value={run.config} />
        </div>
      );
    }
    return (
      <div className="case-timing-panel case-tab-content">
        <div className="detail-grid">
          <div className="panel-inner">
            <h4>{item.grade ? "Grade breakdown" : "Inference output"}</h4>
            {item.grade ? (
              <div className="grade-list">
                <Grade label="Parse success" value={item.grade.parseSuccess} />
                <Grade label="Schema valid" value={item.grade.schemaValid} />
                <Grade
                  label={
                    isToolWorkflow ? "Tool checks passed" : "Field accuracy"
                  }
                  value={
                    item.grade.fieldAccuracy === undefined
                      ? undefined
                      : metric(item.grade.fieldAccuracy)
                  }
                />
                {isDocumentWorkflow && (
                  <Grade label="OCR score" value={ocrSummary(item.ocrGrade)} />
                )}
              </div>
            ) : (
              <p className="muted">
                No expected JSON supplied; this case is not scored.
              </p>
            )}
            {failures.length ? (
              <div className="failures">
                <h4>
                  {isToolWorkflow ? "Tool check failures" : "Field failures"}
                </h4>
                {failures.map((failure, index) => (
                  <div
                    className="failure"
                    key={`${failure.path || "failure"}-${index}`}
                  >
                    <strong>{failure.path || "Unknown field"}</strong>
                    <span>{failure.message || failure.kind || "Mismatch"}</span>
                    {failure.expected !== undefined && (
                      <code>
                        expected {pretty(failure.expected)} · actual{" "}
                        {pretty(failure.actual)}
                      </code>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="panel-inner">
            <h4>{isToolWorkflow ? "Timing" : "Timing & judge"}</h4>
            <div className="timing">
              {timingEntries.length ? (
                timingEntries.map(([key, value]) => (
                  <span key={key}>
                    <b>{key.replace(/Ms$/, "")}</b>
                    {Math.round(value)} ms
                  </span>
                ))
              ) : (
                <span className="muted">No timing recorded.</span>
              )}
            </div>
            {!isToolWorkflow &&
              (item.judge ? (
                <div
                  className={`judge ${
                    item.judge.verdict === "ungraded"
                      ? "judge-ungraded"
                      : item.judge.verdict === true || item.judge.verdict === "pass"
                        ? "judge-pass"
                        : "judge-fail"
                  }`}
                >
                  <span className="eyebrow">JUDGE MODEL</span>
                  <strong>
                    {item.judge.verdict === "ungraded"
                      ? "Couldn't grade this case"
                      : item.judge.verdict === true || item.judge.verdict === "pass"
                        ? "Pass"
                        : "Fail"}
                  </strong>
                  <p>
                    {item.judge.verdict === "ungraded"
                      ? item.judge.error || "The judge model didn't return a usable verdict."
                      : item.judge.evidence || "No explanation given."}
                  </p>
                </div>
              ) : (
                <p className="muted">No judge model was used for this run.</p>
              ))}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="case-view">
      <div className="case-tabs" role="tablist" aria-label="Case details">
        {tabOptions.map((tab) => (
          <button
            key={tab.id}
            type="button"
            id={tabId(tab.id)}
            className={`case-tab${activeTab === tab.id ? " active" : ""}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={panelId}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={handleTabKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="case-inspection-body">
        <aside
          className="case-reference-pane"
          aria-label="Case input reference"
          tabIndex={0}
        >
          {hasImage ? (
            <div className="image-card">
              <ZoomableImage src={image} alt={`Document ${item.caseId}`} />
            </div>
          ) : (
            <CompareText
              title="Input text"
              value={item.inputText}
              muted="No input text supplied"
            />
          )}
        </aside>
        <section
          id={panelId}
          className="case-tab-panel"
          role="tabpanel"
          aria-labelledby={tabId(activeTab)}
          tabIndex={0}
        >
          {renderCaseContent()}
        </section>
      </div>
      <footer className="case-status-strip" aria-label="Case status summary">
        {timingEntries.length ? (
          timingEntries.map(([key, value]) => (
            <span key={key}>
              <b>{key.replace(/Ms$/, "")}</b>
              <code>{Math.round(value)} ms</code>
            </span>
          ))
        ) : (
          <span>
            <b>Duration</b>
            <code>{duration}</code>
          </span>
        )}
        <span>
          <b>Attempts</b>
          <code>{attemptCount || "—"}</code>
        </span>
        <span>
          <b>Judge</b>
          <strong>{judgeSummary}</strong>
        </span>
      </footer>
    </div>
  );
}
function CompareText({
  title,
  value,
  muted,
}: {
  title: string;
  value?: string;
  muted: string;
}) {
  return (
    <div className="text-pane">
      <h4>{title}</h4>
      <p tabIndex={value ? 0 : undefined} aria-label={title}>
        {value || <span className="muted">{muted}</span>}
      </p>
    </div>
  );
}
function CodeCard({
  title,
  value,
  details,
}: {
  title: string;
  value: Json;
  details?: Json;
}) {
  return (
    <div className="code-card">
      <h4>{title}</h4>
      <pre tabIndex={0} aria-label={title}>
        <HighlightedJson text={pretty(value)} />
      </pre>
      {details !== undefined && (
        <details className="code-card-details">
          <summary>Raw provider envelope</summary>
          <pre tabIndex={0} aria-label="Raw provider envelope">
            <HighlightedJson text={pretty(details)} />
          </pre>
        </details>
      )}
    </div>
  );
}
function Grade({ label, value }: { label: string; value?: boolean | string }) {
  return (
    <div>
      <span>{label}</span>
      <strong
        className={
          value === true || (typeof value === "string" && value.includes("%"))
            ? "good"
            : value === false
              ? "bad"
              : ""
        }
      >
        {value === true ? "Yes" : value === false ? "No" : (value ?? "—")}
      </strong>
    </div>
  );
}
function Datasets({
  datasets,
  targets,
  onRefresh,
}: {
  datasets: Dataset[];
  targets: Target[];
  onRefresh: () => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [zipDragging, setZipDragging] = useState(false);
  const [generationSubmitting, setGenerationSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<Notice["kind"]>("success");
  const [createOpen, setCreateOpen] = useState(false);
  const addDialog = useRef<HTMLDialogElement>(null);
  const [addMode, setAddMode] = useState<"sample" | "import" | "generate">("sample");
  const [jobs, setJobs] = useState<DatasetJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [jobAction, setJobAction] = useState<"retry" | "delete" | "stop" | "">("");
  const [jobActionError, setJobActionError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [datasetMutation, setDatasetMutation] = useState<"duplicate" | "delete" | "">("");
  const [contextMenu, setContextMenu] = useState<{
    kind: "dataset" | "job";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const draft = useRef<GenerationDraft | null>(null);
  if (!draft.current) draft.current = readGenerationDraft();
  const [generateTarget, setGenerateTarget] = useState(
    draft.current.target || targets[0]?.name || "",
  );
  const [generateTaskKind, setGenerateTaskKind] = useState<
    "text-json" | "tool-calling"
  >(draft.current.taskKind);
  const [generateName, setGenerateName] = useState(draft.current.name);
  const [generateCount, setGenerateCount] = useState(draft.current.count);
  const [generateBrief, setGenerateBrief] = useState(draft.current.brief);
  const [generateTimeoutMinutes, setGenerateTimeoutMinutes] = useState(
    draft.current.timeoutMinutes,
  );
  const onRefreshRef = useRef(onRefresh);
  const jobsRef = useRef<DatasetJob[]>([]);
  const selectedJobIdRef = useRef("");
  const suppressDatasetAutoSelectRef = useRef(false);
  const renameTitleRef = useRef<HTMLHeadingElement>(null);
  const renameRequestRef = useRef(false);
  const datasetMutationRef = useRef(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const jobsRequestRef = useRef<Promise<DatasetJob[]> | null>(null);
  const handledCompletedJobsRef = useRef(new Set<string>());
  const knownJobStatusesRef = useRef(new Map<string, DatasetJobStatus>());
  const submittedJobIdsRef = useRef(new Set<string>());
  const initialJobsLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const pollingStoppedRef = useRef(false);
  const pollTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        DATASET_GENERATION_DRAFT_KEY,
        JSON.stringify({
          target: generateTarget,
          taskKind: generateTaskKind,
          name: generateName,
          count: generateCount,
          brief: generateBrief,
          timeoutMinutes: generateTimeoutMinutes,
        }),
      );
    } catch {
      /* Creation draft persistence is best-effort. */
    }
  }, [
    generateBrief,
    generateCount,
    generateName,
    generateTarget,
    generateTaskKind,
    generateTimeoutMinutes,
  ]);
  const selectCompletedJob = async (job: DatasetJob) => {
    if (!job.datasetVersion) return;
    try {
      await onRefreshRef.current();
      if (!mountedRef.current) return;
      if (
        selectedJobIdRef.current &&
        selectedJobIdRef.current !== job.jobId
      )
        return;
      setSelectedJobId("");
      setSelectedVersion(job.datasetVersion);
      setMessageKind("success");
      setMessage(`${job.name || "Dataset"} is ready.`);
    } catch (err) {
      if (!mountedRef.current) return;
      setMessageKind("error");
      setMessage(
        err instanceof Error ? err.message : "Could not refresh datasets",
      );
    }
  };
  const retryDatasetJob = async (job: DatasetJob) => {
    if (jobAction) return;
    setJobAction("retry");
    setJobActionError("");
    try {
      const retried = await api<DatasetJob>(
        `/api/dataset-jobs/${encodeURIComponent(job.jobId)}/retry`,
        { method: "POST" },
      );
      setJobs((current) => {
        const next = [...current, retried];
        jobsRef.current = next;
        return next;
      });
      submittedJobIdsRef.current.add(retried.jobId);
      setSelectedJobId(retried.jobId);
      setJobActionError("");
      void pollJobs();
    } catch (err) {
      setJobActionError(
        err instanceof Error ? err.message : "Could not retry generation",
      );
    } finally {
      setJobAction("");
    }
  };
  const stopDatasetJob = async (job: DatasetJob) => {
    if (jobAction) return;
    setJobAction("stop");
    setJobActionError("");
    try {
      const stopped = await api<DatasetJob>(
        `/api/dataset-jobs/${encodeURIComponent(job.jobId)}/stop`,
        { method: "POST" },
      );
      await jobsRequestRef.current;
      if (!mountedRef.current) return;
      setJobs((current) => {
        const next = current.map((item) => item.jobId === stopped.jobId ? stopped : item);
        jobsRef.current = next;
        return next;
      });
      void pollJobs();
    } catch (error) {
      if (mountedRef.current)
        setJobActionError(error instanceof Error ? error.message : "Could not stop generation.");
    } finally {
      if (mountedRef.current) setJobAction("");
    }
  };
  const deleteDatasetJob = async (job: DatasetJob) => {
    if (jobAction) return;
    if (!window.confirm(`Delete the generation attempt "${job.name || "Untitled dataset"}"?\n\nThis permanently removes its history and error details. Saved datasets will not be deleted.`)) return;
    setJobAction("delete");
    setJobActionError("");
    if (selectedJobIdRef.current === job.jobId) {
      setSelectedJobId("");
      setSelectedVersion("");
      suppressDatasetAutoSelectRef.current = true;
    }
    try {
      await api<void>(
        `/api/dataset-jobs/${encodeURIComponent(job.jobId)}`,
        { method: "DELETE" },
      );
      setJobs((current) => {
        const next = current.filter((item) => item.jobId !== job.jobId);
        jobsRef.current = next;
        return next;
      });
    } catch (err) {
      setJobActionError(
        err instanceof Error ? err.message : "Could not delete job",
      );
      setMessageKind("error");
      setMessage(
        err instanceof Error ? err.message : "Could not delete generation job.",
      );
    } finally {
      setJobAction("");
    }
  };
  const loadJobs = useCallback(async (): Promise<DatasetJob[]> => {
    if (jobsRequestRef.current) return jobsRequestRef.current;
    const request = api<DatasetJob[]>("/api/dataset-jobs")
      .then(async (nextJobs) => {
        if (!mountedRef.current) return nextJobs;
        const isInitialLoad = !initialJobsLoadedRef.current;
        const completedToRefresh = isInitialLoad
          ? nextJobs.some((job) => job.status === "completed" && job.datasetVersion)
          : false;
        const completedToSelect = nextJobs.find(
          (job) =>
            job.status === "completed" &&
            job.datasetVersion &&
            (submittedJobIdsRef.current.has(job.jobId) ||
              knownJobStatusesRef.current.get(job.jobId) === "queued" ||
              knownJobStatusesRef.current.get(job.jobId) === "running"),
        );
        initialJobsLoadedRef.current = true;
        for (const job of nextJobs) {
          knownJobStatusesRef.current.set(job.jobId, job.status);
          if (job.status === "completed") {
            handledCompletedJobsRef.current.add(job.jobId);
          }
        }
        setJobs(nextJobs);
        setJobsError("");
        setJobsLoading(false);
        if (completedToRefresh) {
          try {
            await onRefreshRef.current();
          } catch (err) {
            if (mountedRef.current) {
              setMessageKind("error");
              setMessage(
                err instanceof Error
                  ? err.message
                  : "Could not refresh datasets",
              );
            }
          }
        }
        if (completedToSelect) {
          submittedJobIdsRef.current.delete(completedToSelect.jobId);
          await selectCompletedJob(completedToSelect);
        }
        return nextJobs;
      })
      .catch((err) => {
        if (!mountedRef.current) return jobsRef.current;
        setJobsLoading(false);
        setJobsError(err instanceof Error ? err.message : "Could not load dataset jobs");
        return jobsRef.current;
      })
      .finally(() => {
        jobsRequestRef.current = null;
      });
    jobsRequestRef.current = request;
    return request;
  }, []);
  const pollJobs = useCallback(async () => {
    const nextJobs = await loadJobs();
    if (
      !pollingStoppedRef.current &&
      (nextJobs.some(
        (job) => job.status === "queued" || job.status === "running",
      ) ||
        jobsRef.current.some(
          (job) => job.status === "queued" || job.status === "running",
        )) &&
      pollTimerRef.current === undefined
    ) {
      pollTimerRef.current = window.setTimeout(() => {
        pollTimerRef.current = undefined;
        void pollJobs();
      }, 1500);
    }
  }, [loadJobs]);
  useEffect(() => {
    pollingStoppedRef.current = false;
    void pollJobs();
    return () => {
      pollingStoppedRef.current = true;
      if (pollTimerRef.current !== undefined) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = undefined;
      }
    };
  }, [pollJobs]);
  const activeGenerationJob = jobs.find((job) => job.status === "running");
  const queuedGenerationCount = jobs.filter(
    (job) => job.status === "queued",
  ).length;
  const selectedJob = jobs.find((job) => job.jobId === selectedJobId);
  const datasetVersions = new Set(datasets.map((dataset) => dataset.version));
  const pickerJobs = jobs.filter(
    (job) =>
      job.status !== "completed" ||
      !job.datasetVersion ||
      !datasetVersions.has(job.datasetVersion),
  );
  const [selectedVersion, setSelectedVersion] = useState(() => {
    try {
      return (
        window.localStorage.getItem("local-evals-selected-dataset") ||
        datasets[0]?.version ||
        ""
      );
    } catch {
      return datasets[0]?.version || "";
    }
  });
  const selectedDataset = datasets.find(
    (dataset) => dataset.version === selectedVersion,
  );
  const contextDataset =
    contextMenu?.kind === "dataset"
      ? datasets.find((dataset) => dataset.version === contextMenu.id)
      : undefined;
  const contextJob =
    contextMenu?.kind === "job"
      ? jobs.find((job) => job.jobId === contextMenu.id)
      : undefined;
  useEffect(() => {
    setRenameName(selectedDataset?.name || "");
    setRenameOpen(false);
    setRenameError("");
  }, [selectedDataset?.name, selectedDataset?.version]);
  const renameDataset = async () => {
    if (!selectedDataset || renameBusy || renameRequestRef.current) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError("Dataset name cannot be empty.");
      return;
    }
    renameRequestRef.current = true;
    setRenameBusy(true);
    setRenameError("");
    const version = selectedDataset.version;
    try {
      await api<Dataset>(
        `/api/datasets/${encodeURIComponent(version)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      await onRefreshRef.current();
      if (!mountedRef.current) return;
      setSelectedVersion(version);
      setRenameOpen(false);
    } catch (err) {
      setRenameError(
        err instanceof Error ? err.message : "Could not rename dataset",
      );
    } finally {
      renameRequestRef.current = false;
      if (mountedRef.current) setRenameBusy(false);
    }
  };
  const beginRename = (dataset = selectedDataset) => {
    if (!dataset || datasetMutationRef.current) return;
    closeContextMenu();
    suppressDatasetAutoSelectRef.current = false;
    setSelectedJobId("");
    setSelectedVersion(dataset.version);
    setRenameName(dataset.name || "");
    setRenameError("");
    setRenameOpen(true);
  };
  useEffect(() => {
    if (!renameOpen) return;
    window.requestAnimationFrame(() => {
      const node = renameTitleRef.current;
      if (!node) return;
      node.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  }, [renameOpen]);
  const openContextMenu = (
    kind: "dataset" | "job",
    id: string,
    x: number,
    y: number,
  ) => {
    setContextMenu({
      kind,
      id,
      x: Math.max(8, Math.min(x, window.innerWidth - 220)),
      y: Math.max(8, Math.min(y, window.innerHeight - 180)),
    });
  };
  const closeContextMenu = () => setContextMenu(null);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node))
        closeContextMenu();
    };
    const dismissOnViewportChange = () => closeContextMenu();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(
          contextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not([disabled])',
          ) || [],
        );
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismissOnViewportChange, true);
    window.addEventListener("resize", dismissOnViewportChange);
    window.requestAnimationFrame(() =>
      contextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus(),
    );
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismissOnViewportChange, true);
      window.removeEventListener("resize", dismissOnViewportChange);
    };
  }, [contextMenu]);
  const duplicateDataset = async (dataset: Dataset) => {
    if (datasetMutationRef.current) return;
    datasetMutationRef.current = true;
    setDatasetMutation("duplicate");
    setRenameError("");
    closeContextMenu();
    try {
      const copy = await api<Dataset>(
        `/api/datasets/${encodeURIComponent(dataset.version)}/duplicate`,
        { method: "POST" },
      );
      await onRefreshRef.current();
      if (!mountedRef.current) return;
      suppressDatasetAutoSelectRef.current = false;
      setSelectedJobId("");
      setSelectedVersion(copy.version);
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof Error ? err.message : "Could not duplicate dataset");
    } finally {
      datasetMutationRef.current = false;
      if (mountedRef.current) setDatasetMutation("");
    }
  };
  const deleteDataset = async (dataset: Dataset) => {
    if (datasetMutationRef.current) return;
    if (!window.confirm(
      `Delete dataset "${dataset.name || "Untitled dataset"}"?\n\nThis removes the dataset and its completed creation history. Evaluation runs and imported files are retained.`,
    )) return;
    datasetMutationRef.current = true;
    setDatasetMutation("delete");
    closeContextMenu();
    setSelectedJobId("");
    setSelectedVersion("");
    suppressDatasetAutoSelectRef.current = true;
    try {
      await api<{ deleted: boolean }>(
        `/api/datasets/${encodeURIComponent(dataset.version)}`,
        { method: "DELETE" },
      );
      await onRefreshRef.current();
      await pollJobs();
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof Error ? err.message : "Could not delete dataset");
    } finally {
      datasetMutationRef.current = false;
      if (mountedRef.current) setDatasetMutation("");
    }
  };
  useEffect(() => {
    if (!selectedVersion) {
      if (datasets.length && !suppressDatasetAutoSelectRef.current)
        setSelectedVersion(datasets[0]?.version || "");
      return;
    }
    if (
      datasets.length &&
      !datasets.some((dataset) => dataset.version === selectedVersion)
    ) {
      setSelectedVersion(datasets[0]?.version || "");
    }
  }, [datasets, selectedVersion]);
  useEffect(() => {
    if (!selectedVersion) return;
    try {
      window.localStorage.setItem(
        "local-evals-selected-dataset",
        selectedVersion,
      );
    } catch {
      /* Dataset preference is best-effort. */
    }
  }, [selectedVersion]);
  useEffect(() => {
    if (!generateTarget && targets[0]?.name) setGenerateTarget(targets[0].name);
  }, [generateTarget, targets]);
  const importPath = (datasetPath: string, label: string) =>
    runImport(() => importDatasetPath(datasetPath), label);
  const uploadZip = (file?: File) => {
    if (!file || importBusy) return;
    if (!/\.zip$/i.test(file.name)) {
      setMessageKind("error");
      setMessage("Choose a .zip file. For a JSONL or JSON manifest, enter its path below.");
      return;
    }
    void runImport(() => importDatasetZipFile(file), file.name);
  };
  const runImport = async (request: () => Promise<Dataset>, label: string) => {
    setImportBusy(true);
    setMessage("");
    try {
      const imported = await request();
      await onRefresh();
      setSelectedVersion(imported.version);
      setPath("");
      setCreateOpen(false);
      setMessageKind("success");
      setMessage(`${label} imported.`);
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportBusy(false);
    }
  };
  const importDataset = async (e: FormEvent) => {
    e.preventDefault();
    await importPath(path, "Dataset");
  };
  const generateDataset = async (e: FormEvent) => {
    e.preventDefault();
    if (generationSubmitting || !targets.length) return;
    const timeoutMinutes = Number(generateTimeoutMinutes);
    if (
      !Number.isFinite(timeoutMinutes) ||
      timeoutMinutes < 0.5 ||
      timeoutMinutes > 60
    ) {
      setMessageKind("error");
      setMessage("Generation timeout must be between 0.5 and 60 minutes.");
      return;
    }
    setGenerationSubmitting(true);
    setMessage("");
    try {
      const job = await api<DatasetJob>("/api/datasets/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetName: generateTarget,
          taskKind: generateTaskKind,
          name: generateName,
          caseCount: Number(generateCount),
          brief: generateBrief,
          timeoutSeconds: Math.round(timeoutMinutes * 60),
        }),
      });
      setJobs((current) => {
        const next = [job, ...current.filter((item) => item.jobId !== job.jobId)];
        jobsRef.current = next;
        return next;
      });
      submittedJobIdsRef.current.add(job.jobId);
      if (job.status === "completed" && job.datasetVersion) {
        handledCompletedJobsRef.current.add(job.jobId);
        submittedJobIdsRef.current.delete(job.jobId);
        void selectCompletedJob(job);
      }
      void pollJobs();
      setJobsError("");
      setCreateOpen(false);
      setMessageKind("success");
      setMessage(
        job.status === "completed"
          ? `${job.name || "Dataset"} created.`
          : job.status === "queued"
            ? `${job.name || "Dataset"} added to the queue.`
            : `${job.name || "Dataset"} generation started.`,
      );
    } catch (err) {
      setMessageKind("error");
      setMessage(
        err instanceof Error ? err.message : "Dataset generation failed",
      );
    } finally {
      setGenerationSubmitting(false);
    }
  };
  const sampleDatasets = (Object.keys(SAMPLE_DATASETS) as TaskKind[]).map((taskKind) => ({
    taskKind,
    path: SAMPLE_DATASETS[taskKind],
  }));
  const addInline = !datasets.length && !jobs.length && !jobsLoading;
  useEffect(() => {
    const node = addDialog.current;
    if (!node) return;
    if (createOpen && !addInline && !node.open) node.showModal();
    else if ((!createOpen || addInline) && node.open) node.close();
  }, [createOpen, addInline]);
  const messageNotice = message ? (
    <div
      className={`import-message ${messageKind}`}
      role={messageKind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {message}
      <button
        type="button"
        aria-label="Dismiss dataset message"
        onClick={() => setMessage("")}
      >
        ×
      </button>
    </div>
  ) : null;
  const addPanel = (
    <div className="add-dataset" id="dataset-create-panel">
      <div className="add-dataset-head">
        <h3>Add a dataset</h3>
        {(datasets.length > 0 || jobs.length > 0) && (
          <button type="button" className="text-button" onClick={() => setCreateOpen(false)}>
            Close
          </button>
        )}
      </div>
      <div className="add-dataset-tabs">
        <div className="add-dataset-modes" role="tablist" aria-label="How to add a dataset">
          {ADD_DATASET_MODES.map(([mode, icon, title, text]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={addMode === mode}
              title={text}
              className={`add-dataset-mode${addMode === mode ? " selected" : ""}`}
              onClick={() => setAddMode(mode)}
            >
              <span className="add-dataset-icon" aria-hidden="true">{icon}</span>
              {title}
            </button>
          ))}
        </div>
        <p className="add-dataset-hint">
          {ADD_DATASET_MODES.find(([mode]) => mode === addMode)?.[3]}
        </p>
      </div>
      {addMode === "sample" && (
        <div className="add-dataset-body sample-imports">
          {sampleDatasets.map((sample) => (
            <button
              key={sample.taskKind}
              type="button"
              className="button secondary"
              disabled={importBusy}
              onClick={() => void importPath(sample.path, TASK_KIND_LABELS[sample.taskKind])}
            >
              {TASK_KIND_LABELS[sample.taskKind]} sample
            </button>
          ))}
        </div>
      )}
      {addMode === "import" && (
        <div className="import-pane" aria-busy={importBusy}>
          <div className="import-zip-row">
            <div
              className={`zip-drop${zipDragging ? " dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setZipDragging(true);
              }}
              onDragLeave={() => setZipDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setZipDragging(false);
                uploadZip(event.dataTransfer.files[0]);
              }}
            >
              <span className="zip-drop-icon" aria-hidden="true">⇪</span>
              <strong>
                {importBusy ? "Importing…" : zipDragging ? "Release to import" : "Drop a dataset ZIP here"}
              </strong>
              <label className={`button secondary${importBusy ? " disabled" : ""}`}>
                Choose ZIP file
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="sr-only"
                  disabled={importBusy}
                  onChange={(event) => {
                    uploadZip(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              <small>Up to 512 MB</small>
            </div>
            <aside className="zip-anatomy" aria-label="What goes in a dataset ZIP">
              <span className="eyebrow">What&apos;s inside</span>
              <pre aria-hidden="true">{`my-dataset.zip
├─ manifest.jsonl
├─ assets/
│  └─ receipt-001.jpeg
└─ README.md  (optional)`}</pre>
              <p>
                One case per line in <code>manifest.jsonl</code>, each pointing to an image in the ZIP.
              </p>
              <div className="zip-anatomy-actions">
                <a className="button secondary mini" href="/api/datasets/example.zip" download>
                  Download example
                </a>
                <a
                  className="text-button"
                  href="#help/dataset-zip"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Format guide (opens in a new tab)"
                >
                  Format guide <span aria-hidden="true">↗</span>
                </a>
              </div>
            </aside>
          </div>
          <div className="import-divider" role="separator">
            <span>or</span>
          </div>
          <form className="import-path" onSubmit={importDataset}>
            <label htmlFor="dataset-import-path">Import from a project path</label>
            <div className="import-path-row">
              <input
                id="dataset-import-path"
                required
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="datasets/receipts/manifest.jsonl"
              />
              <button className="button primary" disabled={importBusy}>
                {importBusy ? "Importing…" : "Import"}
              </button>
            </div>
            <small>A .jsonl, .json, or .zip file, relative to the project folder.</small>
          </form>
        </div>
      )}
      {addMode === "generate" && (
        <form
          className="add-dataset-body dataset-create-fields"
          onSubmit={generateDataset}
          aria-busy={generationSubmitting || Boolean(activeGenerationJob)}
        >
          <div className="field">
            <span className="field-label" id="generate-model-label">Model</span>
            <Dropdown
              labelledBy="generate-model-label"
              value={generateTarget}
              onChange={setGenerateTarget}
              options={targetOptions(targets).slice(1)}
              placeholder="Choose a model"
            />
            {!targets.length && <small>Add a model in Providers first.</small>}
          </div>
          <div className="field">
            <span className="field-label" id="generate-type-label">Type</span>
            <Dropdown
              labelledBy="generate-type-label"
              value={generateTaskKind}
              onChange={(kind) => setGenerateTaskKind(kind as "text-json" | "tool-calling")}
              options={[
                { value: "text-json", label: "Text → JSON", detail: "Inputs with expected JSON fields" },
                { value: "tool-calling", label: "Tool calling", detail: "Requests with expected tool calls" },
              ]}
            />
          </div>
          <label className="dataset-create-brief">
            What should the cases cover?
            <textarea
              value={generateBrief}
              onChange={(event) => setGenerateBrief(event.target.value)}
              placeholder="Classify support messages by urgency and topic. Include ambiguous and edge cases."
              rows={3}
            />
          </label>
          <label>
            Number of cases
            <input
              type="number"
              min="1"
              max="50"
              required
              value={generateCount}
              onChange={(event) => setGenerateCount(event.target.value)}
            />
          </label>
          <AdvancedOptions>
            <label>
              <span>
                Dataset name <span className="optional">optional</span>
              </span>
              <input
                value={generateName}
                onChange={(event) => setGenerateName(event.target.value)}
                placeholder="Support intents — generated"
              />
            </label>
            <label>
              Time limit (minutes)
              <input
                type="number"
                min="0.5"
                max="60"
                step="0.5"
                required
                value={generateTimeoutMinutes}
                onChange={(event) => setGenerateTimeoutMinutes(event.target.value)}
              />
              <small>Counts from when generation starts, not while waiting in the queue.</small>
            </label>
          </AdvancedOptions>
          <p className="setup-hint">Images can't be generated. Import document datasets from files.</p>
          <button className="button primary" type="submit" disabled={generationSubmitting || !targets.length}>
            {generationSubmitting
              ? "Starting…"
              : activeGenerationJob || queuedGenerationCount
                ? "Add to queue"
                : "Generate dataset"}
          </button>
        </form>
      )}
    </div>
  );
  return (
    <>
      <PageTitle
        eyebrow="PREPARE"
        title="Datasets"
        sub="The examples your model answers, with optional expected answers."
        action={
          addInline ? undefined : (
            <button
              type="button"
              className="button primary"
              onClick={() => setCreateOpen(true)}
              aria-haspopup="dialog"
            >
              Add dataset
            </button>
          )
        }
      />
      <dialog
        ref={addDialog}
        className="add-dataset-dialog"
        aria-label="Add a dataset"
        onClose={() => setCreateOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) addDialog.current?.close();
        }}
      >
        {createOpen && !addInline && (
          <>
            {addPanel}
            {messageKind === "error" && messageNotice}
          </>
        )}
      </dialog>
      <section className="panel dataset-panel">
        {addInline && addPanel}
        {!(createOpen && !addInline && messageKind === "error") && messageNotice}
        {datasets.length || jobsLoading || jobsError || jobs.length ? (
          <div className="dataset-library">
            <div className="dataset-library-layout">
              <aside className="dataset-picker" aria-label="Dataset selection">
                <div className="dataset-picker-heading">
                  {(activeGenerationJob || queuedGenerationCount > 0) && (
                    <small aria-live="polite">
                      {activeGenerationJob
                        ? `Running ${activeGenerationJob.name || "dataset"}`
                        : `${queuedGenerationCount} queued`}
                    </small>
                  )}
                </div>
                <div className="dataset-choice-list">
                  {datasets.map((d) => {
                    const selected = !selectedJobId && d.version === selectedVersion;
                    return (
                      <button
                        key={d.version}
                        type="button"
                        className={`dataset-choice${selected ? " selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => {
                          suppressDatasetAutoSelectRef.current = false;
                          setSelectedJobId("");
                          setSelectedVersion(d.version);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          suppressDatasetAutoSelectRef.current = false;
                          setSelectedJobId("");
                          setSelectedVersion(d.version);
                          openContextMenu("dataset", d.version, event.clientX, event.clientY);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                            event.preventDefault();
                            suppressDatasetAutoSelectRef.current = false;
                            setSelectedJobId("");
                            setSelectedVersion(d.version);
                            const rect = event.currentTarget.getBoundingClientRect();
                            openContextMenu("dataset", d.version, rect.left, rect.bottom);
                          }
                        }}
                      >
                        <span
                          className="dataset-choice-icon"
                          aria-hidden="true"
                        >
                          ▦
                        </span>
                        <span className="dataset-choice-copy">
                          <strong title={d.name || "Untitled dataset"}>{d.name || "Untitled dataset"}</strong>
                          <span>
                            {TASK_KIND_LABELS[datasetTaskKind(d)]} · {d.cases.length}{" "}
                            {d.cases.length === 1 ? "case" : "cases"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {(jobsLoading || jobsError || pickerJobs.length > 0) && (
                    <div className="dataset-job-list" aria-live="polite">
                      {jobsError && (
                        <div className="dataset-picker-message error" role="alert">
                          <span>Could not load jobs: {jobsError}</span>
                          <button type="button" className="text-button" onClick={() => void pollJobs()}>
                            Retry
                          </button>
                        </div>
                      )}
                      {jobsLoading && <p className="dataset-picker-loading" role="status">Loading jobs…</p>}
                      {!jobsLoading && !jobsError && pickerJobs.map((job) => {
                        const statusLabel = job.status[0].toUpperCase() + job.status.slice(1);
                        const statusClass =
                          job.status === "running"
                            ? "running"
                            : job.status === "failed" || job.status === "interrupted"
                              ? "fail"
                              : job.status === "completed"
                                ? "pass"
                                : "neutral";
                        return (
                          <div className="dataset-job" key={job.jobId}>
                            <button
                              type="button"
                              className={`dataset-choice${selectedJobId === job.jobId ? " selected" : ""}`}
                              aria-pressed={selectedJobId === job.jobId}
                              aria-label={`${job.name || "Untitled dataset"}: ${statusLabel}. Show details`}
                              onClick={() => {
                                setJobActionError("");
                                setSelectedJobId(job.jobId);
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                setJobActionError("");
                                setSelectedJobId(job.jobId);
                                openContextMenu("job", job.jobId, event.clientX, event.clientY);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                                  event.preventDefault();
                                  setJobActionError("");
                                  setSelectedJobId(job.jobId);
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  openContextMenu("job", job.jobId, rect.left, rect.bottom);
                                }
                              }}
                            >
                            <span className="dataset-choice-icon" aria-hidden="true">&#9638;</span>
                            <span className="dataset-job-copy dataset-choice-copy">
                              <strong title={job.name || "Untitled dataset"}>{job.name || "Untitled dataset"}</strong>
                              <span>
                                {TASK_KIND_LABELS[asTaskKind(job.taskKind)]} · {job.caseCount} {job.caseCount === 1 ? "case" : "cases"}
                                {(job.status === "queued" || job.status === "running") &&
                                  typeof job.timeoutSeconds === "number" &&
                                  Number.isFinite(job.timeoutSeconds) &&
                                  ` · ${Math.round((job.timeoutSeconds / 60) * 10) / 10} min timeout`}
                              </span>
                            </span>
                            <span className={`dataset-job-indicator ${statusClass}`} title={statusLabel} aria-hidden="true">
                              {job.status === "failed" || job.status === "interrupted" ? "!" : job.status === "completed" ? "+" : "\u00b7"}
                            </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </aside>
              {contextMenu && (contextDataset || contextJob) && (
                <div
                  ref={contextMenuRef}
                  className="dataset-context-menu"
                  role="menu"
                  aria-label="Dataset actions"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                  {contextDataset && (
                    <>
                      <button type="button" role="menuitem" onClick={() => beginRename(contextDataset)}>
                        Rename
                      </button>
                      <button type="button" role="menuitem" disabled={Boolean(datasetMutation)} onClick={() => void duplicateDataset(contextDataset)}>
                        {datasetMutation === "duplicate" ? "Duplicating..." : "Duplicate"}
                      </button>
                      <button type="button" role="menuitem" disabled={Boolean(datasetMutation)} onClick={() => void deleteDataset(contextDataset)}>
                        {datasetMutation === "delete" ? "Deleting..." : "Delete"}
                      </button>
                    </>
                  )}
                  {contextJob && (contextJob.status === "queued" || contextJob.status === "running") && (
                    <button type="button" role="menuitem" disabled={Boolean(jobAction)} onClick={() => { closeContextMenu(); void stopDatasetJob(contextJob); }}>
                      {contextJob.status === "queued" ? "Remove from queue" : "Stop generation"}
                    </button>
                  )}
                  {contextJob && (contextJob.status === "failed" || contextJob.status === "interrupted") && (
                    <>
                      <button type="button" role="menuitem" disabled={Boolean(jobAction)} onClick={() => { closeContextMenu(); void retryDatasetJob(contextJob); }}>
                        {jobAction === "retry" ? "Retrying..." : "Retry generation"}
                      </button>
                      <button type="button" role="menuitem" disabled={Boolean(jobAction)} onClick={() => { closeContextMenu(); void deleteDatasetJob(contextJob); }}>
                        {jobAction === "delete" ? "Deleting..." : "Delete failed job"}
                      </button>
                    </>
                  )}
                </div>
              )}
              <section className="dataset-selection" aria-label="Selected dataset">
                {selectedJob ? (
                  <div className="dataset-detail dataset-job-detail">
                    <div className="dataset-detail-heading">
                      <div>
                        <span className="eyebrow">DATASET GENERATION JOB</span>
                        <h4>{selectedJob.name || "Untitled dataset"}</h4>
                      </div>
                      <span
                        className={`status-pill ${
                          selectedJob.status === "running"
                            ? "running"
                            : selectedJob.status === "failed" || selectedJob.status === "interrupted"
                              ? "fail"
                              : selectedJob.status === "completed"
                                ? "pass"
                                : "neutral"
                        }`}
                      >
                        {selectedJob.status[0].toUpperCase() + selectedJob.status.slice(1)}
                      </span>
                    </div>
                    <p className="dataset-job-description" role="status">
                      {selectedJob.status === "running"
                        ? "Generating your dataset. You can leave this page and return when it is ready."
                        : selectedJob.status === "queued"
                          ? "Waiting in the queue. Generation will start when the current job finishes."
                          : selectedJob.status === "completed"
                            ? "Your dataset is ready to open."
                            : "Generation did not complete. Review the error below, then retry or delete this attempt."}
                    </p>
                    <dl className="dataset-job-facts">
                      <div><dt>Type</dt><dd>{TASK_KIND_LABELS[asTaskKind(selectedJob.taskKind)]}</dd></div>
                      <div><dt>Cases requested</dt><dd>{selectedJob.caseCount}</dd></div>
                      <div><dt>Provider target</dt><dd>{selectedJob.targetName}</dd></div>
                      {typeof selectedJob.timeoutSeconds === "number" && (
                        <div><dt>Generation timeout</dt><dd>{Math.round((selectedJob.timeoutSeconds / 60) * 10) / 10} minutes</dd></div>
                      )}
                    </dl>
                    {(selectedJob.status === "running" || selectedJob.status === "queued") && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={Boolean(jobAction)}
                        onClick={() => void stopDatasetJob(selectedJob)}
                      >
                        {jobAction === "stop" ? "Stopping..." : selectedJob.status === "queued" ? "Remove from queue" : "Stop generation"}
                      </button>
                    )}
                    {selectedJob.status === "completed" && selectedJob.datasetVersion && (
                      <button type="button" className="button primary" onClick={() => void selectCompletedJob(selectedJob)}>Open dataset</button>
                    )}
                    {selectedJob.error && (
                      <div className="run-error-notice" role="alert">
                        <strong>Generation error</strong>
                        <p>{selectedJob.error}</p>
                      </div>
                    )}
                    {(selectedJob.status === "failed" || selectedJob.status === "interrupted") && (
                      <div className="dataset-header-actions">
                        <button
                          type="button"
                          className="button primary"
                          disabled={Boolean(jobAction)}
                          onClick={() => void retryDatasetJob(selectedJob)}
                        >
                          {jobAction === "retry" ? "Retrying..." : "Retry generation"}
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={Boolean(jobAction)}
                          onClick={() => void deleteDatasetJob(selectedJob)}
                        >
                          {jobAction === "delete" ? "Deleting..." : "Delete failed job"}
                        </button>
                      </div>
                    )}
                    {jobActionError && (
                      <div className="import-message error" role="alert">
                        {jobActionError}
                      </div>
                    )}
                  </div>
                ) : selectedDataset ? (
                  <DatasetViewer
                    dataset={selectedDataset}
                    onTitleDoubleClick={beginRename}
                    actions={
                      <ActionsMenu
                        label={`Actions for ${selectedDataset.name || "dataset"}`}
                        items={[
                          { label: "Rename", onSelect: () => beginRename(selectedDataset) },
                          { label: "Duplicate", disabled: Boolean(datasetMutation), onSelect: () => void duplicateDataset(selectedDataset) },
                          { label: "Delete", destructive: true, disabled: Boolean(datasetMutation), onSelect: () => void deleteDataset(selectedDataset) },
                        ]}
                      />
                    }
                    titleEditor={renameOpen ? (
                      <>
                      <h3
                        className="dataset-title-editor"
                        ref={renameTitleRef}
                        contentEditable={!renameBusy}
                        suppressContentEditableWarning
                        role="textbox"
                        aria-label="Dataset name"
                        aria-multiline="false"
                        onInput={(event) => setRenameName(event.currentTarget.textContent || "")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void renameDataset();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setRenameName(selectedDataset.name || "");
                            setRenameError("");
                            setRenameOpen(false);
                          }
                        }}
                        onBlur={() => {
                          if (renameOpen) void renameDataset();
                        }}
                      >
                        {renameName}
                      </h3>
                      {renameError && (
                        <span className="error dataset-title-edit-error" role="alert">
                          {renameError}
                        </span>
                      )}
                      </>
                    ) : undefined}
                  />
                ) : (
                  <Empty
                    icon="▦"
                    title="No completed dataset yet"
                    text="Generated datasets will appear here when they finish, or import a JSONL manifest to get started."
                  />
                )}
              </section>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

const datasetSearchText = (item: Dataset["cases"][number]) =>
  [
    item.caseId,
    item.inputText,
    item.referenceTranscription,
    pretty(item.expected),
    pretty(item.metadata),
  ]
    .filter((value) => value !== undefined)
    .join("\n")
    .toLowerCase();

const datasetDisplayValue = (value: Json | undefined, fallback = "—") => {
  if (value === undefined) return fallback;
  const rendered = pretty(value);
  return rendered === "" ? "(empty)" : rendered;
};

const datasetJsonlFallback = (dataset: Dataset) =>
  dataset.cases
    .map((item) => {
      const record: Record<string, unknown> = { caseId: item.caseId };
      const imagePath = item.originalImagePath || item.imagePath;
      if (imagePath) record.imagePath = imagePath;
      if (item.inputText !== undefined) record.inputText = item.inputText;
      if (item.expected !== undefined) record.expected = item.expected;
      if (item.referenceTranscription !== undefined)
        record.referenceTranscription = item.referenceTranscription;
      if (item.metadata !== undefined) record.metadata = item.metadata;
      return JSON.stringify(record);
    })
    .join("\n") + (dataset.cases.length ? "\n" : "");

const providerLabel = (target: Target) =>
  target.provider === "openrouter"
    ? "OpenRouter"
    : target.provider === "llama.cpp"
      ? "Local llama.cpp"
      : /openai\.com/i.test(target.baseUrl)
        ? "OpenAI"
        : "OpenAI-compatible";

function DatasetViewer({ dataset, onTitleDoubleClick, titleEditor, actions }: { dataset: Dataset; onTitleDoubleClick?: () => void; titleEditor?: ReactNode; actions?: ReactNode }) {
  const taskKind = datasetTaskKind(dataset);
  const [query, setQuery] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(
    dataset.cases[0]?.caseId || null,
  );
  const [maximized, setMaximized] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState(() => datasetJsonlFallback(dataset));
  const [rawBusy, setRawBusy] = useState(false);
  const [rawCopied, setRawCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const rawDialog = useRef<HTMLDialogElement>(null);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const viewerKey =
    dataset.version.replace(/[^a-zA-Z0-9_-]/g, "-") || "dataset";
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCases = dataset.cases.filter(
    (item) =>
      !normalizedQuery || datasetSearchText(item).includes(normalizedQuery),
  );
  const selectedCase =
    visibleCases.find((item) => item.caseId === selectedCaseId) ||
    visibleCases[0] ||
    null;

  useEffect(() => {
    setQuery("");
    setSelectedCaseId(dataset.cases[0]?.caseId || null);
    setMaximized(false);
    setRawOpen(false);
    setRawText(datasetJsonlFallback(dataset));
  }, [dataset.version]);

  useEffect(() => {
    const node = rawDialog.current;
    if (!node) return;
    if (rawOpen && !node.open) {
      node.showModal();
      setRawBusy(true);
      void api<string>(
        `/api/datasets/${encodeURIComponent(dataset.version)}/jsonl`,
      )
        .then(setRawText)
        .catch(() => setRawText(datasetJsonlFallback(dataset)))
        .finally(() => setRawBusy(false));
      window.requestAnimationFrame(() =>
        node.querySelector<HTMLElement>("[data-raw-close]")?.focus(),
      );
    } else if (!rawOpen && node.open) {
      node.close();
    }
  }, [dataset, rawOpen]);

  useEffect(() => {
    const nextCaseId = selectedCase?.caseId || null;
    if (nextCaseId !== selectedCaseId) setSelectedCaseId(nextCaseId);
  }, [selectedCase?.caseId, selectedCaseId]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (maximized && !node.open) {
      node.showModal();
      window.requestAnimationFrame(() => {
        node.querySelector<HTMLElement>("[data-dialog-close]")?.focus();
      });
    } else if (!maximized && node.open) {
      node.close();
    }
  }, [maximized]);

  const closeDialog = () => {
    if (dialog.current?.open) dialog.current.close();
    else setMaximized(false);
  };
  const closeRaw = () => {
    if (rawDialog.current?.open) rawDialog.current.close();
    else setRawOpen(false);
  };
  const downloadRaw = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([rawText], { type: "application/jsonl" }),
    );
    link.download = `${(dataset.name || "dataset").replace(/[^a-z0-9._-]+/gi, "-")}.jsonl`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <>
      <div className="dataset-viewer">
        <DatasetHeader
          dataset={dataset}
          onTitleDoubleClick={onTitleDoubleClick}
          titleEditor={titleEditor}
          taskKind={taskKind}
          isOpen={maximized}
          onMaximize={() => setMaximized(true)}
          onRaw={() => setRawOpen(true)}
          maximizeButtonRef={maximizeButton}
          actions={actions}
        />
        <DatasetViewerSurface
          dataset={dataset}
          taskKind={taskKind}
          query={query}
          onQueryChange={setQuery}
          visibleCases={visibleCases}
          selectedCase={selectedCase}
          onSelectCase={setSelectedCaseId}
          idPrefix={`${viewerKey}-inline`}
        />
      </div>
      <dialog
        ref={dialog}
        className="dataset-viewer-dialog"
        aria-labelledby={`${viewerKey}-dialog-title`}
        onClose={() => {
          setMaximized(false);
          window.requestAnimationFrame(() => maximizeButton.current?.focus());
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="dataset-dialog-shell">
          <DatasetHeader
            dataset={dataset}
            taskKind={taskKind}
            titleId={`${viewerKey}-dialog-title`}
            onClose={closeDialog}
          />
          <DatasetViewerSurface
            dataset={dataset}
            taskKind={taskKind}
            query={query}
            onQueryChange={setQuery}
            visibleCases={visibleCases}
            selectedCase={selectedCase}
            onSelectCase={setSelectedCaseId}
            idPrefix={`${viewerKey}-dialog`}
            expanded
          />
        </div>
      </dialog>
      <dialog
        ref={rawDialog}
        className="dataset-raw-dialog"
        aria-labelledby={`${viewerKey}-raw-title`}
        onClose={() => {
          setRawOpen(false);
          setRawCopied(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) rawDialog.current?.close();
        }}
      >
        <div className="dataset-raw-shell">
          <div className="dataset-raw-header">
            <div>
              <span className="eyebrow">RAW DATASET</span>
              <h3 id={`${viewerKey}-raw-title`}>JSONL view</h3>
              <p>One case per line, using the dataset’s canonical records.</p>
            </div>
            <div className="dataset-raw-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(rawText).then(() => {
                    setRawCopied(true);
                    window.setTimeout(() => setRawCopied(false), 1800);
                  });
                }}
                disabled={rawBusy}
              >
                {rawCopied ? "Copied" : "Copy JSONL"}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={downloadRaw}
                disabled={rawBusy}
              >
                Download
              </button>
              <button
                type="button"
                className="button secondary"
                data-raw-close
                onClick={closeRaw}
              >
                Close
              </button>
            </div>
          </div>
          <pre
            className="dataset-raw-code"
            tabIndex={0}
            aria-label="Raw dataset JSONL"
          >
            {rawBusy ? "Loading JSONL…" : <HighlightedJson text={rawText} />}
          </pre>
        </div>
      </dialog>
    </>
  );
}

function DatasetHeader({
  dataset,
  onTitleDoubleClick,
  titleEditor,
  taskKind,
  titleId,
  isOpen,
  onMaximize,
  onRaw,
  onClose,
  maximizeButtonRef,
  actions,
}: {
  actions?: ReactNode;
  dataset: Dataset;
  onTitleDoubleClick?: () => void;
  titleEditor?: ReactNode;
  taskKind: TaskKind;
  titleId?: string;
  isOpen?: boolean;
  onMaximize?: () => void;
  onRaw?: () => void;
  onClose?: () => void;
  maximizeButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const isDialog = Boolean(onClose);
  return (
    <div
      className={`dataset-header ${isDialog ? "dataset-header-dialog" : ""}`}
    >
      <div className="dataset-title-group">
        <span className="dataset-icon" aria-hidden="true">
          ▦
        </span>
        <div className="dataset-title-content">
          <div className="dataset-title-line">
            {titleEditor ?? (
              <h3 id={titleId} onDoubleClick={onTitleDoubleClick}>
                {dataset.name || "Untitled dataset"}
              </h3>
            )}
            <span className="tag dataset-kind">
              {TASK_KIND_LABELS[taskKind]}
            </span>
          </div>
          <div className="dataset-meta">
            <span className="data-version" title={dataset.version}>
              Version {dataset.version.slice(0, 8)}
            </span>
          </div>
        </div>
      </div>
      <div className="dataset-header-actions">
        <span
          className="dataset-case-count"
          aria-label={`${dataset.cases.length} ${dataset.cases.length === 1 ? "case" : "cases"}`}
        >
          <strong>{dataset.cases.length}</strong>
          <span>{dataset.cases.length === 1 ? "case" : "cases"}</span>
        </span>
        {onMaximize && (
          <button
            ref={maximizeButtonRef}
            type="button"
            className="button secondary dataset-maximize"
            aria-label={`Open full viewer for ${dataset.name || "dataset"}`}
            title="Open full dataset viewer"
            aria-haspopup="dialog"
            aria-expanded={isOpen ?? false}
            onClick={onMaximize}
          >
            <span aria-hidden="true">⤢</span>
            <span>Open viewer</span>
          </button>
        )}
        {onRaw && (
          <button
            type="button"
            className="button secondary dataset-raw-button"
            onClick={onRaw}
          >
            <span aria-hidden="true">{`{}`}</span>
            <span>Raw JSONL</span>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="button secondary dataset-close"
            data-dialog-close
            onClick={onClose}
          >
            Close
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}

function DatasetViewerSurface({
  dataset,
  taskKind,
  query,
  onQueryChange,
  visibleCases,
  selectedCase,
  onSelectCase,
  idPrefix,
  expanded = false,
}: {
  dataset: Dataset;
  taskKind: TaskKind;
  query: string;
  onQueryChange: (value: string) => void;
  visibleCases: Dataset["cases"];
  selectedCase: Dataset["cases"][number] | null;
  onSelectCase: (caseId: string) => void;
  idPrefix: string;
  expanded?: boolean;
}) {
  const searchId = `${idPrefix}-search`;
  const previewDialog = useRef<HTMLDialogElement>(null);
  const previewBody = useRef<HTMLDivElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const selectedIndex = visibleCases.findIndex((item) => item.caseId === selectedCase?.caseId);
  const selectCase = (caseId: string) => {
    onSelectCase(caseId);
    if (window.matchMedia("(max-width: 960px)").matches) setPreviewOpen(true);
  };
  useEffect(() => {
    const node = previewDialog.current;
    if (previewOpen && node && !node.open) node.showModal();
    if (!previewOpen && node?.open) node.close();
  }, [previewOpen]);
  useEffect(() => {
    if (previewBody.current) previewBody.current.scrollTop = 0;
  }, [selectedCase?.caseId]);
  useEffect(() => {
    setPreviewOpen(false);
  }, [dataset.version]);
  useEffect(() => {
    if (!previewOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [previewOpen]);
  const casesHeadingId = `${idPrefix}-cases-heading`;
  const isDocumentWorkflow = taskKind === "document-json";
  const isToolWorkflow = taskKind === "tool-calling";
  const expectedLabel = isToolWorkflow
    ? "Expected tool calls"
    : "Expected JSON";
  return (
    <div
      className={`dataset-browser ${expanded ? "dataset-browser-expanded" : ""}`}
    >
      <div className="dataset-viewer-toolbar">
        <label className="dataset-search" htmlFor={searchId}>
          <span className="sr-only">Search cases by ID or text</span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Case ID or text"
            aria-describedby={`${searchId}-hint`}
          />
          <span id={`${searchId}-hint`} className="sr-only">
            Searches case IDs, input text, reference text, and expected output.
          </span>
        </label>
        <div className="dataset-toolbar-meta">
          {query.trim() && (
            <button
              type="button"
              className="text-button dataset-clear-search"
              onClick={() => onQueryChange("")}
            >
              Clear search
            </button>
          )}
          <span
            className="dataset-result-count"
            role="status"
            aria-live="polite"
          >
            {visibleCases.length} of {dataset.cases.length} cases shown
          </span>
        </div>
      </div>
      <div className="dataset-workspace">
        <section
          className="dataset-table-section"
          aria-labelledby={casesHeadingId}
        >
          <div className="dataset-section-heading">
            <div>
              <h4 id={casesHeadingId}>Cases</h4>
              <p>Choose a row to inspect the complete case.</p>
              <span className="dataset-table-hint">
                Swipe the table sideways to see more columns.
              </span>
            </div>
          </div>
          {visibleCases.length ? (
            <div className="dataset-table-wrap" tabIndex={0}>
              <table
                className={`dataset-table ${isDocumentWorkflow ? "dataset-table-document" : ""}`}
                aria-label={`${dataset.name || "Dataset"} cases`}
              >
                <caption className="sr-only">
                  {dataset.name || "Dataset"} cases. Select a row to open its
                  detail inspector.
                </caption>
                <thead>
                  <tr>
                    {isDocumentWorkflow && <th scope="col">Preview</th>}
                    <th scope="col">Case ID</th>
                    <th scope="col">
                      {isDocumentWorkflow
                        ? "Reference transcription"
                        : "Input text"}
                    </th>
                    <th scope="col">{expectedLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCases.map((item) => (
                    <DatasetTableRow
                      key={item.caseId}
                      dataset={dataset}
                      taskKind={taskKind}
                      item={item}
                      selected={item.caseId === selectedCase?.caseId}
                      onSelect={() => selectCase(item.caseId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dataset-filter-empty" role="status">
              <strong>
                {dataset.cases.length
                  ? "No matching cases"
                  : "No cases in this dataset"}
              </strong>
              <span>
                {dataset.cases.length
                  ? "Try a different case ID or text search."
                  : "Import a manifest with at least one case to browse it here."}
              </span>
            </div>
          )}
        </section>
        <DatasetDetail
          dataset={dataset}
          taskKind={taskKind}
          item={selectedCase}
          idPrefix={idPrefix}
        />
      </div>
      <dialog
        ref={previewDialog}
        className="dataset-case-dialog"
        aria-label="Case preview"
        onClose={() => setPreviewOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPreviewOpen(false);
        }}
      >
        <div className="dataset-case-dialog-shell">
          <div className="dataset-case-dialog-toolbar">
            <span aria-live="polite">{selectedIndex + 1} / {visibleCases.length}</span>
            <div className="dataset-case-dialog-navigation">
            <button type="button" className="button secondary" disabled={selectedIndex <= 0} onClick={() => onSelectCase(visibleCases[selectedIndex - 1].caseId)}>← Prev</button>
            <button type="button" className="button secondary" disabled={selectedIndex < 0 || selectedIndex >= visibleCases.length - 1} onClick={() => onSelectCase(visibleCases[selectedIndex + 1].caseId)}>Next →</button>
            </div>
            <button type="button" className="button secondary" onClick={() => setPreviewOpen(false)}>Close</button>
          </div>
          <div className="dataset-case-dialog-body" ref={previewBody}>
            {previewOpen && <DatasetDetail dataset={dataset} taskKind={taskKind} item={selectedCase} idPrefix={`${idPrefix}-preview`} />}
          </div>
        </div>
      </dialog>
    </div>
  );
}

function DatasetTableRow({
  dataset,
  taskKind,
  item,
  selected,
  onSelect,
}: {
  dataset: Dataset;
  taskKind: TaskKind;
  item: Dataset["cases"][number];
  selected: boolean;
  onSelect: () => void;
}) {
  const isDocumentWorkflow = taskKind === "document-json";
  const isToolWorkflow = taskKind === "tool-calling";
  const image = item.imagePath
    ? `/api/datasets/${encodeURIComponent(dataset.version)}/cases/${encodeURIComponent(item.caseId)}/image`
    : "";
  return (
    <tr
      className={selected ? "dataset-table-row selected" : "dataset-table-row"}
      tabIndex={0}
      aria-selected={selected}
      aria-label={`Select case ${item.caseId}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {isDocumentWorkflow && (
        <td className="dataset-preview-cell">
          {image ? (
            <ZoomableImage
              className="dataset-thumb"
              src={image}
              alt={`Document ${item.caseId}`}
            />
          ) : (
            <span className="dataset-no-image">No image</span>
          )}
        </td>
      )}
      <td className="dataset-case-id-cell">
        <strong>{item.caseId}</strong>
      </td>
      <td>
        <DatasetTableValue
          value={
            isDocumentWorkflow ? item.referenceTranscription : item.inputText
          }
          empty={isDocumentWorkflow ? "No reference text" : "No input text"}
        />
      </td>
      <td>
        <DatasetTableValue
          value={item.expected}
          empty={isToolWorkflow ? "Not labeled" : "Not labeled"}
          code
        />
      </td>
    </tr>
  );
}

function DatasetTableValue({
  value,
  empty,
  code = false,
}: {
  value: Json | undefined;
  empty: string;
  code?: boolean;
}) {
  const text = datasetDisplayValue(value, empty);
  return (
    <span
      className={`dataset-table-value ${code ? "dataset-table-value-code" : ""}`}
      title={text}
    >
      {code ? <HighlightedJson text={text} /> : text}
    </span>
  );
}

function DatasetDetail({
  dataset,
  taskKind,
  item,
  idPrefix,
}: {
  dataset: Dataset;
  taskKind: TaskKind;
  item: Dataset["cases"][number] | null;
  idPrefix: string;
}) {
  if (!item) {
    return (
      <aside
        className="dataset-detail dataset-detail-empty"
        aria-label="Case detail inspector"
      >
        <span className="placeholder-icon" aria-hidden="true">
          □
        </span>
        <h4>Select a case</h4>
        <p>
          Choose a row above to inspect the full input, image, and expected
          output.
        </p>
      </aside>
    );
  }
  const isToolWorkflow = taskKind === "tool-calling";
  const detailId = `${idPrefix}-${item.caseId.replace(/[^a-zA-Z0-9_-]/g, "-")}-detail`;
  const caseNumber =
    dataset.cases.findIndex((candidate) => candidate.caseId === item.caseId) +
    1;
  const image = item.imagePath
    ? `/api/datasets/${encodeURIComponent(dataset.version)}/cases/${encodeURIComponent(item.caseId)}/image`
    : "";
  return (
    <aside className="dataset-detail" aria-labelledby={detailId} tabIndex={-1}>
      <div className="dataset-detail-heading">
        <div>
          <span className="eyebrow">SELECTED CASE</span>
          <h4 id={detailId}>{item.caseId}</h4>
        </div>
        <span className="dataset-detail-position">
          {caseNumber} of {dataset.cases.length}
        </span>
      </div>
      {image && (
        <div className="dataset-detail-image">
          <ZoomableImage src={image} alt={`Document ${item.caseId}`} />
          <span>Click image to zoom</span>
        </div>
      )}
      <div className="dataset-detail-blocks">
        {item.inputText !== undefined && (
          <DatasetDetailBlock title="Input text" value={item.inputText} />
        )}
        {item.referenceTranscription !== undefined && (
          <DatasetDetailBlock
            title="Reference transcription"
            value={item.referenceTranscription}
          />
        )}
        <DatasetDetailBlock
          title={isToolWorkflow ? "Expected tool calls" : "Expected JSON"}
          value={item.expected}
          empty={
            isToolWorkflow
              ? "Expected tool calls are not labeled."
              : "Expected JSON is not labeled."
          }
          code
        />
        {item.metadata !== undefined && (
          <DatasetDetailBlock title="Metadata" value={item.metadata} code />
        )}
        {(item.imagePath || item.imageHash) && (
          <div className="dataset-asset-meta">
            <span>
              <b>Image path</b>
              <code>{item.imagePath || "No image"}</code>
            </span>
            <span>
              <b>Image hash</b>
              <code>{item.imageHash || "No hash"}</code>
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

function DatasetDetailBlock({
  title,
  value,
  empty,
  code = false,
}: {
  title: string;
  value: Json | undefined;
  empty?: string;
  code?: boolean;
}) {
  return (
    <section
      className={`dataset-detail-block ${code ? "dataset-detail-json" : ""}`}
    >
      <h5>{title}</h5>
      <pre tabIndex={0} aria-label={title}>
        {code ? (
          <HighlightedJson text={datasetDisplayValue(value, empty || "Not supplied")} />
        ) : (
          <code>{datasetDisplayValue(value, empty || "Not supplied")}</code>
        )}
      </pre>
    </section>
  );
}

function ModelPicker({
  value,
  onManualChange,
  onSelect,
  endpoint,
  providerName,
}: {
  value: string;
  onManualChange: (value: string) => void;
  onSelect: (model: ModelCatalogModel) => void;
  endpoint: string;
  providerName: string;
}) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(!value);
  const [filters, setFilters] = useState({
    vision: false,
    structured: false,
    tools: false,
    free: false,
  });
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCatalogError("");
    void api<ModelCatalogResponse>(endpoint)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((error) => {
        if (!cancelled)
          setCatalogError(
            error instanceof Error
              ? error.message
              : `Could not load models from ${providerName}.`,
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogAttempt, endpoint, providerName]);
  const search = query.trim().toLowerCase();
  const filteredModels = (catalog?.models || [])
    .filter((model) => {
      const capabilities = modelCapabilities(model);
      const matchesSearch =
        !search ||
        search
          .split(/\s+/)
          .every((term) => `${model.id} ${model.name} ${model.description || ""}`.toLowerCase().includes(term));
      return (
        matchesSearch &&
        (!filters.vision || capabilities.vision) &&
        (!filters.structured || capabilities.structured) &&
        (!filters.tools || capabilities.tools) &&
        (!filters.free || capabilities.free)
      );
    })
    .sort((left, right) => {
      if (!search) return left.name.localeCompare(right.name);
      const score = (model: ModelCatalogModel) => {
        const id = model.id.toLowerCase();
        const name = model.name.toLowerCase();
        if (id === search) return 0;
        if (id.startsWith(search)) return 1;
        if (name.startsWith(search)) return 2;
        return 3;
      };
      return score(left) - score(right) || left.name.localeCompare(right.name);
    });
  const selectedModel = catalog?.models.find((model) => model.id === value);
  const narrowing = Boolean(search) || Object.values(filters).some(Boolean);
  const catalogSource =
    catalog?.source === "openrouter" ? "OpenRouter's live model list" : `the models ${providerName} reports`;
  const typedId = query.trim();
  const canUseTyped =
    typedId.length > 0 && !/\s/.test(typedId) && !(catalog?.models || []).some((model) => model.id === typedId);
  const filterChips: [keyof typeof filters, string][] = [
    ["vision", "Reads images"],
    ["structured", "JSON schema"],
    ["tools", "Tools"],
    ...(providerName === "OpenRouter" ? ([["free", "Free"]] as [keyof typeof filters, string][]) : []),
  ];
  const choose = (model: ModelCatalogModel) => {
    onSelect(model);
    setBrowsing(false);
    setQuery("");
  };
  const capabilityBadges = (model: ModelCatalogModel) => {
    const capabilities = modelCapabilities(model);
    return (
      <span className="model-badges">
        {capabilities.vision && <span>Images</span>}
        {capabilities.structured && <span>JSON</span>}
        {capabilities.tools && <span>Tools</span>}
        {capabilities.free && providerName === "OpenRouter" && <span>Free</span>}
      </span>
    );
  };
  return (
    <div className="model-picker">
      <span className="field-label" id="model-picker-label">
        Model
      </span>
      {value && !browsing ? (
        <div className="model-selected">
          <span className="model-option-name">
            <strong>{selectedModel?.name || value}</strong>
            <code>{value}</code>
          </span>
          {selectedModel && capabilityBadges(selectedModel)}
          <button type="button" className="button secondary" onClick={() => setBrowsing(true)}>
            Change
          </button>
        </div>
      ) : (
        <div className="model-browser">
          <input
            type="search"
            aria-labelledby="model-picker-label"
            autoFocus={Boolean(value)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (filteredModels[0]) choose(filteredModels[0]);
                else if (canUseTyped) {
                  onManualChange(typedId);
                  setBrowsing(false);
                  setQuery("");
                }
              }
              if (event.key === "Escape" && value) setBrowsing(false);
            }}
            placeholder={`Search ${providerName} models, or type a model ID`}
          />
          <div className="model-filter-chips" role="group" aria-label="Only show models that">
            {filterChips.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filters[key]}
                className={filters[key] ? "chip-toggle on" : "chip-toggle"}
                onClick={() => setFilters((current) => ({ ...current, [key]: !current[key] }))}
              >
                {label}
              </button>
            ))}
            <span className="model-picker-status" aria-live="polite">
              {loading
                ? `Loading ${providerName} models…`
                : catalogError
                  ? "Couldn't load the model list."
                  : narrowing
                    ? `${filteredModels.length} of ${catalog?.models.length || 0}`
                    : ""}
              {catalogError && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
                >
                  Retry
                </button>
              )}
            </span>
          </div>
          {!narrowing && !loading && !catalogError && (
            <p className="model-picker-idle">
              {catalog?.models.length || 0} models from {catalogSource}
              {catalog?.cachedAt &&
                ` · updated ${new Date(catalog.cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              {catalog?.stale ? " (offline copy)" : ""}. Type a name like “qwen vl”, or pick a filter.
            </p>
          )}
          {(narrowing || catalogError) && (
          <div className="model-picker-results" role="listbox" aria-labelledby="model-picker-label">
            {canUseTyped && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="model-option model-option-manual"
                onClick={() => {
                  onManualChange(typedId);
                  setBrowsing(false);
                  setQuery("");
                }}
              >
                <span className="model-option-name">
                  <strong>Use “{typedId}”</strong>
                  <code>Enter this model ID exactly as your provider shows it</code>
                </span>
              </button>
            )}
            {!loading &&
              !catalogError &&
              filteredModels.slice(0, 60).map((model) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={model.id === value}
                  className={model.id === value ? "model-option selected" : "model-option"}
                  key={model.id}
                  onClick={() => choose(model)}
                >
                  <span className="model-option-name">
                    <strong>{model.name || model.id}</strong>
                    <code>{model.id}</code>
                  </span>
                  {capabilityBadges(model)}
                  <small>
                    {modelContextLabel(model.contextLength)}
                    {providerName === "OpenRouter" &&
                      (modelCapabilities(model).free
                        ? " · free"
                        : ` · ${modelPriceLabel(model.promptPrice)} in, ${modelPriceLabel(model.completionPrice)} out`)}
                  </small>
                </button>
              ))}
            {!loading && !catalogError && !filteredModels.length && !canUseTyped && (
              <p className="model-picker-empty">No models match. Try fewer filters, or type the exact model ID.</p>
            )}
            {catalogError && (
              <p className="model-picker-empty">
                {catalogError} You can still type the model ID above.
              </p>
            )}
            {filteredModels.length > 60 && (
              <p className="model-picker-empty">Showing 60 of {filteredModels.length}. Keep typing to narrow it down.</p>
            )}
          </div>
          )}
          {value && (
            <button type="button" className="text-button model-picker-cancel" onClick={() => setBrowsing(false)}>
              Keep {value}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type ProviderPreset = {
  id: string;
  label: string;
  provider: NonNullable<Target["provider"]>;
  baseUrl: string;
  needsKey: boolean;
  hint: string;
};
const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openrouter", label: "OpenRouter", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, hint: "Many cloud models, one key" },
  { id: "openai", label: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsKey: true, hint: "GPT models" },
  { id: "lmstudio", label: "LM Studio", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, hint: "Runs on this computer" },
  { id: "ollama", label: "Ollama", provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, hint: "Runs on this computer" },
  { id: "llamacpp", label: "llama.cpp", provider: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", needsKey: false, hint: "llama-server on this computer" },
  { id: "other", label: "Other", provider: "openai-compatible", baseUrl: "", needsKey: false, hint: "Any OpenAI-compatible URL" },
];
const presetForTarget = (target: Target) => {
  const url = target.baseUrl.replace(/\/$/, "");
  return (
    PROVIDER_PRESETS.find((preset) => preset.provider === target.provider && preset.baseUrl === url) ??
    PROVIDER_PRESETS.find((preset) =>
      target.provider === "openrouter" ? preset.id === "openrouter" : target.provider === "llama.cpp" ? preset.id === "llamacpp" : preset.id === "other",
    )!
  );
};
const CAPABILITY_LABELS = {
  supportsVision: "Can read images",
  supportsStructuredOutput: "Follows a JSON schema",
  supportsTools: "Can call tools",
} as const;
const targetNameFromModel = (model: string, taken: string[]) => {
  const base =
    (model.split("/").pop() || "model")
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model";
  let name = base;
  for (let index = 2; taken.includes(name); index++) name = `${base}-${index}`;
  return name;
};
const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};
const keyProviderLabel = (baseUrl: string) => {
  const url = normalizeBaseUrl(baseUrl);
  const preset = PROVIDER_PRESETS.find((item) => item.baseUrl && item.baseUrl === url);
  if (preset) return preset.label;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const hasProviderKey = (keys: ProviderKey[], baseUrl: string) =>
  Boolean(baseUrl.trim()) && keys.some((key) => key.baseUrl === normalizeBaseUrl(baseUrl));
type TargetTestResult = { ok: boolean; message: string };
const targetMissingKey = (target: Target) =>
  presetForTarget(target).needsKey && !target.hasApiKey && !target.apiKeyEnv;
const emptyTarget = (preset: ProviderPreset): Target => ({
  name: "",
  baseUrl: preset.baseUrl,
  provider: preset.provider,
  model: "",
  apiKeyEnv: "",
  apiKey: "",
  supportsVision: false,
  supportsStructuredOutput: false,
  supportsTools: false,
});
const testTarget = async (name: string, vision: boolean): Promise<TargetTestResult> => {
  try {
    const result = await api<{ message?: string }>(`/api/targets/${encodeURIComponent(name)}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vision }),
    });
    return { ok: true, message: result.message || "Connected. The model answered." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Connection test failed" };
  }
};

function SchemaStatus({ check, validLabel }: { check: SchemaCheck | null; validLabel: string }) {
  if (!check) return null;
  if (!check.issues.length)
    return (
      <p className="schema-status ok" role="status">
        ✓ {validLabel}
      </p>
    );
  const shown = check.issues.slice(0, 4);
  return (
    <ul className="schema-status" role="status" aria-label="Schema check">
      {shown.map((issue, index) => (
        <li key={`${issue.path}-${index}`} className={issue.severity}>
          <span aria-hidden="true">{issue.severity === "error" ? "✗" : "!"}</span>
          <span>
            {issue.path !== "/" && <code>{issue.path}</code>} {issue.message}
          </span>
        </li>
      ))}
      {check.issues.length > shown.length && (
        <li className="more">and {check.issues.length - shown.length} more</li>
      )}
    </ul>
  );
}
type DropdownOption = {
  value: string;
  label: string;
  detail?: string;
  badges?: string[];
  group?: string;
  disabled?: boolean;
};
let dropdownCount = 0;
function Dropdown({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  labelledBy,
  ariaLabel,
  disabled,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  labelledBy?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [id] = useState(() => `dropdown-${++dropdownCount}`);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchable = options.length > 8;
  const visible = query.trim()
    ? options.filter((option) =>
        `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;
  const selected = options.find((option) => option.value === value);
  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  };
  const pick = (option?: DropdownOption) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  };
  useEffect(() => {
    if (!open) return;
    const index = visible.findIndex((option) => option.value === value);
    setActive(index >= 0 ? index : 0);
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", outside);
    requestAnimationFrame(() =>
      (root.current?.querySelector<HTMLElement>(".dropdown-search") ?? list.current)?.focus(),
    );
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const move = (delta: number) => {
      event.preventDefault();
      if (!visible.length) return;
      let next = active;
      for (let step = 0; step < visible.length; step++) {
        next = (next + delta + visible.length) % visible.length;
        if (!visible[next].disabled) break;
      }
      setActive(next);
    };
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(visible.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(visible[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") close(false);
  };
  let lastGroup: string | undefined;
  return (
    <div className={`dropdown${open ? " open" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}-value` : undefined}
        aria-label={labelledBy ? undefined : ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="dropdown-value" id={`${id}-value`}>
          {selected ? (
            <>
              <strong>{selected.label}</strong>
              {selected.detail && <small>{selected.detail}</small>}
            </>
          ) : (
            <span className="dropdown-placeholder">{placeholder}</span>
          )}
        </span>
        <span className="dropdown-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="dropdown-popover">
          {searchable && (
            <input
              className="dropdown-search"
              type="search"
              aria-label="Filter options"
              value={query}
              placeholder="Type to filter"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
          )}
          <div
            ref={list}
            id={`${id}-list`}
            className="dropdown-list"
            role="listbox"
            tabIndex={-1}
            aria-labelledby={labelledBy}
            aria-activedescendant={visible[active] ? `${id}-option-${active}` : undefined}
            onKeyDown={onKeyDown}
          >
            {visible.map((option, index) => {
              const header = option.group && option.group !== lastGroup ? option.group : null;
              lastGroup = option.group;
              return (
                <div key={option.value || `empty-${index}`} role="presentation">
                  {header && (
                    <div className="dropdown-group" role="presentation">
                      {header}
                    </div>
                  )}
                  <div
                    id={`${id}-option-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    className={`dropdown-option${index === active ? " active" : ""}${option.value === value ? " selected" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(option)}
                  >
                    <span className="dropdown-option-text">
                      <strong>{option.label}</strong>
                      {option.detail && <small>{option.detail}</small>}
                    </span>
                    {option.badges?.length ? (
                      <span className="model-badges">
                        {option.badges.map((badge) => (
                          <span key={badge}>{badge}</span>
                        ))}
                      </span>
                    ) : null}
                    {option.value === value && (
                      <span className="dropdown-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {!visible.length && <p className="dropdown-empty">No matches</p>}
          </div>
        </div>
      )}
    </div>
  );
}
const targetOptions = (targets: Target[], empty = "Choose a model"): DropdownOption[] => [
  { value: "", label: empty },
  ...targets.map((target) => ({
    value: target.name,
    label: target.name,
    detail: target.model,
    badges: [
      ...(target.supportsVision ? ["Images"] : []),
      ...(target.supportsStructuredOutput ? ["JSON"] : []),
      ...(target.supportsTools ? ["Tools"] : []),
    ],
  })),
];

function ActionsMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; destructive?: boolean; disabled?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="actions-menu" ref={ref}>
      <button
        type="button"
        className="icon-btn actions-menu-toggle"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div className="actions-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.destructive ? "destructive" : undefined}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetForm({
  initial,
  initialPresetId,
  targets,
  providerKeys: suppliedKeys,
  onSaved,
  onCancel,
  onNotice,
}: {
  initial?: Target;
  /** Provider preselected for a new model. */
  initialPresetId?: string;
  targets: Target[];
  /** Saved provider keys; loaded by the form itself when the parent doesn't supply them. */
  providerKeys?: ProviderKey[];
  onSaved: (target: Target, test?: TargetTestResult) => void;
  onCancel?: () => void;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
}) {
  const isEdit = Boolean(initial);
  const startPreset = PROVIDER_PRESETS.find((item) => item.id === initialPresetId) ?? PROVIDER_PRESETS[0];
  const [preset, setPreset] = useState<ProviderPreset>(() =>
    initial ? presetForTarget(initial) : startPreset,
  );
  const [editing, setEditing] = useState<Target>(() =>
    initial ? { ...initial, apiKey: "" } : emptyTarget(startPreset),
  );
  const [nameTouched, setNameTouched] = useState(isEdit);
  const [ownKeyOpen, setOwnKeyOpen] = useState(false);
  const [useSharedKey, setUseSharedKey] = useState(false);
  const [loadedKeys, setLoadedKeys] = useState<ProviderKey[]>([]);
  useEffect(() => {
    if (suppliedKeys) return;
    void api<ProviderKey[]>("/api/provider-keys")
      .then(setLoadedKeys)
      .catch(() => setLoadedKeys([]));
  }, [suppliedKeys]);
  const providerKeys = suppliedKeys ?? loadedKeys;
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [result, setResult] = useState<TargetTestResult | null>(null);
  const takenNames = targets.map((target) => target.name).filter((name) => name !== initial?.name);
  const update = (patch: Partial<Target>) => {
    setResult(null);
    setEditing((current) => {
      const next = { ...current, ...patch };
      if (!nameTouched && !isEdit && patch.model !== undefined)
        next.name = patch.model ? targetNameFromModel(patch.model, takenNames) : "";
      return next;
    });
  };
  const choosePreset = (next: ProviderPreset) => {
    setPreset(next);
    update({ provider: next.provider, baseUrl: next.baseUrl || editing.baseUrl });
  };
  const savedTarget = targets.find((target) => target.name === editing.name);
  const discoveryEndpoint =
    editing.provider === "openrouter"
      ? "/api/models/openrouter"
      : savedTarget
        ? `/api/models/target/${encodeURIComponent(editing.name)}`
        : "";
  const selectDiscovered = (model: ModelCatalogModel) => {
    const capabilities = modelCapabilities(model);
    update({
      model: model.id,
      ...(capabilities.known
        ? {
            supportsVision: capabilities.vision,
            supportsStructuredOutput: capabilities.structured,
            supportsTools: capabilities.tools,
          }
        : {}),
    });
  };
  const sharedKey = hasProviderKey(providerKeys, editing.baseUrl);
  const ownKey = editing.keySource === "model" && !useSharedKey;
  const keyLabel = preset.id === "other" ? keyProviderLabel(editing.baseUrl) : preset.label;
  const persist = async () => {
    const name = editing.name.trim() || targetNameFromModel(editing.model, takenNames);
    return api<Target>(`/api/targets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...editing,
        name,
        keyScope: sharedKey ? "model" : "provider",
        ...(useSharedKey && !editing.apiKey?.trim() ? { clearApiKey: true } : {}),
      }),
    });
  };
  const submit = async (withTest: boolean) => {
    if (!editing.model.trim() || !editing.baseUrl.trim()) {
      setResult({ ok: false, message: editing.model.trim() ? "Enter the server URL under Advanced options." : "Enter a model ID." });
      return;
    }
    if (preset.needsKey && !sharedKey && !editing.hasApiKey && !editing.apiKeyEnv && !editing.apiKey?.trim()) {
      setResult({ ok: false, message: `${preset.label} needs an API key. Paste it above.` });
      return;
    }
    setBusy(withTest ? "test" : "save");
    try {
      const saved = await persist();
      setEditing({ ...saved, apiKey: "" });
      setNameTouched(true);
      const test = withTest ? await testTarget(saved.name, Boolean(saved.supportsVision)) : undefined;
      setResult(test ?? { ok: true, message: `Saved “${saved.name}”.` });
      onSaved(saved, test);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save model";
      setResult({ ok: false, message });
      onNotice(message, "error");
    } finally {
      setBusy("");
    }
  };
  const keyNeeded = preset.needsKey && !sharedKey && !editing.hasApiKey;
  const showKeyInput = !sharedKey || ownKey || ownKeyOpen;
  return (
    <form
      className="target-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <fieldset className="preset-grid" disabled={Boolean(busy)}>
        <legend>Where does the model run?</legend>
        {PROVIDER_PRESETS.map((item) => (
          <label key={item.id} className={`preset-card${preset.id === item.id ? " selected" : ""}`}>
            <input
              type="radio"
              name="provider-preset"
              checked={preset.id === item.id}
              onChange={() => choosePreset(item)}
            />
            <strong>{item.label}</strong>
            <span>{item.hint}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="target-form-fields" disabled={Boolean(busy)}>
        {(preset.needsKey || editing.hasApiKey || sharedKey || preset.id === "other") &&
          (showKeyInput ? (
            <label>
              <span>
                {sharedKey ? "API key for this model only" : "API key"}{" "}
                <span className="optional">{preset.needsKey && !sharedKey ? "required" : "optional"}</span>
              </span>
              <input
                type="password"
                required={keyNeeded}
                autoComplete="off"
                value={editing.apiKey || ""}
                onChange={(event) => update({ apiKey: event.target.value })}
                placeholder={
                  ownKey || (!sharedKey && editing.hasApiKey)
                    ? "Saved — enter a new key to replace it"
                    : sharedKey
                      ? "Paste a key for this model"
                      : preset.id === "other"
                        ? "Paste the key, if your server needs one"
                        : `Paste your ${preset.label} key`
                }
              />
              <small>
                {sharedKey
                  ? `Overrides your saved ${keyLabel} key for this model. `
                  : `Saved once for every ${keyLabel} model, encrypted on this computer. `}
                {sharedKey && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setOwnKeyOpen(false);
                      setUseSharedKey(true);
                      update({ apiKey: "" });
                    }}
                  >
                    Use the saved key instead
                  </button>
                )}
              </small>
            </label>
          ) : (
            <div className="key-status" role="status">
              <span aria-hidden="true">✓</span>
              <span>
                Uses your saved <strong>{keyLabel}</strong> key.{" "}
                <button type="button" className="link-button" onClick={() => setOwnKeyOpen(true)}>
                  Use a different key for this model
                </button>
              </span>
            </div>
          ))}
        {discoveryEndpoint ? (
          <ModelPicker
            value={editing.model}
            onManualChange={(model) => update({ model })}
            onSelect={selectDiscovered}
            endpoint={discoveryEndpoint}
            providerName={preset.id === "other" ? "your server" : preset.label}
          />
        ) : (
          <label>
            Model ID
            <input
              required
              value={editing.model}
              onChange={(event) => update({ model: event.target.value })}
              placeholder={preset.id === "openai" ? "gpt-4o-mini" : preset.id === "ollama" ? "llama3.2" : "qwen2.5-vl"}
            />
            <small>
              {preset.needsKey ? "The model name from your provider." : "The model name shown by your local server. Start the server first."}
            </small>
          </label>
        )}
        <label>
          Name
          <input
            value={editing.name}
            readOnly={isEdit}
            onChange={(event) => {
              setNameTouched(true);
              setEditing({ ...editing, name: event.target.value });
            }}
            placeholder="Filled in from the model"
          />
          <small>{isEdit ? "Names can't be changed after saving." : "How this model appears in Setup."}</small>
        </label>
        <AdvancedOptions>
          <label>
            Server URL
            <input
              required
              value={editing.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder="http://127.0.0.1:8080/v1"
            />
            <small>Usually ends in /v1.</small>
          </label>
          <fieldset className="checks">
            <legend>What can this model do?</legend>
            {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).map((key) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={Boolean(editing[key])}
                  onChange={(event) => update({ [key]: event.target.checked })}
                />
                {CAPABILITY_LABELS[key]}
              </label>
            ))}
            <small>Picking a model from the list fills these in when the provider reports them.</small>
          </fieldset>
        </AdvancedOptions>
      </fieldset>
      {result && (
        <p className={`test-result ${result.ok ? "ok" : "error"}`} role={result.ok ? "status" : "alert"}>
          <b aria-hidden="true">{result.ok ? "✓" : "✗"}</b> {result.message}
        </p>
      )}
      <div className="form-actions">
        <button className="button primary" type="submit" disabled={Boolean(busy)}>
          {busy === "test" ? "Testing…" : "Save & test"}
        </button>
        <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void submit(false)}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        {onCancel && (
          <button className="text-button" type="button" disabled={Boolean(busy)} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ProviderKeysPanel({
  keys,
  targets,
  onChanged,
  onNotice,
  onAddModel,
}: {
  keys: ProviderKey[];
  targets: Target[];
  onChanged: () => Promise<void>;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
  onAddModel: (presetId: string) => void;
}) {
  const [editingUrl, setEditingUrl] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem("local-evals-providers-panel");
      if (saved) return saved === "open";
    } catch {
      /* Panel preference is best-effort. */
    }
    return true;
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem("local-evals-providers-panel", next ? "open" : "closed");
    } catch {
      /* Panel preference is best-effort. */
    }
  };
  const rows = [
    ...PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      hint: preset.hint,
      baseUrl: preset.baseUrl,
      keyed: preset.needsKey,
      models: targets.filter((target) => presetForTarget(target).id === preset.id).length,
    })),
    ...keys
      .filter((key) => !PROVIDER_PRESETS.some((preset) => preset.baseUrl === key.baseUrl))
      .map((key) => ({
        id: key.baseUrl,
        label: keyProviderLabel(key.baseUrl),
        hint: "Custom server",
        baseUrl: key.baseUrl,
        keyed: true,
        models: key.models.length,
      })),
  ];
  const save = async (baseUrl: string) => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await api("/api/provider-keys", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey: value }),
      });
      setEditingUrl("");
      setValue("");
      await onChanged();
      onNotice(`${keyProviderLabel(baseUrl)} key saved. Every ${keyProviderLabel(baseUrl)} model uses it.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not save the key", "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (key: ProviderKey) => {
    const label = keyProviderLabel(key.baseUrl);
    if (
      !window.confirm(
        `Remove the saved ${label} key?${key.models.length ? `\n\n${key.models.length} model${key.models.length === 1 ? "" : "s"} will need a key again.` : ""}`,
      )
    )
      return;
    try {
      await api(`/api/provider-keys?baseUrl=${encodeURIComponent(key.baseUrl)}`, { method: "DELETE" });
      await onChanged();
      onNotice(`${label} key removed.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not remove the key", "error");
    }
  };
  return (
    <section className={`provider-keys${open ? "" : " collapsed"}`} aria-labelledby="provider-keys-title">
      <button
        type="button"
        className="provider-keys-head"
        aria-expanded={open}
        aria-controls="provider-keys-list"
        onClick={toggle}
      >
        <span className="provider-keys-chevron" aria-hidden="true">
          ›
        </span>
        <strong id="provider-keys-title" className="provider-keys-title">
          Supported providers
        </strong>
        {open ? (
          <p>Cloud providers need an API key, saved once and used by all their models. Local servers need none.</p>
        ) : (
          <span className="provider-keys-summary">
            {rows
              .filter((row) => row.models > 0 || keys.some((key) => key.baseUrl === row.baseUrl))
              .map((row) => (
                <span key={row.id} className="muted-chip">
                  {row.label}
                  {keys.some((key) => key.baseUrl === row.baseUrl) ? " ✓" : ""} · {row.models}
                </span>
              ))}
            {targets.some(targetMissingKey) && (
              <span className="test-badge error">
                {targets.filter(targetMissingKey).length} need a key
              </span>
            )}
            <span className="provider-keys-more">Show all {rows.length}</span>
          </span>
        )}
      </button>
      {open && (
      <>
      <ul id="provider-keys-list">
        {rows.map(({ id, label, hint, baseUrl, keyed, models }) => {
          const key = baseUrl ? keys.find((item) => item.baseUrl === baseUrl) : undefined;
          const waiting = targets.filter(
            (target) => baseUrl && normalizeBaseUrl(target.baseUrl) === baseUrl && targetMissingKey(target),
          ).length;
          const isPreset = PROVIDER_PRESETS.some((preset) => preset.id === id);
          return (
            <li key={id}>
              <div className="provider-key-name">
                <span>
                  <strong>{label}</strong>
                  <small>
                    {hint}
                    {models > 0 && ` · ${models} model${models === 1 ? "" : "s"}`}
                  </small>
                </span>
                <span className={`test-badge ${key ? "ok" : waiting ? "error" : ""}`}>
                  {key
                    ? "✓ Key saved"
                    : waiting
                      ? `${waiting} model${waiting === 1 ? "" : "s"} need a key`
                      : keyed
                        ? "No key yet"
                        : id === "other"
                          ? "Key optional"
                          : "No key needed"}
                </span>
              </div>
              {keyed && editingUrl === baseUrl ? (
                <form
                  className="provider-key-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(baseUrl);
                  }}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    autoFocus
                    aria-label={`${label} API key`}
                    placeholder={`Paste your ${label} key`}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  />
                  <button className="button primary mini" disabled={busy || !value.trim()}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditingUrl("");
                      setValue("");
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="provider-key-actions">
                  {keyed && (
                    <button
                      type="button"
                      className="button secondary mini"
                      onClick={() => {
                        setEditingUrl(baseUrl);
                        setValue("");
                      }}
                    >
                      {key ? "Replace key" : "Add key"}
                    </button>
                  )}
                  {key && (
                    <button type="button" className="text-button destructive" onClick={() => void remove(key)}>
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Add a ${label} model`}
                    onClick={() => onAddModel(isPreset ? id : "other")}
                  >
                    + Model
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <small>Keys are encrypted on this computer and never shown again.</small>
      </>
      )}
    </section>
  );
}

function Targets({
  targets,
  setTargets,
  onNotice,
}: {
  targets: Target[];
  setTargets: (x: Target[]) => void;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
}) {
  const [formFor, setFormFor] = useState<Target | "new" | null>(null);
  const [newPresetId, setNewPresetId] = useState<string>(PROVIDER_PRESETS[0].id);
  const [query, setQuery] = useState("");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleTargets = terms.length
    ? targets.filter((target) => {
        const text = [
          target.name,
          target.model,
          presetForTarget(target).label,
          target.baseUrl,
          target.supportsVision ? `${CAPABILITY_LABELS.supportsVision} reads images vision` : "",
          target.supportsStructuredOutput ? `${CAPABILITY_LABELS.supportsStructuredOutput} json structured` : "",
          target.supportsTools ? `${CAPABILITY_LABELS.supportsTools} tool calling` : "",
          targetMissingKey(target) ? "needs api key" : "",
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => text.includes(term));
      })
    : targets;
  const formPanel = useRef<HTMLElement>(null);
  const addModel = (presetId = PROVIDER_PRESETS[0].id) => {
    setNewPresetId(presetId);
    setFormFor("new");
    window.requestAnimationFrame(() => formPanel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const [testing, setTesting] = useState("");
  const [results, setResults] = useState<Record<string, TargetTestResult>>({});
  const [providerKeys, setProviderKeys] = useState<ProviderKey[]>([]);
  const showForm = formFor !== null || !targets.length;
  const upsert = (target: Target) =>
    setTargets([...targets.filter((item) => item.name !== target.name), target].sort((a, b) => a.name.localeCompare(b.name)));
  const refreshKeys = async () => {
    try {
      const [keys, latest] = await Promise.all([
        api<ProviderKey[]>("/api/provider-keys"),
        api<Target[]>("/api/targets"),
      ]);
      setProviderKeys(keys);
      setTargets(latest);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not load API keys", "error");
    }
  };
  useEffect(() => {
    void refreshKeys();
  }, []);
  const runTest = async (target: Target) => {
    setTesting(target.name);
    const result = await testTarget(target.name, Boolean(target.supportsVision));
    setResults((current) => ({ ...current, [target.name]: result }));
    onNotice(result.message, result.ok ? "success" : "error");
    setTesting("");
  };
  const removeKey = async (target: Target) => {
    const shared = hasProviderKey(providerKeys, target.baseUrl);
    if (
      !window.confirm(
        shared
          ? `Remove the key saved for “${target.name}” only? It will use your saved ${keyProviderLabel(target.baseUrl)} key instead.`
          : `Remove the saved API key for “${target.name}”?`,
      )
    )
      return;
    try {
      upsert(
        await api<Target>(`/api/targets/${encodeURIComponent(target.name)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...target, apiKey: "", clearApiKey: true }),
        }),
      );
      onNotice(`Saved key removed from “${target.name}”.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not remove key", "error");
    }
  };
  const remove = async (target: Target) => {
    if (!window.confirm(`Delete “${target.name}”? Past runs keep their results.`)) return;
    try {
      await api(`/api/targets/${encodeURIComponent(target.name)}`, { method: "DELETE" });
      setTargets(targets.filter((item) => item.name !== target.name));
      if (formFor !== "new" && formFor?.name === target.name) setFormFor(null);
      onNotice(`Deleted “${target.name}”.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not delete model", "error");
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="PREPARE"
        title="Providers"
        sub="Connect the models you want to evaluate. Local servers and cloud providers both work."
      />
      <ProviderKeysPanel
        keys={providerKeys}
        targets={targets}
        onChanged={refreshKeys}
        onNotice={onNotice}
        onAddModel={addModel}
      />
      <div className={`targets-layout${showForm ? "" : " list-only"}`}>
        {targets.length > 0 && (
          <section className="target-list-wrap" aria-labelledby="target-list-title">
            <div className="target-list-head">
              <h3 id="target-list-title">
                Models{" "}
                <span className="count-chip">
                  {terms.length ? `${visibleTargets.length} of ${targets.length}` : targets.length}
                </span>
              </h3>
              {targets.length > 2 && (
                <input
                  type="search"
                  className="target-search"
                  aria-label="Search models"
                  placeholder="Search by name, model ID, provider, or capability"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              )}
              {formFor === null && (
                <button className="button primary mini" type="button" onClick={() => addModel()}>
                  + Add model
                </button>
              )}
            </div>
            {terms.length > 0 && !visibleTargets.length && (
              <p className="target-search-empty">
                No models match “{query.trim()}”.{" "}
                <button type="button" className="link-button" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </p>
            )}
            <div className="target-list">
            {visibleTargets.map((target) => {
              const result = results[target.name];
              return (
                <article className="target-card" key={target.name}>
                  <header>
                    <div>
                      <strong>{target.name}</strong>
                      <span>
                        {presetForTarget(target).label} · <code>{target.model}</code>
                      </span>
                    </div>
                    <span
                      className={`test-badge ${targetMissingKey(target) ? "error" : result ? (result.ok ? "ok" : "error") : ""}`}
                      title={targetMissingKey(target) ? "Edit this model and paste its API key." : result?.message}
                    >
                      {targetMissingKey(target)
                        ? "Needs API key"
                        : result
                          ? result.ok
                            ? "✓ Connected"
                            : "✗ Failed"
                          : "Not tested"}
                    </span>
                  </header>
                  <ul className="capability-chips" aria-label="Capabilities">
                    {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[])
                      .filter((key) => target[key])
                      .map((key) => (
                        <li key={key}>{CAPABILITY_LABELS[key]}</li>
                      ))}
                    {target.keySource === "provider" && (
                      <li className="muted-chip">Uses {keyProviderLabel(target.baseUrl)} key</li>
                    )}
                    {target.keySource === "model" && <li className="muted-chip">Own key</li>}
                  </ul>
                  <footer>
                    <button className="button mini" type="button" disabled={testing === target.name} onClick={() => void runTest(target)}>
                      {testing === target.name ? "Testing…" : "Test"}
                    </button>
                    <button className="text-button" type="button" onClick={() => setFormFor(target)}>
                      Edit
                    </button>
                    <ActionsMenu
                      label={`More actions for ${target.name}`}
                      items={[
                        ...(target.keySource === "model"
                          ? [
                              {
                                label: hasProviderKey(providerKeys, target.baseUrl)
                                  ? `Use saved ${keyProviderLabel(target.baseUrl)} key`
                                  : "Remove saved key",
                                onSelect: () => void removeKey(target),
                              },
                            ]
                          : []),
                        { label: "Delete", destructive: true, onSelect: () => void remove(target) },
                      ]}
                    />
                  </footer>
                </article>
              );
            })}
            </div>
          </section>
        )}
        {showForm && (
          <section
            ref={formPanel}
            className="panel target-form-panel"
            aria-label={formFor && formFor !== "new" ? "Edit model" : "Add a model"}
          >
            <h3>{formFor && formFor !== "new" ? `Edit ${formFor.name}` : targets.length ? "Add a model" : "Connect your first model"}</h3>
            <TargetForm
              key={formFor && formFor !== "new" ? formFor.name : `new-${newPresetId}`}
              initial={formFor && formFor !== "new" ? formFor : undefined}
              initialPresetId={newPresetId}
              targets={targets}
              providerKeys={providerKeys}
              onNotice={onNotice}
              onCancel={targets.length ? () => setFormFor(null) : undefined}
              onSaved={(target, test) => {
                upsert(target);
                void refreshKeys();
                if (test) setResults((current) => ({ ...current, [target.name]: test }));
                if (!test || test.ok) {
                  onNotice(test ? `“${target.name}” saved and connected.` : `“${target.name}” saved.`);
                  setFormFor(null);
                } else setFormFor(target);
              }}
            />
          </section>
        )}
      </div>
    </>
  );
}
function Compare({
  runs,
  preferredRun,
  preferredPair,
}: {
  runs: Run[];
  preferredRun?: string;
  preferredPair?: [string, string] | null;
}) {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [result, setResult] = useState<any>(null);
  const [resultKey, setResultKey] = useState("");
  const [busy, setBusy] = useState(false);
  const compareRequest = useRef(0);
  useEffect(() => {
    if (!preferredPair) return;
    const [first, second] = preferredPair
      .map((id) => runs.find((run) => run.runId === id))
      .sort((a, b) => (Date.parse(a?.createdAt || "") || 0) - (Date.parse(b?.createdAt || "") || 0));
    if (first && second) {
      compareRequest.current += 1;
      setResult(null);
      setLeft(first.runId);
      setRight(second.runId);
    }
  }, [preferredPair]);
  useEffect(() => {
    if (!left && runs[1]) setLeft(runs[1].runId);
    if (!right && preferredRun) setRight(preferredRun);
    else if (!right && runs[0]) setRight(runs[0].runId);
  }, [runs, left, right, preferredRun]);
  const selectionKey = `${left}:${right}`;
  const changeSelection = (side: "left" | "right", value: string) => {
    compareRequest.current += 1;
    setResult(null);
    setResultKey("");
    if (side === "left") setLeft(value);
    else setRight(value);
  };
  const submit = async () => {
    const request = ++compareRequest.current;
    const requestKey = selectionKey;
    setBusy(true);
    try {
      const comparison = await api(
        `/api/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`,
      );
      if (request === compareRequest.current) {
        setResult(comparison);
        setResultKey(requestKey);
      }
    } catch (e) {
      if (request === compareRequest.current) {
        setResult({
          error: e instanceof Error ? e.message : "Runs are not comparable.",
        });
        setResultKey(requestKey);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="COMPARISON"
        title="Compare runs"
        sub="See what got better or worse between two runs of the same dataset."
      />
      <form
        className="panel compare-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (left && right && !busy) void submit();
        }}
      >
        <div className="field">
          <span className="field-label" id="compare-left-label">Before (baseline)</span>
          <Dropdown
            labelledBy="compare-left-label"
            value={left}
            onChange={(value) => changeSelection("left", value)}
            placeholder="Choose a run"
            options={runs.map((r) => ({ value: r.runId, label: runLabel(r), detail: `${date(r.createdAt)} · ${runOutcome(r).label}` }))}
          />
        </div>
        <span className="versus">VS</span>
        <div className="field">
          <span className="field-label" id="compare-right-label">After (candidate)</span>
          <Dropdown
            labelledBy="compare-right-label"
            value={right}
            onChange={(value) => changeSelection("right", value)}
            placeholder="Choose a run"
            options={(() => {
              const base = runs.find((r) => r.runId === left);
              const others = runs.filter((r) => r.runId !== left);
              const toOption = (r: Run, group?: string): DropdownOption => ({
                value: r.runId,
                label: runLabel(r),
                detail: `${date(r.createdAt)} · ${runOutcome(r).label}`,
                group,
              });
              if (!base?.datasetVersion) return others.map((r) => toOption(r));
              return [
                ...others.filter((r) => r.datasetVersion === base.datasetVersion).map((r) => toOption(r, "Same dataset (comparable)")),
                ...others.filter((r) => r.datasetVersion !== base.datasetVersion).map((r) => toOption(r, "Other datasets")),
              ];
            })()}
          />
        </div>
        <button
          className="button primary"
          disabled={!left || !right || busy}
          type="submit"
        >
          {busy ? "Comparing…" : "Compare runs"}
        </button>
      </form>
      {result && resultKey === selectionKey && result.error ? (
        <div className="alert error" role="alert">
          <strong>These runs can't be compared.</strong> Compare works for graded runs of the same dataset with the same
          scoring settings, such as two models tried in one experiment. <small>Details: {result.error}</small>
        </div>
      ) : result && resultKey === selectionKey ? (
        <section className="comparison-results">
          <div className="stats">
            <Stat
              label="Matched cases"
              value={String(result.sampleCount)}
              note="Cases in both runs"
            />
            <Stat
              label="Improved"
              value={String(result.improved)}
              note="Better in the after run"
            />
            <Stat
              label="Regressed"
              value={String(result.regressed)}
              note="Worse in the after run"
            />
          </div>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>Changes by field</h3>
                <p>How many cases improved or regressed for each field.</p>
              </div>
            </div>
            {result.fields?.length ? (
              result.fields.map(
                (f: { path: string; improved: number; regressed: number }) => (
                  <div className="field-row" key={f.path}>
                    <code>{f.path}</code>
                    <span className="good">+{f.improved}</span>
                    <span className="bad">−{f.regressed}</span>
                  </div>
                ),
              )
            ) : (
              <Empty
                icon="≈"
                title="No field-level movement"
                text="The compared runs have no changed fields."
              />
            )}
          </div>
        </section>
      ) : (
        <Empty
          icon="≈"
          title="Choose two runs"
          text="Pick two graded runs of the same dataset, for example two models or two prompts."
        />
      )}
    </>
  );
}

function Experiments({
  experiments,
  runs,
  selectedId,
  onSelect,
  onOpenRun,
  onRefresh,
  onNotice,
  onNewRun,
  onCompare,
}: {
  experiments: Experiment[];
  runs: Run[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenRun: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
  onNewRun: (experimentId: string) => void;
  onCompare: (left: string, right: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [rename, setRename] = useState("");
  const [picking, setPicking] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const selected =
    experiments.find((item) => item.experimentId === selectedId) || experiments[0] || null;
  const linkedRuns = selected
    ? newestRuns(runs.filter((run) => run.experimentId === selected.experimentId))
    : [];
  const ungrouped = newestRuns(runs.filter((run) => !run.experimentId));
  useEffect(() => {
    setRenaming(false);
    setPicking(false);
    setToAdd([]);
    setChosen([]);
  }, [selected?.experimentId]);
  const call = async (work: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true);
    try {
      await work();
      await onRefresh();
      onNotice(success);
      return true;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : failure, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    let createdId = "";
    const ok = await call(
      async () => {
        createdId = (await api<Experiment>("/api/experiments", json("POST", { name }))).experimentId;
      },
      `Experiment “${name}” created.`,
      "Could not create experiment",
    );
    if (ok) {
      setNewName("");
      setCreating(false);
      onSelect(createdId);
    }
  };
  const saveRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !rename.trim()) return;
    if (
      await call(
        () => api(`/api/experiments/${encodeURIComponent(selected.experimentId)}`, json("PATCH", { name: rename.trim() })),
        "Experiment renamed.",
        "Could not rename experiment",
      )
    )
      setRenaming(false);
  };
  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete “${selected.name}”? Its runs are kept and become ungrouped.`)) return;
    if (
      await call(
        () => api(`/api/experiments/${encodeURIComponent(selected.experimentId)}`, { method: "DELETE" }),
        "Experiment deleted.",
        "Could not delete experiment",
      )
    )
      onSelect(null);
  };
  const assign = (runIds: string[], experimentId: string | null) =>
    call(
      () =>
        Promise.all(
          runIds.map((runId) =>
            api(`/api/runs/${encodeURIComponent(runId)}/experiment`, json("PUT", { experimentId })),
          ),
        ),
      experimentId
        ? `${runIds.length} run${runIds.length === 1 ? "" : "s"} added.`
        : "Run removed from experiment.",
      "Could not update the experiment",
    );
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  return (
    <div className="experiments-page" data-view-heading="experiments">
      <PageTitle
        eyebrow="ANALYZE"
        title="Experiments"
        sub="Group runs that answer one question, like “which model reads receipts best?”"
      />
      <div className="experiments-layout">
        <section className="panel experiment-list-panel" aria-label="Experiments">
          <div className="experiment-list-head">
            <h3>Experiments</h3>
            {!creating && (
              <button type="button" className="button secondary" onClick={() => setCreating(true)}>
                New experiment
              </button>
            )}
          </div>
          {creating && (
            <form className="inline-form experiment-create" onSubmit={create}>
              <input
                autoFocus
                aria-label="Experiment name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setCreating(false);
                    setNewName("");
                  }
                }}
                placeholder="Name, e.g. Receipt models"
              />
              <button className="button primary" disabled={busy || !newName.trim()}>
                Create
              </button>
              <button type="button" className="text-button" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </form>
          )}
          <div className="experiment-list">
            {experiments.length ? (
              experiments.map((experiment) => (
                <button
                  type="button"
                  key={experiment.experimentId}
                  className={selected?.experimentId === experiment.experimentId ? "experiment-item selected" : "experiment-item"}
                  aria-pressed={selected?.experimentId === experiment.experimentId}
                  onClick={() => onSelect(experiment.experimentId)}
                >
                  <span>
                    <strong>{experiment.name}</strong>
                    <small>
                      {experiment.runCount} run{experiment.runCount === 1 ? "" : "s"} · updated {date(experiment.updatedAt)}
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))
            ) : (
              !creating && (
                <p className="muted experiment-empty">
                  No experiments yet. Create one to keep related runs together.
                </p>
              )
            )}
          </div>
        </section>
        <section className="panel experiment-detail-panel" aria-label="Selected experiment">
          {selected ? (
            <>
              <header className="experiment-detail-head">
                {renaming ? (
                  <form className="inline-form" onSubmit={saveRename}>
                    <input
                      autoFocus
                      aria-label="Experiment name"
                      value={rename}
                      onChange={(event) => setRename(event.target.value)}
                      onKeyDown={(event) => event.key === "Escape" && setRenaming(false)}
                    />
                    <button className="button primary" disabled={busy || !rename.trim()}>
                      Save
                    </button>
                    <button type="button" className="text-button" onClick={() => setRenaming(false)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div>
                    <h3>{selected.name}</h3>
                    <small>
                      {linkedRuns.length} run{linkedRuns.length === 1 ? "" : "s"}
                    </small>
                  </div>
                )}
                <div className="experiment-detail-actions">
                  <button type="button" className="button primary" onClick={() => onNewRun(selected.experimentId)}>
                    New run in this experiment
                  </button>
                  <ActionsMenu
                    label={`More actions for ${selected.name}`}
                    items={[
                      {
                        label: "Rename",
                        onSelect: () => {
                          setRename(selected.name);
                          setRenaming(true);
                        },
                      },
                      { label: "Delete experiment", destructive: true, onSelect: () => void remove() },
                    ]}
                  />
                </div>
              </header>
              {linkedRuns.length ? (
                <div className="experiment-table" role="table" aria-label="Runs in this experiment">
                  <div className="experiment-table-row head" role="row">
                    <span role="columnheader" aria-label="Select" />
                    <span role="columnheader">Run</span>
                    <span role="columnheader">Result</span>
                    <span role="columnheader" aria-label="Actions" />
                  </div>
                  {linkedRuns.map((run) => (
                    <div className="experiment-table-row" role="row" key={run.runId}>
                      <span role="cell">
                        <input
                          type="checkbox"
                          aria-label={`Select ${runLabel(run)} to compare`}
                          checked={chosen.includes(run.runId)}
                          disabled={!chosen.includes(run.runId) && chosen.length >= 2}
                          onChange={() => setChosen((current) => toggle(current, run.runId))}
                        />
                      </span>
                      <button type="button" role="cell" className="experiment-run-link" onClick={() => void onOpenRun(run.runId)}>
                        <strong>{runLabel(run)}</strong>
                        <small>{date(run.createdAt)}</small>
                      </button>
                      <span role="cell">
                        <RunStatusBadge run={run} />
                      </span>
                      <span role="cell">
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void assign([run.runId], null)}
                        >
                          Remove
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="experiment-empty-runs">
                  <strong>No runs here yet</strong>
                  <span>Start a new run in this experiment, or add runs you already have.</span>
                </div>
              )}
              <div className="experiment-toolbar">
                <button
                  type="button"
                  className="button secondary"
                  disabled={chosen.length !== 2}
                  onClick={() => onCompare(chosen[0], chosen[1])}
                  title={chosen.length === 2 ? undefined : "Select two runs to compare"}
                >
                  Compare selected{chosen.length ? ` (${chosen.length}/2)` : ""}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  aria-expanded={picking}
                  disabled={!ungrouped.length}
                  onClick={() => setPicking((value) => !value)}
                >
                  {ungrouped.length ? "Add existing runs" : "No ungrouped runs"}
                </button>
              </div>
              {picking && (
                <div className="inline-panel run-picker">
                  <div className="inline-panel-head">
                    <strong>Add runs that aren't in an experiment</strong>
                    <button type="button" className="text-button" onClick={() => setPicking(false)}>
                      Close
                    </button>
                  </div>
                  <div className="run-picker-list">
                    {ungrouped.map((run) => (
                      <label key={run.runId} className="check-row">
                        <input
                          type="checkbox"
                          checked={toAdd.includes(run.runId)}
                          onChange={() => setToAdd((current) => toggle(current, run.runId))}
                        />
                        <span>
                          <strong>{runLabel(run)}</strong>
                          <small>{date(run.createdAt)}</small>
                        </span>
                        <RunStatusBadge run={run} />
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || !toAdd.length}
                    onClick={() =>
                      void assign(toAdd, selected.experimentId).then((ok) => {
                        if (ok) {
                          setToAdd([]);
                          setPicking(false);
                        }
                      })
                    }
                  >
                    Add {toAdd.length || ""} run{toAdd.length === 1 ? "" : "s"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <Empty
              icon="◫"
              title="No experiment selected"
              text="Create an experiment to group related runs and compare them."
            />
          )}
        </section>
      </div>
    </div>
  );
}

function SetupPanel({
  setup,
  experiments,
  selectedExperimentId,
  onSelectExperiment,
  onCreateExperiment,
  targets,
  datasets,
  activeExecution,
  onRefreshRuns,
  onSaved,
  onNotice,
  onOpenRun,
  onBusyChange,
  setTargets,
  onRefreshDatasets,
}: {
  setTargets: (targets: Target[]) => void;
  onRefreshDatasets: () => Promise<void>;
  setup: Setup;
  experiments: Experiment[];
  selectedExperimentId: string | null;
  onSelectExperiment: (id: string | null) => void;
  onCreateExperiment: (name: string) => Promise<Experiment>;
  targets: Target[];
  datasets: Dataset[];
  activeExecution: ActiveExecution;
  onRefreshRuns: () => Promise<void>;
  onSaved: (x: Setup) => void;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
  onOpenRun: (runId: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [inlineExperimentName, setInlineExperimentName] = useState("");
  const [creatingExperiment, setCreatingExperiment] = useState(false);
  const initialTaskKind = asTaskKind(setup.config?.taskKind);
  const [form, setForm] = useState(() => ({
    taskKind: initialTaskKind,
    datasetVersion:
      setup.config?.datasetVersion ||
      datasets.find((dataset) => datasetTaskKind(dataset) === initialTaskKind)
        ?.version ||
      "",
    baseConfigPath: setup.config?.baseConfigPath || "",
    ocrTarget: setup.config?.ocrTarget || "",
    extractionTarget: setup.config?.extractionTarget || "",
    judgeTarget:
      initialTaskKind === "tool-calling" ? "" : setup.config?.judgeTarget || "",
    inferenceOnly: setup.config?.inferenceOnly || false,
    extractionSource: setup.config?.extractionSource || "ocr",
    outputMode: setup.config?.outputMode || "prompted-json",
    judgeRubric:
      initialTaskKind === "tool-calling" ? "" : setup.config?.judgeRubric || "",
    schema: editorText(
      setup.config?.schema,
      initialTaskKind === "text-json" ? DEFAULT_TEXT_SCHEMA : "",
    ),
    stagePrompts: {
      ocr:
        setup.config?.stagePrompts?.ocr ||
        (initialTaskKind === "document-json"
          ? DEFAULT_DOCUMENT_OCR_PROMPT
          : ""),
      extraction:
        setup.config?.stagePrompts?.extraction ||
        (initialTaskKind === "text-json"
          ? DEFAULT_TEXT_PROMPT
          : initialTaskKind === "document-json"
            ? DEFAULT_DOCUMENT_EXTRACTION_PROMPT
            : ""),
    },
    fieldRules: editorText(setup.config?.fieldRules, "[]"),
    tools: editorText(
      setup.config?.tools,
      initialTaskKind === "tool-calling" ? DEFAULT_TOOLS : "[]",
    ),
    toolChoice: setup.config?.toolChoice || "auto",
    toolCallOrder: setup.config?.toolCallOrder || "ordered",
    temperature: String(setup.config?.generation?.temperature ?? 0.2),
    maxTokens: String(
      setup.config?.generation?.maxTokens ??
        setup.config?.generation?.max_tokens ??
        setup.config?.generation?.max_completion_tokens ??
        2048,
    ),
  }));
  const [savedFormKey, setSavedFormKey] = useState(() => JSON.stringify(form));
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [exampleBusy, setExampleBusy] = useState(false);
  const taskKindOverride = useRef<TaskKind | null>(null);
  useEffect(() => {
    onBusyChange(saving || starting || exampleBusy);
    return () => onBusyChange(false);
  }, [exampleBusy, onBusyChange, saving, starting]);
  const syncedConfig = useRef<unknown>(Symbol("unsynced"));
  useEffect(() => {
    if (syncedConfig.current === setup.config) {
      setForm((current) => {
        const kind = asTaskKind(current.taskKind);
        const matching = datasets.filter((dataset) => datasetTaskKind(dataset) === kind);
        const has = (name: string) => targets.some((target) => target.name === name);
        return {
          ...current,
          datasetVersion: matching.some((dataset) => dataset.version === current.datasetVersion)
            ? current.datasetVersion
            : matching[0]?.version || "",
          extractionTarget: has(current.extractionTarget) ? current.extractionTarget : targets[0]?.name || "",
          ocrTarget:
            kind !== "document-json"
              ? ""
              : has(current.ocrTarget)
                ? current.ocrTarget
                : targets.find((target) => target.supportsVision)?.name || "",
        };
      });
      return;
    }
    syncedConfig.current = setup.config;
    const taskKind =
      taskKindOverride.current ||
      asTaskKind(setup.config?.taskKind ?? form.taskKind);
    const matchingDatasets = datasets.filter(
      (dataset) => datasetTaskKind(dataset) === taskKind,
    );
    const configuredDataset = setup.config?.datasetVersion;
    const datasetVersion =
      (configuredDataset &&
        matchingDatasets.some(
          (dataset) => dataset.version === configuredDataset,
        ) &&
        configuredDataset) ||
      (matchingDatasets.some(
        (dataset) => dataset.version === form.datasetVersion,
      )
        ? form.datasetVersion
        : matchingDatasets[0]?.version || "");
    const next = {
      ...form,
      taskKind,
      datasetVersion,
      baseConfigPath: setup.config?.baseConfigPath || form.baseConfigPath,
      ocrTarget:
        taskKind === "document-json"
          ? setup.config?.ocrTarget ||
            form.ocrTarget ||
            targets.find((t) => t.supportsVision)?.name ||
            ""
          : "",
      extractionTarget:
        setup.config?.extractionTarget ||
        form.extractionTarget ||
        targets[0]?.name ||
        "",
      judgeTarget:
        taskKind === "tool-calling"
          ? ""
          : (setup.config?.judgeTarget ?? form.judgeTarget),
      inferenceOnly: setup.config?.inferenceOnly ?? form.inferenceOnly,
      extractionSource:
        taskKind === "document-json"
          ? setup.config?.extractionSource || form.extractionSource
          : "reference",
      outputMode: setup.config?.outputMode || form.outputMode,
      judgeRubric:
        taskKind === "tool-calling"
          ? ""
          : (setup.config?.judgeRubric ?? form.judgeRubric),
      schema:
        setup.config?.schema === undefined
          ? form.schema
          : editorText(setup.config.schema),
      stagePrompts: {
        ocr: setup.config?.stagePrompts?.ocr ?? form.stagePrompts.ocr,
        extraction:
          setup.config?.stagePrompts?.extraction ??
          form.stagePrompts.extraction,
      },
      fieldRules:
        setup.config?.fieldRules === undefined
          ? form.fieldRules
          : editorText(setup.config.fieldRules, "[]"),
      tools:
        setup.config?.tools === undefined
          ? form.tools
          : editorText(setup.config.tools, "[]"),
      toolChoice: setup.config?.toolChoice ?? form.toolChoice,
      toolCallOrder: setup.config?.toolCallOrder ?? form.toolCallOrder,
      temperature: String(
        setup.config?.generation?.temperature ?? form.temperature,
      ),
      maxTokens: String(
        setup.config?.generation?.maxTokens ??
          setup.config?.generation?.max_tokens ??
          setup.config?.generation?.max_completion_tokens ??
          form.maxTokens,
      ),
    };
    setForm(next);
    const persistedMaxTokens =
      setup.config?.generation?.maxTokens ??
      setup.config?.generation?.max_tokens ??
      setup.config?.generation?.max_completion_tokens;
    const persistedForm = setup.config
      ? {
          ...next,
          temperature:
            setup.config.generation?.temperature == null
              ? "__missing__"
              : next.temperature,
          maxTokens:
            persistedMaxTokens == null ? "__missing__" : next.maxTokens,
        }
      : null;
    setSavedFormKey(persistedForm ? JSON.stringify(persistedForm) : "");
  }, [setup.config, targets, datasets]);
  useEffect(() => {
    const matchingDatasets = datasets.filter(
      (dataset) => datasetTaskKind(dataset) === asTaskKind(form.taskKind),
    );
    if (
      form.datasetVersion &&
      matchingDatasets.some(
        (dataset) => dataset.version === form.datasetVersion,
      )
    )
      return;
    setForm((current) => ({
      ...current,
      datasetVersion: matchingDatasets[0]?.version || "",
    }));
  }, [datasets, form.taskKind]);
  const matchingDatasets = datasets.filter(
    (dataset) => datasetTaskKind(dataset) === asTaskKind(form.taskKind),
  );
  const currentTaskKind = asTaskKind(form.taskKind);
  const sampleConfigPath =
    currentTaskKind === "document-json"
      ? "sample-data/config.json"
      : `sample-data/${currentTaskKind}/config.json`;
  const selectedExtractionTarget = targets.find(
    (target) => target.name === form.extractionTarget,
  );
  /** Copy a configuration's prompts, schema, and rules into the in-app editors. */
  const applyConfig = (example: SetupConfig) => {
    setSourceMode("editor");
    setForm((current) => ({
      ...current,
      baseConfigPath: "",
      outputMode: example.outputMode ?? current.outputMode,
      judgeTarget: currentTaskKind === "tool-calling" ? "" : current.judgeTarget,
      judgeRubric:
        currentTaskKind === "tool-calling" ? "" : (example.judgeRubric ?? current.judgeRubric),
      schema: example.schema === undefined ? current.schema : editorText(example.schema),
      stagePrompts: { ...current.stagePrompts, ...(example.stagePrompts || {}) },
      fieldRules:
        example.fieldRules === undefined ? current.fieldRules : editorText(example.fieldRules, "[]"),
      tools: example.tools === undefined ? current.tools : editorText(example.tools, "[]"),
      toolChoice: example.toolChoice ?? current.toolChoice,
      toolCallOrder: example.toolCallOrder ?? current.toolCallOrder,
    }));
  };
  const loadExampleRubric = async () => {
    if (
      form.judgeRubric.trim() &&
      !window.confirm("Replace your judge instructions with the example? Your current text will be lost.")
    )
      return;
    setExampleBusy(true);
    try {
      const example = await api<SetupConfig>(`/api/examples/${encodeURIComponent(currentTaskKind)}`);
      if (!example.judgeRubric?.trim()) throw new Error("This evaluation type has no example judge instructions.");
      setForm((current) => ({ ...current, judgeRubric: example.judgeRubric! }));
      onNotice("Example judge instructions loaded. Adjust them for your data.");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not load the example", "error");
    } finally {
      setExampleBusy(false);
    }
  };
  const loadSampleSettings = async () => {
    setExampleBusy(true);
    try {
      const payload = await api<SetupConfig | { config?: SetupConfig }>(
        `/api/examples/${encodeURIComponent(currentTaskKind)}`,
      );
      const candidate = payload as { config?: SetupConfig };
      const example =
        candidate.config && typeof candidate.config === "object"
          ? candidate.config
          : (payload as SetupConfig);
      applyConfig(example);
      onNotice(
        `${TASK_KIND_LABELS[currentTaskKind]} example loaded into the editors. Your dataset and models were kept.`,
      );
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Could not load sample settings",
        "error",
      );
    } finally {
      setExampleBusy(false);
    }
  };
  const changeTaskKind = (taskKind: TaskKind) => {
    taskKindOverride.current = taskKind;
    const nextDatasets = datasets.filter(
      (dataset) => datasetTaskKind(dataset) === taskKind,
    );
    setForm((current) => ({
      ...current,
      taskKind,
      baseConfigPath:
        current.taskKind === taskKind
          ? current.baseConfigPath
          : taskKind === "document-json"
            ? "sample-data/config.json"
            : "",
      datasetVersion:
        nextDatasets.find(
          (dataset) => dataset.version === current.datasetVersion,
        )?.version ||
        nextDatasets[0]?.version ||
        "",
      ocrTarget:
        taskKind === "document-json"
          ? current.ocrTarget ||
            targets.find((target) => target.supportsVision)?.name ||
            ""
          : "",
      extractionSource:
        taskKind === "document-json"
          ? current.taskKind === "document-json"
            ? current.extractionSource
            : "ocr"
          : "reference",
      judgeTarget: taskKind === "tool-calling" ? "" : current.judgeTarget,
      judgeRubric: taskKind === "tool-calling" ? "" : current.judgeRubric,
      schema:
        taskKind === "text-json"
          ? current.taskKind === "text-json"
            ? current.schema
            : DEFAULT_TEXT_SCHEMA
          : taskKind === "tool-calling"
            ? ""
            : current.schema,
      stagePrompts: {
        ...current.stagePrompts,
        ocr:
          taskKind === "document-json" && current.taskKind !== "document-json"
            ? DEFAULT_DOCUMENT_OCR_PROMPT
            : current.stagePrompts.ocr,
        extraction:
          taskKind === "document-json" && current.taskKind !== "document-json"
            ? DEFAULT_DOCUMENT_EXTRACTION_PROMPT
            : taskKind === "text-json"
              ? current.taskKind === "text-json"
                ? current.stagePrompts.extraction
                : DEFAULT_TEXT_PROMPT
              : taskKind === "tool-calling" &&
                  current.taskKind !== "tool-calling"
                ? ""
                : current.stagePrompts.extraction,
      },
      fieldRules:
        taskKind === "document-json" || current.taskKind === taskKind
          ? current.fieldRules
          : "[]",
      tools:
        taskKind === "tool-calling"
          ? current.taskKind === "tool-calling"
            ? current.tools
            : DEFAULT_TOOLS
          : "[]",
    }));
  };
  const setupPayload = () => {
    const taskKind = asTaskKind(form.taskKind);
    const fieldRules = parseEditorJson(form.fieldRules);
    return {
      ...form,
      taskKind,
      schema: parseEditorJson(form.schema),
      stagePrompts: form.stagePrompts,
      fieldRules:
        taskKind === "tool-calling"
          ? []
          : taskKind === "document-json" &&
              form.fieldRules.trim() === "[]" &&
              setup.config?.fieldRules === undefined
            ? undefined
            : fieldRules,
      tools: taskKind === "tool-calling" ? parseEditorJson(form.tools) : undefined,
      toolChoice: form.toolChoice,
      toolCallOrder: form.toolCallOrder,
      judgeTarget: taskKind === "tool-calling" ? "" : form.judgeTarget,
      judgeRubric: taskKind === "tool-calling" ? "" : form.judgeRubric,
      outputMode: taskKind === "tool-calling" ? "prompted-json" : form.outputMode,
      generation: {
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
      },
    };
  };
  const saveConfig = async (quiet = false): Promise<boolean> => {
    const taskKind = asTaskKind(form.taskKind);
    const issues = validateSetup(
      { ...form, taskKind, checks: { schema: schemaCheck ?? undefined, tools: toolsCheck ?? undefined } },
      targets.map((target) => ({ ...target, missingKey: targetMissingKey(target) })),
    );
    if (issues.length) {
      onNotice(issues[0].message, "error");
      return false;
    }
    setSaving(true);
    try {
      const result = await api<Setup>("/api/setup/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(setupPayload()),
      });
      taskKindOverride.current = null;
      onSaved({ ...setup, ...result });
      setSavedFormKey(JSON.stringify(form));
      if (!quiet) onNotice("Settings saved. You can run them here or from a terminal.");
      return true;
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Could not save configuration",
        "error",
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    await saveConfig();
  };
  const command =
    setup.runCommand ||
    "npm run localevals -- run sample-data/manifest.jsonl sample-data/config.json";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      onNotice("Run command copied.");
    } catch {
      onNotice("Could not copy command; select it manually.", "error");
    }
  };
  const start = async () => {
    setStarting(true);
    try {
      if (JSON.stringify(form) !== savedFormKey && !(await saveConfig(true)))
        return;
      const result = await api<{ runId?: string }>("/api/runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selectedExperimentId ? { experimentId: selectedExperimentId } : {}),
      });
      await onRefreshRuns();
      if (result.runId) await onOpenRun(result.runId);
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Could not start evaluation",
        "error",
      );
    } finally {
      setStarting(false);
    }
  };
  const createInlineExperiment = async () => {
    const name = inlineExperimentName.trim();
    if (!name || creatingExperiment) return;
    setCreatingExperiment(true);
    try {
      await onCreateExperiment(name);
      setInlineExperimentName("");
      onNotice(`Experiment “${name}” created and selected.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not create experiment", "error");
    } finally {
      setCreatingExperiment(false);
    }
  };
  const stop = async () => {
    try {
      await api("/api/runs/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      onNotice("Cancellation requested. In-flight model requests will stop.");
      await onRefreshRuns();
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Could not stop evaluation",
        "error",
      );
    }
  };
  const [view, setView] = useState<"guided" | "full">(() => {
    try {
      return window.localStorage.getItem("local-evals-setup-view") === "full" ? "full" : "guided";
    } catch {
      return "guided";
    }
  });
  const changeView = (next: "guided" | "full") => {
    setView(next);
    try {
      window.localStorage.setItem("local-evals-setup-view", next);
    } catch {
      /* View preference is best-effort. */
    }
  };
  const [step, setStep] = useState<SetupStep>("type");
  const [addingModel, setAddingModel] = useState(false);
  const [importPathValue, setImportPathValue] = useState("");
  const [importing, setImporting] = useState(false);
  const [newExperimentOpen, setNewExperimentOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState<"editor" | "file">(() => (form.baseConfigPath ? "file" : "editor"));
  const [lastFilePath, setLastFilePath] = useState("");
  const [preview, setPreview] = useState<{
    path: string;
    loading: boolean;
    error?: string;
    summary?: SetupConfig & { crossFieldRules?: unknown[] };
    content?: Record<string, unknown>;
  } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsPath, setSaveAsPath] = useState("");
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  useEffect(() => {
    if (form.baseConfigPath) setSourceMode("file");
  }, [form.baseConfigPath]);
  const fileMode = sourceMode === "file";
  const [schemaCheck, setSchemaCheck] = useState<SchemaCheck | null>(null);
  const [toolsCheck, setToolsCheck] = useState<SchemaCheck | null>(null);
  useEffect(() => {
    const kind = currentTaskKind === "tool-calling" ? "tools" : "schema";
    const setCheck = kind === "tools" ? setToolsCheck : setSchemaCheck;
    if (fileMode) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api<SchemaCheck>("/api/schema-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          kind === "tools"
            ? { kind, text: form.tools }
            : { kind, text: form.schema, fieldRules: parseEditorJson(form.fieldRules) },
        ),
      })
        .then((result) => !cancelled && setCheck(result))
        .catch(() => !cancelled && setCheck(null));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileMode, currentTaskKind, form.schema, form.fieldRules, form.tools]);
  const toolCount = (() => {
    const tools = parseEditorJson(form.tools);
    return Array.isArray(tools) ? tools.length : 0;
  })();
  useEffect(() => {
    const requested = form.baseConfigPath.trim();
    if (!fileMode || !requested) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview((current) => ({ ...(current?.path === requested ? current : {}), path: requested, loading: true }));
    const timer = window.setTimeout(() => {
      void api<{ path: string; summary: SetupConfig; content: Record<string, unknown> }>(
        `/api/config-file?path=${encodeURIComponent(requested)}`,
      )
        .then((result) => {
          if (!cancelled) setPreview({ path: requested, loading: false, summary: result.summary, content: result.content });
        })
        .catch((error) => {
          if (!cancelled)
            setPreview({
              path: requested,
              loading: false,
              error: error instanceof Error ? error.message : "Could not open this file.",
            });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileMode, form.baseConfigPath, previewAttempt]);
  const useFile = () => {
    setSourceMode("file");
    setForm((current) => ({
      ...current,
      baseConfigPath: current.baseConfigPath || lastFilePath || sampleConfigPath,
    }));
  };
  const editInApp = () => {
    if (preview?.summary) {
      applyConfig(preview.summary);
      setLastFilePath(preview.path);
      onNotice(`Copied ${preview.path} into the editors. Save as file to update it.`);
    } else {
      setSourceMode("editor");
      setForm((current) => ({ ...current, baseConfigPath: "" }));
    }
  };
  const saveAsFile = async (overwrite = false): Promise<void> => {
    const target = saveAsPath.trim();
    if (!target) return;
    const blocking = issuesForStep(issues, "instructions");
    if (blocking.length) {
      onNotice(blocking[0].message, "error");
      return;
    }
    setSaveAsBusy(true);
    try {
      const response = await fetch("/api/config-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, setup: setupPayload(), overwrite }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.exists) {
        if (window.confirm(`${target} already exists. Replace it with these settings?`)) {
          setSaveAsBusy(false);
          return saveAsFile(true);
        }
        return;
      }
      if (!response.ok) throw new Error(result.error || "Could not save the file.");
      setLastFilePath(result.path);
      setSaveAsOpen(false);
      onNotice(`Saved ${result.path}. Choose “Use a configuration file” to run from it later.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not save the file.", "error");
    } finally {
      setSaveAsBusy(false);
    }
  };
  const issues = validateSetup(
    { ...form, taskKind: currentTaskKind, checks: { schema: schemaCheck ?? undefined, tools: toolsCheck ?? undefined } },
    targets.map((target) => ({ ...target, missingKey: targetMissingKey(target) })),
  );
  const stepIndex = SETUP_STEPS.indexOf(step);
  const selectedDataset = datasets.find((dataset) => dataset.version === form.datasetVersion);
  const selectedOcrTarget = targets.find((target) => target.name === form.ocrTarget);
  const busy = saving || starting || exampleBusy;
  const advancedChanged = [
    form.outputMode !== "prompted-json",
    form.temperature !== "0.2",
    form.maxTokens !== "2048",
    currentTaskKind === "tool-calling" && form.toolChoice !== "auto",
  ].filter(Boolean).length;
  const importForWizard = async (datasetPath: string) => {
    if (!datasetPath.trim()) return;
    setImporting(true);
    try {
      const imported = await importDatasetPath(datasetPath.trim());
      await onRefreshDatasets();
      if (datasetTaskKind(imported) !== currentTaskKind) changeTaskKind(datasetTaskKind(imported));
      setForm((current) => ({ ...current, datasetVersion: imported.version }));
      setImportPathValue("");
      if (datasetPath === SAMPLE_DATASETS[datasetTaskKind(imported)]) await loadSampleSettings();
      onNotice(`${imported.name || "Dataset"} added.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Import failed", "error");
    } finally {
      setImporting(false);
    }
  };
  const describeTarget = (target?: Target) =>
    target ? target.name : "Not chosen";
  const capabilityNote = (target: Target | undefined, need: "vision" | "tools" | "structured") => {
    if (!target) return null;
    const ok =
      need === "vision" ? target.supportsVision : need === "tools" ? target.supportsTools : target.supportsStructuredOutput;
    const text =
      need === "vision"
        ? ok ? "Can read images" : "Not marked as able to read images"
        : need === "tools"
          ? ok ? "Can call tools" : "Not marked as able to call tools"
          : ok ? "Follows a JSON schema" : "Will be asked for JSON in the prompt";
    return (
      <small className={`capability-check ${ok ? "good" : need === "structured" ? "" : "bad"}`}>
        {ok ? "✓" : need === "structured" ? "ℹ" : "⚠"} {text}
      </small>
    );
  };

  const typeCards = (
    <fieldset className="choice-cards" aria-label="Evaluation type">
      {(Object.keys(TASK_KIND_LABELS) as TaskKind[]).map((kind) => (
        <label key={kind} className={`choice-card${currentTaskKind === kind ? " selected" : ""}`}>
          <input
            type="radio"
            name="setup-task-kind"
            checked={currentTaskKind === kind}
            onChange={() => changeTaskKind(kind)}
          />
          <strong>{TASK_KIND_LABELS[kind]}</strong>
          <span>{taskKindDescription(kind)}</span>
          <small>
            {kind === "document-json"
              ? "Image → model reads it → JSON fields"
              : kind === "text-json"
                ? "Text → model → JSON fields"
                : "Text + tools → model → proposed call"}
          </small>
        </label>
      ))}
    </fieldset>
  );

  const datasetChooser = (
    <div className="setup-block">
      {matchingDatasets.length > 0 ? (
        <fieldset className="choice-list" aria-label="Dataset">
          {matchingDatasets.map((dataset) => (
            <label key={dataset.version} className={`choice-row${form.datasetVersion === dataset.version ? " selected" : ""}`}>
              <input
                type="radio"
                name="setup-dataset"
                checked={form.datasetVersion === dataset.version}
                onChange={() => setForm({ ...form, datasetVersion: dataset.version })}
              />
              <span>
                <strong>{dataset.name || "Untitled dataset"}</strong>
                <small>
                  {dataset.cases.length} {dataset.cases.length === 1 ? "case" : "cases"} ·{" "}
                  {datasetHasExpected(dataset) ? "has expected answers" : "no expected answers"}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="setup-empty">No {TASK_KIND_LABELS[currentTaskKind]} datasets yet. Add one below.</p>
      )}
      <div className="inline-add">
        <button
          type="button"
          className="button secondary"
          disabled={importing}
          onClick={() => void importForWizard(SAMPLE_DATASETS[currentTaskKind])}
        >
          {importing ? "Adding…" : `Use the ${TASK_KIND_LABELS[currentTaskKind]} sample`}
        </button>
        <span className="inline-add-or">or import a file</span>
        <div className="inline-form">
          <input
            aria-label="Dataset file path"
            value={importPathValue}
            onChange={(event) => setImportPathValue(event.target.value)}
            placeholder="datasets/my-cases.jsonl"
          />
          <button
            type="button"
            className="button secondary"
            disabled={importing || !importPathValue.trim()}
            onClick={() => void importForWizard(importPathValue)}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );

  const scoringControl = (
    <div className="setup-block">
      <span className="field-label">How should results be checked?</span>
      <div className="segmented" role="radiogroup" aria-label="Scoring">
        <button
          type="button"
          role="radio"
          aria-checked={!form.inferenceOnly}
          onClick={() => setForm({ ...form, inferenceOnly: false })}
        >
          <strong>Graded</strong>
          <small>Compare with expected answers</small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={form.inferenceOnly}
          onClick={() => setForm({ ...form, inferenceOnly: true })}
        >
          <strong>Save outputs only</strong>
          <small>No scores, review answers later</small>
        </button>
      </div>
      {selectedDataset && !datasetHasExpected(selectedDataset) && !form.inferenceOnly && (
        <small className="form-warning">
          Some cases in this dataset have no expected answer. Choose “Save outputs only”, or those cases will fail.
        </small>
      )}
    </div>
  );

  const targetSelect = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: Target[],
    note: ReactNode,
  ) => (
    <div className="field">
      <span className="field-label" id={`setup-field-${label.replace(/\W+/g, "-").toLowerCase()}`}>
        {label}
      </span>
      <Dropdown
        labelledBy={`setup-field-${label.replace(/\W+/g, "-").toLowerCase()}`}
        value={value}
        onChange={onChange}
        options={targetOptions(options, label.includes("optional") ? "No judge" : "Choose a model")}
      />
      {note}
    </div>
  );

  const modelChooser = (
    <div className="setup-block">
      {currentTaskKind === "document-json" && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.extractionSource === "reference"}
            onChange={(event) =>
              setForm({ ...form, extractionSource: event.target.checked ? "reference" : "ocr" })
            }
          />
          My cases already include the document text (skip reading images)
        </label>
      )}
      {currentTaskKind === "document-json" &&
        form.extractionSource === "ocr" &&
        targetSelect(
          "Model that reads the image",
          form.ocrTarget,
          (ocrTarget) => setForm({ ...form, ocrTarget }),
          targets.filter((target) => target.supportsVision),
          targets.some((target) => target.supportsVision) ? (
            capabilityNote(selectedOcrTarget, "vision")
          ) : (
            <small className="capability-check bad">⚠ No model is marked as able to read images. Add one below.</small>
          ),
        )}
      {targetSelect(
        currentTaskKind === "document-json" ? "Model that extracts the JSON" : "Model",
        form.extractionTarget,
        (extractionTarget) => setForm({ ...form, extractionTarget }),
        targets,
        capabilityNote(selectedExtractionTarget, currentTaskKind === "tool-calling" ? "tools" : "structured"),
      )}
      {addingModel ? (
        <div className="inline-panel">
          <div className="inline-panel-head">
            <strong>Add a model</strong>
            <button type="button" className="text-button" onClick={() => setAddingModel(false)}>
              Close
            </button>
          </div>
          <TargetForm
            targets={targets}
            onNotice={onNotice}
            onSaved={(target, test) => {
              setTargets([...targets.filter((item) => item.name !== target.name), target]);
              setForm((current) => ({
                ...current,
                extractionTarget: target.name,
                ocrTarget:
                  current.taskKind === "document-json" && target.supportsVision ? target.name : current.ocrTarget,
              }));
              if (!test || test.ok) {
                setAddingModel(false);
                onNotice(`“${target.name}” ${test ? "connected and " : ""}selected.`);
              }
            }}
          />
        </div>
      ) : (
        <button type="button" className="button secondary inline-add-button" onClick={() => setAddingModel(true)}>
          + Add a model
        </button>
      )}
    </div>
  );

  const configLocked = fileMode;
  const ruleRows = (rules: unknown) =>
    Array.isArray(rules)
      ? (rules as Record<string, unknown>[]).filter((rule) => rule && typeof rule === "object")
      : [];
  const configPreview = (
    <div className="config-preview" aria-live="polite">
      {!preview ? (
        <p className="setup-hint">Enter the path of a .json file inside the project folder.</p>
      ) : preview.loading && !preview.summary ? (
        <p className="setup-hint">Opening {preview.path}…</p>
      ) : preview.error ? (
        <div className="alert error" role="alert">
          <strong>Couldn't open {preview.path}.</strong> {preview.error}
        </div>
      ) : preview.summary ? (
        <>
          <header className="config-preview-head">
            <div>
              <span className="eyebrow">FILE CONTENTS</span>
              <strong>{preview.path}</strong>
            </div>
            <div className="config-preview-actions">
              <button type="button" className="text-button" onClick={() => setPreviewAttempt((value) => value + 1)}>
                Reload
              </button>
              <button type="button" className="button secondary" onClick={editInApp}>
                Edit in the app
              </button>
            </div>
          </header>
          <p className="setup-hint">
            The file supplies the prompts, schema, and grading rules. Your dataset, models, and JSON mode come from
            Setup.
          </p>
          {currentTaskKind === "document-json" && preview.summary.stagePrompts?.ocr && (
            <section className="config-preview-section">
              <h5>Reading prompt</h5>
              <p className="config-prompt">{preview.summary.stagePrompts.ocr}</p>
            </section>
          )}
          <section className="config-preview-section">
            <h5>{currentTaskKind === "tool-calling" ? "Instructions" : "Extraction prompt"}</h5>
            <p className="config-prompt">{preview.summary.stagePrompts?.extraction || "Not set"}</p>
          </section>
          {currentTaskKind === "tool-calling" ? (
            <section className="config-preview-section">
              <h5>Tools ({Array.isArray(preview.summary.tools) ? preview.summary.tools.length : 0})</h5>
              <pre className="config-json">
                <HighlightedJson text={editorText(preview.summary.tools, "[]")} />
              </pre>
            </section>
          ) : (
            <section className="config-preview-section">
              <h5>Fields to return (schema)</h5>
              {preview.summary.schema ? (
                <pre className="config-json">
                  <HighlightedJson text={editorText(preview.summary.schema)} />
                </pre>
              ) : (
                <p className="setup-hint">No schema. The model is only asked for JSON in the prompt.</p>
              )}
            </section>
          )}
          {ruleRows(preview.summary.fieldRules).length > 0 && (
            <section className="config-preview-section">
              <h5>How fields are graded</h5>
              <table className="config-rules">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Match</th>
                    <th scope="col">Tolerance</th>
                  </tr>
                </thead>
                <tbody>
                  {ruleRows(preview.summary.fieldRules).map((rule, index) => (
                    <tr key={`${String(rule.path)}-${index}`}>
                      <td>
                        <code>{String(rule.path ?? "")}</code>
                      </td>
                      <td>{String(rule.match ?? "exact")}</td>
                      <td>{rule.tolerance === undefined ? "—" : String(rule.tolerance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {ruleRows(preview.content?.crossFieldRules).length > 0 && (
            <section className="config-preview-section">
              <h5>Cross-field checks</h5>
              <ul className="config-checks">
                {ruleRows(preview.content?.crossFieldRules).map((rule, index) => (
                  <li key={index}>{String(rule.name ?? rule.type ?? "Check")}</li>
                ))}
              </ul>
            </section>
          )}
          <details className="config-raw">
            <summary>Show the whole file</summary>
            <pre className="config-json">
              <HighlightedJson text={JSON.stringify(preview.content ?? {}, null, 2)} />
            </pre>
          </details>
        </>
      ) : null}
    </div>
  );
  const instructions = (
    <div className="setup-block">
      <div className="segmented" role="radiogroup" aria-label="Where the instructions come from">
        <button type="button" role="radio" aria-checked={!fileMode} onClick={editInApp}>
          <strong>Edit in the app</strong>
          <small>Write the prompt and schema here</small>
        </button>
        <button type="button" role="radio" aria-checked={fileMode} onClick={useFile}>
          <strong>Use a configuration file</strong>
          <small>Read them from a .json file in the project</small>
        </button>
      </div>
      {fileMode ? (
        <>
          <label>
            Configuration file
            <input
              value={form.baseConfigPath}
              placeholder={sampleConfigPath}
              spellCheck={false}
              onChange={(event) => setForm({ ...form, baseConfigPath: event.target.value })}
            />
          </label>
          {configPreview}
        </>
      ) : (
        <>
          {currentTaskKind === "document-json" && form.extractionSource === "ocr" && (
            <label>
              Reading prompt
              <textarea
                value={form.stagePrompts.ocr}
                rows={3}
                onChange={(event) =>
                  setForm({ ...form, stagePrompts: { ...form.stagePrompts, ocr: event.target.value } })
                }
                placeholder={DEFAULT_DOCUMENT_OCR_PROMPT}
              />
              <small>Tells the image model what to transcribe.</small>
            </label>
          )}
          <label>
            {currentTaskKind === "tool-calling"
              ? "Instructions for the model"
              : currentTaskKind === "document-json"
                ? "Extraction prompt"
                : "Prompt"}
            <textarea
              value={form.stagePrompts.extraction}
              rows={4}
              onChange={(event) =>
                setForm({ ...form, stagePrompts: { ...form.stagePrompts, extraction: event.target.value } })
              }
              placeholder={
                currentTaskKind === "tool-calling"
                  ? "Read the request and propose the right tool calls."
                  : currentTaskKind === "document-json"
                    ? DEFAULT_DOCUMENT_EXTRACTION_PROMPT
                    : DEFAULT_TEXT_PROMPT
              }
            />
            <small>
              {currentTaskKind === "tool-calling"
                ? "Say when to call each tool and what the arguments mean. Tools are never executed."
                : "Tell the model which fields to return."}
            </small>
          </label>
          {currentTaskKind !== "tool-calling" && schemaFieldsMissing(form.schema, selectedDataset).length > 0 && (
            <div className="alert warning" role="status">
              The schema doesn't include fields your expected answers use (
              {schemaFieldsMissing(form.schema, selectedDataset).slice(0, 4).join(", ")}). Select{" "}
              <strong>Use example</strong> for the sample dataset, or add them to the schema.
            </div>
          )}
          {currentTaskKind !== "tool-calling" ? (
            <label>
              Fields to return (JSON schema)
              <textarea
                className={`json-editor${schemaCheck && !schemaCheck.ok ? " invalid" : ""}`}
                value={form.schema}
                spellCheck={false}
                aria-invalid={schemaCheck ? !schemaCheck.ok : undefined}
                onChange={(event) => setForm({ ...form, schema: event.target.value })}
              />
              <SchemaStatus check={schemaCheck} validLabel="Valid JSON Schema" />
            </label>
          ) : (
            <label>
              Tools the model can use (JSON)
              <textarea
                className={`json-editor tools-editor${toolsCheck && !toolsCheck.ok ? " invalid" : ""}`}
                value={form.tools}
                spellCheck={false}
                aria-invalid={toolsCheck ? !toolsCheck.ok : undefined}
                onChange={(event) => setForm({ ...form, tools: event.target.value })}
              />
              <SchemaStatus
                check={toolsCheck}
                validLabel={`${toolCount} valid tool definition${toolCount === 1 ? "" : "s"}`}
              />
              <small>
                An array of <code>{`{ "type": "function", "function": { … } }`}</code>. Don't put secrets here.
              </small>
            </label>
          )}
          <div className="config-preset-actions">
            <button type="button" className="button secondary" disabled={exampleBusy} onClick={() => void loadSampleSettings()}>
              {exampleBusy ? "Loading example…" : "Use example"}
            </button>
            <button
              type="button"
              className="button secondary"
              aria-expanded={saveAsOpen}
              onClick={() => {
                setSaveAsPath(saveAsPath || lastFilePath || `configs/${currentTaskKind}-settings.json`);
                setSaveAsOpen((value) => !value);
              }}
            >
              Save as file…
            </button>
          </div>
          {saveAsOpen && (
            <div className="inline-panel save-as-panel">
              <label>
                Save these settings to
                <div className="inline-form">
                  <input
                    autoFocus
                    value={saveAsPath}
                    spellCheck={false}
                    onChange={(event) => setSaveAsPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveAsFile();
                      }
                      if (event.key === "Escape") setSaveAsOpen(false);
                    }}
                    placeholder="configs/receipts.json"
                  />
                  <button
                    type="button"
                    className="button primary"
                    disabled={saveAsBusy || !saveAsPath.trim() || issuesForStep(issues, "instructions").length > 0}
                    onClick={() => void saveAsFile()}
                  >
                    {saveAsBusy ? "Saving…" : "Save"}
                  </button>
                </div>
                {issuesForStep(issues, "instructions").length > 0 ? (
                  <small className="save-as-blocked">Can't save yet. {issuesForStep(issues, "instructions")[0].message}</small>
                ) : (
                  <small>
                    A .json file inside the project folder. It includes the prompts, schema, rules, and model names, never
                    API keys.
                  </small>
                )}
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );

  const advancedFields = (
    <AdvancedOptions changed={advancedChanged} defaultOpen>
      <div className="options">
        {currentTaskKind !== "tool-calling" && (
          <div className="field">
            <span className="field-label" id="setup-json-mode">JSON mode</span>
            <Dropdown
              labelledBy="setup-json-mode"
              value={form.outputMode}
              onChange={(outputMode) => setForm({ ...form, outputMode })}
              options={[
                { value: "prompted-json", label: "Ask in the prompt", detail: "Works with any model" },
                {
                  value: "schema-constrained-json",
                  label: "Enforce the schema",
                  detail: "Needs a model that follows a JSON schema",
                },
              ]}
            />
          </div>
        )}
        <label>
          Temperature
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={form.temperature}
            onChange={(event) => setForm({ ...form, temperature: event.target.value })}
          />
        </label>
        <label>
          Max tokens
          <input
            type="number"
            min="1"
            value={form.maxTokens}
            onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
          />
          <small>Raise this if answers get cut off.</small>
        </label>
        {currentTaskKind === "tool-calling" && (
          <>
            <div className="field">
              <span className="field-label" id="setup-tool-choice">Tool choice</span>
              <Dropdown
                labelledBy="setup-tool-choice"
                value={form.toolChoice}
                onChange={(toolChoice) => setForm({ ...form, toolChoice: toolChoice as ToolChoice })}
                options={[
                  { value: "auto", label: "Model decides" },
                  { value: "required", label: "Must call a tool" },
                  { value: "none", label: "No tools" },
                ]}
              />
            </div>
          </>
        )}
      </div>
    </AdvancedOptions>
  );

  const suggestFieldRules = () => {
    const schema = parseEditorJson(form.schema) as { properties?: Record<string, { type?: unknown; format?: unknown }> } | undefined;
    const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
    const existing = parseEditorJson(form.fieldRules);
    const rules: Record<string, unknown>[] = Array.isArray(existing) ? [...existing] : [];
    const covered = new Set(rules.map((rule) => rule?.path));
    let added = 0;
    for (const [field, definition] of Object.entries(properties)) {
      if (covered.has(field)) continue;
      const types = Array.isArray(definition?.type) ? definition.type : [definition?.type];
      const rule: Record<string, unknown> = { path: field };
      if (types.includes("number") || types.includes("integer")) Object.assign(rule, { match: "number", tolerance: 0.01 });
      else if (definition?.format === "date" || /date/i.test(field)) rule.match = "date";
      else if (types.includes("string") && /(summary|description|notes?|comment|reason|explanation)$/i.test(field))
        rule.match = "ignore";
      else if (types.includes("string"))
        rule.match = /(id|number|no|num|code|sku|order|reference|ref)$/i.test(field) ? "exact" : "normalized";
      else continue;
      rules.push(rule);
      added += 1;
    }
    if (!added) {
      onNotice(
        Object.keys(properties).length
          ? "Every text, number, and date field in the schema already has a rule."
          : "Add a schema with properties first, then suggest rules.",
      );
      return;
    }
    setForm({ ...form, fieldRules: JSON.stringify(rules, null, 2) });
    onNotice(`Added ${added} rule${added === 1 ? "" : "s"} from the schema. Adjust any that should be stricter.`);
  };
  const fieldRuleCount = (() => {
    const rules = parseEditorJson(form.fieldRules);
    return Array.isArray(rules) ? rules.length : 0;
  })();
  const grading = form.inferenceOnly ? (
    <div className="setup-block">
      <div className="callout">
        <strong>Nothing to grade.</strong> This run only saves the model's answers. To score them, your cases need
        expected answers.
      </div>
      {scoringControl}
    </div>
  ) : (
    <div className="setup-block grading-block">
      <p className="setup-hint">
        {currentTaskKind === "tool-calling"
          ? "Each answer's tool calls are compared with the expected tool calls: the tool names and every argument."
          : "Each answer is compared with the case's expected answer. A case passes when the JSON is valid, matches the schema, and every expected field matches."}
      </p>
      {currentTaskKind === "tool-calling" ? (
<>
            <div className="field">
              <span className="field-label" id="setup-call-order">Call order</span>
              <Dropdown
                labelledBy="setup-call-order"
                value={form.toolCallOrder}
                onChange={(toolCallOrder) => setForm({ ...form, toolCallOrder: toolCallOrder as ToolCallOrder })}
                options={[
                  { value: "ordered", label: "Order matters" },
                  { value: "unordered", label: "Any order" },
                ]}
              />
            </div>
          <p className="setup-hint">Arguments are compared field by field. Tools are never executed.</p>
        </>
      ) : (
        <>
          <section className="grading-section">
            <header>
              <h4>How fields are compared</h4>
              <span className="tag">{fieldRuleCount ? `${fieldRuleCount} rule${fieldRuleCount === 1 ? "" : "s"}` : "Exact match"}</span>
            </header>
            <p className="setup-hint">
              Fields without a rule must match exactly, and fields that aren't in the expected answer count as
              errors. Add rules to allow rounding, ignore spacing and case, compare dates, let a field be left out,
              or skip free-text fields entirely.
            </p>
            <dl className="match-legend">
              <div>
                <dt>exact</dt>
                <dd>Identical values (the default)</dd>
              </div>
              <div>
                <dt>normalized</dt>
                <dd>Text equal after trimming, collapsing spaces, ignoring case</dd>
              </div>
              <div>
                <dt>number</dt>
                <dd>Within <code>tolerance</code>, e.g. 0.01</dd>
              </div>
              <div>
                <dt>date</dt>
                <dd>Same calendar date</dd>
              </div>
              <div>
                <dt>ignore</dt>
                <dd>Not graded, e.g. a free-text summary</dd>
              </div>
            </dl>
            {configLocked ? (
              <div className="callout">The configuration file supplies the field rules. Review them in the Instructions step.</div>
            ) : (
              <>
                <label>
                  <span className="sr-only">Field rules (JSON)</span>
                  <textarea
                    className="json-editor field-rules-editor"
                    value={form.fieldRules}
                    spellCheck={false}
                    onChange={(event) => setForm({ ...form, fieldRules: event.target.value })}
                    placeholder='[ { "path": "total", "match": "number", "tolerance": 0.01 } ]'
                  />
                  <small>
                    Use <code>*</code> for any list position, e.g. <code>lineItems.*.amount</code>. Add{" "}
                    <code>"required": false</code> to let a field be left out.
                  </small>
                </label>
                <div className="config-preset-actions">
                  <button type="button" className="button secondary" onClick={suggestFieldRules}>
                    Suggest rules from schema
                  </button>
                  {fieldRuleCount > 0 && (
                    <button type="button" className="text-button" onClick={() => setForm({ ...form, fieldRules: "[]" })}>
                      Clear rules
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="grading-section">
            <header>
              <h4>Judge model</h4>
              <span className="tag">{form.judgeTarget ? "On" : "Off"}</span>
            </header>
            <p className="setup-hint">
              Optional. A second model reads each expected and actual answer and gives its own verdict, shown next to the
              field checks. Useful for things exact rules can't capture.
            </p>
            {targetSelect(
              "Judge model (optional)",
              form.judgeTarget,
              (judgeTarget) => setForm({ ...form, judgeTarget }),
              targets,
              null,
            )}
            {form.judgeTarget && (
              <label>
                What should the judge check?
                <textarea
                  required
                  rows={3}
                  value={form.judgeRubric}
                  onChange={(event) => setForm({ ...form, judgeRubric: event.target.value })}
                  placeholder="Is the vendor the legal entity rather than a brand name? Is every field supported by the document?"
                />
              </label>
            )}
            {form.judgeTarget && (
              <div className="config-preset-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={exampleBusy}
                  onClick={() => void loadExampleRubric()}
                >
                  {exampleBusy ? "Loading example…" : "Use example"}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );

  const experimentField = (
    <div className="setup-block">
      <div className="field">
        <span className="field-label" id="setup-experiment-label">
          Experiment <span className="optional">optional</span>
        </span>
        <Dropdown
          labelledBy="setup-experiment-label"
          disabled={creatingExperiment || starting}
          value={newExperimentOpen ? "__new__" : selectedExperimentId || ""}
          onChange={(next) => {
            if (next === "__new__") {
              setNewExperimentOpen(true);
              return;
            }
            setNewExperimentOpen(false);
            onSelectExperiment(next || null);
          }}
          options={[
            { value: "", label: "Leave ungrouped" },
            ...experiments.map((experiment) => ({
              value: experiment.experimentId,
              label: experiment.name,
              detail: `${experiment.runCount} run${experiment.runCount === 1 ? "" : "s"}`,
            })),
            { value: "__new__", label: "+ New experiment…" },
          ]}
        />
        <small>Group runs you want to compare, like different models on one dataset.</small>
      </div>
      {newExperimentOpen && (
        <div className="inline-form">
          <input
            aria-label="New experiment name"
            autoFocus
            value={inlineExperimentName}
            onChange={(event) => setInlineExperimentName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createInlineExperiment().then(() => setNewExperimentOpen(false));
              }
            }}
            placeholder="e.g. Receipt models"
          />
          <button
            type="button"
            className="button secondary"
            disabled={!inlineExperimentName.trim() || creatingExperiment}
            onClick={() => void createInlineExperiment().then(() => setNewExperimentOpen(false))}
          >
            {creatingExperiment ? "Creating…" : "Create"}
          </button>
        </div>
      )}
    </div>
  );

  const summaryItems: { step: SetupStep; label: string; value: string }[] = [
    { step: "type", label: "Type", value: TASK_KIND_LABELS[currentTaskKind] },
    {
      step: "data",
      label: "Dataset",
      value: selectedDataset
        ? `${selectedDataset.name || "Untitled"} · ${selectedDataset.cases.length} ${selectedDataset.cases.length === 1 ? "case" : "cases"}`
        : "Not chosen",
    },
    {
      step: "model",
      label: "Model",
      value:
        currentTaskKind === "document-json" && form.extractionSource === "ocr"
          ? `${describeTarget(selectedOcrTarget)} → ${describeTarget(selectedExtractionTarget)}`
          : describeTarget(selectedExtractionTarget),
    },
    {
      step: "grading",
      label: "Grading",
      value: form.inferenceOnly
        ? "None (outputs only)"
        : currentTaskKind === "tool-calling"
          ? form.toolCallOrder === "unordered"
            ? "Tool calls, any order"
            : "Tool calls, in order"
          : [
              configLocked ? "Rules from file" : fieldRuleCount ? `${fieldRuleCount} field rule${fieldRuleCount === 1 ? "" : "s"}` : "Exact match",
              form.judgeTarget ? `judge: ${form.judgeTarget}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
    },
  ];
  const summary = (onEdit?: (step: SetupStep) => void) => (
    <dl className="setup-summary">
      {summaryItems.map((item) => {
        const missing = issuesForStep(issues, item.step).length > 0 && item.value === "Not chosen";
        return (
          <div key={item.label} className={missing ? "missing" : undefined}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
            {onEdit && (
              <button type="button" className="text-button" onClick={() => onEdit(item.step)}>
                Edit
              </button>
            )}
          </div>
        );
      })}
    </dl>
  );

  const runActions = (
    <div className="setup-run-actions">
      {issues.length > 0 && (
        <ul className="step-issues" role="status">
          {issues.map((issue) => (
            <li key={issue.message}>
              {issue.message}
              {view === "guided" && issue.step !== step && (
                <>
                  {" "}
                  <button type="button" className="text-button" onClick={() => setStep(issue.step)}>
                    Fix
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="command-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || creatingExperiment || activeExecution.active || issues.length > 0}
          onClick={() => void start()}
        >
          {starting
            ? "Starting…"
            : activeExecution.active
              ? activeExecution.phase === "starting"
                ? "Preparing…"
                : "Evaluation running"
              : "Run evaluation"}
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void saveConfig()}>
          {saving ? "Saving…" : "Save without running"}
        </button>
        {activeExecution.canStop && (
          <button
            type="button"
            className="button secondary destructive"
            disabled={activeExecution.phase === "stopping"}
            onClick={() => void stop()}
          >
            {activeExecution.phase === "stopping" ? "Stopping…" : "Stop run"}
          </button>
        )}
      </div>
      {activeExecution.active && !activeExecution.canStop && (
        <small className="execution-note">A run started from a terminal is active. Stop it from that terminal.</small>
      )}
      {JSON.stringify(form) !== savedFormKey && !issues.length && (
        <small className="execution-note">Running saves these settings first.</small>
      )}
      <details className="terminal-option">
        <summary>Run from a terminal</summary>
        <div className="command">
          <code tabIndex={0} aria-label="Terminal run command">
            {command}
          </code>
          <button type="button" onClick={() => void copy()} aria-label="Copy run command">
            ⧉
          </button>
        </div>
        <small>Uses the saved settings: {setup.configPath || "save first"}</small>
      </details>
    </div>
  );

  const stepMeta: Record<SetupStep, { title: string; sub: string; body: ReactNode }> = {
    type: { title: "What are you evaluating?", sub: "Pick the kind of input in your dataset.", body: typeCards },
    data: {
      title: "Choose your data",
      sub: "The cases the model will answer.",
      body: (
        <>
          {datasetChooser}
          {scoringControl}
        </>
      ),
    },
    model: { title: "Pick a model", sub: "The model whose answers you want to check.", body: modelChooser },
    instructions: {
      title: "Tell the model what to do",
      sub: "Start from the example, then adjust it for your data.",
      body: instructions,
    },
    grading: {
      title: "How answers are graded",
      sub: "Decide how strict the checks are. The defaults work for most datasets.",
      body: grading,
    },
    review: {
      title: "Review & run",
      sub: "Check your choices, optionally group the run, then start it.",
      body: (
        <>
          {summary((target) => setStep(target))}
          {experimentField}
          {advancedFields}
          {runActions}
        </>
      ),
    },
  };
  const currentIssues = issuesForStep(issues, step);
  const stepLabels: Record<SetupStep, string> = {
    type: "Type",
    data: "Data",
    model: "Model",
    instructions: "Instructions",
    grading: "Grading",
    review: "Review & run",
  };

  return (
    <>
      <PageTitle
        eyebrow="NEW EVALUATION"
        title="Set up a run"
        sub={view === "guided" ? "Six short steps. You can change anything before running." : "All settings on one page."}
        action={
          <div className="view-switch" role="radiogroup" aria-label="Setup view">
            <button type="button" role="radio" aria-checked={view === "guided"} onClick={() => changeView("guided")}>
              Guided
            </button>
            <button type="button" role="radio" aria-checked={view === "full"} onClick={() => changeView("full")}>
              Full form
            </button>
          </div>
        }
      />
      <fieldset className="setup-fieldset" disabled={busy}>
        {view === "guided" ? (
          <div className="wizard">
            <ol className="wizard-steps" aria-label="Steps">
              {SETUP_STEPS.map((item, index) => {
                const done = index < stepIndex && issuesForStep(issues, item).length === 0;
                const reachable = index <= stepIndex || SETUP_STEPS.slice(0, index).every((prior) => issuesForStep(issues, prior).length === 0);
                return (
                  <li key={item} className={item === step ? "current" : done ? "done" : undefined}>
                    <button
                      type="button"
                      aria-current={item === step ? "step" : undefined}
                      disabled={!reachable}
                      onClick={() => setStep(item)}
                    >
                      <span className="wizard-step-dot" aria-hidden="true">
                        {done ? "✓" : index + 1}
                      </span>
                      {stepLabels[item]}
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className={`wizard-columns${step === "review" ? " single" : ""}`}>
            <section className="panel wizard-panel" aria-labelledby="wizard-step-title">
              <header className="wizard-head">
                <span className="eyebrow">
                  Step {stepIndex + 1} of {SETUP_STEPS.length}
                </span>
                <h3 id="wizard-step-title" tabIndex={-1}>
                  {stepMeta[step].title}
                </h3>
                <p>{stepMeta[step].sub}</p>
              </header>
              <div className="wizard-body">{stepMeta[step].body}</div>
              {step !== "review" && currentIssues.length > 0 && (
                <ul className="step-issues" role="status">
                  {currentIssues.map((issue) => (
                    <li key={issue.message}>{issue.message}</li>
                  ))}
                </ul>
              )}
              <footer className="wizard-nav">
                <button
                  type="button"
                  className="button secondary"
                  disabled={stepIndex === 0}
                  onClick={() => setStep(SETUP_STEPS[stepIndex - 1])}
                >
                  ← Back
                </button>
                {step !== "review" && (
                  <button
                    type="button"
                    className="button primary"
                    disabled={currentIssues.length > 0}
                    onClick={() => setStep(SETUP_STEPS[stepIndex + 1])}
                  >
                    Next →
                  </button>
                )}
              </footer>
            </section>
            {step !== "review" && (
              <aside className="panel wizard-aside" aria-label="Your choices so far">
                <span className="eyebrow">YOUR RUN</span>
                {summary((target) => setStep(target))}
                <p className="setup-hint">
                  {issues.length
                    ? `${issues.length} thing${issues.length === 1 ? "" : "s"} left before you can run.`
                    : "Everything is ready. Review and run when you're done."}
                </p>
              </aside>
            )}
            </div>
          </div>
        ) : (
          <div className="setup-layout">
            <form
              className="panel setup-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveConfig();
              }}
            >
              <section className="form-section">
                <h3>1 · What are you evaluating?</h3>
                {typeCards}
              </section>
              <section className="form-section">
                <h3>2 · Data</h3>
                {datasetChooser}
                {scoringControl}
              </section>
              <section className="form-section">
                <h3>3 · Model</h3>
                {modelChooser}
              </section>
              <section className="form-section">
                <h3>4 · Instructions</h3>
                {instructions}
              </section>
              <section className="form-section">
                <h3>5 · Grading</h3>
                {grading}
              </section>
              {advancedFields}
            </form>
            <aside className="panel command-card">
              <span className="eyebrow">SUMMARY</span>
              <h3>Ready to run?</h3>
              {summary()}
              {experimentField}
              {runActions}
            </aside>
          </div>
        )}
      </fieldset>
    </>
  );
}
function Loading() {
  return (
    <div className="loading">
      <span />
      Loading workspace data…
    </div>
  );
}
function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: string;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
applyTheme(readTheme());
createRoot(document.getElementById("root")!).render(<App />);
