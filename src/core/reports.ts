import { stable, hash } from "./manifest.js";
export function metrics(
  cases: any[],
  total = cases.length,
  inferenceOnly = false,
) {
  const n = total || 1,
    graded = cases.filter((c) => c.ocrGrade?.graded);
  const costs = cases
    .flatMap((c) => [c.ocrUsage?.costUsd, c.extractionUsage?.costUsd])
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  const timing = (key: string) => {
    const values = cases
      .map((c) => c.timings?.[key])
      .filter((v) => typeof v === "number");
    return values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
  };
  return {
    sampleCount: total,
    completed: cases.length,
    passed: cases.filter((c) => c.grade?.passed).length,
    passRate: inferenceOnly
      ? null
      : cases.filter((c) => c.grade?.passed).length / n,
    parseRate: inferenceOnly
      ? null
      : cases.filter((c) => c.grade?.parseSuccess).length / n,
    schemaRate: inferenceOnly
      ? null
      : cases.filter((c) => c.grade?.schemaValid).length / n,
    fieldAccuracy: inferenceOnly
      ? null
      : cases.reduce((s, c) => s + (c.grade?.fieldAccuracy ?? 0), 0) / n,
    inferenceOnly,
    gradedCount: inferenceOnly ? 0 : cases.filter((c) => c.grade).length,
    ocrGraded: graded.length,
    cer: graded.length
      ? graded.reduce((s, c) => s + c.ocrGrade.cer, 0) / graded.length
      : null,
    wer: graded.length
      ? graded.reduce((s, c) => s + c.ocrGrade.wer, 0) / graded.length
      : null,
    meanOcrMs: timing("ocrMs"),
    meanExtractionMs: timing("extractionMs"),
    knownCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    costObservations: costs.length,
  };
}
export function compatibility(config: any, snapshot: any) {
  const snapshotConfig = snapshot?.config ?? {};
  const taskKind =
    config.taskKind ??
    snapshot?.taskKind ??
    snapshotConfig.taskKind ??
    "document-json";
  const schema = snapshot?.schema ?? snapshotConfig.schema ?? config.schema;
  const tools =
    taskKind === "tool-calling"
      ? config.tools ?? snapshotConfig.tools ?? snapshot?.tools ?? []
      : [];
  return hash(
    stable({
      dataset: config.datasetVersion,
      schema,
      schemaHash: snapshot?.schemaHash ?? hash(stable(schema)),
      schemaVersion: config.schemaVersion,
      grader: snapshot?.graderVersion ?? "legacy",
      rules: config.fieldRules,
      cross: config.crossFieldRules,
      taskKind,
      tools,
      toolChoice:
        taskKind === "tool-calling"
          ? config.toolChoice ??
            snapshotConfig.toolChoice ??
            snapshot?.toolChoice ??
            "auto"
          : undefined,
      toolCallOrder:
        taskKind === "tool-calling"
          ? config.toolCallOrder ??
            snapshotConfig.toolCallOrder ??
            snapshot?.toolCallOrder ??
            "ordered"
          : undefined,
      source:
        taskKind === "document-json"
          ? config.extractionSource ?? "ocr"
          : "native",
    }),
  );
}
export function compareRuns(left: any, right: any) {
  if (!left || !right) throw new Error("Both runs must exist.");
  if (
    compatibility(left.config, left.snapshot) !==
    compatibility(right.config, right.snapshot)
  )
    throw new Error(
      "Runs have incompatible dataset, schema, grader, field rules, extraction source, task kind, tools, tool order, or tool choice.",
    );
  if (left.config.inferenceOnly || right.config.inferenceOnly)
    throw new Error(
      "Inference-only runs do not have deterministic quality scores to compare.",
    );
  const map = new Map(right.cases.map((c: any) => [c.caseId, c]));
  const fields = new Map<
    string,
    { path: string; improved: number; regressed: number }
  >();
  let improved = 0,
    regressed = 0,
    unchanged = 0,
    fieldComparableCases = 0;
  const pairs: any[] = [];
  for (const a of left.cases) {
    const b: any = map.get(a.caseId);
    if (!b) continue;
    const before = !!a.grade?.passed,
      after = !!b.grade?.passed;
    if (!before && after) improved++;
    else if (before && !after) regressed++;
    else unchanged++;
    const af = new Set<string>(
        (a.grade?.failures ?? []).map((f: any) => f.path),
      ),
      bf = new Set<string>((b.grade?.failures ?? []).map((f: any) => f.path));
    if (a.grade?.parseSuccess && b.grade?.parseSuccess) {
      fieldComparableCases++;
      for (const key of new Set([...af, ...bf])) {
        const row = fields.get(key) ?? { path: key, improved: 0, regressed: 0 };
        if (af.has(key) && !bf.has(key)) row.improved++;
        if (!af.has(key) && bf.has(key)) row.regressed++;
        fields.set(key, row);
      }
    }
    pairs.push({ caseId: a.caseId, before, after });
  }
  const ids = new Set(pairs.map((p) => p.caseId));
  return {
    sampleCount: pairs.length,
    fieldComparableCases,
    improved,
    regressed,
    unchanged,
    fields: [...fields.values()],
    pairs,
    leftMetrics: metrics(left.cases.filter((c: any) => ids.has(c.caseId))),
    rightMetrics: metrics(right.cases.filter((c: any) => ids.has(c.caseId))),
  };
}
export function markdownReport(run: any) {
  const m = run.metrics;
  const taskKind =
    run.config?.taskKind ?? run.snapshot?.taskKind ?? "document-json";
  const passRate =
    m.passRate == null ? "unavailable" : (m.passRate * 100).toFixed(2) + "%";
  const evidence =
    "\n\n## Configuration, snapshot and request attempts\n\n```json\n" +
    JSON.stringify(
      { config: run.config, snapshot: run.snapshot, attempts: run.attempts },
      null,
      2,
    ) +
    "\n```\n";
  return (
    "# EvalForge run " +
    run.runId +
    "\n\nStatus: " +
    run.status +
    "\n\nCases: " +
    m.sampleCount +
    "; passed: " +
    m.passed +
    "; pass rate: " +
    passRate +
    "\n\nTask kind: " +
    taskKind +
    "\n\nJSON parse: " +
    m.parseRate +
    "; schema: " +
    m.schemaRate +
    "; field accuracy: " +
    m.fieldAccuracy +
    "\n\nOCR graded: " +
    m.ocrGraded +
    "; CER: " +
    (m.cer ?? "ungraded") +
    "; WER: " +
    (m.wer ?? "ungraded") +
    "\n\n" +
    run.cases
      .map(
        (c: any) =>
          "## " +
          String(c.caseId).replace(/[\r\n]/g, " ") +
          "\n\n" +
          (c.error ?? (c.grade?.passed ? "PASS" : "FAIL")) +
          "\n\n```json\n" +
          JSON.stringify(c, null, 2) +
          "\n```\n",
      )
      .join("\n") +
    evidence
  );
}
