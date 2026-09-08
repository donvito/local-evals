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
};
type Target = {
  name: string;
  baseUrl: string;
  model: string;
  provider?: "openrouter" | "llama.cpp" | "openai-compatible";
  apiKeyEnv?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  supportsVision?: boolean;
  supportsStructuredOutput?: boolean;
  supportsTools?: boolean;
};
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
  judge?: { verdict?: string; evidence?: string };
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
type Tab = "overview" | "runs" | "datasets" | "targets" | "compare" | "setup";
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
  "datasets",
  "targets",
  "compare",
  "setup",
];
const tabFromLocation = (): Tab => {
  const value = window.location.hash.replace(/^#/, "") as Tab;
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
const modelPriceLabel = (value: number | null) =>
  value == null ? "Unknown" : `$${(value * 1_000_000).toFixed(4)}/1M`;
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
const supportedMetrics = (metrics?: Record<string, unknown>) =>
  Object.entries(metrics || {})
    .map(([key, value]) => ({ key, ...metricValue(key, value) }))
    .filter(
      (
        item,
      ): item is {
        key: string;
        label: string;
        display: string;
        kind: "percent" | "count" | "ms" | "text";
      } => Boolean(item.label),
    );
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
const runAverageStageTime = (run: Run) => {
  const values = [
    numericRunMetric(run, "meanOcrMs"),
    numericRunMetric(run, "meanExtractionMs"),
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
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
const isOverviewPerformanceRun = (run: Run) => {
  const status = run.status?.toLowerCase();
  return (
    runAverageStageTime(run) !== undefined &&
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
      return preference === null || preference === "collapsed";
    } catch {
      return true;
    }
  });
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
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
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
    const nextHash = tab === "overview" ? "" : `#${tab}`;
    if (window.location.hash !== nextHash) {
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
  const loadActiveExecution = useCallback(async () => {
    try {
      setActiveExecution(await api<ActiveExecution>("/api/runs/active"));
    } catch {
      /* keep the last known execution state while the dashboard reconnects */
    }
  }, []);
  useEffect(() => {
    void loadRuns();
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
  }, [loadActiveExecution, loadRuns]);
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadRuns();
      void loadActiveExecution();
    }, 2500);
    return () => window.clearInterval(id);
  }, [loadActiveExecution, loadRuns]);
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
          <div>
            <div className="eyebrow">LOCAL-FIRST MODEL EVALUATION</div>
            <h1>Local Evals</h1>
          </div>
        </div>
        <div className="top-actions">
          <span className="connection">
            <i /> Local workspace
          </span>
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
          <div className="nav-label">Workspace</div>
          {(
            [
              "overview",
              "runs",
              "datasets",
              "targets",
              "compare",
              "setup",
            ] as Tab[]
          ).map((item) => (
            <button
              className={tab === item ? "nav-item active" : "nav-item"}
              aria-current={tab === item ? "page" : undefined}
              title={
                sidebarCollapsed
                  ? item === "targets"
                    ? "Providers"
                    : item[0].toUpperCase() + item.slice(1)
                  : undefined
              }
              disabled={setupBusy && item !== "setup"}
              onClick={() => changeTab(item)}
              key={item}
            >
              <span className={`nav-icon icon-${item}`} aria-hidden="true" />
              {item === "targets"
                ? "Providers"
                : item[0].toUpperCase() + item.slice(1)}
              {item === "runs" && runs.some((r) => r.status === "running") ? (
                <b className="live-dot" />
              ) : null}
            </button>
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
          {activeExecution.active && (
            <div className="alert success" role="status" aria-live="polite">
              <strong>
                {activeExecution.ownedByDashboard
                  ? activeExecution.phase === "starting"
                    ? "Evaluation is starting."
                    : "Evaluation is running."
                  : "A terminal-owned evaluation is running."}
              </strong>{" "}
              {activeExecution.ownedByDashboard
                ? "You can stop it from Setup."
                : "Stop it from the terminal that started it."}{" "}
              <button
                className="text-button"
                disabled={setupBusy}
                onClick={() => {
                  if (activeExecution.runId)
                    void openRun(activeExecution.runId);
                  else changeTab("runs");
                }}
              >
                Open Runs →
              </button>
            </div>
          )}
          {tab === "overview" && (
            <Overview
              runs={runs}
              latest={latest}
              passRate={passRate}
              loading={loading}
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
            <Compare runs={runs} preferredRun={selectedRun?.runId} />
          )}
          {tab === "setup" && (
            <SetupPanel
              setup={setup}
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
            />
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile workspace">
        {moreOpen && (
          <div className="mobile-more" id="mobile-more" ref={morePanel}>
            <span className="eyebrow">Workspace</span>
            {(
              [
                ["targets", "Model connections"],
                ["compare", "Compare runs"],
              ] as [Tab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                aria-current={tab === value ? "page" : undefined}
                disabled={setupBusy}
                onClick={() => changeTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {(
          [
            ["overview", "Home"],
            ["runs", "Runs"],
            ["datasets", "Datasets"],
            ["setup", "New run"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            aria-current={tab === value ? "page" : undefined}
            disabled={setupBusy && value !== "setup"}
            onClick={() => changeTab(value)}
          >
            <span className={`nav-icon icon-${value}`} aria-hidden="true" />
            {label}
          </button>
        ))}
        <button
          ref={moreButton}
          aria-expanded={moreOpen}
          aria-controls="mobile-more"
          aria-current={
            ["targets", "compare"].includes(tab) ? "page" : undefined
          }
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

function PageTitle({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 tabIndex={-1}>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </header>
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
function RunRow({ run, onClick }: { run: Run; onClick: () => void }) {
  const total = run.totalCases || run.caseCount || 0;
  return (
    <button className="run-row" onClick={onClick}>
      <span
        className={`status-pill ${run.status === "running" ? "running" : run.inferenceOnly ? "neutral" : run.passedCount === total && total ? "pass" : "neutral"}`}
      >
        {run.status === "running"
          ? "RUNNING"
          : run.inferenceOnly
            ? "INFERENCE"
            : run.status || "COMPLETE"}
      </span>
      <span className="run-name">
        {run.runId.slice(0, 12)}
        <small>{date(run.createdAt)}</small>
      </span>
      <span className="run-count">
        {run.inferenceOnly ? (
          "outputs stored"
        ) : (
          <>
            <>{run.passedCount}</>
            <em>/{total}</em> passed
          </>
        )}
      </span>
      <span className="row-arrow">→</span>
    </button>
  );
}
function AnalyticsBar({
  label,
  value,
}: {
  label: string;
  value?: number;
}) {
  const percentage =
    value === undefined ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="analytics-bar">
      <div className="analytics-bar-label">
        <span>{label}</span>
        <strong>{value === undefined ? "Unavailable" : metric(value)}</strong>
      </div>
      <div
        className="analytics-bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === undefined ? undefined : percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
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
                    aria-label={`${point.run.runId.slice(0, 12)} pass rate ${metric(point.value)}`}
                    onClick={() => onRun(point.run.runId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRun(point.run.runId);
                      }
                    }}
                  />
                  <title>
                    {point.run.runId.slice(0, 12)} · {metric(point.value)}
                  </title>
                </g>
              ))}
            </svg>
          </div>
          <div className="analytics-run-list" aria-label="Recent scored runs">
            {runs
              .slice()
              .reverse()
              .slice(0, 4)
              .map((run) => {
                const passRate = runPassRate(run);
                const stageTime = runAverageStageTime(run);
                return (
                  <button
                    type="button"
                    className="analytics-run-row"
                    key={run.runId}
                    onClick={() => onRun(run.runId)}
                  >
                    <span className="analytics-run-name">
                      <code>{run.runId.slice(0, 12)}</code>
                      <small>{date(run.createdAt)}</small>
                    </span>
                    <span>
                      <b>{passRate === undefined ? "—" : metric(passRate)}</b>
                      <small>pass rate</small>
                    </span>
                    <span>
                      <b>{stageTime === undefined ? "—" : `${Math.round(stageTime)} ms`}</b>
                      <small>avg latency</small>
                    </span>
                    <span className="row-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                );
              })}
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
function LatencyTrend({
  runs,
  onRun,
}: {
  runs: Run[];
  onRun: (id: string) => void;
}) {
  const width = 360;
  const height = 148;
  const left = 42;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = runs.map((run) => runAverageStageTime(run) ?? 0);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, maximum * 0.4, 1);
  const domainMin = Math.max(0, minimum - range * 0.5);
  const domainMax = maximum + range * 0.5;
  const points = runs.map((run, index) => {
    const value = runAverageStageTime(run) ?? 0;
    return {
      run,
      value,
      x:
        runs.length === 1
          ? left + plotWidth / 2
          : left + (plotWidth * index) / (runs.length - 1),
      y: top + ((domainMax - value) / (domainMax - domainMin)) * plotHeight,
    };
  });
  return points.length ? (
    <>
      <div className="analytics-chart-wrap">
        <svg
          className="analytics-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Average stage latency by recent run"
        >
          <title>Average latency by run</title>
          <desc>
            Recent completed runs with timing data shown as independent bars.
            Inference-only runs can be included.
          </desc>
          {[domainMax, (domainMax + domainMin) / 2, domainMin].map(
            (value) => {
              const y =
                top + ((domainMax - value) / (domainMax - domainMin)) * plotHeight;
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
                    {Math.round(value)} ms
                  </text>
                </g>
              );
            },
          )}
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
                aria-label={`${point.run.runId.slice(0, 12)} average latency ${Math.round(point.value)} milliseconds`}
                onClick={() => onRun(point.run.runId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onRun(point.run.runId);
                  }
                }}
              />
              <title>
                {point.run.runId.slice(0, 12)} · {Math.round(point.value)} ms
              </title>
            </g>
          ))}
        </svg>
      </div>
      <div className="analytics-run-list" aria-label="Recent timed runs">
        {runs
          .slice()
          .reverse()
          .slice(0, 4)
          .map((run) => {
            const stageTime = runAverageStageTime(run);
            return (
              <button
                type="button"
                className="analytics-run-row"
                key={run.runId}
                onClick={() => onRun(run.runId)}
              >
                <span className="analytics-run-name">
                  <code>{run.runId.slice(0, 12)}</code>
                  <small>{date(run.createdAt)}</small>
                </span>
                <span>
                  <b>{stageTime === undefined ? "—" : `${Math.round(stageTime)} ms`}</b>
                  <small>avg latency</small>
                </span>
                <span>
                  <b>{runSampleCount(run)}</b>
                  <small>cases</small>
                </span>
                <span className="row-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            );
          })}
      </div>
    </>
  ) : (
    <div className="analytics-empty">
      <strong>Timing data will appear here</strong>
      <span>Completed runs with recorded stage timings will populate this trend.</span>
    </div>
  );
}
function Overview({
  runs,
  latest,
  passRate,
  loading,
  onRun,
  onTab,
}: {
  runs: Run[];
  latest?: Run;
  passRate?: number;
  loading: boolean;
  onRun: (id: string) => void;
  onTab: (tab: Tab) => void;
}) {
  const orderedRuns = newestRuns(runs);
  const qualityRuns = orderedRuns.filter(isOverviewScoredRun);
  const scoredCases = qualityRuns.reduce(
    (total, run) => total + runSampleCount(run),
    0,
  );
  const scoredPasses = qualityRuns.reduce(
    (total, run) => total + runPassedCount(run),
    0,
  );
  const overallPassRate = scoredCases ? scoredPasses / scoredCases : undefined;
  const failedRuns = orderedRuns.filter((run) =>
    failedRunStatuses.has(run.status?.toLowerCase() || ""),
  ).length;
  const activeRuns = orderedRuns.filter(
    (run) => run.status === "running" || run.status === "pending",
  ).length;
  const trendRuns = qualityRuns.slice(0, 8).reverse();
  const performanceRuns = orderedRuns
    .filter(isOverviewPerformanceRun)
    .slice(0, 8)
    .reverse();
  const latestPassRate = latest ? runPassRate(latest) : passRate;
  const latestSampleCount = latest ? runSampleCount(latest) : 0;
  const latestCompleted = latest
    ? runCompletedCount(latest)
    : 0;
  const latestStageTime = latest ? runAverageStageTime(latest) : undefined;
  const latestCost = latest
    ? numericRunMetric(latest, "knownCostUsd")
    : undefined;
  const latestQuality = latest && isOverviewScoredRun(latest);
  const latestScoredRun = qualityRuns[0];
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS"
        title="Evaluation overview"
        sub="Track quality across document, text, and tool-calling evaluations."
        action={
          <button className="button primary" onClick={() => onTab("setup")}>
            Set up a run <span>→</span>
          </button>
        }
      />
      <section className="stats">
        <Stat
          label="Latest pass rate"
          value={
            latest ? metric(latestQuality ? latestPassRate : undefined) : "—"
          }
          note={
            latest
              ? latest.inferenceOnly
                ? "Inference-only; outputs stored, not scored"
                : latestQuality
                  ? `${runPassedCount(latest)} of ${latestSampleCount} cases`
                  : "Quality score unavailable for this run"
              : "No runs yet"
          }
        />
        <Stat
          label="Overall pass rate"
          value={metric(overallPassRate)}
          note={
            qualityRuns.length
              ? `${scoredCases} scored cases across ${qualityRuns.length} completed runs`
              : "Awaiting a completed scored run"
          }
        />
        <Stat
          label="Cases evaluated"
          value={String(
            runs.reduce((total, run) => total + runCompletedCount(run), 0),
          )}
          note={`${runs.length} recorded run${runs.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Active runs"
          value={String(activeRuns)}
          note={
            failedRuns
              ? `${failedRuns} failed run${failedRuns === 1 ? "" : "s"}`
              : "Dashboard or terminal"
          }
        />
      </section>
      {latest?.metrics && (
        <section className="metric-strip">
          {supportedMetrics(latest.metrics).map((item) => (
            <span key={item.key}>
              <b>{item.label}</b>
              <strong>{item.display}</strong>
            </span>
          ))}
        </section>
      )}
      <section className="overview-analytics">
        <section className="panel analytics-panel analytics-trend-panel">
          <div className="panel-head">
            <div>
              <h3>{trendRuns.length ? "Pass rate by run" : "Average latency by run"}</h3>
              <p>
                {trendRuns.length
                  ? "Recent completed scored runs · click a run to inspect its cases"
                  : "Completed runs with timing data · inference-only runs can be included"}
              </p>
            </div>
            <span className="analytics-scope">
              {trendRuns.length ? `${qualityRuns.length} scored` : `${performanceRuns.length} timed`}
            </span>
          </div>
          {trendRuns.length ? (
            <PassRateTrend runs={trendRuns} onRun={onRun} />
          ) : (
            <LatencyTrend runs={performanceRuns} onRun={onRun} />
          )}
        </section>
        <section className="panel analytics-panel analytics-breakdown-panel">
          <div className="panel-head">
            <div>
              <h3>Latest quality signals</h3>
              <p>Checks available from the latest completed scored run</p>
            </div>
          </div>
          {latestScoredRun ? (
            <div className="analytics-bars">
              <AnalyticsBar label="Pass rate" value={runPassRate(latestScoredRun)} />
              <AnalyticsBar
                label="JSON parse success"
                value={numericRunMetric(latestScoredRun, "parseRate")}
              />
              <AnalyticsBar
                label="Schema compliance"
                value={numericRunMetric(latestScoredRun, "schemaRate")}
              />
              <AnalyticsBar
                label="Field accuracy"
                value={numericRunMetric(latestScoredRun, "fieldAccuracy")}
              />
            </div>
          ) : (
            <div className="analytics-empty analytics-empty-compact">
              <strong>No quality score available yet</strong>
              <span>
                Complete a scored run to see pass, parse, schema, and field
                accuracy here.
              </span>
            </div>
          )}
          {latest && (
            <button
              type="button"
              className="text-button analytics-open-button"
              onClick={() => onRun((latestScoredRun || latest).runId)}
            >
              Open latest run details →
            </button>
          )}
        </section>
      </section>
      {latest && (
        <section className="panel analytics-detail-panel">
          <div className="panel-head">
            <div>
              <h3>Latest run detail</h3>
              <p>
                <code>{latest.runId.slice(0, 12)}</code> ·{" "}
                {date(latest.createdAt)}
              </p>
            </div>
            <span className="analytics-status">
              {latest.status || "Complete"}
              {latest.inferenceOnly ? " · Inference only" : ""}
            </span>
          </div>
          <div className="analytics-detail-grid">
            <div>
              <span>Cases complete</span>
              <strong>
                {latestCompleted}/{latestSampleCount || "—"}
              </strong>
              <small>Outputs recorded for this run</small>
            </div>
            <div>
              <span>Pass rate</span>
              <strong>
                {latestQuality ? metric(latestPassRate) : "Unavailable"}
              </strong>
              <small>
                {latest.inferenceOnly
                  ? "Inference-only run"
                  : "Requires scored cases"}
              </small>
            </div>
            <div>
              <span>Average stage time</span>
              <strong>
                {latestStageTime === undefined
                  ? "Unavailable"
                  : `${Math.round(latestStageTime)} ms`}
              </strong>
              <small>OCR plus extraction mean</small>
            </div>
            <div>
              <span>Known cost</span>
              <strong>
                {latestCost === undefined
                  ? "Not reported"
                  : `$${latestCost.toFixed(4)}`}
              </strong>
              <small>Provider usage when available</small>
            </div>
          </div>
        </section>
      )}
      <section className="panel recent">
        <div className="panel-head">
          <div>
            <h3>Recent runs</h3>
            <p>Your latest evaluation snapshots</p>
          </div>
          <button className="text-button" onClick={() => onTab("runs")}>
            View all runs →
          </button>
        </div>
        {loading ? (
          <Loading />
        ) : runs.length ? (
          runs
            .slice(0, 4)
            .map((r) => (
              <RunRow key={r.runId} run={r} onClick={() => onRun(r.runId)} />
            ))
        ) : (
          <Empty
            icon="◎"
            title="No evaluations yet"
            text="Follow the three steps below to make your first evaluation."
            action={
              <div className="onboarding-checklist">
                <button
                  className="text-button"
                  onClick={() => onTab("targets")}
                >
                  <strong>1. Configure and test a target</strong>{" "}
                  <span>Targets →</span>
                </button>
                <button
                  className="text-button"
                  onClick={() => onTab("datasets")}
                >
                  <strong>2. Import a dataset</strong> <span>Datasets →</span>
                </button>
                <button className="text-button" onClick={() => onTab("setup")}>
                  <strong>3. Configure and run</strong> <span>Setup →</span>
                </button>
              </div>
            }
          />
        )}
      </section>
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
              evaluation snapshot{runs.length === 1 ? "" : "s"}
            </span>
          </div>
          <button className="button secondary" onClick={() => onTab("setup")}>
            Setup <span aria-hidden="true">→</span>
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
                      {r.runId.slice(0, 12)} · {date(r.createdAt)} ·{" "}
                      {r.status || "Complete"}
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
                      <code className="run-name" title={r.runId}>
                        {r.runId.slice(0, 12)}
                      </code>
                      <time dateTime={r.createdAt}>{date(r.createdAt)}</time>
                    </span>
                    <span
                      className={`run-row-status ${
                        r.status === "failed" || r.status === "cancelled"
                          ? "fail"
                          : r.status === "running"
                            ? "running"
                            : r.inferenceOnly
                              ? "neutral"
                              : r.passedCount ===
                                    (r.totalCases || r.caseCount || 0) &&
                                  (r.totalCases || r.caseCount || 0)
                                ? "pass"
                                : "neutral"
                      }`}
                    >
                      {r.status === "failed" || r.status === "cancelled"
                        ? r.status
                        : r.status === "running"
                          ? "RUNNING"
                          : r.inferenceOnly
                            ? "INFERENCE"
                            : r.status || "COMPLETE"}
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
              text="Open Run setup to start your first evaluation."
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
                  {pretty({
                    snapshot: run.snapshot,
                    attempts: run.attempts,
                    config: run.config,
                  })}
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
              {error}
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
    : item.judge?.verdict || "Not configured";
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
                <div className="judge">
                  <span className="eyebrow">SEMANTIC JUDGE</span>
                  <strong>{item.judge.verdict || "Recorded"}</strong>
                  <p>{item.judge.evidence || "No evidence supplied."}</p>
                </div>
              ) : (
                <p className="muted">No semantic judge configured.</p>
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
        {pretty(value)}
      </pre>
      {details !== undefined && (
        <details className="code-card-details">
          <summary>Raw provider envelope</summary>
          <pre tabIndex={0} aria-label="Raw provider envelope">
            {pretty(details)}
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<Notice["kind"]>("success");
  const [createOpen, setCreateOpen] = useState(false);
  const [generateTarget, setGenerateTarget] = useState(targets[0]?.name || "");
  const [generateTaskKind, setGenerateTaskKind] = useState<
    "text-json" | "tool-calling"
  >("text-json");
  const [generateName, setGenerateName] = useState("");
  const [generateCount, setGenerateCount] = useState("5");
  const [generateBrief, setGenerateBrief] = useState("");
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
  useEffect(() => {
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
  const importPath = async (datasetPath: string, label: string) => {
    setBusy(true);
    setMessage("");
    try {
      const imported = await api<Dataset>("/api/datasets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: datasetPath }),
      });
      await onRefresh();
      setSelectedVersion(imported.version);
      setPath("");
      setMessageKind("success");
      setMessage(`${label} imported.`);
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };
  const importDataset = async (e: FormEvent) => {
    e.preventDefault();
    await importPath(path, "Dataset");
  };
  const generateDataset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const generated = await api<Dataset>("/api/datasets/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetName: generateTarget,
          taskKind: generateTaskKind,
          name: generateName,
          caseCount: Number(generateCount),
          brief: generateBrief,
        }),
      });
      await onRefresh();
      setSelectedVersion(generated.version);
      setCreateOpen(false);
      setMessageKind("success");
      setMessage(
        `${generated.name} created with ${generated.cases.length} cases.`,
      );
    } catch (err) {
      setMessageKind("error");
      setMessage(
        err instanceof Error ? err.message : "Dataset generation failed",
      );
    } finally {
      setBusy(false);
    }
  };
  const sampleDatasets: { taskKind: TaskKind; path: string }[] = [
    { taskKind: "document-json", path: "sample-data/manifest.json" },
    { taskKind: "text-json", path: "sample-data/text-json/manifest.json" },
    {
      taskKind: "tool-calling",
      path: "sample-data/tool-calling/manifest.json",
    },
  ];
  return (
    <>
      <PageTitle eyebrow="DATASETS" title="Datasets" />
      <section className="panel dataset-panel">
        <div
          className="dataset-management-toolbar"
          aria-label="Dataset management"
        >
          <form
            className="inline-form dataset-import-form"
            onSubmit={importDataset}
            aria-busy={busy}
          >
            <label
              className="dataset-toolbar-label"
              htmlFor="dataset-import-path"
            >
              Import JSONL
            </label>
            <div className="import-controls">
              <input
                id="dataset-import-path"
                required
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="manifests/invoices.jsonl"
                aria-describedby="dataset-path-help"
              />
              <button className="button secondary" disabled={busy}>
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
            <small id="dataset-path-help" className="sr-only">
              Use a path relative to the project root, for example{" "}
              <code>datasets/receipts.jsonl</code>.
            </small>
          </form>
          <button
            type="button"
            className="button primary dataset-create-toggle"
            onClick={() => setCreateOpen((value) => !value)}
            aria-expanded={createOpen}
            aria-controls="dataset-create-panel"
          >
            {createOpen ? "Close creator" : "Create new dataset"}
          </button>
          <div className="sample-imports">
            <span className="dataset-toolbar-label">Quick samples</span>
            <div className="sample-import-actions">
              {sampleDatasets.map((sample) => (
                <button
                  key={sample.taskKind}
                  type="button"
                  className="button mini"
                  disabled={busy}
                  onClick={() =>
                    void importPath(
                      sample.path,
                      TASK_KIND_LABELS[sample.taskKind],
                    )
                  }
                >
                  Import {TASK_KIND_LABELS[sample.taskKind]}
                </button>
              ))}
            </div>
          </div>
        </div>
        {createOpen && (
          <form
            id="dataset-create-panel"
            className="dataset-create-panel"
            onSubmit={generateDataset}
            aria-busy={busy}
          >
            <div className="dataset-create-copy">
              <span className="eyebrow">PROVIDER-POWERED</span>
              <h3>Create a synthetic dataset</h3>
              <p>
                Generate labeled Text → JSON or Tool calling cases with a
                configured provider and model. Credentials stay in the local
                encrypted vault.
              </p>
              <small>
                Image documents still come from imported files, so the creator
                does not invent image assets.
              </small>
            </div>
            <div className="dataset-create-fields">
              <label>
                Provider &amp; model
                <select
                  required
                  value={generateTarget}
                  onChange={(event) => setGenerateTarget(event.target.value)}
                >
                  <option value="" disabled>
                    Choose a configured provider
                  </option>
                  {targets.map((target) => (
                    <option key={target.name} value={target.name}>
                      {target.name} · {providerLabel(target)} · {target.model}
                    </option>
                  ))}
                </select>
                {!targets.length && (
                  <small>
                    Add a provider and model in Providers &amp; models first.
                  </small>
                )}
              </label>
              <label>
                Dataset type
                <select
                  value={generateTaskKind}
                  onChange={(event) =>
                    setGenerateTaskKind(
                      event.target.value as "text-json" | "tool-calling",
                    )
                  }
                >
                  <option value="text-json">Text → JSON</option>
                  <option value="tool-calling">Tool calling</option>
                </select>
              </label>
              <label>
                Dataset name <span className="optional">optional</span>
                <input
                  value={generateName}
                  onChange={(event) => setGenerateName(event.target.value)}
                  placeholder="Support intents — generated"
                />
              </label>
              <label>
                Cases
                <input
                  type="number"
                  min="1"
                  max="50"
                  required
                  value={generateCount}
                  onChange={(event) => setGenerateCount(event.target.value)}
                />
              </label>
              <label className="dataset-create-brief">
                What should the cases cover?
                <textarea
                  value={generateBrief}
                  onChange={(event) => setGenerateBrief(event.target.value)}
                  placeholder="Classify support messages by urgency and topic. Include ambiguous and edge cases."
                  rows={3}
                />
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={busy || !targets.length}
              >
                {busy ? "Generating…" : "Generate dataset"}
              </button>
            </div>
          </form>
        )}
        {message && (
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
        )}
        {datasets.length ? (
          <div className="dataset-library">
            <div className="dataset-library-layout">
              <aside className="dataset-picker" aria-label="Dataset selection">
                <div className="dataset-picker-heading">
                  <strong>Datasets</strong>
                </div>
                <div className="dataset-choice-list">
                  {datasets.map((d) => {
                    const selected = d.version === selectedVersion;
                    return (
                      <button
                        key={d.version}
                        type="button"
                        className={`dataset-choice${selected ? " selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => setSelectedVersion(d.version)}
                      >
                        <span
                          className="dataset-choice-icon"
                          aria-hidden="true"
                        >
                          ▦
                        </span>
                        <span className="dataset-choice-copy">
                          <strong>{d.name || "Untitled dataset"}</strong>
                          <span>
                            {TASK_KIND_LABELS[datasetTaskKind(d)]} ·{" "}
                            {d.cases.length}{" "}
                            {d.cases.length === 1 ? "case" : "cases"}
                          </span>
                        </span>
                        <span
                          className="dataset-choice-arrow"
                          aria-hidden="true"
                        >
                          →
                        </span>
                      </button>
                    );
                  })}
                </div>
              </aside>
              {datasets.find(
                (dataset) => dataset.version === selectedVersion,
              ) && (
                <section
                  className="dataset-selection"
                  aria-label="Selected dataset"
                >
                  <div className="dataset-selection-note">
                    <div>
                      <span className="eyebrow">SELECTED DATASET</span>
                      <p>Browse the cases and inspect one record at a time.</p>
                    </div>
                    <span className="dataset-selection-hint">
                      Use Open viewer for a larger workspace
                    </span>
                  </div>
                  <DatasetViewer
                    dataset={datasets.find(
                      (dataset) => dataset.version === selectedVersion,
                    )!}
                  />
                </section>
              )}
            </div>
          </div>
        ) : (
          <Empty
            icon="▦"
            title="No datasets imported"
            text="Import a JSONL manifest with a project-relative path."
          />
        )}
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

function DatasetViewer({ dataset }: { dataset: Dataset }) {
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
          taskKind={taskKind}
          isOpen={maximized}
          onMaximize={() => setMaximized(true)}
          onRaw={() => setRawOpen(true)}
          maximizeButtonRef={maximizeButton}
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
            {rawBusy ? "Loading JSONL…" : rawText}
          </pre>
        </div>
      </dialog>
    </>
  );
}

function DatasetHeader({
  dataset,
  taskKind,
  titleId,
  isOpen,
  onMaximize,
  onRaw,
  onClose,
  maximizeButtonRef,
}: {
  dataset: Dataset;
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
            <h3 id={titleId}>{dataset.name || "Untitled dataset"}</h3>
            <span className="tag dataset-kind">
              {TASK_KIND_LABELS[taskKind]}
            </span>
          </div>
          <div className="dataset-meta">
            <span className="data-version" title={dataset.version}>
              Version {dataset.version}
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
      {code ? <code>{text}</code> : text}
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
        <code>{datasetDisplayValue(value, empty || "Not supplied")}</code>
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
  const [minimumContext, setMinimumContext] = useState("");
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
  const minimumContextValue = Number(minimumContext);
  const filteredModels = (catalog?.models || [])
    .filter((model) => {
      const capabilities = modelCapabilities(model);
      const search = query.trim().toLowerCase();
      const matchesSearch =
        !search ||
        `${model.id} ${model.name} ${model.description || ""}`
          .toLowerCase()
          .includes(search);
      const matchesContext =
        !minimumContext ||
        (model.contextLength != null &&
          Number.isFinite(minimumContextValue) &&
          model.contextLength >= minimumContextValue);
      return (
        matchesSearch &&
        matchesContext &&
        (!filters.vision || capabilities.vision) &&
        (!filters.structured || capabilities.structured) &&
        (!filters.tools || capabilities.tools) &&
        (!filters.free || capabilities.free)
      );
    })
    .sort((left, right) => {
      const search = query.trim().toLowerCase();
      if (!search) return left.name.localeCompare(right.name);
      const score = (model: ModelCatalogModel) => {
        const id = model.id.toLowerCase();
        const name = model.name.toLowerCase();
        if (id === search) return 0;
        if (id.startsWith(search)) return 1;
        if (name.startsWith(search)) return 2;
        if (id.includes(search) || name.includes(search)) return 3;
        return 4;
      };
      return score(left) - score(right) || left.name.localeCompare(right.name);
    });
  const activeFilterCount =
    Number(Boolean(query.trim())) +
    Number(Boolean(minimumContext)) +
    Object.values(filters).filter(Boolean).length;
  const clearFilters = () => {
    setQuery("");
    setMinimumContext("");
    setFilters({ vision: false, structured: false, tools: false, free: false });
  };
  return (
    <div className="model-picker">
      <label>
        Model ID
        <input
          required
          value={value}
          onChange={(e) => onManualChange(e.target.value)}
          placeholder="anthropic/claude-3.5-sonnet"
          aria-describedby="model-picker-help"
        />
      </label>
      <div className="model-picker-toolbar">
        <label>
          Search {providerName} models
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search model name or ID"
          />
        </label>
        <label>
          Min context
          <input
            type="number"
            min="0"
            step="1000"
            value={minimumContext}
            onChange={(e) => setMinimumContext(e.target.value)}
            placeholder="Any"
          />
        </label>
      </div>
      <div
        className="model-picker-filters"
        aria-label="Advertised model capabilities"
      >
        {(
          [
            ["vision", "Vision"],
            ["structured", "Structured JSON"],
            ["tools", "Tools"],
            ["free", "Free"],
          ] as [keyof typeof filters, string][]
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={filters[key]}
              onChange={(e) =>
                setFilters((current) => ({
                  ...current,
                  [key]: e.target.checked,
                }))
              }
            />
            {label}
          </label>
        ))}
      </div>
      {activeFilterCount > 0 && (
        <button
          type="button"
          className="text-button model-picker-clear"
          onClick={clearFilters}
        >
          Clear search and filters ({activeFilterCount})
        </button>
      )}
      <div className="model-picker-status" aria-live="polite">
        {loading
          ? `Loading ${providerName} models…`
          : catalogError
            ? catalogError
            : `${filteredModels.length} of ${catalog?.models.length || 0} models`}
        {catalog?.stale && !catalogError ? " · cached data" : ""}
        {catalogError && (
          <button
            type="button"
            className="text-button model-picker-retry"
            onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
          >
            Retry catalog
          </button>
        )}
      </div>
      {!loading && !catalogError && (
        <div
          className="model-picker-results"
          role="group"
          aria-label={`${providerName} models`}
        >
          {filteredModels.slice(0, 100).map((model) => {
            const capabilities = modelCapabilities(model);
            const selected = model.id === value;
            return (
              <button
                type="button"
                aria-pressed={selected}
                className={selected ? "model-option selected" : "model-option"}
                key={model.id}
                onClick={() => onSelect(model)}
              >
                <span className="model-option-name">
                  <strong>{model.name || model.id}</strong>
                  <code>{model.id}</code>
                </span>
                <span className="model-badges">
                  {capabilities.vision && <span>Vision</span>}
                  {capabilities.structured && <span>JSON</span>}
                  {capabilities.tools && <span>Tools</span>}
                  {capabilities.free && providerName === "OpenRouter" && (
                    <span>Free</span>
                  )}
                </span>
                <small>
                  {modelContextLabel(model.contextLength)}
                  {providerName === "OpenRouter" && (
                    <>
                      {" · In "}
                      {modelPriceLabel(model.promptPrice)}
                      {" · Out "}
                      {modelPriceLabel(model.completionPrice)}
                    </>
                  )}
                  {!capabilities.known && " · Capabilities not advertised"}
                </small>
              </button>
            );
          })}
          {!filteredModels.length && (
            <p className="model-picker-empty">
              No {providerName} models match these filters.
            </p>
          )}
          {filteredModels.length > 100 && (
            <p className="model-picker-empty">
              Showing the first 100 matches. Search or filter to narrow the
              list.
            </p>
          )}
        </div>
      )}
      <small id="model-picker-help" className="model-picker-help">
        Choose a discovered model to fill in its ID. Advertised capabilities are
        hints only; endpoint preflight remains authoritative. If this provider
        does not expose model metadata, enter the model ID manually and set
        capabilities below.
      </small>
    </div>
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
  const [editing, setEditing] = useState<Target>({
    name: "",
    baseUrl: "http://127.0.0.1:8080/v1",
    provider: "openai-compatible",
    model: "",
    apiKeyEnv: "",
    apiKey: "",
    supportsVision: false,
    supportsStructuredOutput: false,
    supportsTools: false,
  });
  const [testing, setTesting] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await api<Target>(
        `/api/targets/${encodeURIComponent(editing.name)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editing),
        },
      );
      setTargets([...targets.filter((t) => t.name !== result.name), result]);
      setEditing({ ...result, apiKey: "" });
      onNotice(`Target “${result.name}” saved.`);
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Could not save target",
        "error",
      );
    }
  };
  const test = async (target: Target) => {
    setTesting(target.name);
    try {
      const result = await api<{ message?: string }>(
        `/api/targets/${encodeURIComponent(target.name)}/test`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vision: Boolean(target.supportsVision) }),
        },
      );
      onNotice(result.message || `Connection to ${target.name} succeeded.`);
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Connection test failed",
        "error",
      );
    } finally {
      setTesting("");
    }
  };
  const savedEditingTarget = targets.find(
    (target) => target.name === editing.name,
  );
  const modelDiscoveryEndpoint =
    editing.provider === "openrouter"
      ? "/api/models/openrouter"
      : savedEditingTarget
        ? `/api/models/target/${encodeURIComponent(editing.name)}`
        : "";
  const modelDiscoveryName =
    editing.provider === "openrouter" ? "OpenRouter" : providerLabel(editing);
  const selectDiscoveredModel = (model: ModelCatalogModel) => {
    const capabilities = modelCapabilities(model);
    setEditing((current) => ({
      ...current,
      model: model.id,
      ...(capabilities.known
        ? {
            supportsVision: capabilities.vision,
            supportsStructuredOutput: capabilities.structured,
            supportsTools: capabilities.tools,
          }
        : {}),
    }));
  };
  return (
    <>
      <PageTitle
        eyebrow="PROVIDERS & MODELS"
        title="Providers & models"
        sub="Configure the local or cloud models used by each pipeline stage."
      />
      <div className="targets-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Configured providers &amp; models</h3>
              <p>
                Credentials are encrypted locally and never shown after saving.
              </p>
            </div>
          </div>
          {targets.length ? (
            targets.map((t) => (
              <div className="target-row" key={t.name}>
                <div className="target-info">
                  <strong>{t.name}</strong>
                  <span>
                    {providerLabel(t)} · {t.model} · {t.baseUrl}
                  </span>
                  <small>
                    {t.supportsVision ? "Vision" : "Text only"} ·{" "}
                    {t.supportsStructuredOutput
                      ? "Structured output"
                      : "Prompted JSON"}{" "}
                    · {t.supportsTools ? "Tools" : "No tools"} ·{" "}
                    {t.hasApiKey ? "Credential saved" : "No credential"}
                  </small>
                </div>
                <div className="target-actions">
                  <button
                    className="button mini"
                    disabled={testing === t.name}
                    onClick={() => void test(t)}
                  >
                    {testing === t.name ? "Testing…" : "Test"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setEditing({ ...t, apiKey: "" })}
                  >
                    Edit
                  </button>
                  {t.hasApiKey && (
                    <button
                      className="text-button destructive"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove the saved credential for “${t.name}”?`,
                          )
                        )
                          return;
                        void api<Target>(
                          `/api/targets/${encodeURIComponent(t.name)}`,
                          {
                            method: "PUT",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                              ...t,
                              apiKey: "",
                              clearApiKey: true,
                            }),
                          },
                        )
                          .then((result) => {
                            setTargets([
                              ...targets.filter((x) => x.name !== result.name),
                              result,
                            ]);
                            setEditing((current) =>
                              current.name === result.name
                                ? { ...result, apiKey: "" }
                                : current,
                            );
                            onNotice(
                              `Saved credential removed from “${result.name}”.`,
                            );
                          })
                          .catch((err) =>
                            onNotice(
                              err instanceof Error
                                ? err.message
                                : "Could not remove credential",
                              "error",
                            ),
                          );
                      }}
                    >
                      Remove saved credential
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <Empty
              icon="⌁"
              title="No targets configured"
              text="Add a local or OpenAI-compatible endpoint to get started."
            />
          )}
        </section>
        <form className="panel target-form" onSubmit={save}>
          <h3>{editing.name ? "Edit target" : "Add target"}</h3>
          <p className="form-intro">
            The name is used in run configuration and snapshots.
          </p>
          <label>
            Provider
            <select
              value={editing.provider || "openai-compatible"}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  provider: e.target.value as Target["provider"],
                })
              }
            >
              <option value="openrouter">OpenRouter</option>
              <option value="llama.cpp">llama.cpp</option>
              <option value="openai-compatible">OpenAI / compatible</option>
            </select>
          </label>
          <label>
            Name
            <input
              required
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="local-llama"
            />
          </label>
          <label>
            Base URL
            <input
              required
              value={editing.baseUrl}
              onChange={(e) =>
                setEditing({ ...editing, baseUrl: e.target.value })
              }
              placeholder="http://127.0.0.1:8080/v1"
            />
            <small>
              OpenAI: https://api.openai.com/v1 · LM Studio:
              http://127.0.0.1:1234/v1
            </small>
          </label>
          {modelDiscoveryEndpoint ? (
            <ModelPicker
              value={editing.model}
              onManualChange={(model) => setEditing({ ...editing, model })}
              onSelect={selectDiscoveredModel}
              endpoint={modelDiscoveryEndpoint}
              providerName={modelDiscoveryName}
            />
          ) : (
            <label>
              Model ID
              <input
                required
                value={editing.model}
                onChange={(e) =>
                  setEditing({ ...editing, model: e.target.value })
                }
                placeholder="qwen2.5-vl"
              />
              {editing.provider !== "openrouter" && editing.name && (
                <small>Save this provider first to discover its models.</small>
              )}
            </label>
          )}
          <label>
            API key <span className="optional">encrypted locally</span>
            <input
              type="password"
              value={editing.apiKey || ""}
              onChange={(e) =>
                setEditing({ ...editing, apiKey: e.target.value })
              }
              placeholder={
                editing.hasApiKey
                  ? "Saved — enter a new key to replace"
                  : "Paste your OpenRouter key"
              }
            />
            <small>
              Stored encrypted in the local database. It is not returned to the
              browser or exported.
            </small>
          </label>
          <div className="checks">
            <label>
              <input
                type="checkbox"
                checked={Boolean(editing.supportsVision)}
                onChange={(e) =>
                  setEditing({ ...editing, supportsVision: e.target.checked })
                }
              />{" "}
              Supports vision
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(editing.supportsStructuredOutput)}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    supportsStructuredOutput: e.target.checked,
                  })
                }
              />{" "}
              Structured output
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(editing.supportsTools)}
                onChange={(e) =>
                  setEditing({ ...editing, supportsTools: e.target.checked })
                }
              />{" "}
              Tool calling
            </label>
          </div>
          <button className="button primary" type="submit">
            Save target
          </button>
        </form>
      </div>
    </>
  );
}
function Compare({
  runs,
  preferredRun,
}: {
  runs: Run[];
  preferredRun?: string;
}) {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [result, setResult] = useState<any>(null);
  const [resultKey, setResultKey] = useState("");
  const [busy, setBusy] = useState(false);
  const compareRequest = useRef(0);
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
        sub="Find regressions across matching cases and compatible snapshots."
      />
      <form
        className="panel compare-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (left && right && !busy) void submit();
        }}
      >
        <label>
          Baseline (left)
          <select
            value={left}
            onChange={(e) => changeSelection("left", e.target.value)}
          >
            <option value="">Choose a run</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.runId.slice(0, 12)} · {date(r.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <span className="versus">VS</span>
        <label>
          Candidate (right)
          <select
            value={right}
            onChange={(e) => changeSelection("right", e.target.value)}
          >
            <option value="">Choose a run</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.runId.slice(0, 12)} · {date(r.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={!left || !right || busy}
          type="submit"
        >
          {busy ? "Comparing…" : "Compare runs"}
        </button>
      </form>
      {result && resultKey === selectionKey && result.error ? (
        <div className="alert error">{result.error}</div>
      ) : result && resultKey === selectionKey ? (
        <section className="comparison-results">
          <div className="stats">
            <Stat
              label="Matched cases"
              value={String(result.sampleCount)}
              note="Comparable sample"
            />
            <Stat
              label="Improved"
              value={String(result.improved)}
              note="Candidate better"
            />
            <Stat
              label="Regressed"
              value={String(result.regressed)}
              note="Candidate worse"
            />
          </div>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>Field movement</h3>
                <p>Positive and negative changes by JSON path.</p>
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
          title="Choose two compatible runs"
          text="Comparison requires matching dataset, schema, and grader versions."
        />
      )}
    </>
  );
}
function SetupPanel({
  setup,
  targets,
  datasets,
  activeExecution,
  onRefreshRuns,
  onSaved,
  onNotice,
  onOpenRun,
  onBusyChange,
}: {
  setup: Setup;
  targets: Target[];
  datasets: Dataset[];
  activeExecution: ActiveExecution;
  onRefreshRuns: () => Promise<void>;
  onSaved: (x: Setup) => void;
  onNotice: (message: string, kind?: Notice["kind"]) => void;
  onOpenRun: (runId: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
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
  useEffect(() => {
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
      setForm((current) => ({
        ...current,
        // Sample settings are copied into the native editors. Clear the
        // advanced path so the copied values are the only active source.
        baseConfigPath: "",
        outputMode: example.outputMode ?? current.outputMode,
        judgeTarget:
          currentTaskKind === "tool-calling" ? "" : current.judgeTarget,
        judgeRubric:
          currentTaskKind === "tool-calling"
            ? ""
            : (example.judgeRubric ?? current.judgeRubric),
        schema:
          example.schema === undefined
            ? current.schema
            : editorText(example.schema),
        stagePrompts: {
          ...current.stagePrompts,
          ...(example.stagePrompts || {}),
        },
        fieldRules:
          example.fieldRules === undefined
            ? current.fieldRules
            : editorText(example.fieldRules, "[]"),
        tools:
          example.tools === undefined
            ? current.tools
            : editorText(example.tools, "[]"),
        toolChoice: example.toolChoice ?? current.toolChoice,
        toolCallOrder: example.toolCallOrder ?? current.toolCallOrder,
      }));
      onNotice(
        `${TASK_KIND_LABELS[currentTaskKind]} sample settings loaded into the native editors. Your dataset and targets were kept.`,
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
  const saveConfig = async (): Promise<boolean> => {
    const taskKind = asTaskKind(form.taskKind);
    if (
      taskKind === "document-json" &&
      form.extractionSource === "ocr" &&
      !form.ocrTarget
    ) {
      onNotice(
        "Choose a vision-capable OCR target, or select reference transcription.",
        "error",
      );
      return false;
    }
    if (
      taskKind === "tool-calling" &&
      !selectedExtractionTarget?.supportsTools
    ) {
      onNotice(
        "Choose a target marked as tool-capable before saving a tool-calling run.",
        "error",
      );
      return false;
    }
    const schema = parseEditorJson(form.schema);
    const fieldRules = parseEditorJson(form.fieldRules);
    const tools = parseEditorJson(form.tools);
    const fieldRulesPayload =
      taskKind === "document-json" &&
      form.fieldRules.trim() === "[]" &&
      setup.config?.fieldRules === undefined
        ? undefined
        : fieldRules;
    if (taskKind === "text-json") {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        onNotice(
          "Enter a valid JSON object schema for the text workflow.",
          "error",
        );
        return false;
      }
      if (!form.stagePrompts.extraction.trim()) {
        onNotice("Add an extraction prompt for the text workflow.", "error");
        return false;
      }
    }
    if (taskKind === "tool-calling" && !form.stagePrompts.extraction.trim()) {
      onNotice("Add tool-calling instructions before saving.", "error");
      return false;
    }
    if (
      taskKind !== "tool-calling" &&
      ((form.fieldRules.trim() !== "" && !Array.isArray(fieldRules)) ||
        (taskKind !== "document-json" && !Array.isArray(fieldRules)))
    ) {
      onNotice("Field rules must be a JSON array.", "error");
      return false;
    }
    if (taskKind === "tool-calling") {
      if (!Array.isArray(tools)) {
        onNotice("Tool definitions must be a JSON array.", "error");
        return false;
      }
      if (form.toolChoice !== "none" && tools.length === 0) {
        onNotice(
          "Add at least one tool or choose tool choice “none”.",
          "error",
        );
        return false;
      }
    }
    if (
      taskKind !== "tool-calling" &&
      form.judgeTarget &&
      !form.judgeRubric.trim()
    ) {
      onNotice(
        "Add a judge rubric when a semantic judge is configured.",
        "error",
      );
      return false;
    }
    setSaving(true);
    try {
      const result = await api<Setup>("/api/setup/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          taskKind,
          schema,
          // Legacy document mode inherits the proven OCR/extraction prompts
          // from its defaults or base config. Native text/tool modes submit
          // their editors.
          stagePrompts: form.stagePrompts,
          fieldRules: taskKind === "tool-calling" ? [] : fieldRulesPayload,
          tools: taskKind === "tool-calling" ? tools : undefined,
          toolChoice: form.toolChoice,
          toolCallOrder: form.toolCallOrder,
          judgeTarget: taskKind === "tool-calling" ? "" : form.judgeTarget,
          judgeRubric: taskKind === "tool-calling" ? "" : form.judgeRubric,
          outputMode:
            taskKind === "tool-calling" ? "prompted-json" : form.outputMode,
          generation: {
            temperature: Number(form.temperature),
            maxTokens: Number(form.maxTokens),
          },
        }),
      });
      taskKindOverride.current = null;
      onSaved({ ...setup, ...result });
      setSavedFormKey(JSON.stringify(form));
      onNotice(
        "Run configuration saved. You can start it here or from your terminal.",
      );
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
    setup.runCommand || "evalforge run --config evalforge.config.json";
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
      if (JSON.stringify(form) !== savedFormKey && !(await saveConfig()))
        return;
      const result = await api<{ runId?: string }>("/api/runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      onNotice("Evaluation started. Watch progress in Run history.");
      await onRefreshRuns();
      if (result.runId) await onOpenRun(result.runId);
      else onNotice("Evaluation started. Open Runs to watch progress.");
    } catch (err) {
      onNotice(
        err instanceof Error ? err.message : "Could not start evaluation",
        "error",
      );
    } finally {
      setStarting(false);
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
  return (
    <>
      <PageTitle
        eyebrow="GET STARTED"
        title="Prepare an evaluation"
        sub="Choose your dataset and models, then start a run."
      />
      <div className="setup-layout">
        <form className="panel setup-form" onSubmit={save}>
          <fieldset disabled={saving || starting || exampleBusy}>
            <section
              className="form-section"
              aria-labelledby="setup-data-heading"
            >
              <div className="section-heading">
                <h3 id="setup-data-heading">Dataset & configuration</h3>
                <p>Choose the input type, dataset, and evaluation rules.</p>
              </div>
              <label>
                Evaluation type
                <select
                  aria-label="Evaluation type"
                  value={currentTaskKind}
                  onChange={(e) => changeTaskKind(e.target.value as TaskKind)}
                >
                  {(Object.keys(TASK_KIND_LABELS) as TaskKind[]).map((kind) => (
                    <option value={kind} key={kind}>
                      {TASK_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <small>{taskKindDescription(currentTaskKind)}</small>
              </label>
              <label>
                Evaluation configuration
                <input
                  value={form.baseConfigPath}
                  placeholder="sample-data/config.json"
                  onChange={(e) =>
                    setForm({ ...form, baseConfigPath: e.target.value })
                  }
                />
                <small>
                  Advanced fixture path for schema, prompts, and grading rules.
                  Leave blank to use the saved configuration or native editors.
                  Sample path: <code>{sampleConfigPath}</code>
                </small>
              </label>
              <div className="config-preset-actions">
                <button
                  type="button"
                  className="button mini"
                  disabled={exampleBusy}
                  onClick={() => void loadSampleSettings()}
                >
                  {exampleBusy ? "Loading sample…" : "Load sample settings"}
                </button>
                {currentTaskKind !== "document-json" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        baseConfigPath: "",
                      }))
                    }
                  >
                    Use native editors
                  </button>
                )}
              </div>
              {form.baseConfigPath && (
                <div className="alert warning" role="status">
                  This fixture path remains active, so native schema, prompt,
                  field-rule, and tool-definition edits are disabled and will
                  not be used. Clear it to edit those values here.
                </div>
              )}
              <label>
                Dataset
                <select
                  required
                  value={form.datasetVersion}
                  onChange={(e) =>
                    setForm({ ...form, datasetVersion: e.target.value })
                  }
                >
                  <option value="">Select dataset</option>
                  {matchingDatasets.map((d) => (
                    <option key={d.version} value={d.version}>
                      {d.name} · {d.version.slice(0, 8)}
                    </option>
                  ))}
                </select>
                {!matchingDatasets.length && (
                  <small className="form-warning">
                    No {TASK_KIND_LABELS[currentTaskKind].toLowerCase()} dataset
                    is imported yet. Use a quick sample on Datasets.
                  </small>
                )}
              </label>
            </section>
            <section
              className="form-section"
              aria-labelledby="setup-pipeline-heading"
            >
              <div className="section-heading">
                <h3 id="setup-pipeline-heading">Pipeline</h3>
                <p>Assign a model to each stage.</p>
              </div>
              {currentTaskKind === "document-json" && (
                <div className="stage">
                  <span>01</span>
                  <div>
                    <h3>OCR target</h3>
                    <p>
                      Vision model; optional for reference transcription runs.
                    </p>
                  </div>
                  <select
                    aria-label="OCR target"
                    required={form.extractionSource === "ocr"}
                    value={form.ocrTarget}
                    onChange={(e) =>
                      setForm({ ...form, ocrTarget: e.target.value })
                    }
                  >
                    <option value="">Select target</option>
                    {targets
                      .filter((t) => t.supportsVision)
                      .map((t) => (
                        <option key={t.name}>{t.name}</option>
                      ))}
                  </select>
                </div>
              )}
              <div className="stage">
                <span>{currentTaskKind === "document-json" ? "02" : "01"}</span>
                <div>
                  <h3>
                    {currentTaskKind === "text-json"
                      ? "Text JSON target"
                      : currentTaskKind === "tool-calling"
                        ? "Tool-calling target"
                        : "Extraction target"}
                  </h3>
                  <p>
                    {currentTaskKind === "text-json"
                      ? "Converts input text into structured JSON."
                      : currentTaskKind === "tool-calling"
                        ? "Proposes function calls without executing them."
                        : "Converts transcription into structured JSON."}
                  </p>
                </div>
                <select
                  aria-label={`${TASK_KIND_LABELS[currentTaskKind]} target`}
                  required
                  value={form.extractionTarget}
                  onChange={(e) =>
                    setForm({ ...form, extractionTarget: e.target.value })
                  }
                >
                  <option value="">Select target</option>
                  {targets.map((t) => (
                    <option key={t.name}>{t.name}</option>
                  ))}
                </select>
                {currentTaskKind === "tool-calling" && (
                  <small
                    className={
                      selectedExtractionTarget?.supportsTools
                        ? "capability-check good"
                        : "capability-check bad"
                    }
                  >
                    {selectedExtractionTarget?.supportsTools
                      ? "✓ Tools advertised by this target"
                      : "⚠ Choose a target marked as tool-capable in Targets"}
                  </small>
                )}
                {currentTaskKind === "text-json" && (
                  <small className="capability-check">
                    {selectedExtractionTarget?.supportsStructuredOutput
                      ? "✓ Structured JSON advertised"
                      : "Prompted JSON is available; choose a structured-output target for stronger guarantees"}
                  </small>
                )}
              </div>
              {currentTaskKind !== "tool-calling" && (
                <div className="stage">
                  <span>
                    {currentTaskKind === "document-json" ? "03" : "02"}
                  </span>
                  <div>
                    <h3>Optional judge</h3>
                    <p>Stored separately from deterministic grading.</p>
                  </div>
                  <select
                    aria-label="Semantic judge target"
                    value={form.judgeTarget}
                    onChange={(e) =>
                      setForm({ ...form, judgeTarget: e.target.value })
                    }
                  >
                    <option value="">No semantic judge</option>
                    {targets.map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </section>
            {currentTaskKind === "text-json" && (
              <section
                className="form-section native-editor-section"
                aria-labelledby="setup-text-json-heading"
              >
                <div className="section-heading">
                  <h3 id="setup-text-json-heading">Text JSON instructions</h3>
                  <p>
                    These native settings replace receipt/document extraction
                    prompts when no fixture path is selected.
                  </p>
                </div>
                <label>
                  JSON schema
                  <textarea
                    aria-label="JSON schema"
                    className="json-editor"
                    value={form.schema}
                    disabled={Boolean(form.baseConfigPath)}
                    onChange={(e) =>
                      setForm({ ...form, schema: e.target.value })
                    }
                    spellCheck={false}
                    aria-describedby="text-json-schema-help"
                  />
                  <small id="text-json-schema-help">
                    Example object schema is prefilled. Edit it to match the
                    selected text dataset.
                  </small>
                </label>
                <label>
                  Extraction prompt
                  <textarea
                    aria-label="Extraction prompt"
                    value={form.stagePrompts.extraction}
                    disabled={Boolean(form.baseConfigPath)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        stagePrompts: {
                          ...form.stagePrompts,
                          extraction: e.target.value,
                        },
                      })
                    }
                    placeholder={DEFAULT_TEXT_PROMPT}
                  />
                </label>
              </section>
            )}
            {currentTaskKind === "tool-calling" && (
              <section
                className="form-section native-editor-section"
                aria-labelledby="setup-tools-heading"
              >
                <div className="section-heading">
                  <h3 id="setup-tools-heading">Tool definitions</h3>
                  <p>
                    OpenAI function definitions are sent to the model as
                    proposals; the runner never executes them.
                  </p>
                </div>
                <label>
                  Tools JSON
                  <textarea
                    aria-label="Tools JSON"
                    className="json-editor tools-editor"
                    value={form.tools}
                    disabled={Boolean(form.baseConfigPath)}
                    onChange={(e) =>
                      setForm({ ...form, tools: e.target.value })
                    }
                    spellCheck={false}
                    aria-describedby="tools-json-help"
                  />
                  <small id="tools-json-help">
                    Use an array of{" "}
                    <code>{`{ type: "function", function: { ... } }`}</code>{" "}
                    definitions. A clear lookup-order example is prefilled.
                  </small>
                </label>
                <label>
                  Tool-calling instructions
                  <textarea
                    aria-label="Tool-calling instructions"
                    value={form.stagePrompts.extraction}
                    disabled={Boolean(form.baseConfigPath)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        stagePrompts: {
                          ...form.stagePrompts,
                          extraction: e.target.value,
                        },
                      })
                    }
                    placeholder="Read the input and propose the appropriate tool calls. Do not execute tools."
                    aria-describedby="tool-calling-prompt-help"
                  />
                  <small id="tool-calling-prompt-help">
                    Tell the model when to call each function and what the
                    arguments should represent. The runner only records calls;
                    it never executes them.
                  </small>
                </label>
                <div className="options tool-options">
                  <label>
                    Tool choice
                    <select
                      value={form.toolChoice}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          toolChoice: e.target.value as ToolChoice,
                        })
                      }
                    >
                      <option value="auto">Auto</option>
                      <option value="required">Required</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                  <label>
                    Tool call order
                    <select
                      value={form.toolCallOrder}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          toolCallOrder: e.target.value as ToolCallOrder,
                        })
                      }
                    >
                      <option value="ordered">Ordered</option>
                      <option value="unordered">Unordered</option>
                    </select>
                  </label>
                </div>
                <div className="callout tool-safety">
                  Tool calls are untrusted model output. Keep tools narrow, do
                  not put secrets in definitions, and validate arguments in any
                  downstream system before execution.
                </div>
              </section>
            )}
            {currentTaskKind !== "tool-calling" && (
              <details className="advanced-editor">
                <summary>Advanced grading rules</summary>
                <label>
                  Field rules JSON
                  <textarea
                    aria-label="Field rules JSON"
                    className="json-editor"
                    value={form.fieldRules}
                    disabled={Boolean(form.baseConfigPath)}
                    onChange={(e) =>
                      setForm({ ...form, fieldRules: e.target.value })
                    }
                    spellCheck={false}
                  />
                  <small>
                    Usually <code>[]</code> for text and document workflows;
                    fixture configs may provide field-level grading rules.
                  </small>
                </label>
              </details>
            )}
            <section
              className="form-section"
              aria-labelledby="setup-options-heading"
            >
              <div className="section-heading">
                <h3 id="setup-options-heading">Run settings</h3>
                <p>Set the evaluation mode and generation limits.</p>
              </div>
              <div className="options">
                <label>
                  Evaluation mode
                  <select
                    value={form.inferenceOnly ? "inference" : "graded"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        inferenceOnly: e.target.value === "inference",
                      })
                    }
                  >
                    <option value="graded">Graded evaluation</option>
                    <option value="inference">
                      Inference-only (outputs stored, not scored)
                    </option>
                  </select>
                  <small>
                    Outputs are stored for review but are not scored.
                  </small>
                </label>
                {currentTaskKind === "document-json" && (
                  <label>
                    Extraction source
                    <select
                      value={form.extractionSource}
                      onChange={(e) =>
                        setForm({ ...form, extractionSource: e.target.value })
                      }
                    >
                      <option value="ocr">OCR transcription</option>
                      <option value="reference">Reference transcription</option>
                    </select>
                  </label>
                )}
                {currentTaskKind !== "tool-calling" && (
                  <label>
                    Output mode
                    <select
                      value={form.outputMode}
                      onChange={(e) =>
                        setForm({ ...form, outputMode: e.target.value })
                      }
                    >
                      <option value="prompted-json">Prompted JSON</option>
                      <option value="schema-constrained-json">
                        Schema-constrained JSON
                      </option>
                    </select>
                  </label>
                )}
                <label>
                  Temperature
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={form.temperature}
                    onChange={(e) =>
                      setForm({ ...form, temperature: e.target.value })
                    }
                  />
                </label>
                <label>
                  Max tokens
                  <input
                    type="number"
                    min="1"
                    value={form.maxTokens}
                    onChange={(e) =>
                      setForm({ ...form, maxTokens: e.target.value })
                    }
                  />
                </label>
              </div>
              {currentTaskKind !== "tool-calling" && (
                <label>
                  Judge rubric{" "}
                  {form.judgeTarget && (
                    <span className="optional">required with judge</span>
                  )}
                  <textarea
                    required={Boolean(form.judgeTarget)}
                    value={form.judgeRubric}
                    onChange={(e) =>
                      setForm({ ...form, judgeRubric: e.target.value })
                    }
                    placeholder="What should the semantic judge verify?"
                  />
                </label>
              )}
            </section>
            <div className="setup-actions">
              <button className="button secondary" type="submit">
                {saving ? "Saving…" : "Save run configuration"}
              </button>
              {JSON.stringify(form) !== savedFormKey && (
                <small className="execution-note" role="status">
                  Unsaved changes. Starting a run will save this configuration
                  first.
                </small>
              )}
            </div>
          </fieldset>
        </form>
        <aside className="panel command-card">
          <span className="eyebrow">READY TO RUN</span>
          <h3>Run evaluation</h3>
          <p>
            Start this configuration and follow live progress, logs, and results
            in Runs.
          </p>
          <div className="command-actions">
            <button
              className="button primary"
              disabled={saving || starting || activeExecution.active}
              onClick={() => void start()}
            >
              {starting
                ? "Starting…"
                : activeExecution.active
                  ? activeExecution.phase === "starting"
                    ? "Preparing evaluation"
                    : "Evaluation running"
                  : "Run evaluation now"}
            </button>
            {activeExecution.canStop && (
              <button
                className="button secondary destructive"
                disabled={activeExecution.phase === "stopping"}
                onClick={() => void stop()}
              >
                {activeExecution.phase === "stopping"
                  ? "Stopping…"
                  : "Stop run"}
              </button>
            )}
            {activeExecution.active && !activeExecution.canStop && (
              <small className="execution-note">
                A terminal-owned run is active. Stop it from that terminal.
              </small>
            )}
          </div>
          <div className="callout">
            Before running, make sure your configured targets are available.
            Saved credentials are loaded from the encrypted local vault.
          </div>
          <details className="terminal-option">
            <summary>Run from your terminal</summary>
            <div className="command">
              <code tabIndex={0} aria-label="Terminal run command">
                {command}
              </code>
              <button onClick={() => void copy()} aria-label="Copy run command">
                ⧉
              </button>
            </div>
            <small>Config: {setup.configPath || "not saved yet"}</small>
          </details>
        </aside>
      </div>
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
createRoot(document.getElementById("root")!).render(<App />);
