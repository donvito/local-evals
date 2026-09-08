import { expect, it } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  copyFile,
  rm,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadManifest, importManifest, hash } from "../src/core/manifest.js";
it("imports PNG bytes, hashes content, rejects duplicates and path escapes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evalforge-manifest-"));
  try {
    const image = await readFile("sample-data/assets/northstar-invoice.png");
    await mkdir(path.join(dir, "input"));
    await writeFile(path.join(dir, "input", "invoice.png"), image);
    const file = path.join(dir, "input", "cases.jsonl"),
      row = {
        caseId: "a",
        imagePath: "invoice.png",
        expected: { total: 104.5 },
        referenceTranscription: "Total: 104.50",
      };
    await writeFile(file, JSON.stringify(row) + "\n");
    const imported = await importManifest(file, path.join(dir, "assets"));
    expect(imported.cases[0].imageHash).toBe(hash(image));
    expect(await readFile(imported.cases[0].imagePath)).toEqual(image);
    expect((await loadManifest(file)).version).toBe(imported.version);
    await writeFile(file, JSON.stringify(row) + "\n" + JSON.stringify(row));
    await expect(loadManifest(file)).rejects.toThrow(/Duplicate/);
    await writeFile(path.join(dir, "outside.png"), image);
    await writeFile(
      file,
      JSON.stringify({ ...row, imagePath: "../outside.png" }),
    );
    await expect(loadManifest(file)).rejects.toThrow(/escapes/);
    await writeFile(path.join(dir, "input", "fake.png"), "not an image");
    await writeFile(file, JSON.stringify({ ...row, imagePath: "fake.png" }));
    await expect(loadManifest(file)).rejects.toThrow(/PNG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
