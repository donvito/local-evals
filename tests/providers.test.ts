import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  callOpenAICompatible,
  ProviderError,
  testToolCallingTarget,
  TOOL_PREFLIGHT_PROBE,
  testTarget,
} from "../src/core/providers.js";

const target = {
  name: "mock",
  baseUrl: "http://mock.local/v1",
  model: "vision",
  supportsVision: true,
  supportsStructuredOutput: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider", () => {
  it("sends image bytes, generation settings, and schema constraints", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("vision");
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(99);
      expect(body.messages[0].content[1].image_url.url).toMatch(
        /^data:image\/png;base64,/,
      );
      expect(body.response_format.json_schema.strict).toBe(true);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const path = "/private/tmp/evalforge-provider-test.png";
    await writeFile(path, Buffer.from([137, 80, 78, 71]));
    const response = await callOpenAICompatible(
      target,
      "extract",
      path,
      "schema-constrained-json",
      undefined,
      { type: "object" },
      { temperature: 0, maxTokens: 99 },
    );
    expect(response.text).toBe('{"ok":true}');
    expect(response.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      costUsd: undefined,
    });
  });

  it("rejects schema mode without silently falling back", async () => {
    await expect(
      callOpenAICompatible(
        { ...target, supportsStructuredOutput: false },
        "extract",
        undefined,
        "schema-constrained-json",
        undefined,
        { type: "object" },
      ),
    ).rejects.toThrow(ProviderError);
  });

  it("uses a 64-pixel vision probe instead of a rejected one-pixel image", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content[1].image_url.url).toContain(
        "data:image/png;base64",
      );
      const png = Buffer.from(
        body.messages[0].content[1].image_url.url.split(",")[1],
        "base64",
      );
      expect(png.readUInt32BE(16)).toBe(64);
      expect(png.readUInt32BE(20)).toBe(64);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(testTarget(target, { vision: true })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects structured preflight output with wrong types or extra properties", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"ok":"wrong","extra":1}' } }],
            }),
            { status: 200 },
          ),
      ),
    );
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    await expect(testTarget(target, { schema })).rejects.toThrow(
      /did not honor/,
    );
  });

  it("reports provider error envelopes returned with HTTP 2xx and hints at /v1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "Unexpected endpoint or method. (POST /chat/completions)",
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      callOpenAICompatible(
        { ...target, baseUrl: "http://mock.local" },
        "extract",
      ),
    ).rejects.toThrow(/provider error.*\/v1/i);
  });

  it("uses a reasoning-safe token budget and validates the tool preflight call", async () => {
    let request: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        request = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      type: "function",
                      function: {
                        name: "evalforge_probe",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    await expect(testToolCallingTarget(target)).resolves.toMatchObject({
      ok: true,
    });
    expect(request.max_tokens).toBe(512);
    expect(request.messages[0].content).toContainEqual({
      type: "text",
      text: expect.stringContaining("evalforge_probe"),
    });
    expect(request.messages[0].content[0].text).toMatch(/exactly once/i);
    expect(request.tools).toEqual([TOOL_PREFLIGHT_PROBE]);
  });

  it("retries rate limits but never retries authentication errors or leaks secrets", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3)
        return new Response(JSON.stringify({ error: "busy" }), { status: 429 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { withRetries } = await import("../src/core/providers.js");
    await expect(
      withRetries(() => callOpenAICompatible(target, "x")),
    ).resolves.toMatchObject({ text: "ok" });
    expect(calls).toBe(3);

    const secret = "sentinel-provider-secret";
    process.env.PROVIDER_TEST_SECRET = secret;
    const authMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: secret }), { status: 401 }),
    );
    vi.stubGlobal("fetch", authMock);
    await expect(
      callOpenAICompatible(
        { ...target, apiKeyEnv: "PROVIDER_TEST_SECRET" },
        "x",
      ),
    ).rejects.toThrow("[REDACTED]");
    expect(authMock).toHaveBeenCalledTimes(1);
    delete process.env.PROVIDER_TEST_SECRET;
  });
});
