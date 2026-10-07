import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseStore, normalizeBaseUrl } from "../src/storage/db.js";
import { startServer } from "../src/server.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
const model = (name: string, baseUrl = OPENROUTER) => ({ name, model: `vendor/${name}`, baseUrl, provider: "openrouter" });

async function withDb<T>(run: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "localevals-provider-keys-"));
  try {
    return await run(path.join(dir, "app.db"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("provider keys", () => {
  it("normalizes server URLs", () => {
    expect(normalizeBaseUrl("https://OpenRouter.ai/api/v1/ ")).toBe(OPENROUTER);
    expect(normalizeBaseUrl("http://127.0.0.1:1234/v1//")).toBe("http://127.0.0.1:1234/v1");
  });

  it("shares one saved key across models on the same server, with per-model overrides", () =>
    withDb(async (file) => {
      const db = new DatabaseStore(file);
      try {
        db.saveProviderKey(`${OPENROUTER}/`, "sk-or-shared");
        db.saveTarget(model("a"));
        db.saveTarget(model("b", `${OPENROUTER}/`));
        db.saveTarget(model("local", "http://127.0.0.1:1234/v1"));
        db.saveTarget(model("own"), "sk-or-own");
        const byName = Object.fromEntries(db.listTargets().map((target) => [target.name, target]));
        expect(byName.a).toMatchObject({ hasApiKey: true, keySource: "provider" });
        expect(byName.b).toMatchObject({ hasApiKey: true, keySource: "provider" });
        expect(byName.local.hasApiKey).toBeUndefined();
        expect(byName.own).toMatchObject({ hasApiKey: true, keySource: "model" });
        expect(db.getTarget("a", true).apiKey).toBe("sk-or-shared");
        expect(db.getTarget("own", true).apiKey).toBe("sk-or-own");
        expect(db.getTarget("a").apiKey).toBeUndefined();
        expect(JSON.stringify(db.db.prepare("SELECT * FROM provider_keys").all())).not.toContain("sk-or-shared");

        db.saveTarget({ ...db.getTarget("a"), model: "vendor/a-2" });
        expect(db.db.prepare("SELECT config_json FROM targets WHERE name='a'").get()).not.toMatchObject({
          config_json: expect.stringContaining("keySource"),
        });

        expect(db.deleteProviderKey(OPENROUTER)).toBe(true);
        expect(db.getTarget("a").hasApiKey).toBeUndefined();
        expect(db.getTarget("own", true).apiKey).toBe("sk-or-own");
        expect(db.deleteProviderKey(OPENROUTER)).toBe(false);
      } finally {
        db.close();
      }
    }));

  it("moves existing per-model keys into shared provider keys once", () =>
    withDb(async (file) => {
      const db = new DatabaseStore(file);
      db.saveTarget(model("a"), "sk-or-first");
      db.saveTarget(model("b"), "sk-or-first");
      db.saveTarget(model("c"), "sk-or-different");
      db.saveTarget(model("openai", "https://api.openai.com/v1"), "sk-openai");
      db.saveTarget(model("plain", "http://127.0.0.1:1234/v1"));
      db.db.exec("DROP TABLE provider_keys; DELETE FROM schema_migrations WHERE version = 8;");
      db.close();

      const upgraded = new DatabaseStore(file);
      try {
        const byName = Object.fromEntries(upgraded.listTargets().map((target) => [target.name, target]));
        expect(byName.a.keySource).toBe("provider");
        expect(byName.b.keySource).toBe("provider");
        expect(byName.c.keySource).toBe("model");
        expect(byName.openai.keySource).toBe("provider");
        expect(byName.plain.hasApiKey).toBeUndefined();
        expect(upgraded.getTarget("b", true).apiKey).toBe("sk-or-first");
        expect(upgraded.getTarget("c", true).apiKey).toBe("sk-or-different");
        expect(upgraded.getTarget("openai", true).apiKey).toBe("sk-openai");
        expect(upgraded.listProviderKeys().map((entry) => entry.baseUrl)).toEqual([
          "https://api.openai.com/v1",
          OPENROUTER,
        ]);
        const stored = upgraded.db.prepare("SELECT config_json FROM targets WHERE name='a'").get() as { config_json: string };
        expect(JSON.parse(stored.config_json).apiKeyEncrypted).toBeUndefined();
      } finally {
        upgraded.close();
      }
    }));

  it("saves a key once over HTTP and reuses it for later models", () =>
    withDb(async (file, dir) => {
      const server = await startServer(file, 0, dir);
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const put = (pathname: string, payload: unknown) =>
        fetch(url + pathname, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).then(async (response) => ({ status: response.status, body: await response.json() }));
      try {
        const first = await put("/api/targets/first", { ...model("first"), apiKey: "sk-or-once" });
        expect(first.body).toMatchObject({ hasApiKey: true, keySource: "provider" });
        const second = await put("/api/targets/second", model("second"));
        expect(second.body).toMatchObject({ hasApiKey: true, keySource: "provider" });

        const keys = await (await fetch(url + "/api/provider-keys")).json();
        expect(keys).toEqual([{ baseUrl: OPENROUTER, updatedAt: expect.any(String), models: ["first", "second"] }]);
        expect(JSON.stringify(keys)).not.toContain("sk-or-once");

        const override = await put("/api/targets/second", { ...model("second"), apiKey: "sk-or-other", keyScope: "model" });
        expect(override.body.keySource).toBe("model");
        const back = await put("/api/targets/second", { ...model("second"), apiKey: "", clearApiKey: true });
        expect(back.body.keySource).toBe("provider");

        expect((await put("/api/provider-keys", { baseUrl: OPENROUTER, apiKey: "sk-or-rotated" })).status).toBe(200);
        const removed = await fetch(`${url}/api/provider-keys?baseUrl=${encodeURIComponent(OPENROUTER)}`, { method: "DELETE" });
        expect(removed.status).toBe(200);
        expect((await (await fetch(url + "/api/targets")).json()).every((target: any) => !target.hasApiKey)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }));
});
