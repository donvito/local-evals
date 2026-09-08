import { compileSchema } from "./grading.js";
import type {
  FieldFailure,
  Grade,
  Json,
  ToolCallExpectation,
  ToolCallOrder,
  ToolDefinition,
} from "./types.js";

export type ToolGrade = Grade & {
  actualToolCalls: unknown[];
  expectedToolCalls: ToolCallExpectation[];
  toolCallOrder: ToolCallOrder;
};

type ObservedCall = {
  index: number;
  raw: unknown;
  name?: string;
  rawArguments?: unknown;
  parsedArguments?: Record<string, Json>;
};

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJson(value: unknown): Json | undefined {
  // Provider responses are JSON values. The cast intentionally keeps the
  // original malformed argument string/object intact in a failure record.
  return value === undefined ? undefined : (value as Json);
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  if (typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left as object);
    const rightKeys = Object.keys(right as object);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right as object, key) &&
          equalJson(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return false;
}

function expectedCalls(value: unknown): ToolCallExpectation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(
      (call) =>
        isObject(call) &&
        typeof call.name === "string" &&
        isObject(call.arguments),
    )
  )
    return undefined;
  return value as ToolCallExpectation[];
}

function actualCalls(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    if (Array.isArray(value.toolCalls)) return value.toolCalls;
    if (Array.isArray(value.tool_calls)) return value.tool_calls;
    const message = value.choices?.[0]?.message;
    if (Array.isArray(message?.tool_calls)) return message.tool_calls;
  }
  return null;
}

function parseObserved(raw: unknown, index: number): ObservedCall {
  const call = isObject(raw) ? raw : {};
  const fn = isObject(call.function) ? call.function : call;
  const name = typeof fn.name === "string" ? fn.name : undefined;
  const rawArguments = Object.hasOwn(fn, "arguments")
    ? fn.arguments
    : undefined;
  const observed: ObservedCall = { index, raw, name, rawArguments };
  if (isObject(rawArguments)) {
    observed.parsedArguments = rawArguments as Record<string, Json>;
  } else if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments);
      if (isObject(parsed))
        observed.parsedArguments = parsed as Record<string, Json>;
    } catch {
      // Keep rawArguments for deterministic malformed-argument diagnostics.
    }
  }
  return observed;
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
    ...(expected !== undefined ? { expected: asJson(expected) } : {}),
    ...(actual !== undefined ? { actual: asJson(actual) } : {}),
  });
}

/**
 * Grade a single-turn OpenAI-compatible tool response without executing a
 * tool. Names, count, arguments, call order, and each configured parameters
 * schema are checked deterministically. The raw call array is returned in the
 * grade so malformed argument strings remain inspectable.
 */
export function gradeToolCalls(
  expected: unknown,
  actual: unknown,
  tools: ToolDefinition[] = [],
  order: ToolCallOrder = "ordered",
): ToolGrade {
  const failures: FieldFailure[] = [];
  const count = { checks: 0, passed: 0 };
  const expectedList = expectedCalls(expected) ?? [];
  const expectedIsValid = expectedCalls(expected) !== undefined;
  if (!expectedIsValid)
    addFailure(
      failures,
      "$.expected",
      "invalid-expected-tools",
      "Expected tool calls must be an array of name/arguments objects.",
      expected,
    );

  const rawList = actualCalls(actual);
  let parseSuccess = rawList !== null;
  const rawCalls = rawList ?? [];
  if (!parseSuccess)
    addFailure(
      failures,
      "$.tool_calls",
      "invalid-tool-calls",
      "Provider tool_calls must be an array.",
      undefined,
      actual,
    );
  const observed = rawCalls.map(parseObserved);
  const definitions = new Map(tools.map((tool) => [tool.function.name, tool]));

  count.checks += 1;
  if (observed.length === expectedList.length) count.passed += 1;
  else
    addFailure(
      failures,
      "$.tool_calls",
      "tool-count",
      `Expected ${expectedList.length} tool call(s), received ${observed.length}.`,
      expectedList.length as unknown as Json,
      observed.length as unknown as Json,
    );

  const compareArguments = (
    expectedCall: ToolCallExpectation,
    observedCall: ObservedCall,
    expectedIndex: number,
  ) => {
    const path = `$[${observedCall.index}].arguments`;
    count.checks += 1;
    if (observedCall.parsedArguments !== undefined) {
      if (equalJson(expectedCall.arguments, observedCall.parsedArguments))
        count.passed += 1;
      else
        addFailure(
          failures,
          path,
          "tool-arguments",
          "Tool arguments do not match the expected arguments.",
          expectedCall.arguments,
          observedCall.parsedArguments,
        );
    } else {
      parseSuccess &&
        addFailure(
          failures,
          path,
          "malformed-arguments",
          "Tool arguments were not a valid JSON object.",
          expectedCall.arguments,
          observedCall.rawArguments ?? observedCall.raw,
        );
    }
    // Keep the parameter for an explicit call-site index in stack traces and
    // future diagnostics without changing the public failure shape.
    void expectedIndex;
  };

  if (order === "ordered") {
    for (
      let index = 0;
      index < Math.max(expectedList.length, observed.length);
      index += 1
    ) {
      const expectedCall = expectedList[index];
      const observedCall = observed[index];
      if (!expectedCall || !observedCall) {
        if (observedCall && !expectedCall)
          addFailure(
            failures,
            `$[${observedCall.index}].name`,
            "extra-tool-call",
            "Provider returned an unexpected extra tool call.",
            undefined,
            observedCall.raw,
          );
        continue;
      }
      count.checks += 1;
      if (observedCall.name === expectedCall.name) count.passed += 1;
      else
        addFailure(
          failures,
          `$[${observedCall.index}].name`,
          "tool-name",
          "Tool name does not match the expected call.",
          expectedCall.name,
          observedCall.name ?? observedCall.raw,
        );
      compareArguments(expectedCall, observedCall, index);
    }
  } else {
    const unmatched = new Set(observed.map((_, index) => index));
    for (const [expectedIndex, expectedCall] of expectedList.entries()) {
      // Prefer an exact name+arguments match so repeated calls to the same
      // tool remain order-independent. Fall back to same-name matching to
      // produce a useful arguments failure when no exact call exists.
      const exact = [...unmatched].find(
        (index) =>
          observed[index].name === expectedCall.name &&
          observed[index].parsedArguments !== undefined &&
          equalJson(expectedCall.arguments, observed[index].parsedArguments),
      );
      const matched =
        exact ??
        [...unmatched].find(
          (index) => observed[index].name === expectedCall.name,
        );
      if (matched === undefined) {
        addFailure(
          failures,
          `$[${expectedIndex}].name`,
          "tool-name",
          "Expected tool name was not returned.",
          expectedCall.name,
        );
        continue;
      }
      unmatched.delete(matched);
      count.checks += 1;
      count.passed += 1;
      compareArguments(expectedCall, observed[matched], expectedIndex);
    }
    for (const index of unmatched)
      addFailure(
        failures,
        `$[${observed[index].index}].name`,
        "extra-tool-call",
        "Provider returned an unexpected extra tool call.",
        undefined,
        observed[index].raw,
      );
  }

  let schemaValid = parseSuccess && expectedIsValid;
  for (const call of observed) {
    if (!call.name) {
      schemaValid = false;
      addFailure(
        failures,
        `$[${call.index}].name`,
        "malformed-tool-call",
        "Tool call is missing a function name.",
        undefined,
        call.raw,
      );
      continue;
    }
    const definition = definitions.get(call.name);
    if (!definition) {
      schemaValid = false;
      addFailure(
        failures,
        `$[${call.index}].name`,
        "unknown-tool",
        `Tool ${call.name} is not configured.`,
        undefined,
        call.name,
      );
      continue;
    }
    if (call.parsedArguments === undefined) {
      schemaValid = false;
      continue;
    }
    count.checks += 1;
    try {
      const validator = compileSchema(definition.function.parameters);
      if (validator(call.parsedArguments)) count.passed += 1;
      else {
        schemaValid = false;
        addFailure(
          failures,
          `$[${call.index}].arguments`,
          "tool-schema",
          `Arguments do not satisfy ${call.name}'s parameters schema: ${(
            validator.errors ?? []
          )
            .map((error: any) => error.message)
            .join("; ")}`,
          undefined,
          call.parsedArguments,
        );
      }
    } catch (error) {
      schemaValid = false;
      addFailure(
        failures,
        `$[${call.index}].arguments`,
        "tool-schema",
        `Tool ${call.name}'s parameters schema could not be applied: ${String(error)}`,
        undefined,
        call.parsedArguments,
      );
    }
  }

  // Parsing a malformed argument is a response failure even when expected is
  // empty or the name itself is wrong; retain the raw value above and expose
  // the state through parseSuccess/schemaValid.
  for (const call of observed)
    if (call.parsedArguments === undefined) {
      schemaValid = false;
      parseSuccess = false;
      if (typeof call.rawArguments === "string") {
        // compareArguments adds the expected-context failure for matched calls;
        // this adds one for unmatched/extra calls as well.
        if (
          !failures.some(
            (failure) => failure.path === `$[${call.index}].arguments`,
          )
        )
          addFailure(
            failures,
            `$[${call.index}].arguments`,
            "malformed-arguments",
            "Tool arguments were not a valid JSON object.",
            undefined,
            call.rawArguments,
          );
      } else if (
        !failures.some(
          (failure) => failure.path === `$[${call.index}].arguments`,
        )
      )
        addFailure(
          failures,
          `$[${call.index}].arguments`,
          "malformed-arguments",
          "Tool arguments were not a valid JSON object.",
          undefined,
          call.rawArguments,
        );
    }

  const result: ToolGrade = {
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
    actualToolCalls: rawCalls,
    expectedToolCalls: expectedList,
    toolCallOrder: order,
  };
  return result;
}
