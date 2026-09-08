import { it, expect } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { DatabaseStore } from "../src/storage/db.js";

it("generates a dataset through a configured provider and exposes canonical JSONL", async () => {
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    expect(request.model).toBe("mock-model");
    expect(request.response_format).toBeUndefined();
    const output = {
      cases: [
        {
          caseId: "generated-001",
          inputText: "Name: Ada",
          expected: { name: "Ada" },
        },
      ],
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const providerPort = (provider.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-generation-api-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget({
    name: "mock-provider",
    model: "mock-model",
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    provider: "openai-compatible",
    supportsStructuredOutput: false,
  });
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(url + "/api/datasets/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetName: "mock-provider",
        taskKind: "text-json",
        name: "Generated text fixture",
        caseCount: 1,
        brief: "Extract names.",
      }),
    });
    expect(response.status).toBe(200);
    const dataset = await response.json();
    expect(dataset).toMatchObject({
      name: "Generated text fixture",
      taskKind: "text-json",
    });
    expect(dataset.cases).toHaveLength(1);
    const listed = await (await fetch(url + "/api/datasets")).json();
    expect(listed.some((item: any) => item.version === dataset.version)).toBe(
      true,
    );

    const raw = await fetch(
      url + `/api/datasets/${encodeURIComponent(dataset.version)}/jsonl`,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("application/jsonl");
    expect(await raw.text()).toContain('"caseId":"generated-001"');
    expect(
      (await fetch(url + "/api/datasets/does-not-exist/jsonl")).status,
    ).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
