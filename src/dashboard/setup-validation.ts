import type { SchemaCheck } from "../core/schema-check.js";
export type SetupStep = "type" | "data" | "model" | "instructions" | "grading" | "review";
export const SETUP_STEPS: SetupStep[] = ["type", "data", "model", "instructions", "grading", "review"];

export type SetupIssue = { step: SetupStep; message: string };

export type SetupFormInput = {
  taskKind: "document-json" | "text-json" | "tool-calling";
  datasetVersion: string;
  extractionSource: string;
  ocrTarget: string;
  extractionTarget: string;
  judgeTarget: string;
  judgeRubric: string;
  schema: string;
  stagePrompts: { extraction: string; ocr?: string };
  baseConfigPath?: string;
  /** Server-side JSON Schema checks for the editors, when available. */
  checks?: { schema?: SchemaCheck; tools?: SchemaCheck };
  fieldRules: string;
  tools: string;
  toolChoice: string;
};

export type SetupTargetInput = {
  name: string;
  supportsVision?: boolean;
  supportsTools?: boolean;
  missingKey?: boolean;
};

const parse = (value: string): unknown => {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export function validateSetup(
  form: SetupFormInput,
  targets: SetupTargetInput[],
): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (step: SetupStep, message: string) => issues.push({ step, message });
  const { taskKind } = form;
  const extraction = targets.find((target) => target.name === form.extractionTarget);

  if (!form.datasetVersion) add("data", "Choose a dataset.");

  if (taskKind === "document-json" && form.extractionSource === "ocr" && !form.ocrTarget)
    add("model", "Choose a vision-capable OCR target, or select reference transcription.");
  const needsKey = (name: string) => targets.find((target) => target.name === name)?.missingKey;
  for (const name of new Set([
    taskKind === "document-json" && form.extractionSource === "ocr" ? form.ocrTarget : "",
    form.extractionTarget,
    taskKind === "tool-calling" ? "" : form.judgeTarget,
  ]))
    if (name && needsKey(name))
      add("model", `“${name}” has no API key saved. Open Providers, edit it, and paste the key.`);
  if (!form.extractionTarget) add("model", "Choose a model.");
  else if (taskKind === "tool-calling" && !extraction?.supportsTools)
    add("model", "Choose a target marked as tool-capable before saving a tool-calling run.");

  const fromFile = Boolean(form.baseConfigPath?.trim());
  const addSchemaErrors = (check?: SchemaCheck) => {
    const first = check?.issues.find((issue) => issue.severity === "error");
    if (first)
      add(
        "instructions",
        `Fix the ${taskKind === "tool-calling" ? "tool definitions" : "schema"}: ${first.path === "/" ? "" : `${first.path} `}${first.message}`,
      );
  };
  if (taskKind === "document-json" && !fromFile) {
    if (form.extractionSource === "ocr" && !form.stagePrompts.ocr?.trim())
      add("instructions", "Add a reading prompt for the image model.");
    if (!form.stagePrompts.extraction.trim())
      add("instructions", "Add an extraction prompt.");
    const schema = parse(form.schema);
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      add("instructions", "Enter a valid JSON object schema, or select Use example.");
    else addSchemaErrors(form.checks?.schema);
  }
  if (taskKind === "text-json" && !fromFile) {
    const schema = parse(form.schema);
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      add("instructions", "Enter a valid JSON object schema for the text workflow.");
    else addSchemaErrors(form.checks?.schema);
    if (!form.stagePrompts.extraction.trim())
      add("instructions", "Add an extraction prompt for the text workflow.");
  }
  if (taskKind === "tool-calling" && !fromFile) {
    if (!form.stagePrompts.extraction.trim())
      add("instructions", "Add tool-calling instructions before saving.");
    const tools = parse(form.tools);
    if (!Array.isArray(tools)) add("instructions", "Tool definitions must be a JSON array.");
    else if (form.toolChoice !== "none" && tools.length === 0)
      add("instructions", "Add at least one tool or choose tool choice “none”.");
    else if (tools.length) addSchemaErrors(form.checks?.tools);
  }

  if (taskKind !== "tool-calling") {
    const fieldRules = parse(form.fieldRules);
    if (
      (form.fieldRules.trim() !== "" && !Array.isArray(fieldRules)) ||
      (taskKind !== "document-json" && !Array.isArray(fieldRules))
    )
      add("grading", "Field rules must be a JSON array.");
    if (form.judgeTarget && !form.judgeRubric.trim())
      add("grading", "Describe what the judge should check, or remove the judge model.");
  }
  return issues;
}

export const issuesForStep = (issues: SetupIssue[], step: SetupStep) =>
  issues.filter((issue) => issue.step === step);
