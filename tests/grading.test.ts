import { describe, expect, it } from "vitest";
import { gradeJson, gradeOcr } from "../src/core/grading.js";
describe("grading", () => {
  it("handles normalized strings, numeric tolerance and nulls", () => {
    const result = gradeJson(
      { name: "Acme Ltd", total: 10, note: null },
      { name: " acme   ltd ", total: 10.01, note: null },
      undefined,
      [
        { path: "name", match: "normalized" },
        { path: "total", match: "number", tolerance: 0.02 },
        { path: "note" },
      ],
    );
    expect(result.passed).toBe(true);
  });
  it("fails extra fields unless a rule ignores them", () => {
    const expected = { category: "billing", urgency: "high" };
    const actual = { category: "billing", urgency: "high", summary: "Charged twice." };
    const strict = gradeJson(expected, actual, undefined, []);
    expect(strict.passed).toBe(false);
    expect(strict.failures[0]).toMatchObject({ path: "summary", kind: "extra" });
    const ignored = gradeJson(expected, actual, undefined, [{ path: "summary", match: "ignore" }]);
    expect(ignored.passed).toBe(true);
    expect(ignored.fieldAccuracy).toBe(1);
    expect(gradeJson({ ...expected, summary: "x" }, expected, undefined, [{ path: "summary", match: "ignore" }]).passed).toBe(true);
  });
  it("reports malformed JSON and OCR references", () => {
    expect(gradeJson({}, undefined, undefined, []).failures[0].kind).toBe(
      "malformed-json",
    );
    expect(gradeOcr("hello world", "hello  world").cer).toBe(0);
    expect(gradeOcr(undefined, "x").graded).toBe(false);
  });
  it("checks cross-field sums", () => {
    const result = gradeJson(
      { total: 3, lines: [{ amount: 1 }, { amount: 2 }] },
      { total: 3, lines: [{ amount: 1 }, { amount: 2 }] },
      undefined,
      [],
      [
        {
          name: "line sum",
          type: "sum_equals",
          fields: ["lines.0.amount", "lines.1.amount"],
          total: "total",
        },
      ],
    );
    expect(result.passed).toBe(true);
  });
  it("grades invalid dates and nonnumeric cross-field values as failures", () => {
    const date = gradeJson(
      { issued: "2025-01-01" },
      { issued: "not-a-date" },
      undefined,
      [{ path: "issued", match: "date" }],
    );
    expect(date.passed).toBe(false);
    const sum = gradeJson(
      { total: 3 },
      { total: 3, lines: [{ amount: "oops" }] },
      undefined,
      [{ path: "total" }],
      [
        {
          name: "line sum",
          type: "sum_equals",
          fields: ["lines.0.amount"],
          total: "total",
        },
      ],
    );
    expect(sum.passed).toBe(false);
  });
});
