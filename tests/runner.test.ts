import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runEvaluation } from "../src/core/runner.js";
import { ProviderError } from "../src/core/providers.js";
import { DatabaseStore } from "../src/storage/db.js";
import type {
  CaseResult,
  DatasetManifest,
  RunConfig,
} from "../src/core/types.js";

const baseConfig: RunConfig = {
  datasetVersion: "d1",
  schemaVersion: "s1",
  stagePrompts: { ocr: "ocr", extraction: "extract" },
  outputMode: "prompted-json",
  extractionSource: "reference",
  ocrTarget: { name: "ocr", baseUrl: "http://ocr", model: "m" },
  extractionTarget: { name: "extract", baseUrl: "http://extract", model: "m" },
  fieldRules: [],
  concurrency: 2,
};
const manifest: DatasetManifest = {
  cases: [
    {
      caseId: "a",
      imagePath: "/does/not/exist-a.png",
      referenceTranscription: "invoice A",
      expected: { total: 1 },
    },
    {
      caseId: "b",
      imagePath: "/does/not/exist-b.png",
      referenceTranscription: "invoice B",
      expected: { total: 2 },
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());

function fakeDb() {
  const saved: CaseResult[] = [];
  const attempts: unknown[] = [];
  const events: unknown[] = [];
  const createdSnapshots: unknown[] = [];
  const updatedSnapshots: unknown[] = [];
  return {
    saved,
    attempts,
    events,
    createdSnapshots,
    updatedSnapshots,
    createRun: vi.fn((_id: string, _config: unknown, _dataset: string, snapshot: unknown) =>
      createdSnapshots.push(structuredClone(snapshot)),
    ),
    saveCaseResult: vi.fn((_id: string, result: CaseResult) =>
      saved.push(result),
    ),
    saveAttempt: vi.fn(
      (_id: string, _case: string, stage: string, attempt: unknown) =>
        attempts.push({ ...(attempt as object), stage }),
    ),
    finishRun: vi.fn(),
    updateRunSnapshot: vi.fn((_id: string, snapshot: unknown) =>
      updatedSnapshots.push(structuredClone(snapshot)),
    ),
    appendRunEvent: vi.fn((_id: string, type: string, payload: unknown) =>
      events.push({ type, ...(payload as object) }),
    ),
  } as any;
}

describe("evaluation runner", () => {
  it("skips OCR in extraction-only mode and persists stage attempts", async () => {
    const db = fakeDb();
    const provider = vi.fn(async (_target: any, prompt: string) => ({
      text: JSON.stringify({ total: prompt.includes("invoice A") ? 1 : 2 }),
      raw: { prompt },
    }));
    const result = await runEvaluation(manifest, baseConfig, {
      db,
      provider: provider as any,
    });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(
      provider.mock.calls.every(
        (call) => call[0] === baseConfig.extractionTarget,
      ),
    ).toBe(true);
    expect(db.attempts).toHaveLength(2);
    expect(result.results.every((item) => item.grade?.parseSuccess)).toBe(true);
    expect(db.events.map((event: any) => event.type)).toEqual(
      expect.arrayContaining([
        "run_started",
        "case_started",
        "stage_started",
        "stage_finished",
        "case_finished",
        "run_finished",
      ]),
    );
    expect(
      db.events.filter((event: any) => event.type === "run_finished"),
    ).toHaveLength(1);
  });

  it("records the resolved target configuration without credentials", async () => {
    const db = fakeDb();
    db.resolveTarget = vi.fn((target: any) => ({
      ...target,
      baseUrl: "http://current-target/v1",
      model: "current-model",
      apiKey: "runtime-secret",
    }));
    const provider = vi.fn(async () => ({
      text: '{"total":1}',
      raw: {},
    }));
    await runEvaluation({ cases: [manifest.cases[0]] }, baseConfig, {
      db,
      provider: provider as any,
    });
    const storedConfig = db.createRun.mock.calls[0][1];
    expect(storedConfig.extractionTarget).toMatchObject({
      baseUrl: "http://current-target/v1",
      model: "current-model",
    });
    expect(storedConfig.extractionTarget.apiKey).toBeUndefined();
  });

  it("does not retry invalid model output", async () => {
    const db = fakeDb();
    const provider = vi.fn(async () => ({ text: "not json", raw: {} }));
    await runEvaluation(manifest, baseConfig, {
      db,
      provider: provider as any,
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not issue OCR preflight in reference extraction mode", async () => {
    const db = fakeDb();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content[0].text).toContain("invoice");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"total":1}' } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await runEvaluation(manifest, baseConfig, { db });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(([url]) =>
        String(url).endsWith("/chat/completions"),
      ),
    ).toBe(true);
    expect(
      db.attempts.every((attempt: any) => attempt.stage === "extraction"),
    ).toBe(true);
  });

  it("falls back to prompted-json when schema-constrained preflight returns invalid content", async () => {
    const db = fakeDb();
    const target = {
      name: "extract",
      baseUrl: "http://extract",
      model: "m",
      supportsStructuredOutput: true,
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.response_format?.json_schema?.name === "evalforge_preflight") {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "not-json" } }] }),
            { status: 200 },
          );
        }
        expect(body.response_format).toBeUndefined();
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"total":1}' } }],
          }),
          { status: 200 },
        );
      });
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ...baseConfig,
      taskKind: "text-json" as const,
      outputMode: "schema-constrained-json" as const,
      extractionTarget: target,
      stagePrompts: { ocr: "", extraction: "extract" },
      schema: {
        type: "object",
        properties: { total: { type: "number" } },
        required: ["total"],
        additionalProperties: false,
      },
    };
    const result = await runEvaluation(
      { cases: [{ caseId: "a", inputText: "total=1", expected: { total: 1 } }] },
      config as any,
      { db },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(([url]) =>
        String(url).endsWith("/chat/completions"),
      ),
    ).toBe(true);
    expect(result.results[0].parsedJson).toMatchObject({ total: 1 });
    expect(db.updatedSnapshots).toHaveLength(2);
    expect(db.updatedSnapshots[0].config.outputMode).toBe("schema-constrained-json");
    expect(db.updatedSnapshots[1]).toMatchObject({
      config: { outputMode: "prompted-json" },
      requestedOutputMode: "schema-constrained-json",
    });
    expect(db.updatedSnapshots[1].configHash).not.toBe(
      db.createdSnapshots[0].configHash,
    );
    expect(db.events.some((event: any) => event.type === "preflight_warning")).toBe(
      true,
    );
  });

  it("aborts on truncated schema preflight without fallback or extraction", async () => {
    const db = fakeDb();
    const target = {
      name: "extract",
      baseUrl: "http://extract",
      model: "m",
      supportsStructuredOutput: true,
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: null } }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ...baseConfig,
      taskKind: "text-json" as const,
      outputMode: "schema-constrained-json" as const,
      extractionTarget: target,
      stagePrompts: { ocr: "", extraction: "extract" },
      schema: {
        type: "object",
        properties: { total: { type: "number" } },
        required: ["total"],
        additionalProperties: false,
      },
    };

    await expect(
      runEvaluation(
        { cases: [{ caseId: "a", inputText: "total=1", expected: { total: 1 } }] },
        config as any,
        { db },
      ),
    ).rejects.toThrow(/Preflight exhausted its 512-token output budget/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.saved).toHaveLength(0);
    expect(db.attempts).toHaveLength(1);
    expect(db.attempts[0].stage).toBe("extraction-preflight");
    expect(db.events.some((event: any) => event.type === "preflight_warning")).toBe(false);
  });

  it("persists prompted-json in the SQLite run config after fallback", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-runner-fallback-"));
    const db = new DatabaseStore(path.join(dir, "runs.db"));
    const target = {
      name: "extract",
      baseUrl: "http://extract",
      model: "m",
      supportsStructuredOutput: true,
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return body.response_format?.json_schema?.name === "evalforge_preflight"
        ? new Response(
            JSON.stringify({ choices: [{ message: { content: "not-json" } }] }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({ choices: [{ message: { content: '{"total":1}' } }] }),
            { status: 200 },
          );
    });
    vi.stubGlobal("fetch", fetchMock);
    let runId = "";
    try {
      await runEvaluation(
        { cases: [{ caseId: "a", inputText: "total=1", expected: { total: 1 } }] },
        {
          ...baseConfig,
          taskKind: "text-json",
          outputMode: "schema-constrained-json",
          extractionTarget: target,
          stagePrompts: { ocr: "", extraction: "extract" },
          schema: {
            type: "object",
            properties: { total: { type: "number" } },
            required: ["total"],
            additionalProperties: false,
          },
        },
        { db, onStarted: (id) => (runId = id) },
      );
      expect(db.getRun(runId)?.config.outputMode).toBe("prompted-json");
      expect(db.listRunEvents(runId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "preflight_warning",
          payload: {
            stage: "extraction-preflight",
            requestedOutputMode: "schema-constrained-json",
            outputMode: "prompted-json",
          },
        }),
      ]));
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists all HTTP 429 attempts before succeeding", async () => {
    const db = fakeDb();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls <= 2) return new Response("{}", { status: 429 });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"total":1}' } }],
          }),
          { status: 200 },
        );
      }),
    );
    await runEvaluation({ cases: [manifest.cases[0]] }, baseConfig, { db });
    expect(calls).toBe(3);
    expect(db.attempts).toHaveLength(3);
    expect(
      db.attempts.every((attempt: any) => attempt.stage === "extraction"),
    ).toBe(true);
    expect(db.attempts.map((attempt: any) => attempt.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(
      db.events.filter((event: any) => event.type === "retry_scheduled"),
    ).toHaveLength(2);
  });

  it("does not schedule extraction after OCR fails", async () => {
    const db = fakeDb();
    const provider = vi.fn(async (target: any) => {
      if (target.name === "ocr") throw new Error("ocr failed");
      return { text: '{"total":1}', raw: {} };
    });
    const config = {
      ...baseConfig,
      extractionSource: "ocr" as const,
      ocrTarget: { ...baseConfig.ocrTarget, name: "ocr" },
    };
    const result = await runEvaluation({ cases: [manifest.cases[0]] }, config, {
      db,
      provider: provider as any,
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.results[0].error).toContain("ocr failed");
    expect(db.events.some((event: any) => event.type === "case_error")).toBe(
      true,
    );
  });

  it("keeps provider payloads out of lifecycle diagnostics", async () => {
    const db = fakeDb();
    const provider = vi.fn(async () => {
      throw new ProviderError(
        'Validation failed: {"prompt":"PRIVATE_PROMPT","image":"PRIVATE_IMAGE"}',
      );
    });
    const result = await runEvaluation(
      { cases: [manifest.cases[0]] },
      { ...baseConfig, extractionSource: "ocr" },
      { db, provider: provider as any },
    );
    const diagnostics = JSON.stringify(db.events);
    expect(diagnostics).not.toContain("PRIVATE_PROMPT");
    expect(diagnostics).not.toContain("PRIVATE_IMAGE");
    expect(diagnostics).toContain("Provider request failed.");
    expect(result.results[0].error).toContain("PRIVATE_PROMPT");
  });

  it("keeps malformed judge results ungraded without changing deterministic grade", async () => {
    const db = fakeDb();
    const provider = vi.fn(async (target: any) =>
      target.name === "judge"
        ? { text: '{"verdict":"maybe"}', raw: {} }
        : { text: '{"total":1}', raw: {} },
    );
    const config = {
      ...baseConfig,
      judgeTarget: { name: "judge", baseUrl: "http://judge", model: "m" },
      judgeRubric: "judge",
    };
    const result = await runEvaluation({ cases: [manifest.cases[0]] }, config, {
      db,
      provider: provider as any,
    });
    expect(result.results[0].grade).toBeDefined();
    expect(result.results[0].judge.verdict).toBe("ungraded");
  });

  it("bounds concurrent requests and stops scheduling after cancellation", async () => {
    const db = fakeDb();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const controller = new AbortController();
    const provider = vi.fn(
      async (
        _target: any,
        _prompt: string,
        _image: string | undefined,
        _mode: any,
        signal: AbortSignal,
      ) => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        active -= 1;
        return { text: '{"total":1}', raw: {} };
      },
    );
    const promise = runEvaluation(
      { cases: [...manifest.cases, { ...manifest.cases[0], caseId: "c" }] },
      { ...baseConfig, concurrency: 2 },
      { db, provider: provider as any, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    await promise;
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(2);
    expect(db.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "cancelled",
      expect.any(String),
    );
    expect(
      db.events.some((event: any) => event.type === "cancellation_requested"),
    ).toBe(true);
    expect(
      db.events.filter((event: any) => event.type === "run_finished"),
    ).toHaveLength(1);
  });

  it("aborts timed-out requests and rejects malformed schemas before making requests", async () => {
    const db = fakeDb();
    let aborted = false;
    const provider = vi.fn(
      async (
        _target: any,
        _prompt: string,
        _image: string | undefined,
        _mode: any,
        signal: AbortSignal,
      ) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error("timed out");
      },
    );
    const result = await runEvaluation(
      { cases: [manifest.cases[0]] },
      { ...baseConfig, requestTimeoutMs: 5 },
      { db, provider: provider as any },
    );
    expect(aborted).toBe(true);
    expect(result.results[0].error).toContain("timed out");
    const invalidProvider = vi.fn();
    await expect(
      runEvaluation(
        { cases: [manifest.cases[0]] },
        { ...baseConfig, schema: { type: "not-a-schema" } },
        { db: fakeDb(), provider: invalidProvider as any },
      ),
    ).rejects.toThrow();
    expect(invalidProvider).not.toHaveBeenCalled();
  });
});
