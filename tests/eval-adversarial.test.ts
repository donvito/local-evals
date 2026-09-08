import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadManifest, importManifest } from "../src/core/manifest.js";
import { validateRunConfig } from "../src/core/project.js";
import { resolveTaskKind } from "../src/core/runner.js";
import { gradeToolCalls } from "../src/core/tool-grading.js";
import type { ToolDefinition } from "../src/core/types.js";

const lookupTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lookup_weather",
    description: "Look up a fictional forecast.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

function toolConfig(overrides: Record<string, unknown> = {}) {
  return {
    datasetVersion: "tool-dataset",
    schemaVersion: "tool-schema",
    taskKind: "tool-calling",
    stagePrompts: { extraction: "Propose tool calls." },
    outputMode: "prompted-json",
    extractionTarget: {
      name: "tool-model",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "tool-model",
      supportsTools: true,
    },
    fieldRules: [],
    tools: [lookupTool],
    toolCallOrder: "ordered",
    ...overrides,
  };
}

function observedCall(name: string, argumentsValue: unknown) {
  return {
    id: `call-${name}`,
    type: "function",
    function: {
      name,
      arguments:
        typeof argumentsValue === "string"
          ? argumentsValue
          : JSON.stringify(argumentsValue),
    },
  };
}

const expectedLookup = (city: string) => ({
  name: "lookup_weather",
  arguments: { city },
});

describe("adversarial evaluation modes", () => {
  it("imports text-only cases without requiring or inventing image assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-text-import-"));
    try {
      const manifestPath = path.join(dir, "text.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          name: "Text cases",
          taskKind: "text-json",
          cases: [
            {
              caseId: "text-1",
              inputText: "customer=Ada",
              expected: { customer: "Ada" },
            },
          ],
        }),
      );

      const imported = await importManifest(
        manifestPath,
        path.join(dir, "assets"),
      );
      expect(imported.taskKind).toBe("text-json");
      expect(imported.cases[0]).toMatchObject({
        caseId: "text-1",
        inputText: "customer=Ada",
        expected: { customer: "Ada" },
      });
      expect(imported.cases[0].imagePath).toBeUndefined();
      expect(await readdir(path.join(dir, "assets"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a tool-calling case whose expected value is not a call list", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evalforge-tool-manifest-"));
    try {
      const manifestPath = path.join(dir, "tools.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          taskKind: "tool-calling",
          cases: [
            {
              caseId: "bad-expected",
              inputText: "Look up the weather.",
              expected: { name: "lookup_weather", arguments: {} },
            },
          ],
        }),
      );
      await expect(loadManifest(manifestPath)).rejects.toThrow(
        /tool-calling expected must be an array/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a usable tool configuration for tool-calling runs", () => {
    expect(() => validateRunConfig(toolConfig({ tools: [] }))).toThrow(
      /requires at least one configured tool/i,
    );
    expect(() =>
      validateRunConfig(
        toolConfig({
          extractionTarget: {
            name: "no-tools-model",
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "no-tools-model",
            supportsTools: false,
          },
        }),
      ),
    ).toThrow(/tool-calling support/i);
  });

  it("enforces date argument formats using the shared JSON schema validator", () => {
    const tool: any = {
      type: "function",
      function: {
        name: "date_lookup",
        parameters: {
          type: "object",
          properties: { date: { type: "string", format: "date" } },
          required: ["date"],
        },
      },
    };
    for (const [date, valid] of [
      ["2024-02-29", true],
      ["2025-02-30", false],
    ] as const) {
      const call = { name: "date_lookup", arguments: { date } };
      const result = gradeToolCalls([call], [call], [tool]);
      expect(result.schemaValid).toBe(valid);
      expect(result.passed).toBe(valid);
    }
  });

  it("distinguishes an expected no-call response from a missing call", () => {
    const noCall = gradeToolCalls([], [], [lookupTool]);
    expect(noCall.passed).toBe(true);

    const missing = gradeToolCalls(
      [expectedLookup("Singapore")],
      [],
      [lookupTool],
    );
    expect(missing.passed).toBe(false);
    expect(missing.failures.map((failure) => failure.kind)).toContain(
      "tool-count",
    );
  });

  it("rejects unknown tools instead of treating their names as arbitrary JSON", () => {
    const result = gradeToolCalls(
      [],
      [observedCall("delete_everything", {})],
      [lookupTool],
    );
    expect(result.passed).toBe(false);
    expect(
      result.failures.some((failure) => failure.kind === "unknown-tool"),
    ).toBe(true);
  });

  it("reports malformed JSON arguments without executing or coercing them", () => {
    const result = gradeToolCalls(
      [expectedLookup("Singapore")],
      [observedCall("lookup_weather", '{"city":"Singapore"')],
      [lookupTool],
    );
    expect(result.passed).toBe(false);
    expect(result.parseSuccess).toBe(false);
    expect(result.schemaValid).toBe(false);
    expect(
      result.failures.some((failure) => failure.kind === "malformed-arguments"),
    ).toBe(true);
  });

  it("fails both extra and missing tool calls", () => {
    const expected = [expectedLookup("Singapore")];
    const extra = gradeToolCalls(
      expected,
      [
        observedCall("lookup_weather", { city: "Singapore" }),
        observedCall("lookup_weather", { city: "Tokyo" }),
      ],
      [lookupTool],
    );
    expect(extra.passed).toBe(false);
    expect(extra.failures.map((failure) => failure.kind)).toContain(
      "tool-count",
    );
    expect(extra.failures.map((failure) => failure.kind)).toContain(
      "extra-tool-call",
    );

    const missing = gradeToolCalls(
      [expectedLookup("Singapore"), expectedLookup("Tokyo")],
      [observedCall("lookup_weather", { city: "Singapore" })],
      [lookupTool],
    );
    expect(missing.passed).toBe(false);
    expect(missing.failures.map((failure) => failure.kind)).toContain(
      "tool-count",
    );
  });

  it("matches unordered duplicate tool names by full argument object", () => {
    const expected = [expectedLookup("Singapore"), expectedLookup("Tokyo")];
    const reversed = gradeToolCalls(
      expected,
      [
        observedCall("lookup_weather", { city: "Tokyo" }),
        observedCall("lookup_weather", { city: "Singapore" }),
      ],
      [lookupTool],
      "unordered",
    );
    expect(reversed.passed).toBe(true);

    const wrongDuplicate = gradeToolCalls(
      expected,
      [
        observedCall("lookup_weather", { city: "Singapore" }),
        observedCall("lookup_weather", { city: "Singapore" }),
      ],
      [lookupTool],
      "unordered",
    );
    expect(wrongDuplicate.passed).toBe(false);
    expect(
      wrongDuplicate.failures.some(
        (failure) => failure.kind === "tool-arguments",
      ),
    ).toBe(true);
  });

  it("does not compare a JSON object as if it were a tool-call list", () => {
    const result = gradeToolCalls({ customer: "Ada" }, [], [lookupTool]);
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toContain(
      "invalid-expected-tools",
    );
  });

  it("rejects a dataset/config task-kind mismatch before comparison", () => {
    expect(() =>
      resolveTaskKind(
        {
          taskKind: "tool-calling",
          cases: [],
        },
        toolConfig({ taskKind: "text-json" }) as any,
      ),
    ).toThrow(/does not match dataset taskKind/i);
  });
});
