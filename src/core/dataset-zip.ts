import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importManifest } from "./manifest.js";
import type { DatasetManifest, TaskKind } from "./types.js";
import { DATASET_ZIP_AGENTS, DATASET_ZIP_README } from "./dataset-zip-docs.js";
import { readZip, writeZip, type ZipEntry } from "./zip.js";

export const MAX_DATASET_ZIP_BYTES = 512 * 1024 ** 2;
const MANIFEST_NAMES = ["manifest.jsonl", "manifest.json"];

function entryPath(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.includes("..") ||
    !segments.length
  )
    throw new Error(`Unsafe path in ZIP: ${name}`);
  return segments.join("/");
}

const ignoredEntry = (file: string) =>
  file.startsWith("__MACOSX/") ||
  file.split("/").some((segment) => segment === ".DS_Store" || segment.startsWith("._"));

export function findZipManifest(files: string[]): string {
  const topLevel = [...new Set(files.map((file) => file.split("/")[0]))];
  const wrapped = files.every((file) => file.includes("/")) && topLevel.length === 1;
  const prefix = wrapped ? `${topLevel[0]}/` : "";
  const level = files
    .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"))
    .map((file) => file.slice(prefix.length));
  const named = MANIFEST_NAMES.find((name) => level.some((file) => file.toLowerCase() === name));
  if (named) return prefix + level.find((file) => file.toLowerCase() === named)!;
  const candidates = level.filter((file) => /\.jsonl?$/i.test(file));
  if (candidates.length === 1) return prefix + candidates[0];
  if (candidates.length)
    throw new Error(
      `Found several possible manifests (${candidates.join(", ")}). Name the dataset file manifest.jsonl or manifest.json.`,
    );
  const shown = [...new Set(files.map((file) => file.replace(/\/.*$/, "/")))];
  throw new Error(
    `No manifest found. Put manifest.jsonl or manifest.json at the top level of the ZIP. Found: ${
      shown.slice(0, 8).join(", ") + (shown.length > 8 ? ", …" : "")
    }`,
  );
}

/**
 * Extracts a dataset ZIP into a private temporary folder, imports its manifest
 * with the normal validation (images must stay inside the extracted folder),
 * and removes the folder again. `name` replaces a filename-derived dataset name.
 */
export async function importDatasetZip(
  zip: Buffer,
  assetRoot: string,
  options: { allowMissingExpected?: boolean; taskKind?: TaskKind; name?: string } = {},
): Promise<DatasetManifest> {
  if (zip.length > MAX_DATASET_ZIP_BYTES)
    throw new Error(`The ZIP is larger than ${MAX_DATASET_ZIP_BYTES / 1024 ** 2} MB.`);
  const entries = readZip(zip)
    .map((entry) => ({ ...entry, name: entryPath(entry.name) }))
    .filter((entry) => !ignoredEntry(entry.name));
  if (!entries.length) throw new Error("The ZIP contains no files.");
  const manifestPath = findZipManifest(entries.map((entry) => entry.name));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "localevals-zip-")));
  try {
    for (const entry of entries) {
      const file = path.join(root, entry.name);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(file, entry.data, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`The ZIP contains ${entry.name} more than once.`);
        throw error;
      }
    }
    const manifest = await importManifest(path.join(root, manifestPath), assetRoot, options);
    if (options.name && manifest.name === path.basename(manifestPath)) manifest.name = options.name;
    return manifest;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).path;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missing?.startsWith(root + path.sep))
      throw new Error(
        `${path.relative(root, missing).split(path.sep).join("/")} is referenced by the manifest but missing from the ZIP.`,
      );
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Builds the downloadable example ZIP from the Document → JSON sample. */
export async function exampleDatasetZip(sampleRoot: string): Promise<Buffer> {
  const manifest = await readFile(path.join(sampleRoot, "manifest.jsonl"));
  const images = [
    ...new Set(
      manifest
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line).imagePath as string)
        .filter(Boolean),
    ),
  ];
  const entries: ZipEntry[] = [
    { name: "README.md", data: Buffer.from(DATASET_ZIP_README, "utf8") },
    { name: "AGENTS.md", data: Buffer.from(DATASET_ZIP_AGENTS, "utf8") },
    { name: "manifest.jsonl", data: manifest },
  ];
  for (const image of images)
    entries.push({ name: entryPath(image), data: await readFile(path.join(sampleRoot, image)) });
  return writeZip(entries);
}
