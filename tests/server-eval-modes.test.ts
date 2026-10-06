import { it, expect } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { DatabaseStore } from "../src/storage/db.js";

it("exposes fixed synthetic example settings without modifying saved setup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-examples-api-"));
  const server = await startServer(path.join(dir, "app.db"), 0, process.cwd());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const kind of ["document-json", "text-json", "tool-calling"]) {
      const response = await fetch(`${url}/api/examples/${kind}`);
      expect(response.status).toBe(200);
      const config = await response.json();
      expect(config.taskKind).toBe(kind);
      expect(config.stagePrompts.extraction).toBeTruthy();
      if (kind === "tool-calling")
        expect(config.tools.length).toBeGreaterThan(0);
      else expect(config.schema).toBeTruthy();
    }
    expect((await fetch(`${url}/api/examples/unknown`)).status).toBe(404);
    expect(
      (await (await fetch(`${url}/api/setup`)).json()).config,
    ).toBeUndefined();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("saves native text/tool setups without OCR and rejects invalid replacements", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-mode-api-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  const target = {
    name: "local",
    model: "model",
    baseUrl: "http://127.0.0.1:1234/v1",
    supportsTools: true,
  };
  db.saveTarget(target);
  db.saveDataset({
    name: "Text",
    version: "text-v1",
    taskKind: "text-json",
    cases: [{ caseId: "a", inputText: "name: Ada", expected: { name: "Ada" } }],
  });
  db.saveDataset({
    name: "Tools",
    version: "tools-v1",
    taskKind: "tool-calling",
    cases: [{ caseId: "a", inputText: "Hello", expected: [] }],
  });
  db.close();
  const base = {
    taskKind: "text-json",
    datasetVersion: "text-v1",
    schemaVersion: "s",
    extractionTarget: target,
    stagePrompts: { ocr: "", extraction: "Extract JSON" },
    outputMode: "prompted-json",
    fieldRules: [],
    schema: { type: "object" },
  };
  const configPath = path.join(dir, "dashboard-config.json");
  await writeFile(configPath, JSON.stringify(base));
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (data: unknown) =>
    fetch(url + "/api/setup/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    await writeFile(path.join(dir, "unlabeled.json"), JSON.stringify({ taskKind: "text-json", cases: [{ caseId: "unlabeled", inputText: "Extract this later" }] }));
    const imported = await fetch(url + "/api/datasets/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "unlabeled.json" }) });
    expect(imported.status).toBe(200);
    expect((await imported.json()).cases[0].expected).toBeUndefined();
    const input = {
      ...base,
      extractionTarget: "local",
      extractionSource: "ocr",
    };
    const result = await post(input);
    expect(result.status).toBe(200);
    expect((await result.json()).config.taskKind).toBe("text-json");
    const image = await fetch(url + "/api/datasets/text-v1/cases/a/image");
    expect(image.status).toBe(404);
    expect((await image.json()).error).toBe("This case has no image");
    const before = await readFile(configPath, "utf8");
    expect((await post({ ...input, taskKind: "tool-calling" })).status).toBe(
      400,
    );
    expect(await readFile(configPath, "utf8")).toBe(before);
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ];
    const toolResult = await post({
      ...input,
      datasetVersion: "tools-v1",
      taskKind: "tool-calling",
      tools,
    });
    expect(toolResult.status).toBe(200);
    expect((await toolResult.json()).config.tools).toEqual(tools);
    const valid = await readFile(configPath, "utf8");
    expect(
      (await post({ ...input, schema: { type: "not-a-schema-type" } })).status,
    ).toBe(400);
    expect(await readFile(configPath, "utf8")).toBe(valid);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("respects fixture ownership, explicit detachment, and inherited tool semantics", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-config-ownership-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  const target = {
    name: "local",
    model: "model",
    baseUrl: "http://127.0.0.1:1234/v1",
    supportsTools: true,
  };
  db.saveTarget(target);
  db.saveDataset({
    name: "Tools",
    version: "tools",
    taskKind: "tool-calling",
    cases: [{ caseId: "a", inputText: "Hello", expected: [] }],
  });
  db.close();
  const tools = [
    {
      type: "function",
      function: { name: "lookup", parameters: { type: "object" } },
    },
  ];
  const base = {
    taskKind: "tool-calling",
    datasetVersion: "tools",
    schemaVersion: "s",
    extractionTarget: target,
    stagePrompts: { extraction: "Fixture A" },
    outputMode: "prompted-json",
    fieldRules: [],
    tools,
    toolChoice: "required",
    toolCallOrder: "unordered",
  };
  await writeFile(path.join(dir, "a.json"), JSON.stringify(base));
  await writeFile(
    path.join(dir, "b.json"),
    JSON.stringify({ ...base, stagePrompts: { extraction: "Fixture B" } }),
  );
  await writeFile(
    path.join(dir, "dashboard-config.json"),
    JSON.stringify(base),
  );
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (data: unknown) =>
    fetch(url + "/api/setup/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const input = {
    taskKind: "tool-calling",
    extractionTarget: "local",
    extractionSource: "reference",
    outputMode: "prompted-json",
  };
  try {
    for (const [file, prompt] of [
      ["a.json", "Fixture A"],
      ["b.json", "Fixture B"],
    ]) {
      const response = await post({
        ...input,
        baseConfigPath: file,
        stagePrompts: { extraction: "Stale editor" },
        tools: [],
      });
      expect(response.status).toBe(200);
      expect((await response.json()).config).toMatchObject({
        stagePrompts: { extraction: prompt },
        toolChoice: "required",
        toolCallOrder: "unordered",
        tools,
      });
    }
    const detached = await post({
      ...input,
      baseConfigPath: "",
      stagePrompts: { extraction: "Native editor" },
      tools,
    });
    expect(detached.status).toBe(200);
    const summary = (await detached.json()).config;
    expect(summary.baseConfigPath).toBeUndefined();
    expect(summary.stagePrompts.extraction).toBe("Native editor");
    const before = await readFile(
      path.join(dir, "dashboard-config.json"),
      "utf8",
    );
    const mismatch = await post({ ...input, taskKind: "text-json" });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toMatch(/does not match/);
    expect(
      await readFile(path.join(dir, "dashboard-config.json"), "utf8"),
    ).toBe(before);
    expect(
      (await (await fetch(url + "/api/setup")).json()).config.baseConfigPath,
    ).toBeUndefined();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("previews a configuration file and saves app settings as a new, credential-free file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-config-file-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget({ name: "local", model: "model", baseUrl: "http://127.0.0.1:1234/v1" }, "secret-key");
  db.saveDataset({
    name: "Text",
    version: "text-v1",
    taskKind: "text-json",
    cases: [{ caseId: "a", inputText: "name: Ada", expected: { name: "Ada" } }],
  });
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const save = (data: unknown) =>
    fetch(url + "/api/config-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const setup = {
    taskKind: "text-json",
    datasetVersion: "text-v1",
    extractionTarget: "local",
    extractionSource: "reference",
    outputMode: "prompted-json",
    schema: { type: "object", properties: { name: { type: "string" } } },
    stagePrompts: { extraction: "Return the name as JSON." },
    fieldRules: [],
  };
  try {
    const created = await save({ path: "configs/names.json", setup });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ path: path.join("configs", "names.json") });
    const written = await readFile(path.join(dir, "configs", "names.json"), "utf8");
    expect(written).not.toContain("secret-key");
    expect(written).not.toContain("baseConfigPath");
    expect(JSON.parse(written).stagePrompts.extraction).toBe("Return the name as JSON.");

    const preview = await fetch(url + "/api/config-file?path=configs/names.json");
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body.summary.stagePrompts.extraction).toBe("Return the name as JSON.");
    expect(body.content.extractionTarget).toMatchObject({ name: "local", model: "model" });
    expect(JSON.stringify(body)).not.toContain("secret-key");

    const again = await save({ path: "configs/names.json", setup });
    expect(again.status).toBe(409);
    expect((await again.json()).exists).toBe(true);
    expect((await save({ path: "configs/names.json", setup, overwrite: true })).status).toBe(200);

    expect((await save({ path: "../outside.json", setup })).status).toBe(400);
    expect((await save({ path: "configs/names.txt", setup })).status).toBe(400);
    expect((await fetch(url + "/api/config-file?path=missing.json")).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects saving settings whose schema is not a valid JSON Schema", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-schema-check-"));
  const dbPath = path.join(dir, "app.db");
  const db = new DatabaseStore(dbPath);
  db.saveTarget({ name: "local", model: "model", baseUrl: "http://127.0.0.1:1234/v1" });
  db.saveDataset({
    name: "Text",
    version: "text-v1",
    taskKind: "text-json",
    cases: [{ caseId: "a", inputText: "name: Ada", expected: { name: "Ada" } }],
  });
  db.close();
  const server = await startServer(dbPath, 0, dir);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const setup = {
    taskKind: "text-json",
    datasetVersion: "text-v1",
    extractionTarget: "local",
    extractionSource: "reference",
    outputMode: "prompted-json",
    schema: { type: "object", properties: { name: { type: "text" } } },
    stagePrompts: { extraction: "Return the name." },
    fieldRules: [],
  };
  try {
    for (const [route, body] of [
      ["/api/setup/config", setup],
      ["/api/config-file", { path: "configs/bad.json", setup }],
    ] as const) {
      const response = await fetch(url + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/^The schema isn't valid at \/properties\/name\/type: /);
    }
    await expect(readFile(path.join(dir, "configs", "bad.json"))).rejects.toThrow();
    await expect(readdir(path.join(dir, "configs"))).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
