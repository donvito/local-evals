import type { TargetConfig } from "./types.js";

export type CatalogModel = {
  id: string;
  name: string;
  description?: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  /** Local servers often omit capability metadata from /models. */
  capabilitiesKnown?: boolean;
};
export type Catalog = {
  models: CatalogModel[];
  cachedAt: string;
  stale?: boolean;
  source?: "openrouter" | "configured-endpoint";
};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
const nonnegative = (value: unknown): number | null => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === "" ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
export function normalizeModels(payload: any): CatalogModel[] {
  if (!Array.isArray(payload?.data))
    throw new Error("Model catalog returned an invalid response.");
  return payload.data
    .filter((m: any) => m && typeof m.id === "string" && m.id.length > 0)
    .map((m: any) => {
      const architecture = m.architecture ?? {};
      const capabilities = m.capabilities ?? m.metadata?.capabilities ?? {};
      const inputModalities =
        strings(architecture.input_modalities).length > 0
          ? strings(architecture.input_modalities)
          : strings(m.input_modalities ?? capabilities.input_modalities);
      const outputModalities =
        strings(architecture.output_modalities).length > 0
          ? strings(architecture.output_modalities)
          : strings(m.output_modalities ?? capabilities.output_modalities);
      const supportedParameters =
        strings(m.supported_parameters).length > 0
          ? strings(m.supported_parameters)
          : strings(capabilities.supported_parameters);
      const capabilitiesKnown = Boolean(
        inputModalities.length ||
        outputModalities.length ||
        supportedParameters.length ||
        Object.hasOwn(m, "capabilities") ||
        Object.hasOwn(m, "supported_parameters") ||
        Object.hasOwn(architecture, "input_modalities"),
      );
      return {
        id: m.id,
        name: typeof m.name === "string" ? m.name : m.id,
        description:
          typeof m.description === "string"
            ? m.description
            : typeof m.owned_by === "string"
              ? `Owned by ${m.owned_by}`
              : undefined,
        inputModalities,
        outputModalities,
        supportedParameters,
        contextLength: nonnegative(
          m.context_length ?? m.max_context_length ?? m.contextLength,
        ),
        promptPrice: nonnegative(m.pricing?.prompt),
        completionPrice: nonnegative(m.pricing?.completion),
        capabilitiesKnown,
      };
    });
}

/** Fetch model metadata from a saved OpenAI-compatible target. */
export async function fetchTargetModelCatalog(
  target: TargetConfig,
  fetcher: typeof fetch = fetch,
): Promise<Catalog> {
  const key =
    target.apiKey ??
    (target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined);
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  let response: Response;
  try {
    response = await fetcher(target.baseUrl.replace(/\/$/, "") + "/models", {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      `Could not reach ${target.name}'s model list. Check that the provider is running and its Base URL is correct.`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Configured model endpoint returned HTTP ${response.status}.`,
    );
  const models = normalizeModels(await response.json());
  if (!models.length)
    throw new Error("Configured model endpoint returned no models.");
  return {
    models,
    cachedAt: new Date().toISOString(),
    source: "configured-endpoint",
  };
}

/** Public metadata only: never forwards saved credentials or document content. */
export function createModelCatalog(fetcher: typeof fetch = fetch) {
  let cache: Catalog | undefined;
  let pending: Promise<Catalog> | undefined;
  return async (): Promise<Catalog> => {
    if (cache && Date.now() - Date.parse(cache.cachedAt) < 5 * 60_000)
      return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetcher("https://openrouter.ai/api/v1/models", {
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
          headers: { accept: "application/json" },
        });
        if (!response.ok)
          throw new Error(`Model catalog returned HTTP ${response.status}.`);
        const models = normalizeModels(await response.json());
        if (!models.length)
          throw new Error("Model catalog returned no models.");
        cache = {
          models,
          cachedAt: new Date().toISOString(),
          source: "openrouter",
        };
        return cache;
      } catch {
        if (cache) return { ...cache, stale: true };
        throw new Error(
          "Could not load OpenRouter models. Try again or enter a model ID manually.",
        );
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
