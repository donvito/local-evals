import { readFile } from "node:fs/promises";
import type { TargetConfig } from "./types.js";
import { registerSecrets, sanitize } from "./security.js";
import AjvModule from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

export type ModelResponse = {
  text: string;
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
export type ProviderTestOptions = { vision?: boolean; schema?: object };
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
    throw new ProviderError(
      `Target ${target.name} returned invalid JSON during structured-output preflight.`,
    );
  }
  try {
    const schemaId = (schema as { $schema?: unknown }).$schema;
    const validator = new (typeof schemaId === "string" &&
      schemaId.includes("2020-12")
      ? Ajv2020Ctor
      : AjvCtor)({ allErrors: true, strict: false }).compile(schema);
    if (!validator(parsed))
      throw new ProviderError(
        `Target ${target.name} did not honor the structured-output preflight schema: ${(validator.errors ?? []).map((error: any) => error.message).join("; ")}`,
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

async function postChat(
  target: TargetConfig,
  body: unknown,
  signal?: AbortSignal,
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
  const text = responseText(raw);
  if (typeof text !== "string")
    throw new ProviderError(`Target ${target.name} returned no text content.`);
  return { text, raw, usage: usageFrom(raw) };
}

export async function callOpenAICompatible(
  target: TargetConfig,
  prompt: string,
  imagePath?: string,
  outputMode: "prompted-json" | "schema-constrained-json" = "prompted-json",
  signal?: AbortSignal,
  schema?: object,
  generation?: Record<string, unknown>,
): Promise<ModelResponse> {
  const userContent: any[] = [{ type: "text", text: prompt }];
  if (imagePath)
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${imageMime(imagePath)};base64,${(await readFile(imagePath)).toString("base64")}`,
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
  const normalizedGeneration = { ...(generation ?? {}) };
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
  if (outputMode === "schema-constrained-json") {
    if (!target.supportsStructuredOutput)
      throw new ProviderError(
        `Target ${target.name} does not advertise schema-constrained JSON support.`,
      );
    if (!schema)
      throw new ProviderError(
        "Schema-constrained mode requires an extraction schema.",
      );
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "evalforge_extraction", strict: true, schema },
    };
    if (target.provider === "openrouter")
      body.provider = { ...(body.provider ?? {}), require_parameters: true };
  }
  return postChat(target, body, signal);
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
  if (options.schema && !target.supportsStructuredOutput)
    throw new ProviderError(
      `Target ${target.name} does not advertise schema-constrained JSON support.`,
    );
  const content: any[] = [
    {
      type: "text",
      text: options.schema
        ? "Reply with a JSON object matching the supplied schema."
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
    max_tokens: 8,
    messages: [{ role: "user", content }],
  };
  if (options.schema) {
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
  const response = await postChat(target, body, signal);
  if (options.schema) {
    validateStructuredResponse(target, options.schema, response.text);
  }
  return { ok: true, response };
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
