import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelCatalog,
  fetchTargetModelCatalog,
  normalizeModels,
} from "../src/core/model-catalog.js";
import type { TargetConfig } from "../src/core/types.js";

afterEach(() => vi.useRealTimers());
const payload = {
  data: [
    {
      id: "example/model",
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      supported_parameters: ["tools", "structured_outputs"],
      context_length: 128000,
      pricing: { prompt: "0", completion: "0.000001" },
    },
  ],
};
describe("model catalog", () => {
  it("normalizes advertised capabilities without guessing missing ones", () => {
    expect(normalizeModels(payload)[0]).toMatchObject({
      inputModalities: ["text", "image"],
      supportedParameters: ["tools", "structured_outputs"],
      promptPrice: 0,
      completionPrice: 0.000001,
    });
    expect(normalizeModels({ data: [{ id: "unknown" }] })[0]).toMatchObject({
      inputModalities: [],
      supportedParameters: [],
      promptPrice: null,
      contextLength: null,
    });
    expect(
      normalizeModels({
        data: [{ id: "bad", pricing: { prompt: "-1", completion: "invalid" } }],
      })[0],
    ).toMatchObject({ promptPrice: null, completionPrice: null });
  });
  it("caches and coalesces requests without forwarding credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload)));
    const catalog = createModelCatalog(fetcher);
    const [one, two] = await Promise.all([catalog(), catalog()]);
    expect(one).toEqual(two);
    await catalog();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        headers: { accept: "application/json" },
        redirect: "error",
      }),
    ]);
  });
  it("returns stale metadata on refresh failure and a safe initial error", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
      .mockRejectedValue(new Error("sensitive transport details"));
    const catalog = createModelCatalog(fetcher);
    await catalog();
    vi.advanceTimersByTime(6 * 60_000);
    expect((await catalog()).stale).toBe(true);
    await expect(createModelCatalog(fetcher)()).rejects.toThrow(
      "enter a model ID manually",
    );
  });
  it("normalizes an authenticated local OpenAI-compatible catalog", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/models");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer local-secret",
      );
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen/qwen3-vl-4b",
              owned_by: "lmstudio",
              max_context_length: 32768,
              capabilities: {
                input_modalities: ["text", "image"],
                supported_parameters: ["tools"],
              },
            },
          ],
        }),
      );
    });
    const catalog = await fetchTargetModelCatalog(
      {
        name: "lmstudio",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "qwen/qwen3-vl-4b",
        apiKey: "local-secret",
        provider: "openai-compatible",
      } satisfies TargetConfig,
      fetcher,
    );
    expect(catalog.source).toBe("configured-endpoint");
    expect(catalog.models[0]).toMatchObject({
      id: "qwen/qwen3-vl-4b",
      contextLength: 32768,
      inputModalities: ["text", "image"],
      supportedParameters: ["tools"],
      capabilitiesKnown: true,
    });
    expect(JSON.stringify(catalog)).not.toContain("local-secret");
  });
});
