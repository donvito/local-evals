import { afterEach, describe, expect, it, vi } from "vitest";
import { runEvaluation } from "../src/core/runner.js";
import {
  callOpenAICompatible,
  testToolCallingTarget,
  TOOL_PREFLIGHT_PROBE,
} from "../src/core/providers.js";
import { compareRuns } from "../src/core/reports.js";
import { validateRunConfig } from "../src/core/project.js";
import type { CaseResult, DatasetManifest, RunConfig, ToolDefinition } from "../src/core/types.js";

function fakeDb() {
  const saved: CaseResult[] = [];
  return {
    saved,
    createRun: vi.fn(),
    updateRunSnapshot: vi.fn(),
    saveCaseResult: vi.fn((_runId: string, result: CaseResult) => saved.push(result)),
    finishRun: vi.fn(),
    appendRunEvent: vi.fn(),
  } as any;
}

const target = {
  name: "mock",
  baseUrl: "http://mock.local/v1",
  model: "mock-model",
};

afterEach(() => vi.unstubAllGlobals());

describe("native evaluation modes", () => {
  it("runs text-json in one extraction request without image or OCR", async () => {
    const db = fakeDb();
    const manifest: DatasetManifest = {
      taskKind: "text-json",
      cases: [
        { caseId: "text-1", inputText: "customer=Ada", expected: { customer: "Ada" } },
      ],
    };
    const config: RunConfig = {
      datasetVersion: "text",
      schemaVersion: "v1",
      taskKind: "text-json",
      stagePrompts: { extraction: "Extract JSON." },
      outputMode: "prompted-json",
      extractionTarget: target,
      fieldRules: [],
    };
    const provider = vi.fn(async () => ({
      text: '{"customer":"Ada"}',
      raw: {},
    }));

    const result = await runEvaluation(manifest, config, {
      db,
      provider: provider as any,
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][2]).toBeUndefined();
    expect(provider.mock.calls[0][1]).toContain("customer=Ada");
    expect(result.results[0].ocrText).toBeUndefined();
    expect(result.results[0].grade?.passed).toBe(true);
  });

  it("grades one-turn tool calls and preserves the raw call envelope", async () => {
    const db = fakeDb();
    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "lookup",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    };
    const manifest: DatasetManifest = {
      taskKind: "tool-calling",
      cases: [
        {
          caseId: "tool-1",
          inputText: "Look up Singapore.",
          expected: [{ name: "lookup", arguments: { city: "Singapore" } }],
        },
      ],
    };
    const config: RunConfig = {
      datasetVersion: "tools",
      schemaVersion: "v1",
      taskKind: "tool-calling",
      stagePrompts: { extraction: "Propose calls." },
      outputMode: "prompted-json",
      extractionTarget: { ...target, supportsTools: true },
      fieldRules: [],
      tools: [tool],
      toolChoice: "required",
    };
    const rawCall = {
      id: "call-1",
      type: "function",
      function: { name: "lookup", arguments: '{"city":"Singapore"}' },
    };
    const provider = vi.fn(async () => ({
      text: "",
      toolCalls: [rawCall],
      raw: { choices: [{ message: { content: null, tool_calls: [rawCall] } }] },
    }));

    const result = await runEvaluation(manifest, config, {
      db,
      provider: provider as any,
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][1]).toContain("Look up Singapore.");
    expect(provider.mock.calls[0][7]).toMatchObject({
      tools: [tool],
      toolChoice: "required",
    });
    expect(result.results[0].toolCalls).toEqual([rawCall]);
    expect(result.results[0].grade?.passed).toBe(true);
  });

  it("does not treat an explicitly malformed tool-call envelope as no call", async () => {
    const config: RunConfig = {
      datasetVersion: "tools",
      schemaVersion: "v1",
      taskKind: "tool-calling",
      stagePrompts: { extraction: "Propose calls." },
      outputMode: "prompted-json",
      extractionTarget: { ...target, supportsTools: true },
      fieldRules: [],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      toolChoice: "auto",
    };
    const malformedResponses = [
      {
        text: "",
        toolCalls: { type: "function", function: { name: "lookup" } },
        raw: {},
      },
      {
        text: "",
        raw: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: { type: "function", function: { name: "lookup" } },
              },
            },
          ],
        },
      },
    ];

    for (const response of malformedResponses) {
      const db = fakeDb();
      const result = await runEvaluation(
        {
          taskKind: "tool-calling",
          cases: [{ caseId: "tool-malformed", inputText: "No call.", expected: [] }],
        },
        config,
        { db, provider: vi.fn(async () => response) as any },
      );

      expect(result.results[0].error).toMatch(/expected an array/i);
      expect(result.results[0].grade).toBeUndefined();
    }
  });

  it("keeps prompt iterations comparable when evaluation semantics are unchanged", () => {
    const config: RunConfig = {
      datasetVersion: "text",
      schemaVersion: "v1",
      taskKind: "text-json",
      stagePrompts: { extraction: "Extract the customer." },
      outputMode: "prompted-json",
      extractionTarget: target,
      fieldRules: [{ path: "customer", match: "exact" }],
    };
    const makeRun = (prompt: string) => ({
      config: { ...config, stagePrompts: { extraction: prompt } },
      snapshot: {
        taskKind: "text-json",
        stagePrompts: { extraction: prompt },
        stagePromptsHash: prompt,
      },
      cases: [
        {
          caseId: "text-1",
          grade: { passed: true, parseSuccess: true, schemaValid: true },
        },
      ],
    });

    expect(() =>
      compareRuns(makeRun("Extract the customer."), makeRun("Extract the client.")),
    ).not.toThrow();
  });

  it("rejects a tool config whose judge target would be ignored", () => {
    expect(() =>
      validateRunConfig({
        datasetVersion: "tools",
        schemaVersion: "v1",
        taskKind: "tool-calling",
        stagePrompts: { extraction: "Propose calls." },
        extractionTarget: { ...target, supportsTools: true },
        judgeTarget: { ...target, name: "judge" },
        fieldRules: [],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }),
    ).toThrow(/judgeTarget/i);
  });

  it("accepts content:null tool responses from an OpenAI-compatible endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      type: "function",
                      function: { name: "lookup", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const response = await callOpenAICompatible(target, "call", {
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      toolChoice: "required",
    });
    expect(response.text).toBe("");
    expect(response.toolCalls).toHaveLength(1);
  });

  it("uses a separate verified no-argument tool probe", async () => {
    let request: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        request = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      type: "function",
                      function: {
                        name: "evalforge_probe",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    await testToolCallingTarget({ ...target, provider: "openrouter" });
    expect(request.max_tokens).toBeGreaterThanOrEqual(64);
    expect(request.tool_choice).toBe("required");
    expect(request.tools).toEqual([TOOL_PREFLIGHT_PROBE]);
    expect(request.response_format).toBeUndefined();
    expect(request.provider).toMatchObject({ require_parameters: true });
  });
});
