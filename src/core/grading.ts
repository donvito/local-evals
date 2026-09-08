import AjvModule from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import type {
  CrossFieldRule,
  FieldFailure,
  FieldRule,
  Json,
  Grade,
} from "./types.js";

export const NORMALIZATION_VERSION = "whitespace-v2";
export const GRADER_VERSION = "deterministic-v2";

type AnyRule = FieldRule & { uniqueKey?: string };
type AnyCrossRule =
  | CrossFieldRule
  | {
      name: string;
      type: "equals";
      left: string;
      right: string;
      tolerance?: number;
    };
type AnyGrade = Grade & { checks?: number; passedChecks?: number };

function normalizeString(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
    : "";
}
function isObject(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandPath(
  value: unknown,
  path: string,
  prefix = "",
): Array<{ path: string; value: unknown }> {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length) return [{ path: prefix, value }];
  const [head, ...tail] = parts;
  const nextPrefix = prefix ? `${prefix}.${head}` : head;
  if (head === "*") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, index) =>
      expandPath(
        item,
        tail.join("."),
        prefix ? `${prefix}.${index}` : String(index),
      ),
    );
  }
  if (value == null) return [];
  const next =
    Array.isArray(value) && /^\d+$/.test(head)
      ? value[Number(head)]
      : isObject(value)
        ? value[head]
        : undefined;
  return expandPath(next, tail.join("."), nextPrefix);
}

function dateOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : undefined;
}
function schemaDate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    dateOnly(value) !== undefined
  );
}

function equalValues(
  expected: unknown,
  actual: unknown,
  rule?: AnyRule,
): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (rule?.match === "normalized")
    return (
      typeof expected === "string" &&
      typeof actual === "string" &&
      normalizeString(expected) === normalizeString(actual)
    );
  if (rule?.match === "number")
    return (
      typeof expected === "number" &&
      typeof actual === "number" &&
      Number.isFinite(expected) &&
      Number.isFinite(actual) &&
      Math.abs(expected - actual) <= (rule.tolerance ?? 0)
    );
  if (rule?.match === "date")
    return (
      dateOnly(expected) !== undefined &&
      dateOnly(expected) === dateOnly(actual)
    );
  if (typeof expected !== typeof actual) return false;
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length &&
      expected.every((value, i) => equalValues(value, actual[i]))
    );
  if (isObject(expected) && isObject(actual))
    return (
      Object.keys(expected).length === Object.keys(actual).length &&
      Object.keys(expected).every((key) =>
        equalValues(expected[key], actual[key]),
      )
    );
  return Object.is(expected, actual);
}

function addFailure(
  failures: FieldFailure[],
  path: string,
  kind: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  failures.push({
    path,
    kind,
    message,
    ...(expected !== undefined ? { expected: expected as Json } : {}),
    ...(actual !== undefined ? { actual: actual as Json } : {}),
  });
}

function ruleAt(path: string, rules: AnyRule[]): AnyRule | undefined {
  const pathParts = path.split(".").filter(Boolean);
  return rules.find((rule) => {
    const ruleParts = rule.path.split(".").filter(Boolean);
    return (
      ruleParts.length === pathParts.length &&
      ruleParts.every(
        (part, index) => part === "*" || part === pathParts[index],
      )
    );
  });
}

function leaf(
  expected: unknown,
  actual: unknown,
  path: string,
  rule: AnyRule | undefined,
  failures: FieldFailure[],
  count: { checks: number; passed: number },
): void {
  count.checks += 1;
  if (actual === undefined) {
    if (rule?.required === false) {
      count.passed += 1;
      return;
    }
    return addFailure(
      failures,
      path,
      "missing",
      "Expected field is missing.",
      expected,
    );
  }
  if (expected === null && actual === null) {
    count.passed += 1;
    return;
  }
  if (expected === null && actual !== null)
    return addFailure(
      failures,
      path,
      "null-mismatch",
      "Expected null.",
      expected,
      actual,
    );
  if (actual === null && expected !== null)
    return addFailure(
      failures,
      path,
      "null-mismatch",
      "Actual value is null.",
      expected,
      actual,
    );
  if (actual === "" && expected !== "")
    return addFailure(
      failures,
      path,
      "empty",
      "Actual value is empty.",
      expected,
      actual,
    );
  if (expected !== null && actual !== null && typeof expected !== typeof actual)
    return addFailure(
      failures,
      path,
      "wrong-type",
      "Value has the wrong type.",
      expected,
      actual,
    );
  if (!equalValues(expected, actual, rule))
    return addFailure(
      failures,
      path,
      "incorrect",
      "Value does not match expected value.",
      expected,
      actual,
    );
  count.passed += 1;
}

function compareNode(
  expected: unknown,
  actual: unknown,
  path: string,
  rules: AnyRule[],
  failures: FieldFailure[],
  count: { checks: number; passed: number },
): void {
  const rule = ruleAt(path, rules);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual))
      return leaf(expected, actual, path, rule, failures, count);
    if (!rule?.uniqueKey) {
      if (expected.length === 0 && actual.length === 0) {
        count.checks += 1;
        count.passed += 1;
      }
      for (
        let index = 0;
        index < Math.max(expected.length, actual.length);
        index += 1
      ) {
        if (index >= expected.length) {
          count.checks += 1;
          addFailure(
            failures,
            `${path}.${index}`,
            "extra",
            "Actual array contains an extra item.",
            undefined,
            actual[index],
          );
        } else
          compareNode(
            expected[index],
            actual[index],
            `${path}.${index}`,
            rules,
            failures,
            count,
          );
      }
      return;
    }
    const expectedItems = new Map<unknown, { item: unknown; index: number }>(),
      actualItems = new Map<unknown, { item: unknown; index: number }>();
    const collect = (
      items: unknown[],
      map: Map<unknown, { item: unknown; index: number }>,
      label: string,
    ) =>
      items.forEach((item, index) => {
        const key = isObject(item) ? item[rule.uniqueKey!] : undefined;
        if (map.has(key)) {
          count.checks += 1;
          addFailure(
            failures,
            `${path}.${index}`,
            "duplicate",
            `Duplicate ${label} array item for unique key.`,
            key as Json,
            key as Json,
          );
        } else map.set(key, { item, index });
      });
    collect(expected, expectedItems, "expected");
    collect(actual, actualItems, "actual");
    for (const [key, expectedEntry] of expectedItems) {
      const actualEntry = actualItems.get(key);
      if (!actualEntry) {
        count.checks += 1;
        addFailure(
          failures,
          `${path}.${expectedEntry.index}`,
          "missing",
          "Expected array item is missing.",
          expectedEntry.item,
        );
      } else
        compareNode(
          expectedEntry.item,
          actualEntry.item,
          `${path}.${actualEntry.index}`,
          rules,
          failures,
          count,
        );
    }
    for (const [key, actualEntry] of actualItems)
      if (!expectedItems.has(key)) {
        count.checks += 1;
        addFailure(
          failures,
          `${path}.${actualEntry.index}`,
          "extra",
          "Actual array contains an extra item.",
          undefined,
          actualEntry.item,
        );
      }
    return;
  }
  if (isObject(expected)) {
    if (!isObject(actual))
      return leaf(expected, actual, path, rule, failures, count);
    if (
      Object.keys(expected).length === 0 &&
      Object.keys(actual).length === 0
    ) {
      count.checks += 1;
      count.passed += 1;
    }
    for (const key of Object.keys(expected))
      compareNode(
        expected[key],
        actual[key],
        path ? `${path}.${key}` : key,
        rules,
        failures,
        count,
      );
    for (const key of Object.keys(actual))
      if (!Object.hasOwn(expected, key)) {
        count.checks += 1;
        addFailure(
          failures,
          path ? `${path}.${key}` : key,
          "extra",
          "Actual object contains an extra field.",
          undefined,
          actual[key],
        );
      }
    return;
  }
  leaf(expected, actual, path, rule, failures, count);
}

function schemaErrorPath(error: any): string {
  let path = error.instancePath || "$";
  if (error.keyword === "required" && error.params?.missingProperty)
    path += `/${error.params.missingProperty}`;
  if (
    error.keyword === "additionalProperties" &&
    error.params?.additionalProperty
  )
    path += `/${error.params.additionalProperty}`;
  return path;
}

export function compileSchema(schema: object): any {
  const schemaId = (schema as { $schema?: unknown }).$schema;
  const Ajv2020Ctor = (Ajv2020Module as any).default ?? Ajv2020Module;
  const AjvCtor = (AjvModule as any).default ?? AjvModule;
  const validator =
    typeof schemaId === "string" && schemaId.includes("2020-12")
      ? new Ajv2020Ctor({ allErrors: true })
      : new AjvCtor({ allErrors: true });
  validator.addFormat("date", { type: "string", validate: schemaDate });
  return validator.compile(schema);
}

/** Validate schema configuration at startup, before any cases are graded. */
export function validateSchemaDefinition(schema: object): void {
  compileSchema(schema);
}

function crossValues(value: unknown, path: string): unknown[] {
  return expandPath(value, path).map((item) => item.value);
}
function pathResolves(value: unknown, path: string): boolean {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length) return true;
  const [head, ...tail] = parts;
  if (head === "*")
    return (
      Array.isArray(value) &&
      value.every((item) => pathResolves(item, tail.join(".")))
    );
  if (value == null) return false;
  if (Array.isArray(value) && /^\d+$/.test(head))
    return (
      Number(head) < value.length &&
      pathResolves(value[Number(head)], tail.join("."))
    );
  return (
    isObject(value) &&
    Object.prototype.hasOwnProperty.call(value, head) &&
    pathResolves(value[head], tail.join("."))
  );
}

export function gradeJson(
  expected: Json,
  actual: Json | undefined,
  schema: object | undefined,
  rules: FieldRule[],
  crossFieldRules: CrossFieldRule[] = [],
): Grade {
  const failures: FieldFailure[] = [],
    count = { checks: 0, passed: 0 },
    parseSuccess = actual !== undefined;
  let schemaValid = parseSuccess;
  if (!parseSuccess)
    addFailure(
      failures,
      "$",
      "malformed-json",
      "Extraction response was not valid JSON.",
    );
  else if (schema) {
    try {
      const validate = compileSchema(schema);
      schemaValid = validate(actual);
      if (!schemaValid)
        for (const error of validate.errors ?? [])
          addFailure(
            failures,
            schemaErrorPath(error),
            "schema-failure",
            error.message ?? "Schema validation failed.",
          );
    } catch (error) {
      schemaValid = false;
      addFailure(
        failures,
        "$",
        "schema-failure",
        error instanceof Error
          ? error.message
          : "Schema could not be compiled.",
      );
    }
  }
  if (parseSuccess) {
    compareNode(
      expected,
      actual,
      "",
      rules.map((rule) => rule as AnyRule),
      failures,
      count,
    );
    for (const source of crossFieldRules) {
      const rule = source as AnyCrossRule;
      if (rule.type === "sum_equals") {
        const values = rule.fields.flatMap((path) => crossValues(actual, path)),
          totalValues = crossValues(actual, rule.total);
        const sum: number = values.reduce<number>(
            (running, value) =>
              running + (typeof value === "number" ? value : Number.NaN),
            0,
          ),
          total = totalValues.length === 1 ? totalValues[0] : undefined;
        count.checks += 1;
        const referencesResolve =
          rule.fields.every((path) => pathResolves(actual, path)) &&
          pathResolves(actual, rule.total);
        if (
          referencesResolve &&
          Number.isFinite(sum) &&
          typeof total === "number" &&
          Number.isFinite(total) &&
          Math.abs(sum - total) <= (rule.tolerance ?? 0.01)
        )
          count.passed += 1;
        else
          addFailure(
            failures,
            rule.total,
            "cross-field",
            `${rule.name}: values must sum to the total.`,
            total as Json,
          );
      } else if (rule.type === "equals") {
        const left = crossValues(actual, rule.left),
          right = crossValues(actual, rule.right);
        count.checks += 1;
        const equal =
          pathResolves(actual, rule.left) &&
          pathResolves(actual, rule.right) &&
          left.length === right.length &&
          left.length > 0 &&
          left.every(
            (value, index) =>
              value !== undefined &&
              right[index] !== undefined &&
              (typeof value === "number" &&
              typeof right[index] === "number" &&
              rule.tolerance !== undefined
                ? Math.abs(value - right[index]) <= rule.tolerance
                : equalValues(value, right[index])),
          );
        if (equal) count.passed += 1;
        else
          addFailure(
            failures,
            rule.left,
            "cross-field",
            `${rule.name}: values must be equal.`,
          );
      }
    }
  }
  const result: AnyGrade = {
    parseSuccess,
    schemaValid,
    fieldAccuracy: count.checks
      ? count.passed / count.checks
      : schemaValid
        ? 1
        : 0,
    passed: parseSuccess && schemaValid && failures.length === 0,
    failures,
    checks: count.checks,
    passedChecks: count.passed,
  };
  return result;
}

function editDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length];
}

export function gradeOcr(
  reference: string | undefined,
  actual: string | undefined,
) {
  if (reference == null || actual == null)
    return {
      graded: false,
      cer: null,
      wer: null,
      normalization: NORMALIZATION_VERSION,
    };
  const expected = reference.trim().replace(/\s+/g, " "),
    observed = actual.trim().replace(/\s+/g, " ");
  return {
    graded: true,
    cer:
      editDistance([...expected], [...observed]) /
      Math.max(1, [...expected].length),
    wer:
      editDistance(
        expected ? expected.split(" ") : [],
        observed ? observed.split(" ") : [],
      ) / Math.max(1, expected ? expected.split(" ").length : 0),
    normalization: NORMALIZATION_VERSION,
  };
}
