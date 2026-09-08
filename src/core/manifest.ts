import { readFile, realpath, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatasetManifest } from "./types.js";
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function stable(value: any): string {
  return JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
export async function loadManifest(
  file: string,
  options: { allowMissingExpected?: boolean } = {},
): Promise<DatasetManifest> {
  const raw = await readFile(file, "utf8");
  const parsed = file.endsWith(".jsonl")
    ? raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : JSON.parse(raw);
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases) || cases.length === 0)
    throw new Error("Manifest must contain a non-empty cases array.");
  const ids = new Set<string>();
  const base = await realpath(path.dirname(path.resolve(file)));
  for (const item of cases) {
    item.caseId ??= item.id;
    if (
      typeof item.caseId !== "string" ||
      !item.caseId.trim() ||
      typeof item.imagePath !== "string" ||
      (!options.allowMissingExpected && item.expected === undefined)
    )
      throw new Error(
        "Each case needs caseId, relative imagePath, and expected JSON.",
      );
    if (ids.has(item.caseId))
      throw new Error(`Duplicate caseId: ${item.caseId}`);
    ids.add(item.caseId);
    if (path.isAbsolute(item.imagePath))
      throw new Error(
        "Image paths must be relative to the manifest directory.",
      );
    const resolved = await realpath(path.resolve(base, item.imagePath));
    if (!resolved.startsWith(base + path.sep))
      throw new Error("Image path escapes dataset directory.");
    const bytes = await readFile(resolved);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (
      (png && path.extname(resolved).toLowerCase() !== ".png") ||
      (jpeg && !/\.jpe?g$/i.test(resolved))
    )
      throw new Error("Image extension does not match its file contents.");
    if ((!png && !jpeg) || !/\.(png|jpe?g)$/i.test(resolved))
      throw new Error(
        `Case ${item.caseId}: only PNG/JPEG images are supported.`,
      );
    if (
      item.referenceTranscription !== undefined &&
      typeof item.referenceTranscription !== "string"
    )
      throw new Error("referenceTranscription must be a string.");
    item.originalImagePath = item.imagePath;
    item.imagePath = resolved;
    item.imageHash = hash(bytes);
  }
  return {
    name: parsed.name ?? parsed.version ?? path.basename(file),
    version: hash(stable(cases.map(({ imagePath, ...rest }: any) => rest))),
    cases,
  };
}
export async function importManifest(
  file: string,
  assetRoot: string,
  options: { allowMissingExpected?: boolean } = {},
): Promise<DatasetManifest> {
  const manifest = await loadManifest(file, options);
  await mkdir(assetRoot, { recursive: true });
  for (const item of manifest.cases) {
    const destination = path.join(
      assetRoot,
      item.imageHash + path.extname(item.imagePath).toLowerCase(),
    );
    await copyFile(item.imagePath, destination);
    item.imagePath = destination;
  }
  return manifest;
}
