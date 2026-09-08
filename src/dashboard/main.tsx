import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { describeRunError } from "./errors.js";

type Json = unknown;
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
};
type CaseResult = {
  caseId: string;
  imagePath?: string;
  expected?: Json;
  referenceTranscription?: string;
  ocrText?: string;
  rawExtraction?: string;
  parsedJson?: Json;
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
  cases: {
    caseId: string;
    expected?: Json;
    referenceTranscription?: string;
    metadata?: Record<string, Json>;
    imageHash?: string;
  }[];
};
type Setup = {
  dbPath?: string;
  projectRoot?: string;
  runCommand?: string;
  configPath?: string;
  config?: {
    baseConfigPath?: string;
    datasetVersion?: string;
    ocrTarget?: string;
    extractionTarget?: string;
    judgeTarget?: string;
    inferenceOnly?: boolean;
    extractionSource?: string;
    outputMode?: string;
    judgeRubric?: string;
    generation?: {
      temperature?: number;
      maxTokens?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
    };
  };
};
type ActiveExecution = {
  active: boolean;
  ownedByDashboard: boolean;
  canStop: boolean;
  phase?: "starting" | "running" | "stopping" | "external";
  runId?: string;
};
type Tab = "overview" | "runs" | "datasets" | "targets" | "compare" | "setup";
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
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
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
const deltaLabel = (key: string, left: unknown, right: unknown) => {
  if (typeof left !== "number" || typeof right !== "number")
    return "No baseline";
  const lowerIsBetter = /cer|wer|time|ms|cost/i.test(key);
  if (left === right) return "Unchanged";
  const improved = lowerIsBetter ? right < left : right > left;
  return improved ? "Improved" : "Regressed";
};

function App() {
  const [tab, setTab] = useState<Tab>("overview");
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
        setRunEvents([]);
      }
      if (reset) {
        eventCursor.current = null;
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
          received
            ? ""
            : fallbackEvents.current.length
              ? "Live event log unavailable; showing persisted attempt activity instead."
              : "No activity has been recorded yet.",
        );
      } catch (e) {
        if (controller.signal.aborted) return;
        if (fallbackEvents.current.length) setRunEvents(fallbackEvents.current);
        setRunEventsHint(
          fallbackEvents.current.length
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
      document.querySelector<HTMLElement>(".page-title h2")?.focus(),
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
  const latest = runs[0];
  const passRate =
    latest &&
    !latest.inferenceOnly &&
    latest.caseCount &&
    latest.passedCount != null
      ? latest.passedCount / latest.caseCount
      : undefined;
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">EF</span>
          <div>
            <div className="eyebrow">LOCAL MODEL EVALUATION</div>
            <h1>EvalForge</h1>
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
        <nav className="sidebar" aria-label="Workspace">
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
              disabled={setupBusy && item !== "setup"}
              onClick={() => changeTab(item)}
              key={item}
            >
              <span className={`nav-icon icon-${item}`} aria-hidden="true" />
              {item[0].toUpperCase() + item.slice(1)}
              {item === "runs" && runs.some((r) => r.status === "running") ? (
                <b className="live-dot" />
              ) : null}
            </button>
          ))}
          <div className="sidebar-footer">
            <span className="version">
              EVALFORGE <b>V0.1</b>
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
                ["datasets", "Datasets"],
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
            ["datasets", "targets", "compare"].includes(tab)
              ? "page"
              : undefined
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
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS"
        title="Evaluation overview"
        sub="Track model quality across OCR and structured extraction."
        action={
          <button className="button primary" onClick={() => onTab("setup")}>
            Set up a run <span>→</span>
          </button>
        }
      />
      <section className="stats">
        <Stat
          label="Latest pass rate"
          value={latest ? metric(passRate) : "—"}
          note={
            latest
              ? latest.inferenceOnly
                ? "Inference-only; outputs stored, not scored"
                : `${latest.passedCount} of ${latest.totalCases ?? latest.caseCount} cases`
              : "No runs yet"
          }
        />
        <Stat
          label="Cases evaluated"
          value={String(runs.reduce((n, r) => n + (r.caseCount || 0), 0))}
          note={`${runs.length} recorded run${runs.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Active runs"
          value={String(
            runs.filter((r) => r.status === "running" || r.status === "pending")
              .length,
          )}
          note="Dashboard or terminal"
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
    <>
      <PageTitle
        eyebrow="RUN HISTORY"
        title="Runs & case inspector"
        sub="Select a run to trace every response back to its source."
        action={
          <button className="button secondary" onClick={() => onTab("setup")}>
            Run setup →
          </button>
        }
      />
      <div className="runs-layout">
        <section className="panel run-list">
          <div className="panel-head">
            <div>
              <h3>All runs</h3>
              <p>
                {runs.length} evaluation snapshot{runs.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          {loading ? (
            <Loading />
          ) : runs.length ? (
            <>
              <label className="mobile-run-picker">
                Choose a run
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
                    className={
                      selected?.runId === r.runId
                        ? "run-row selected"
                        : "run-row"
                    }
                    key={r.runId}
                    onClick={() => onOpen(r.runId)}
                  >
                    <span className="run-name">
                      {r.runId.slice(0, 12)}
                      <small>{date(r.createdAt)}</small>
                    </span>
                    <span className="run-count">
                      {r.inferenceOnly
                        ? "inference only"
                        : `${r.passedCount}/${r.caseCount}`}
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
          <section className="panel inspector-placeholder">
            <span className="placeholder-icon">⌁</span>
            <h3>Select a run</h3>
            <p>
              Open a run to inspect images, transcriptions, JSON, timing, and
              judge evidence side by side.
            </p>
          </section>
        )}
      </div>
    </>
  );
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
  return (
    <section className="inspector">
      {run.error && <RunErrorNotice error={run.error} context="Run" />}
      <div className="inspector-head">
        <div>
          <span className="eyebrow">RUN {run.runId.slice(0, 12)}</span>
          <h3>
            {run.status || "Complete"} <small>{date(run.createdAt)}</small>
          </h3>
        </div>
        <div className="export-actions">
          <button className="text-button" onClick={() => onTab("setup")}>
            Open setup →
          </button>
          <button className="text-button" onClick={() => onTab("compare")}>
            Compare this run →
          </button>
          <a
            href={`/api/runs/${encodeURIComponent(run.runId)}/export?format=json`}
            download
          >
            JSON ↓
          </a>
          <a
            href={`/api/runs/${encodeURIComponent(run.runId)}/export?format=markdown`}
            download
          >
            Markdown ↓
          </a>
        </div>
      </div>
      <details className="run-details">
        <summary>Snapshot & attempts</summary>
        <pre tabIndex={0} aria-label="Run snapshot and attempts">
          {pretty({ snapshot: run.snapshot, attempts: run.attempts })}
        </pre>
      </details>
      <section className="case-picker" aria-label="Browse cases">
        <div className="case-filter-row">
          <label>
            Find a case
            <input
              type="search"
              value={caseQuery}
              onChange={(e) => setCaseQuery(e.target.value)}
              placeholder="Search by case ID"
            />
          </label>
          <label className="case-failed-filter">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(e) => setFailedOnly(e.target.checked)}
            />{" "}
            Failed only (
            {
              run.cases.filter((c) => c.error || c.grade?.passed === false)
                .length
            }
            )
          </label>
        </div>
        <label>
          Selected case
          <select
            value={caseIndex >= 0 ? item!.caseId : ""}
            disabled={!visibleCases.length}
            onChange={(e) =>
              onCase(
                visibleCases.find((c) => c.caseId === e.target.value) || null,
              )
            }
          >
            {!visibleCases.length && (
              <option value="">No matching cases</option>
            )}
            {visibleCases.map((c, i) => (
              <option value={c.caseId} key={c.caseId}>
                {i + 1}.{"\u00a0"}
                {c.caseId.length > 18
                  ? `${c.caseId.slice(0, 10)}…${c.caseId.slice(-6)}`
                  : c.caseId}
              </option>
            ))}
          </select>
        </label>
        <div className="case-pagination">
          <button
            className="button secondary"
            disabled={caseIndex <= 0}
            onClick={() => onCase(visibleCases[caseIndex - 1])}
          >
            ← Previous
          </button>
          <span role="status">
            {caseIndex >= 0 ? caseIndex + 1 : 0} of {visibleCases.length}
          </span>
          <button
            className="button secondary"
            disabled={caseIndex < 0 || caseIndex >= visibleCases.length - 1}
            onClick={() => onCase(visibleCases[caseIndex + 1])}
          >
            Next →
          </button>
        </div>
      </section>
      {item ? (
        <CaseView
          run={run}
          item={item}
          afterPhoto={
            <RunActivity
              events={events}
              loading={eventsLoading}
              hint={eventsHint}
            />
          }
        />
      ) : (
        <>
          <Empty
            icon="□"
            title={run.cases.length ? "No matching cases" : "No case results"}
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
        </>
      )}
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
function RunErrorNotice({
  error,
  context,
}: {
  error: string;
  context: string;
}) {
  const friendly = describeRunError(error);
  return (
    <div className="alert error run-error-notice" role="alert">
      <strong>
        {context}: {friendly.title}
      </strong>
      <p>{friendly.message}</p>
      <p>{friendly.action}</p>
      <details>
        <summary>Technical details</summary>
        <pre tabIndex={0} aria-label={`${context} error details`}>
          {error}
        </pre>
      </details>
    </div>
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
  afterPhoto,
}: {
  run: RunDetail;
  item: CaseResult;
  afterPhoto: ReactNode;
}) {
  const image = `/api/runs/${encodeURIComponent(run.runId)}/cases/${encodeURIComponent(item.caseId)}/image`;
  const failures = item.grade?.failures || [];
  return (
    <div className="case-view">
      {item.error && <RunErrorNotice error={item.error} context="Case" />}
      <div className="case-heading">
        <div>
          <span className="eyebrow">CASE</span>
          <h3>{item.caseId}</h3>
        </div>
        <span
          className={
            item.grade?.passed
              ? "status-pill pass"
              : item.grade
                ? "status-pill fail"
                : "status-pill neutral"
          }
        >
          {item.grade?.passed ? "PASS" : item.grade ? "FAIL" : "INFERENCE"}
        </span>
      </div>
      <div className="case-grid">
        <div className="image-card">
          <ZoomableImage src={image} alt={`Document ${item.caseId}`} />
          <span>Tap image to zoom</span>
        </div>
        <div className="transcription">
          <CompareText
            title="Reference transcription"
            value={item.referenceTranscription}
            muted="No reference transcription"
          />
          <CompareText
            title="Model transcription"
            value={item.ocrText}
            muted="OCR did not return text"
          />
        </div>
      </div>
      {afterPhoto}
      <div className="json-grid">
        <CodeCard
          title={
            item.expected === undefined
              ? "Expected JSON (not labeled)"
              : "Expected JSON"
          }
          value={item.expected}
        />
        <CodeCard
          title="Actual JSON"
          value={item.parsedJson ?? item.rawExtraction}
        />
      </div>
      <div className="detail-grid">
        <div className="panel-inner">
          <h4>{item.grade ? "Grade breakdown" : "Inference output"}</h4>
          {item.grade ? (
            <div className="grade-list">
              <Grade label="Parse success" value={item.grade.parseSuccess} />
              <Grade label="Schema valid" value={item.grade.schemaValid} />
              <Grade
                label="Field accuracy"
                value={
                  item.grade.fieldAccuracy === undefined
                    ? undefined
                    : metric(item.grade.fieldAccuracy)
                }
              />
              <Grade label="OCR score" value={ocrSummary(item.ocrGrade)} />
            </div>
          ) : (
            <p className="muted">
              No expected JSON supplied; this case is not scored.
            </p>
          )}
          {failures.length ? (
            <div className="failures">
              <h4>Field failures</h4>
              {failures.map((f, i) => (
                <div className="failure" key={`${f.path}-${i}`}>
                  <strong>{f.path || "Unknown field"}</strong>
                  <span>{f.message || f.kind || "Mismatch"}</span>
                  {f.expected !== undefined && (
                    <code>
                      expected {pretty(f.expected)} · actual {pretty(f.actual)}
                    </code>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="panel-inner">
          <h4>Timing & judge</h4>
          <div className="timing">
            {Object.entries(item.timings || {}).map(([key, value]) => (
              <span key={key}>
                <b>{key.replace(/Ms$/, "")}</b>
                {value} ms
              </span>
            ))}
          </div>
          {item.judge ? (
            <div className="judge">
              <span className="eyebrow">SEMANTIC JUDGE</span>
              <strong>{item.judge.verdict || "Recorded"}</strong>
              <p>{item.judge.evidence || "No evidence supplied."}</p>
            </div>
          ) : (
            <p className="muted">No semantic judge configured.</p>
          )}
        </div>
      </div>
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
function CodeCard({ title, value }: { title: string; value: Json }) {
  return (
    <div className="code-card">
      <h4>{title}</h4>
      <pre tabIndex={0} aria-label={title}>
        {pretty(value)}
      </pre>
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
  onRefresh,
}: {
  datasets: Dataset[];
  onRefresh: () => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<Notice["kind"]>("success");
  const importDataset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api("/api/datasets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      await onRefresh();
      setPath("");
      setMessageKind("success");
      setMessage("Dataset imported.");
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="DATASETS"
        title="Dataset library"
        sub="Inspect versioned cases and their expected outputs."
      />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Imported datasets</h3>
            <p>Browse your documents, reference text, and expected outputs.</p>
          </div>
          <form className="inline-form" onSubmit={importDataset}>
            <label htmlFor="dataset-import-path">Import a dataset</label>
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
                {busy ? "Importing…" : "Import JSONL"}
              </button>
            </div>
            <small id="dataset-path-help">
              Use a path relative to the project root, for example{" "}
              <code>datasets/receipts.jsonl</code>.
            </small>
          </form>
        </div>
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
          datasets.map((d) => (
            <div className="dataset" key={d.version}>
              <div>
                <span className="dataset-icon">▦</span>
                <strong>{d.name || "Untitled dataset"}</strong>
                <span className="tag data-version" title={d.version}>
                  {d.version.slice(0, 12)}
                </span>
              </div>
              <span>{d.cases.length} cases</span>
              <details>
                <summary>Inspect all cases</summary>
                <p className="data-version">Version: {d.version}</p>
                <div className="dataset-cases">
                  {d.cases.map((c) => (
                    <div key={c.caseId}>
                      <ZoomableImage
                        className="dataset-thumb"
                        src={`/api/datasets/${encodeURIComponent(d.version)}/cases/${encodeURIComponent(c.caseId)}/image`}
                        alt={`Document ${c.caseId}`}
                      />
                      <b>{c.caseId}</b>
                      <code>{pretty(c.expected)}</code>
                      <small>
                        {c.referenceTranscription
                          ? "reference text"
                          : "no reference"}{" "}
                        · {c.imageHash || "no hash"}
                      </small>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          ))
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
    supportsVision: true,
    supportsStructuredOutput: false,
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
  return (
    <>
      <PageTitle
        eyebrow="TARGETS"
        title="Model connections"
        sub="Configure the endpoints used by each pipeline stage."
      />
      <div className="targets-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Configured targets</h3>
              <p>
                Credentials are encrypted locally and never shown after saving.
              </p>
            </div>
          </div>
          {targets.length ? (
            targets.map((t) => (
              <div className="target-row" key={t.name}>
                <div className="target-badge">
                  {t.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="target-info">
                  <strong>{t.name}</strong>
                  <span>
                    {t.provider || "openai-compatible"} · {t.model} ·{" "}
                    {t.baseUrl}
                  </span>
                  <small>
                    {t.supportsVision ? "Vision" : "Text only"} ·{" "}
                    {t.supportsStructuredOutput
                      ? "Structured output"
                      : "Prompted JSON"}{" "}
                    · {t.hasApiKey ? "Credential saved" : "No credential"}
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
              <option value="openai-compatible">OpenAI-compatible</option>
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
          </label>
          <label>
            Model
            <input
              required
              value={editing.model}
              onChange={(e) =>
                setEditing({ ...editing, model: e.target.value })
              }
              placeholder="qwen2.5-vl"
            />
          </label>
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
  const [form, setForm] = useState({
    datasetVersion: setup.config?.datasetVersion || datasets[0]?.version || "",
    baseConfigPath: setup.config?.baseConfigPath || "",
    ocrTarget: setup.config?.ocrTarget || "",
    extractionTarget: setup.config?.extractionTarget || "",
    judgeTarget: setup.config?.judgeTarget || "",
    inferenceOnly: setup.config?.inferenceOnly || false,
    extractionSource: setup.config?.extractionSource || "ocr",
    outputMode: setup.config?.outputMode || "prompted-json",
    judgeRubric: setup.config?.judgeRubric || "",
    temperature: String(setup.config?.generation?.temperature ?? 0.2),
    maxTokens: String(
      setup.config?.generation?.maxTokens ??
        setup.config?.generation?.max_tokens ??
        setup.config?.generation?.max_completion_tokens ??
        2048,
    ),
  });
  const [savedFormKey, setSavedFormKey] = useState(() => JSON.stringify(form));
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    onBusyChange(saving || starting);
    return () => onBusyChange(false);
  }, [onBusyChange, saving, starting]);
  useEffect(() => {
    const next = {
      ...form,
      datasetVersion:
        setup.config?.datasetVersion ||
        form.datasetVersion ||
        datasets[0]?.version ||
        "",
      baseConfigPath: setup.config?.baseConfigPath || form.baseConfigPath,
      ocrTarget:
        setup.config?.ocrTarget ||
        form.ocrTarget ||
        targets.find((t) => t.supportsVision)?.name ||
        "",
      extractionTarget:
        setup.config?.extractionTarget ||
        form.extractionTarget ||
        targets[0]?.name ||
        "",
      judgeTarget: setup.config?.judgeTarget ?? form.judgeTarget,
      inferenceOnly: setup.config?.inferenceOnly ?? form.inferenceOnly,
      extractionSource: setup.config?.extractionSource || form.extractionSource,
      outputMode: setup.config?.outputMode || form.outputMode,
      judgeRubric: setup.config?.judgeRubric ?? form.judgeRubric,
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
  const saveConfig = async (): Promise<boolean> => {
    if (form.extractionSource === "ocr" && !form.ocrTarget) {
      onNotice(
        "Choose a vision-capable OCR target, or select reference transcription.",
        "error",
      );
      return false;
    }
    if (form.judgeTarget && !form.judgeRubric.trim()) {
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
          generation: {
            temperature: Number(form.temperature),
            maxTokens: Number(form.maxTokens),
          },
        }),
      });
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
          <fieldset disabled={saving || starting}>
            <section
              className="form-section"
              aria-labelledby="setup-data-heading"
            >
              <div className="section-heading">
                <h3 id="setup-data-heading">Dataset & configuration</h3>
                <p>Choose the documents and evaluation rules.</p>
              </div>
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
                  Schema, prompts, and grading rules. Leave blank to use the
                  saved configuration, or enter a project-relative config path.
                </small>
              </label>
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
                  {datasets.map((d) => (
                    <option key={d.version} value={d.version}>
                      {d.name} · {d.version.slice(0, 8)}
                    </option>
                  ))}
                </select>
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
              <div className="stage">
                <span>02</span>
                <div>
                  <h3>Extraction target</h3>
                  <p>Converts transcription into structured JSON.</p>
                </div>
                <select
                  aria-label="Extraction target"
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
              </div>
              <div className="stage">
                <span>03</span>
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
            </section>
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
                      Inference-only (no expected JSON)
                    </option>
                  </select>
                  <small>
                    Use inference-only for unlabeled receipt batches. Outputs
                    are stored for review but are not scored.
                  </small>
                </label>
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
            Before running, make sure both endpoints are available. Saved
            credentials are loaded from the encrypted local vault.
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
