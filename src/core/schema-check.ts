import { schemaDefinitionErrors } from "./grading.js";

export type SchemaCheckIssue = { path: string; message: string; severity: "error" | "warning" };
export type SchemaCheck = { ok: boolean; issues: SchemaCheckIssue[] };

const error = (path: string, message: string): SchemaCheckIssue => ({ path, message, severity: "error" });
const warning = (path: string, message: string): SchemaCheckIssue => ({ path, message, severity: "warning" });

/** Parse editor text, describing syntax errors by line and column. */
export function parseJsonText(text: string): { value?: unknown; issue?: SchemaCheckIssue } {
  try {
    return { value: JSON.parse(text) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const position = Number(/position (\d+)/.exec(message)?.[1]);
    const lineColumn = /line (\d+) column (\d+)/.exec(message);
    let where = "";
    if (lineColumn) where = `Line ${lineColumn[1]}, column ${lineColumn[2]}`;
    else if (Number.isFinite(position)) {
      const before = text.slice(0, position).split("\n");
      where = `Line ${before.length}, column ${before[before.length - 1].length + 1}`;
    }
    const reason = message
      .replace(/^JSON\.parse: /, "")
      .replace(/ in JSON at position \d+.*$/, "")
      .replace(/ \(line \d+ column \d+\)$/, "")
      .replace(/^Unexpected token '(.)', .*$/, "Unexpected character '$1'");
    return { issue: error(where || "/", `Invalid JSON: ${reason}`) };
  }
}

const topLevelField = (path: string) => path.replace(/\[\d+\]/g, "").split(".")[0];

/** Check an extraction schema the way runs compile it, plus friendly warnings. */
export function checkExtractionSchema(
  text: string,
  options: { fieldRules?: unknown; required?: boolean } = {},
): SchemaCheck {
  if (!text.trim())
    return options.required
      ? { ok: false, issues: [error("/", "Enter a JSON schema.")] }
      : { ok: true, issues: [] };
  const parsed = parseJsonText(text);
  if (parsed.issue) return { ok: false, issues: [parsed.issue] };
  const schema = parsed.value;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return { ok: false, issues: [error("/", "The schema must be a JSON object, like { \"type\": \"object\", … }.")] };
  const issues: SchemaCheckIssue[] = schemaDefinitionErrors(schema).map((item) => error(item.path, item.message));
  if (!issues.length) {
    const root = schema as { type?: unknown; properties?: unknown };
    if (root.type !== undefined && root.type !== "object")
      issues.push(warning("/type", "Answers are JSON objects, so the top-level type is usually \"object\"."));
    const properties =
      root.properties && typeof root.properties === "object" ? Object.keys(root.properties) : undefined;
    if (properties && Array.isArray(options.fieldRules))
      for (const rule of options.fieldRules as { path?: unknown }[]) {
        const field = typeof rule?.path === "string" ? topLevelField(rule.path) : "";
        if (field && !properties.includes(field))
          issues.push(warning(`fieldRules → ${rule.path}`, `A grading rule uses "${field}", which isn't in the schema.`));
      }
  }
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

/** Check tool definitions and each tool's parameters schema. */
export function checkToolDefinitions(text: string): SchemaCheck {
  const parsed = parseJsonText(text || "[]");
  if (parsed.issue) return { ok: false, issues: [parsed.issue] };
  if (!Array.isArray(parsed.value) || !parsed.value.length)
    return { ok: false, issues: [error("/", "Add at least one tool as a JSON array.")] };
  const issues: SchemaCheckIssue[] = [];
  const names = new Set<string>();
  parsed.value.forEach((tool: any, index) => {
    const name = typeof tool?.function?.name === "string" && tool.function.name.trim() ? tool.function.name : "";
    const where = name ? `${name}` : `tool ${index + 1}`;
    if (tool?.type !== "function" || !tool.function || typeof tool.function !== "object") {
      issues.push(error(where, 'Each tool needs "type": "function" and a "function" object.'));
      return;
    }
    if (!name) issues.push(error(where, "The function needs a name."));
    else if (names.has(name)) issues.push(error(where, "Tool names must be unique."));
    names.add(name);
    const parameters = tool.function.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
      issues.push(error(`${where} → parameters`, "Parameters must be a JSON schema object."));
    else
      for (const item of schemaDefinitionErrors(parameters))
        issues.push(error(`${where} → parameters${item.path === "/" ? "" : item.path}`, item.message));
  });
  return { ok: !issues.length, issues };
}
