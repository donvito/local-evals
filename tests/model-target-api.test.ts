import { it, expect } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { DatabaseStore } from "../src/storage/db.js";

it("discovers models from a saved local target without exposing its credential", async () => {
  let authorization = "";
  const upstream = http.createServer((req, res) => {
    authorization = String(req.headers.authorization || "");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "local-vision-model",
            owned_by: "lmstudio",
            capabilities: {
              input_modalities: ["text", "image"],
              supported_parameters: ["tools", "response_format"],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstream.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-model-target-api-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget(
    {
      name: "lmstudio",
      model: "local-vision-model",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      provider: "openai-compatible",
    },
    "local-secret",
  );
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(url + "/api/models/target/lmstudio");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models[0]).toMatchObject({
      id: "local-vision-model",
      capabilitiesKnown: true,
      inputModalities: ["text", "image"],
    });
    expect(authorization).toBe("Bearer local-secret");
    expect(JSON.stringify(body)).not.toContain("local-secret");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("deletes a saved target over HTTP", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-target-delete-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget(
    { name: "remove-me", model: "m", baseUrl: "http://127.0.0.1:9/v1", provider: "openai-compatible" },
    "secret",
  );
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(url + "/api/targets/remove-me", { method: "DELETE" })).status).toBe(200);
    expect(await (await fetch(url + "/api/targets")).json()).toEqual([]);
    expect((await fetch(url + "/api/targets/remove-me", { method: "DELETE" })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
