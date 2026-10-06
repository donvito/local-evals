import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  CrossFieldRule,
  FieldRule,
  RunConfig,
  ToolDefinition,
  ToolChoice,
  ToolCallOrder,
  TaskKind,
} from "./types.js";
import { validateTarget } from "./security.js";
import { validateSchemaDefinition } from "./grading.js";

const TASK_KINDS: readonly TaskKind[] = [
  "document-json",
  "text-json",
  "tool-calling",
];
const OUTPUT_MODES = ["prompted-json", "schema-constrained-json"] as const;
const TOOL_CHOICES: readonly ToolChoice[] = ["auto", "required", "none"];
const TOOL_CALL_ORDERS: readonly ToolCallOrder[] = ["ordered", "unordered"];

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateToolDefinition(
  tool: unknown,
  index: number,
): asserts tool is ToolDefinition {
  if (!plainObject(tool) || tool.type !== "function" || !plainObject(tool.function))
    throw new Error(
      `Invalid tool definition at index ${index}; tools must be OpenAI function definitions.`,
    );
  const fn = tool.function;
  if (typeof fn.name !== "string" || !fn.name.trim())
    throw new Error(`Tool definition at index ${index} requires a function name.`);
  if (fn.description !== undefined && typeof fn.description !== "string")
    throw new Error(`Tool ${fn.name} description must be a string.`);
  if (!plainObject(fn.parameters))
    throw new Error(`Tool ${fn.name} requires an object parameters schema.`);
  validateSchemaDefinition(fn.parameters);
}

function validateFieldRules(rules: unknown): asserts rules is FieldRule[] {
  if (!Array.isArray(rules)) throw new Error("fieldRules must be an array.");
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.path !== "string" ||
      (rule.match &&
        !["exact", "normalized", "number", "date", "ignore"].includes(rule.match))
    )
      throw new Error("Invalid field rule.");
    if (
      rule.tolerance !== undefined &&
      (!Number.isFinite(rule.tolerance) || rule.tolerance < 0)
    )
      throw new Error("Field tolerance must be nonnegative.");
  }
}

function validateCrossFieldRules(
  rules: unknown,
): asserts rules is CrossFieldRule[] | undefined {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) throw new Error("crossFieldRules must be an array.");
  for (const rule of rules) {
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
}

/**
 * Validate a run configuration without reading a file.
 *
 * This is reusable by the dashboard/server path, which builds a config from
 * form values before saving it. Dataset-specific requirements remain in the
 * runner because they need the manifest.
 */
export function validateRunConfig(config: any): asserts config is RunConfig {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config)
  )
    throw new Error("Run configuration must be an object.");
  if (typeof config.datasetVersion !== "string" || !config.datasetVersion.trim())
    throw new Error("datasetVersion is required.");
  if (typeof config.schemaVersion !== "string" || !config.schemaVersion.trim())
    throw new Error("schemaVersion is required.");

  if (config.taskKind !== undefined && !TASK_KINDS.includes(config.taskKind))
    throw new Error("Invalid taskKind; choose document-json, text-json, or tool-calling.");

  // Omitted outputMode remains the legacy prompted-json behavior.
  if (config.outputMode === undefined) config.outputMode = "prompted-json";
  if (!OUTPUT_MODES.includes(config.outputMode))
    throw new Error("Select prompted-json or schema-constrained-json explicitly.");

  const taskKind: TaskKind = config.taskKind ?? "document-json";

  if (
    config.extractionSource !== undefined &&
    !["ocr", "reference"].includes(config.extractionSource)
  )
    throw new Error("Invalid extractionSource.");
  if (
    config.inferenceOnly !== undefined &&
    typeof config.inferenceOnly !== "boolean"
  )
    throw new Error("inferenceOnly must be a boolean.");

  if (!plainObject(config.stagePrompts) || typeof config.stagePrompts.extraction !== "string")
    throw new Error("An extraction stage prompt must be configured.");
  if (
    config.stagePrompts.ocr !== undefined &&
    typeof config.stagePrompts.ocr !== "string"
  )
    throw new Error("The OCR stage prompt must be a string when configured.");

  if (taskKind === "document-json" && config.extractionSource !== "reference") {
    if (!config.ocrTarget)
      throw new Error("document-json OCR mode requires an OCR target.");
    if (!config.stagePrompts.ocr?.trim())
      throw new Error("document-json OCR mode requires an OCR stage prompt.");
  }

  if (!config.extractionTarget) throw new Error("An extraction target is required.");
  validateTarget(config.extractionTarget);
  if (config.ocrTarget) validateTarget(config.ocrTarget);
  if (config.judgeTarget) validateTarget(config.judgeTarget);
  for (const [key, target] of [
    ["supportsVision", config.ocrTarget?.supportsVision],
    ["supportsStructuredOutput", config.extractionTarget?.supportsStructuredOutput],
    ["supportsTools", config.extractionTarget?.supportsTools],
  ] as const)
    if (target !== undefined && typeof target !== "boolean")
      throw new Error(`${key} must be a boolean when configured.`);

  validateFieldRules(config.fieldRules);
  validateCrossFieldRules(config.crossFieldRules);

  if (
    config.concurrency !== undefined &&
    (!Number.isInteger(config.concurrency) ||
      config.concurrency < 1 ||
      config.concurrency > 32)
  )
    throw new Error("Concurrency must be 1–32.");
  if (
    config.requestTimeoutMs !== undefined &&
    (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
  )
    throw new Error("requestTimeoutMs must be positive.");

  if (config.schema !== undefined) {
    if (!plainObject(config.schema)) throw new Error("schema must be a JSON Schema object.");
    validateSchemaDefinition(config.schema);
  }
  if (config.outputMode === "schema-constrained-json" && !config.schema)
    throw new Error("Schema-constrained mode requires an extraction schema.");

  if (config.tools !== undefined) {
    if (!Array.isArray(config.tools)) throw new Error("tools must be an array.");
    const names = new Set<string>();
    config.tools.forEach((tool: unknown, index: number) => {
      validateToolDefinition(tool, index);
      const name = tool.function.name;
      if (names.has(name)) throw new Error(`Duplicate tool name: ${name}.`);
      names.add(name);
    });
  }
  if (taskKind === "tool-calling") {
    if (!Array.isArray(config.tools) || config.tools.length === 0)
      throw new Error("tool-calling mode requires at least one configured tool.");
    if (config.judgeTarget !== undefined && config.judgeTarget !== null)
      throw new Error(
        "tool-calling mode does not support judgeTarget because semantic judging is ignored.",
      );
    if (config.extractionTarget.supportsTools === false)
      throw new Error(
        `Target ${config.extractionTarget.name} does not advertise tool-calling support.`,
      );
    if (config.outputMode === "schema-constrained-json")
      throw new Error(
        "tool-calling mode does not support schema-constrained JSON output.",
      );
  }
  if (config.toolChoice !== undefined && !TOOL_CHOICES.includes(config.toolChoice))
    throw new Error("toolChoice must be auto, required, or none.");
  if (
    config.toolCallOrder !== undefined &&
    !TOOL_CALL_ORDERS.includes(config.toolCallOrder)
  )
    throw new Error("toolCallOrder must be ordered or unordered.");
  if (
    taskKind !== "tool-calling" &&
    (config.tools !== undefined ||
      config.toolChoice !== undefined ||
      config.toolCallOrder !== undefined)
  )
    throw new Error("Tool settings require taskKind tool-calling.");
}

export async function projectFile(root: string, input: string) {
  const resolved = await realpath(path.resolve(root, input));
  const base = await realpath(root);
  if (!resolved.startsWith(base + path.sep))
    throw new Error("Path must be inside the project.");
  return resolved;
}

export async function loadConfig(file: string): Promise<RunConfig> {
  const config: any = JSON.parse(await readFile(file, "utf8"));
  if (config.outputMode === undefined) config.outputMode = "prompted-json";
  // Tool-calling is self-contained and does not need the legacy extraction
  // schema. Native text configs may intentionally omit one in prompted mode;
  // document configs retain the old schema.json default.
  if (!config.schema && config.taskKind !== "tool-calling") {
    try {
      config.schema = JSON.parse(
        await readFile(
          path.resolve(path.dirname(file), config.schemaPath ?? "schema.json"),
          "utf8",
        ),
      );
    } catch (error: any) {
      if (config.taskKind !== "text-json" || error?.code !== "ENOENT") throw error;
    }
  }
  validateRunConfig(config);
  if (
    config.outputMode === "schema-constrained-json" &&
    !config.schema &&
    config.taskKind !== "tool-calling"
  )
    throw new Error("Schema-constrained mode requires an extraction schema.");
  return config;
}

export async function saveJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
