import { readFile } from "node:fs/promises";
import type { TargetConfig, ToolChoice, ToolDefinition } from "./types.js";
import { registerSecrets, sanitize } from "./security.js";
import AjvModule from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

export type ModelResponse = {
  text: string;
  /** Raw OpenAI-compatible message.tool_calls, including malformed arguments. */
  toolCalls?: unknown[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  raw: unknown;
};
export class ProviderError extends Error {
  constructor(
    message: string,
    public transient = false,
    public raw?: unknown,
  ) {
    super(message);
  }
}

export type ProviderTestResult = { ok: true; response: ModelResponse };
export class PreflightError extends ProviderError {
  constructor(message: string, public code: "truncated" | "incompatible") {
    super(message);
  }
}
export type ProviderRequestOptions = {
  imagePath?: string;
  outputMode?: "prompted-json" | "schema-constrained-json";
  signal?: AbortSignal;
  schema?: object;
  generation?: Record<string, unknown>;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
};
export type ProviderTestOptions = {
  vision?: boolean;
  schema?: object;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
};
export const PREFLIGHT_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;
const AjvCtor = ((AjvModule as any).default ?? AjvModule) as any;
const Ajv2020Ctor = ((Ajv2020Module as any).default ?? Ajv2020Module) as any;

function validateStructuredResponse(
  target: TargetConfig,
  schema: object,
  text: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PreflightError(
      `Target ${target.name} returned invalid JSON during structured-output preflight.`,
      "incompatible",
    );
  }
  try {
    const schemaId = (schema as { $schema?: unknown }).$schema;
    const validator = new (typeof schemaId === "string" &&
      schemaId.includes("2020-12")
      ? Ajv2020Ctor
      : AjvCtor)({ allErrors: true, strict: false }).compile(schema);
    if (!validator(parsed))
      throw new PreflightError(
        `Target ${target.name} did not honor the structured-output preflight schema: ${(validator.errors ?? []).map((error: any) => error.message).join("; ")}`,
        "incompatible",
      );
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `Structured-output preflight schema could not be applied for ${target.name}: ${String(error)}`,
    );
  }
}

// A 64×64 image avoids providers rejecting a one-pixel capability probe.
const PREFLIGHT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAkklEQVR4nO3QMQEAIACEQO0fWq/Hw8IM9+EM0wD9DeBZGqC/ATxLA/Q3gGdpgP4G8CwN0N8AnqUB+hvAszRAfwN4lgbobwDP0gD9DeBZGqC/ATxLA/Q3gGdpgP4G8CwN0N8AnqUB+hvAszRAfwN4lgbobwDP0gD9DeBZGqC/ATxLA/Q3gGdpgP4G8CwN0N8AnuUDskn/QYWtf4YAAAAASUVORK5CYII=";

export const TOOL_PREFLIGHT_PROBE: ToolDefinition = {
  type: "function",
  function: {
    name: "evalforge_probe",
    description: "EvalForge capability probe. Do not perform external work.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

function imageMime(path: string): string {
  return path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

function responseText(raw: any): string | undefined {
  const content = raw?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  // OpenAI tool calls conventionally set content to null. Treat that as an
  // empty text response instead of rejecting an otherwise valid call.
  if (content === null) return "";
  return undefined;
}

function usageFrom(raw: any): ModelResponse["usage"] {
  const usage = raw?.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
    costUsd: usage.cost_usd ?? usage.cost,
  };
}

function providerErrorDetail(raw: any): string | undefined {
  if (!raw || typeof raw !== "object" || !Object.hasOwn(raw, "error"))
    return undefined;
  const error = raw?.error;
  if (error == null) return undefined;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    for (const key of ["message", "detail", "code"]) {
      if (typeof error[key] === "string") return error[key];
    }
    return "unknown provider error";
  }
  return String(error);
}

function providerErrorMessage(
  target: TargetConfig,
  raw: any,
): string | undefined {
  const detail = providerErrorDetail(raw);
  if (!detail) return undefined;
  const safeDetail = sanitize(detail);
  const endpointHint =
    /unexpected endpoint|endpoint or method|\/chat\/completions/i.test(detail)
      ? " Check that the provider base URL includes /v1."
      : "";
  return `${target.name} returned a provider error: ${safeDetail}.${endpointHint}`;
}

async function postChat(
  target: TargetConfig,
  body: unknown,
  signal?: AbortSignal,
  preflightMaxTokens?: number,
): Promise<ModelResponse> {
  registerSecrets([target]);
  if (target.apiKeyEnv && !target.apiKey && !process.env[target.apiKeyEnv])
    throw new ProviderError(
      `Target ${target.name} requires environment variable ${target.apiKeyEnv}, but it is not set.`,
    );
  const endpoint = target.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (target.provider === "openrouter")
    headers["X-OpenRouter-Metadata"] = "enabled";
  const envKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
  const apiKey = target.apiKey ?? envKey;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted)
      throw new ProviderError(
        `${target.name}: ${signal.reason?.message ?? "Request cancelled."}`,
        false,
      );
    throw new ProviderError(
      `Transport error calling ${target.name}: ${String(error)}`,
      true,
    );
  }
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 4xx output/auth/schema errors are evaluation errors; only rate limits and
    // server/transport failures are safe to retry.
    const safeRaw = sanitize(raw);
    throw new ProviderError(
      `${target.name} returned ${response.status}: ${JSON.stringify(safeRaw).slice(0, 500)}`,
      response.status === 429 || [500, 502, 503, 504].includes(response.status),
      safeRaw,
    );
  }
  const providerError = providerErrorMessage(target, raw);
  if (providerError)
    throw new ProviderError(providerError, false, sanitize(raw));
  if (preflightMaxTokens !== undefined && raw?.choices?.[0]?.finish_reason === "length") {
    throw new PreflightError(
      `Preflight exhausted its ${preflightMaxTokens}-token output budget before completion. Reasoning may consume this budget; this does not establish provider incompatibility.`,
      "truncated",
    );
  }
  const text = responseText(raw);
  const message = raw?.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as unknown[])
    : undefined;
  if (typeof text !== "string" && !toolCalls) {
    const choices = Array.isArray(raw?.choices) ? raw.choices.length : 0;
    const finishReason =
      typeof raw?.choices?.[0]?.finish_reason === "string"
        ? raw.choices[0].finish_reason
        : "unknown";
    throw new ProviderError(
      `Target ${target.name} returned no text content or tool calls (choices=${choices}, finish_reason=${finishReason}). Check the provider response and that the base URL targets its OpenAI-compatible /v1 endpoint.`,
    );
  }
  return {
    text: text ?? "",
    ...(toolCalls ? { toolCalls } : {}),
    raw,
    usage: usageFrom(raw),
  };
}

export function providerRequestOptions(
  imagePathOrOptions?: string | ProviderRequestOptions,
  outputMode: "prompted-json" | "schema-constrained-json" = "prompted-json",
  signal?: AbortSignal,
  schema?: object,
  generation?: Record<string, unknown>,
  requestOptions?: ProviderRequestOptions,
): ProviderRequestOptions {
  if (imagePathOrOptions && typeof imagePathOrOptions === "object")
    return { ...imagePathOrOptions };
  return {
    ...(requestOptions ?? {}),
    imagePath: imagePathOrOptions,
    outputMode,
    signal,
    schema,
    generation,
  };
}

export async function callOpenAICompatible(
  target: TargetConfig,
  prompt: string,
  options?: ProviderRequestOptions,
): Promise<ModelResponse>;
export async function callOpenAICompatible(
  target: TargetConfig,
  prompt: string,
  imagePath?: string,
  outputMode?: "prompted-json" | "schema-constrained-json",
  signal?: AbortSignal,
  schema?: object,
  generation?: Record<string, unknown>,
  requestOptions?: ProviderRequestOptions,
): Promise<ModelResponse>;
export async function callOpenAICompatible(
  target: TargetConfig,
  prompt: string,
  imagePathOrOptions?: string | ProviderRequestOptions,
  outputMode: "prompted-json" | "schema-constrained-json" = "prompted-json",
  signal?: AbortSignal,
  schema?: object,
  generation?: Record<string, unknown>,
  requestOptions?: ProviderRequestOptions,
): Promise<ModelResponse> {
  const options = providerRequestOptions(
    imagePathOrOptions,
    outputMode,
    signal,
    schema,
    generation,
    requestOptions,
  );
  const requestImagePath = options.imagePath;
  const requestOutputMode = options.outputMode ?? "prompted-json";
  const userContent: any[] = [{ type: "text", text: prompt }];
  if (requestImagePath)
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${imageMime(requestImagePath)};base64,${(await readFile(requestImagePath)).toString("base64")}`,
      },
    });
  const allowedGeneration = [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "n",
  ];
  const normalizedGeneration = { ...(options.generation ?? {}) };
  if (
    normalizedGeneration.maxTokens != null &&
    normalizedGeneration.max_tokens == null &&
    normalizedGeneration.max_completion_tokens == null
  ) {
    normalizedGeneration.max_tokens = normalizedGeneration.maxTokens;
  }
  delete normalizedGeneration.maxTokens;
  const safeGeneration = Object.fromEntries(
    Object.entries(normalizedGeneration).filter(([key]) =>
      allowedGeneration.includes(key),
    ),
  );
  const body: any = {
    model: target.model,
    messages: [{ role: "user", content: userContent }],
    ...safeGeneration,
  };
  const usesTools =
    options.tools !== undefined || options.toolChoice !== undefined;
  if (usesTools && target.supportsTools === false)
    throw new ProviderError(
      `Target ${target.name} does not advertise tool-calling support.`,
    );
  if (options.tools?.length) body.tools = options.tools;
  if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  if (options.tools?.length && target.provider === "openrouter")
    body.provider = { ...(body.provider ?? {}), require_parameters: true };
  if (requestOutputMode === "schema-constrained-json" && !usesTools) {
    if (!target.supportsStructuredOutput)
      throw new ProviderError(
        `Target ${target.name} does not advertise schema-constrained JSON support.`,
      );
    if (!options.schema)
      throw new ProviderError(
        "Schema-constrained mode requires an extraction schema.",
      );
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "evalforge_extraction",
        strict: true,
        schema: options.schema,
      },
    };
    if (target.provider === "openrouter")
      body.provider = { ...(body.provider ?? {}), require_parameters: true };
  }
  return postChat(target, body, options.signal);
}

/** Performs a real, minimal multimodal request so an advertised vision target
 * is checked before an evaluation starts. */
export async function testTarget(
  target: TargetConfig,
  options: ProviderTestOptions = {},
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  const vision = options.vision ?? false;
  if (vision && target.supportsVision === false)
    throw new ProviderError(
      `Target ${target.name} does not support image input.`,
    );
  const usesTools =
    options.tools !== undefined || options.toolChoice !== undefined;
  if (usesTools && target.supportsTools === false)
    throw new ProviderError(
      `Target ${target.name} does not advertise tool-calling support.`,
    );
  if (options.schema && !usesTools && !target.supportsStructuredOutput)
    throw new ProviderError(
      `Target ${target.name} does not advertise schema-constrained JSON support.`,
    );
  const content: any[] = [
    {
      type: "text",
      text: options.schema
        ? `Reply only with a JSON value matching this schema:\n${JSON.stringify(options.schema)}`
        : usesTools
          ? `Call the ${options.tools?.[0]?.function.name ?? "supplied"} function exactly once with an empty JSON object. Do not answer with text.`
          : "Reply with OK.",
    },
  ];
  if (vision)
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PREFLIGHT_PNG}` },
    });
  const body: any = {
    model: target.model,
    max_tokens: options.maxTokens ?? 512,
    messages: [{ role: "user", content }],
  };
  if (options.tools?.length) body.tools = options.tools;
  if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  if (options.tools?.length && target.provider === "openrouter")
    body.provider = { ...(body.provider ?? {}), require_parameters: true };
  if (options.schema && !usesTools) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "evalforge_preflight",
        strict: true,
        schema: options.schema,
      },
    };
    if (target.provider === "openrouter")
      body.provider = { require_parameters: true };
  }
  const response = await postChat(target, body, signal, body.max_tokens);
  if (options.schema && !usesTools) {
    validateStructuredResponse(target, options.schema, response.text);
  }
  return { ok: true, response };
}

/**
 * Perform a safe tool-capability probe using a no-argument local function.
 * The function is never executed; only the provider's returned call envelope
 * is checked. Runtime evaluation tools are intentionally not sent here.
 */
export async function testToolCallingTarget(
  target: TargetConfig,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  const result = await testTarget(
    target,
    {
      tools: [TOOL_PREFLIGHT_PROBE],
      toolChoice: "required",
      maxTokens: 512,
    },
    signal,
  );
  const calls = result.response.toolCalls ?? [];
  if (calls.length !== 1) {
    throw new ProviderError(
      `Target ${target.name} did not return the required tool preflight call.`,
    );
  }
  const call = calls[0] as any;
  const fn = call && typeof call.function === "object" ? call.function : call;
  if (!fn || fn.name !== TOOL_PREFLIGHT_PROBE.function.name)
    throw new ProviderError(
      `Target ${target.name} returned the wrong tool during preflight.`,
    );
  let args: unknown;
  try {
    args =
      typeof fn.arguments === "string"
        ? JSON.parse(fn.arguments)
        : fn.arguments;
  } catch {
    throw new ProviderError(
      `Target ${target.name} returned malformed tool arguments during preflight.`,
    );
  }
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).length !== 0
  )
    throw new ProviderError(
      `Target ${target.name} returned invalid tool arguments during preflight.`,
    );
  return result;
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (
        !(error instanceof ProviderError) ||
        !error.transient ||
        i === attempts - 1
      )
        throw error;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw last;
}

export async function discoverTargetMetadata(
  target: TargetConfig,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const unknown: Record<string, unknown> = {
    model: target.model,
    server: "unknown",
    quantization: "unknown",
    routing: "unknown",
  };
  if (!target.provider) return { ...unknown, ...target.metadata };
  const headers: Record<string, string> = {};
  if (target.apiKeyEnv || target.apiKey) {
    const key = target.apiKey ?? process.env[target.apiKeyEnv!];
    if (!key) return { ...unknown, ...target.metadata };
    headers.authorization = "Bearer " + key;
  }
  const get = async (url: string) => {
    try {
      const response = await fetch(url, {
        headers,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
          : AbortSignal.timeout(3000),
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const models = await get(target.baseUrl.replace(/\/$/, "") + "/models");
  const loaded =
    models?.data?.find((m: any) => m.id === target.model) ??
    (target.provider === "llama.cpp" ? models?.data?.[0] : undefined);
  if (loaded) unknown.modelMetadata = loaded;
  if (target.provider === "llama.cpp") {
    const props = await get(
      target.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/props",
    );
    if (props) {
      unknown.server = props.build_info ?? props.build ?? "unknown";
      unknown.serverMetadata = props;
      unknown.quantization =
        props.quantization ?? loaded?.meta?.quantization ?? "unknown";
    }
  }
  return sanitize({ ...unknown, ...target.metadata });
}
