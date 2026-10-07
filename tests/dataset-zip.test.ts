import { describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, readZip, writeZip } from "../src/core/zip.js";
import {
  exampleDatasetZip,
  findZipManifest,
  importDatasetZip,
} from "../src/core/dataset-zip.js";
import { startServer } from "../src/server.js";

const image = await readFile("sample-data/assets/invoice-001.png");
const line = (row: Record<string, unknown>) => JSON.stringify(row) + "\n";

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "localevals-zip-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("zip reader/writer", () => {
  it("round-trips stored and deflated entries", () => {
    const text = Buffer.from("hello ".repeat(500));
    const entries = readZip(writeZip([
      { name: "a.txt", data: text },
      { name: "dir/image.png", data: image },
      { name: "empty", data: Buffer.alloc(0) },
    ]));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "dir/image.png", "empty"]);
    expect(entries[0].data.equals(text)).toBe(true);
    expect(entries[1].data.equals(image)).toBe(true);
    expect(entries[2].data.length).toBe(0);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("rejects corrupt, encrypted, symlinked, and oversized archives", () => {
    const zip = writeZip([{ name: "a.txt", data: Buffer.from("x".repeat(100)) }]);
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(/Not a valid ZIP/);
    const corrupt = Buffer.from(zip);
    corrupt[40] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow(/Not a valid ZIP/);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    expect(() => readZip(encrypted)).toThrow(/Encrypted/);
    const symlink = Buffer.from(zip);
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    expect(() => readZip(symlink)).toThrow(/Symlinks/);
    expect(() => readZip(zip, { maxEntries: 10, maxTotalBytes: 50 })).toThrow(/expands/);
    expect(() => readZip(zip, { maxEntries: 0, maxTotalBytes: 1e9 })).toThrow(/entries/);
  });
});

describe("findZipManifest", () => {
  it("finds the manifest at the top level or inside one folder", () => {
    expect(findZipManifest(["manifest.jsonl", "assets/a.png", "notes.json"])).toBe("manifest.jsonl");
    expect(findZipManifest(["data/manifest.json", "data/assets/a.png"])).toBe("data/manifest.json");
    expect(findZipManifest(["inference.jsonl", "assets/a.png", "README.md"])).toBe("inference.jsonl");
    expect(() => findZipManifest(["a.jsonl", "b.json"])).toThrow(/several possible manifests/);
    expect(() => findZipManifest(["photos/a.png", "notes.txt"])).toThrow(
      /No manifest found.*Found: photos\/, notes\.txt/,
    );
  });
});

describe("importDatasetZip", () => {
  it("imports the downloadable example with its docs", () =>
    withDir(async (dir) => {
      const zip = await exampleDatasetZip("sample-data");
      const names = readZip(zip).map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(["README.md", "AGENTS.md", "manifest.jsonl", "assets/invoice-001.png"]));
      const dataset = await importDatasetZip(zip, path.join(dir, "assets"), {
        allowMissingExpected: true,
        name: "example",
      });
      expect(dataset.name).toBe("example");
      expect(dataset.cases).toHaveLength(3);
      expect(dataset.cases[0].imagePath.startsWith(path.join(dir, "assets"))).toBe(true);
      expect(await readFile(dataset.cases[0].imagePath)).toBeTruthy();
    }));

  it("handles a wrapping folder, ignores macOS clutter, and keeps manifest names", () =>
    withDir(async (dir) => {
      const zip = writeZip([
        { name: "receipts/manifest.json", data: Buffer.from(JSON.stringify({ name: "Named", cases: [{ caseId: "a", imagePath: "img/a.png" }] })) },
        { name: "receipts/img/a.png", data: image },
        { name: "__MACOSX/receipts/._a.png", data: Buffer.from("junk") },
        { name: "receipts/.DS_Store", data: Buffer.from("junk") },
      ]);
      const dataset = await importDatasetZip(zip, path.join(dir, "assets"), { allowMissingExpected: true, name: "zip-name" });
      expect(dataset.name).toBe("Named");
      expect(dataset.cases[0].caseId).toBe("a");
    }));

  it("explains missing images, unsafe paths, and duplicates", () =>
    withDir(async (dir) => {
      const assets = path.join(dir, "assets");
      const options = { allowMissingExpected: true };
      await expect(
        importDatasetZip(writeZip([{ name: "manifest.jsonl", data: Buffer.from(line({ caseId: "a", imagePath: "assets/missing.png" })) }]), assets, options),
      ).rejects.toThrow("assets/missing.png is referenced by the manifest but missing from the ZIP.");
      await expect(
        importDatasetZip(writeZip([{ name: "../evil.jsonl", data: Buffer.from("{}") }]), assets, options),
      ).rejects.toThrow(/Unsafe path/);
      await expect(
        importDatasetZip(writeZip([
          { name: "manifest.jsonl", data: Buffer.from(line({ caseId: "a", imagePath: "a.png" })) },
          { name: "a.png", data: image },
          { name: "./a.png", data: image },
        ]), assets, options),
      ).rejects.toThrow(/more than once/);
      await expect(
        importDatasetZip(writeZip([
          { name: "manifest.jsonl", data: Buffer.from(line({ caseId: "a", imagePath: "../outside.png" })) },
        ]), assets, options),
      ).rejects.toThrow(/escapes/);
    }));
});

describe("dataset ZIP endpoints", () => {
  it("serves the example, imports uploads and project ZIP paths, and caps type", () =>
    withDir(async (dir) => {
      await cp("sample-data/manifest.jsonl", path.join(dir, "sample-data/manifest.jsonl"));
      await cp("sample-data/assets", path.join(dir, "sample-data/assets"), { recursive: true });
      const server = await startServer(path.join(dir, "app.db"), 0, dir);
      const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
      try {
        const example = await fetch(url + "/api/datasets/example.zip");
        expect(example.status).toBe(200);
        expect(example.headers.get("content-type")).toBe("application/zip");
        const zip = Buffer.from(await example.arrayBuffer());

        const upload = await fetch(url + "/api/datasets/import-zip?name=my-receipts.zip", {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: zip,
        });
        expect(upload.status).toBe(200);
        const uploaded = await upload.json();
        expect(uploaded.name).toBe("my-receipts");
        expect(uploaded.cases).toHaveLength(3);

        const wrongType = await fetch(url + "/api/datasets/import-zip", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "x",
        });
        expect(wrongType.status).toBe(400);

        await writeFile(path.join(dir, "bundle.zip"), zip);
        const byPath = await fetch(url + "/api/datasets/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "bundle.zip" }),
        });
        expect(byPath.status).toBe(200);
        expect((await byPath.json()).name).toBe("bundle");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }));
});
