import { checkExtractionSchema, checkToolDefinitions } from "../src/core/schema-check.js";
import { describe, expect, it } from "vitest";
import { issuesForStep, validateSetup, type SetupFormInput } from "../src/dashboard/setup-validation.js";

const base: SetupFormInput = {
  taskKind: "text-json",
  datasetVersion: "v1",
  extractionSource: "reference",
  ocrTarget: "",
  extractionTarget: "local",
  judgeTarget: "",
  judgeRubric: "",
  schema: '{"type":"object"}',
  stagePrompts: { extraction: "Return JSON." },
  fieldRules: "[]",
  tools: "[]",
  toolChoice: "auto",
};
const targets = [
  { name: "local", supportsVision: false, supportsTools: false },
  { name: "vision", supportsVision: true, supportsTools: true },
];

describe("validateSetup", () => {
  it("accepts a complete text run", () => {
    expect(validateSetup(base, targets)).toEqual([]);
  });

  it("requires a dataset and a model", () => {
    const issues = validateSetup({ ...base, datasetVersion: "", extractionTarget: "" }, targets);
    expect(issuesForStep(issues, "data").map((issue) => issue.message)).toEqual(["Choose a dataset."]);
    expect(issuesForStep(issues, "model").map((issue) => issue.message)).toEqual(["Choose a model."]);
  });

  it("requires an OCR model only for document runs that use OCR", () => {
    const document = { ...base, taskKind: "document-json" as const, fieldRules: "[]" };
    expect(issuesForStep(validateSetup({ ...document, extractionSource: "ocr" }, targets), "model")).toHaveLength(1);
    expect(issuesForStep(validateSetup({ ...document, extractionSource: "reference" }, targets), "model")).toEqual([]);
  });

  it("checks text instructions", () => {
    const issues = validateSetup({ ...base, schema: "[1]", stagePrompts: { extraction: " " } }, targets);
    expect(issuesForStep(issues, "instructions")).toHaveLength(2);
  });

  it("checks tool capability and tool definitions", () => {
    const tool = { ...base, taskKind: "tool-calling" as const, schema: "" };
    expect(issuesForStep(validateSetup(tool, targets), "model")[0].message).toMatch(/tool-capable/);
    const capable = { ...tool, extractionTarget: "vision" };
    expect(issuesForStep(validateSetup(capable, targets), "instructions")[0].message).toMatch(/at least one tool/);
    expect(validateSetup({ ...capable, toolChoice: "none" }, targets)).toEqual([]);
    expect(issuesForStep(validateSetup({ ...capable, tools: "{" }, targets), "instructions")[0].message).toMatch(/JSON array/);
  });

  it("checks grading field rules and judge rubric on the grading step", () => {
    const issues = validateSetup({ ...base, fieldRules: "{}", judgeTarget: "local" }, targets);
    expect(issuesForStep(issues, "grading").map((issue) => issue.message)).toEqual([
      "Field rules must be a JSON array.",
      "Describe what the judge should check, or remove the judge model.",
    ]);
    expect(issuesForStep(issues, "review")).toEqual([]);
  });
});

describe("validateSetup API keys", () => {
  it("blocks models that need a key but have none saved", () => {
    const issues = validateSetup(
      { ...base, taskKind: "document-json", extractionSource: "ocr", ocrTarget: "vision" },
      [
        { name: "local" },
        { name: "vision", supportsVision: true, missingKey: true },
      ],
    );
    expect(issuesForStep(issues, "model").map((issue) => issue.message)).toEqual([
      "“vision” has no API key saved. Open Providers, edit it, and paste the key.",
    ]);
  });
});

describe("validateSetup instruction sources", () => {
  it("checks in-app document instructions but trusts a configuration file", () => {
    const document = {
      ...base,
      taskKind: "document-json" as const,
      extractionSource: "ocr",
      ocrTarget: "vision",
      extractionTarget: "vision",
      schema: "",
      stagePrompts: { extraction: "", ocr: "" },
    };
    expect(issuesForStep(validateSetup(document, targets), "instructions").map((issue) => issue.message)).toEqual([
      "Add a reading prompt for the image model.",
      "Add an extraction prompt.",
      "Enter a valid JSON object schema, or select Use example.",
    ]);
    expect(
      issuesForStep(validateSetup({ ...document, baseConfigPath: "sample-data/config.json" }, targets), "instructions"),
    ).toEqual([]);
    expect(
      issuesForStep(validateSetup({ ...base, schema: "", baseConfigPath: "configs/text.json" }, targets), "instructions"),
    ).toEqual([]);
  });
});

describe("validateSetup schema checks", () => {
  it("blocks saving when the schema itself is invalid", () => {
    const schema = '{"type":"object","properties":{"total":{"type":"money"}}}';
    const issues = validateSetup({ ...base, schema, checks: { schema: checkExtractionSchema(schema) } }, targets);
    expect(issuesForStep(issues, "instructions")[0].message).toMatch(/^Fix the schema: \/properties\/total\/type /);
  });

  it("blocks saving when a tool's parameters schema is invalid", () => {
    const tools = JSON.stringify([{ type: "function", function: { name: "refund", parameters: { type: "object", required: "id" } } }]);
    const issues = validateSetup(
      {
        ...base,
        taskKind: "tool-calling",
        extractionTarget: "vision",
        tools,
        checks: { tools: checkToolDefinitions(tools) },
      },
      targets,
    );
    expect(issuesForStep(issues, "instructions")[0].message).toMatch(/^Fix the tool definitions: refund → parameters\/required /);
  });
});
