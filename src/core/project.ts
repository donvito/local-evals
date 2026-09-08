import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { RunConfig } from "./types.js";
import { validateTarget } from "./security.js";
import { validateSchemaDefinition } from "./grading.js";
export async function projectFile(root: string, input: string) {
  const resolved = await realpath(path.resolve(root, input));
  const base = await realpath(root);
  if (!resolved.startsWith(base + path.sep))
    throw new Error("Path must be inside the project.");
  return resolved;
}
export async function loadConfig(file: string): Promise<RunConfig> {
  const config = JSON.parse(await readFile(file, "utf8"));
  validateTarget(config.extractionTarget);
  if (config.extractionSource !== "reference") validateTarget(config.ocrTarget);
  if (config.judgeTarget) validateTarget(config.judgeTarget);
  if (!["prompted-json", "schema-constrained-json"].includes(config.outputMode))
    throw new Error(
      "Select prompted-json or schema-constrained-json explicitly.",
    );
  if (
    config.extractionSource &&
    !["ocr", "reference"].includes(config.extractionSource)
  )
    throw new Error("Invalid extractionSource.");
  if (
    config.inferenceOnly !== undefined &&
    typeof config.inferenceOnly !== "boolean"
  )
    throw new Error("inferenceOnly must be a boolean.");
  if (
    !config.stagePrompts ||
    typeof config.stagePrompts.extraction !== "string" ||
    typeof config.stagePrompts.ocr !== "string"
  )
    throw new Error("Both stage prompts must be configured.");
  if (!Array.isArray(config.fieldRules))
    throw new Error("fieldRules must be an array.");
  for (const rule of config.fieldRules) {
    if (
      !rule ||
      typeof rule.path !== "string" ||
      (rule.match &&
        !["exact", "normalized", "number", "date"].includes(rule.match))
    )
      throw new Error("Invalid field rule.");
    if (
      rule.tolerance !== undefined &&
      (!Number.isFinite(rule.tolerance) || rule.tolerance < 0)
    )
      throw new Error("Field tolerance must be nonnegative.");
  }
  for (const rule of config.crossFieldRules ?? []) {
    if (
      !rule ||
      typeof rule.name !== "string" ||
      !["sum_equals", "equals"].includes(rule.type)
    )
      throw new Error("Invalid cross-field rule.");
    if (
      rule.type === "sum_equals" &&
      (!Array.isArray(rule.fields) ||
        !rule.fields.length ||
        !rule.fields.every((p: unknown) => typeof p === "string") ||
        typeof rule.total !== "string")
    )
      throw new Error("Sum rules need fields and total paths.");
    if (
      rule.type === "equals" &&
      (typeof rule.left !== "string" || typeof rule.right !== "string")
    )
      throw new Error("Equality rules need left and right paths.");
    if (
      rule.tolerance !== undefined &&
      (!Number.isFinite(rule.tolerance) || rule.tolerance < 0)
    )
      throw new Error("Cross-field tolerance must be nonnegative.");
  }
  if (
    config.concurrency !== undefined &&
    (!Number.isInteger(config.concurrency) ||
      config.concurrency < 1 ||
      config.concurrency > 32)
  )
    throw new Error("Concurrency must be 1–32.");
  if (!config.schema)
    config.schema = JSON.parse(
      await readFile(
        path.resolve(path.dirname(file), config.schemaPath ?? "schema.json"),
        "utf8",
      ),
    );
  validateSchemaDefinition(config.schema);
  return config;
}
export async function saveJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
