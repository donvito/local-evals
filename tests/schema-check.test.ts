import { describe, expect, it } from "vitest";
import { checkExtractionSchema, checkToolDefinitions, parseJsonText } from "../src/core/schema-check.js";

describe("checkExtractionSchema", () => {
  it("accepts a valid schema", () => {
    expect(checkExtractionSchema('{"type":"object","properties":{"name":{"type":"string"}}}')).toEqual({ ok: true, issues: [] });
  });

  it("reports JSON syntax errors with a line and column", () => {
    const result = checkExtractionSchema('{\n  "type": "object",\n  "properties": {,}\n}');
    expect(result.ok).toBe(false);
    expect(result.issues[0].path).toMatch(/^Line 3, column \d+$/);
    expect(result.issues[0].message).toMatch(/^Invalid JSON/);
  });

  it("reports invalid schema keywords with their location", () => {
    const result = checkExtractionSchema('{"type":"object","properties":{"total":{"type":"money"}}}');
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path === "/properties/total/type")).toBe(true);
  });

  it("rejects unknown keywords the same way runs do", () => {
    const result = checkExtractionSchema('{"type":"object","propertys":{}}');
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(/unknown keyword/);
  });

  it("warns about grading rules for fields the schema doesn't define", () => {
    const result = checkExtractionSchema('{"type":"object","properties":{"total":{"type":"number"}}}', {
      fieldRules: [{ path: "total" }, { path: "lineItems[0].amount" }],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining('"lineItems"') }),
    ]);
  });

  it("requires a schema only when asked", () => {
    expect(checkExtractionSchema("").ok).toBe(true);
    expect(checkExtractionSchema("", { required: true }).ok).toBe(false);
    expect(checkExtractionSchema("[]").ok).toBe(false);
  });
});

describe("checkToolDefinitions", () => {
  const tool = (name: string, parameters: unknown) => ({ type: "function", function: { name, parameters } });

  it("accepts valid tools and names the tool with a bad parameters schema", () => {
    expect(checkToolDefinitions(JSON.stringify([tool("lookup", { type: "object" })])).ok).toBe(true);
    const result = checkToolDefinitions(
      JSON.stringify([tool("lookup", { type: "object" }), tool("refund", { type: "object", required: "id" })]),
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].path).toBe("refund → parameters/required");
  });

  it("rejects duplicate names and empty lists", () => {
    expect(checkToolDefinitions(JSON.stringify([tool("a", { type: "object" }), tool("a", { type: "object" })])).issues[0].message).toBe(
      "Tool names must be unique.",
    );
    expect(checkToolDefinitions("[]").ok).toBe(false);
  });
});

describe("parseJsonText", () => {
  it("parses valid JSON", () => {
    expect(parseJsonText('{"a":1}').value).toEqual({ a: 1 });
  });
});

describe("schema error messages", () => {
  it("collapses overlapping errors for one bad keyword into a single message", () => {
    const result = checkExtractionSchema('{"type":"object","properties":{"customer":{"type":"text"}}}');
    expect(result.issues).toEqual([
      {
        path: "/properties/customer/type",
        message: "must be one of: array, boolean, integer, null, number, object, string",
        severity: "error",
      },
    ]);
  });
});
