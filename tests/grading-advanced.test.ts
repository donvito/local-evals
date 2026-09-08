import { describe, expect, it } from "vitest";
import { gradeJson, gradeOcr, GRADER_VERSION } from "../src/core/grading.js";

describe("advanced deterministic grading", () => {
  it("recursively grades expected fields and distinguishes failures", () => {
    const result = gradeJson(
      { customer: { name: "Acme", count: 2 }, note: "memo" },
      { customer: { name: "Acme", count: "2", invented: true }, note: "" },
      undefined,
      [],
    );
    expect(result.failures.map((failure) => failure.kind)).toEqual(
      expect.arrayContaining(["wrong-type", "extra", "empty"]),
    );
    expect(result.passed).toBe(false);
    expect(result.checks).toBe(4);
  });

  it("matches keyed arrays and reports duplicate, missing, and extra items", () => {
    const result = gradeJson(
      {
        lines: [
          { sku: "a", amount: 1 },
          { sku: "b", amount: 2 },
        ],
      },
      {
        lines: [
          { sku: "a", amount: 1 },
          { sku: "a", amount: 1 },
          { sku: "c", amount: 3 },
        ],
      },
      undefined,
      [{ path: "lines", uniqueKey: "sku" } as any],
    );
    expect(result.failures.map((failure) => failure.kind)).toEqual(
      expect.arrayContaining(["duplicate", "missing", "extra"]),
    );
  });

  it("validates draft 2020 schemas and preserves schema error paths", () => {
    const result = gradeJson(
      { issued: "2025-02-28" },
      { issued: "2025-02-30" },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["issued"],
        properties: { issued: { type: "string", format: "date" } },
      },
      [{ path: "issued", match: "date" }],
    );
    expect(result.schemaValid).toBe(false);
    expect(
      result.failures.some(
        (failure) =>
          failure.kind === "schema-failure" && failure.path === "/issued",
      ),
    ).toBe(true);
  });

  it("supports wildcard equality checks and strict OCR whitespace normalization", () => {
    const result = gradeJson(
      {
        lines: [
          { code: "A", label: "A" },
          { code: "B", label: "B" },
        ],
      },
      {
        lines: [
          { code: "A", label: "A" },
          { code: "B", label: "B" },
        ],
      },
      undefined,
      [],
      [
        {
          name: "codes equal labels",
          type: "equals",
          left: "lines.*.code",
          right: "lines.*.label",
        } as any,
      ],
    );
    expect(result.passed).toBe(true);
    expect(gradeOcr("Hello WORLD", "hello  WORLD").cer).toBeGreaterThan(0);
    expect(GRADER_VERSION).toBe("deterministic-v2");
  });

  it("does not forgive invented cross-check inputs and rejects missing wildcard sums", () => {
    const invented = gradeJson(
      { total: 3 },
      { total: 3, lines: [{ amount: 3 }] },
      undefined,
      [],
      [
        {
          name: "sum",
          type: "sum_equals",
          fields: ["lines.*.amount"],
          total: "total",
        } as any,
      ],
    );
    expect(invented.passed).toBe(false);
    expect(invented.failures.some((failure) => failure.kind === "extra")).toBe(
      true,
    );

    const missing = gradeJson(
      { total: 0, lines: [] },
      { total: 0 },
      undefined,
      [],
      [
        {
          name: "sum",
          type: "sum_equals",
          fields: ["lines.*.amount"],
          total: "total",
        } as any,
      ],
    );
    expect(missing.passed).toBe(false);
  });

  it("counts empty containers and applies wildcard field rules to indexed paths", () => {
    const result = gradeJson(
      { items: [], meta: {} },
      { items: [], meta: {} },
      undefined,
      [{ path: "items.*.amount", match: "number" }],
    );
    expect(result.passedChecks).toBe(2);
    expect(result.checks).toBe(2);
  });
});
