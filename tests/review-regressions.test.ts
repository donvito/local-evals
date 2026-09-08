import { it, expect } from "vitest";
import { gradeJson } from "../src/core/grading.js";
import { compareRuns } from "../src/core/reports.js";
import { DatabaseStore } from "../src/storage/db.js";
import { runEvaluation } from "../src/core/runner.js";
it("preserves document and schema fields named token through persistence", () => {
  const db = new DatabaseStore(":memory:");
  try {
    const schema = {
      type: "object",
      required: ["token"],
      additionalProperties: false,
      properties: { token: { type: "string" } },
    };
    const target = { name: "mock", baseUrl: "http://localhost", model: "m" };
    db.createRun(
      "a",
      {
        datasetVersion: "d",
        schemaVersion: "s",
        schema,
        ocrTarget: target,
        extractionTarget: target,
        outputMode: "prompted-json",
        stagePrompts: { ocr: "o", extraction: "e" },
        fieldRules: [],
      },
      "d",
      { schema },
    );
    db.saveCaseResult(
      "a",
      {
        caseId: "a",
        imagePath: "x",
        expected: { token: "business-value" },
        parsedJson: { token: "business-value" },
        timings: {},
      },
      null,
    );
    expect(db.getRun("a")!.snapshot.schema).toEqual(schema);
    expect(db.getRun("a")!.cases[0].parsedJson).toEqual({
      token: "business-value",
    });
  } finally {
    db.close();
  }
});
it("rejects missing equality operands and inherited prototype fields", () => {
  expect(
    gradeJson(
      {},
      {},
      {},
      [],
      [{ type: "equals", name: "equal", left: "a", right: "b" }],
    ).passed,
  ).toBe(false);
  for (const field of ["toString", "constructor", "__proto__"])
    expect(
      gradeJson({}, JSON.parse('{"' + field + '":"invented"}'), {}, []).passed,
    ).toBe(false);
});
it("never calls an OCR or parse failure a field improvement", () => {
  const config = { datasetVersion: "d", schemaVersion: "s", fieldRules: [] },
    snapshot = { graderVersion: "v2" };
  const left = {
    config,
    snapshot,
    cases: [
      {
        caseId: "a",
        grade: {
          parseSuccess: true,
          passed: false,
          failures: [{ path: "total" }],
        },
      },
    ],
  };
  for (const result of [
    { error: "OCR failed" },
    { grade: { parseSuccess: false, failures: [{ path: "$" }] } },
  ]) {
    const comparison = compareRuns(left, {
      config,
      snapshot,
      cases: [{ caseId: "a", ...result }],
    });
    expect(comparison.fields).toEqual([]);
    expect(comparison.fieldComparableCases).toBe(0);
  }
});
it("persists in-flight requests and completes their record on cancellation", async () => {
  const db = new DatabaseStore(":memory:"),
    controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const target = { name: "mock", baseUrl: "http://localhost", model: "m" };
  const pending = runEvaluation(
    {
      cases: [
        {
          caseId: "a",
          imagePath: "missing-test.png",
          expected: {},
          referenceTranscription: "reference",
        },
      ],
    },
    {
      datasetVersion: "d",
      schemaVersion: "s",
      outputMode: "prompted-json",
      extractionSource: "reference",
      ocrTarget: target,
      extractionTarget: target,
      stagePrompts: { ocr: "o", extraction: "e" },
      fieldRules: [],
      schema: { type: "object" },
    },
    {
      db,
      signal: controller.signal,
      provider: async (_target, _prompt, _image, _mode, signal) => {
        started();
        return await new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
      },
    },
  );
  try {
    await ready;
    const runId = db.listRuns()[0].runId;
    expect(db.getRun(runId)!.attempts[0].status).toBe("running");
    controller.abort();
    await pending;
    expect(db.getRun(runId)!.status).toBe("cancelled");
    expect(db.getRun(runId)!.attempts).toHaveLength(1);
    expect(db.getRun(runId)!.attempts[0].status).toBe("error");
  } finally {
    controller.abort();
    db.close();
  }
});
