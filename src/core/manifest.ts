import { readFile, realpath, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatasetManifest, DatasetCase, TaskKind } from "./types.js";

export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export function stable(value: any): string {
  const serialized = JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  return serialized ?? "undefined";
}

const TASK_KINDS: readonly TaskKind[] = [
  "document-json",
  "text-json",
  "tool-calling",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskKindFor(
  manifest: any,
  cases: Array<Record<string, any>>,
  requested?: TaskKind,
): TaskKind {
  const declared = manifest.taskKind ?? requested;
  if (declared !== undefined && !TASK_KINDS.includes(declared))
    throw new Error(
      "Invalid taskKind; choose document-json, text-json, or tool-calling.",
    );
  // Input-only manifests are native text datasets unless they explicitly
  // declare tool-calling. A legacy image manifest remains document-json.
  return (
    declared ??
    (cases.some((item) => item.inputText !== undefined)
      ? "text-json"
      : "document-json")
  );
}

function validateToolExpected(value: unknown, caseId: string): void {
  if (!Array.isArray(value))
    throw new Error(`Case ${caseId}: tool-calling expected must be an array.`);
  for (const [index, call] of value.entries()) {
    if (
      !isPlainObject(call) ||
      typeof call.name !== "string" ||
      !call.name.trim() ||
      !isPlainObject(call.arguments)
    )
      throw new Error(
        `Case ${caseId}: expected tool call ${index} needs name and object arguments.`,
      );
  }
}

/**
 * Serialize the user-facing dataset records as JSONL. Stored image paths are
 * intentionally represented by their original relative path when available;
 * internal copied asset paths and image hashes are implementation details.
 */
export function datasetJsonl(manifest: DatasetManifest): string {
  return (
    manifest.cases
      .map((item) => {
        const record: Record<string, unknown> = { caseId: item.caseId };
        const imagePath = item.originalImagePath ?? item.imagePath;
        if (imagePath) record.imagePath = imagePath;
        if (item.inputText !== undefined) record.inputText = item.inputText;
        if (item.expected !== undefined) record.expected = item.expected;
        if (item.referenceTranscription !== undefined)
          record.referenceTranscription = item.referenceTranscription;
        if (item.metadata !== undefined) record.metadata = item.metadata;
        return JSON.stringify(record);
      })
      .join("\n") + (manifest.cases.length ? "\n" : "")
  );
}

/** Normalize and validate a model-produced text/tool dataset before storage. */
export function generatedManifest(
  value: unknown,
  options: { taskKind: "text-json" | "tool-calling"; name: string },
): DatasetManifest {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.cases) ||
    !value.cases.length
  )
    throw new Error("The provider must return a non-empty cases array.");
  const ids = new Set<string>();
  const cases = value.cases.map((raw, index) => {
    if (!isPlainObject(raw))
      throw new Error(`Generated case ${index + 1} is not an object.`);
    const caseId = raw.caseId;
    if (typeof caseId !== "string" || !caseId.trim())
      throw new Error(`Generated case ${index + 1} needs a caseId.`);
    if (ids.has(caseId))
      throw new Error(`Duplicate generated caseId: ${caseId}`);
    ids.add(caseId);
    if (typeof raw.inputText !== "string" || !raw.inputText.trim())
      throw new Error(`Generated case ${caseId} needs non-empty inputText.`);
    if (!Object.hasOwn(raw, "expected"))
      throw new Error(`Generated case ${caseId} needs expected output JSON.`);
    if (options.taskKind === "tool-calling")
      validateToolExpected(raw.expected, caseId);
    if (
      raw.metadata !== undefined &&
      (!isPlainObject(raw.metadata) ||
        Object.values(raw.metadata).some((item) => item === undefined))
    )
      throw new Error(`Generated case ${caseId} metadata must be an object.`);
    return {
      caseId,
      inputText: raw.inputText,
      expected: raw.expected,
      ...(typeof raw.referenceTranscription === "string"
        ? { referenceTranscription: raw.referenceTranscription }
        : {}),
      ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
    } as DatasetCase;
  });
  return {
    name: options.name,
    version: hash(stable({ taskKind: options.taskKind, cases })),
    taskKind: options.taskKind,
    cases,
  };
}

async function resolveImage(
  base: string,
  item: Record<string, any>,
): Promise<void> {
  if (item.imagePath === undefined) return;
  if (typeof item.imagePath !== "string" || !item.imagePath.trim())
    throw new Error(`Case ${item.caseId}: imagePath must be a relative path.`);
  if (path.isAbsolute(item.imagePath))
    throw new Error("Image paths must be relative to the manifest directory.");
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
    throw new Error(`Case ${item.caseId}: only PNG/JPEG images are supported.`);
  item.originalImagePath = item.imagePath;
  item.imagePath = resolved;
  item.imageHash = hash(bytes);
}

export async function loadManifest(
  file: string,
  options: { allowMissingExpected?: boolean; taskKind?: TaskKind } = {},
): Promise<DatasetManifest> {
  const raw = await readFile(file, "utf8");
  const parsed: any = file.endsWith(".jsonl")
    ? raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : JSON.parse(raw);
  const cases = (Array.isArray(parsed) ? parsed : parsed.cases) as Array<
    Record<string, any>
  >;
  if (!Array.isArray(cases) || cases.length === 0)
    throw new Error("Manifest must contain a non-empty cases array.");
  const taskKind = taskKindFor(
    Array.isArray(parsed) ? {} : parsed,
    cases,
    options.taskKind,
  );
  const ids = new Set<string>();
  const base = await realpath(path.dirname(path.resolve(file)));
  for (const item of cases) {
    item.caseId ??= item.id;
    if (
      typeof item.caseId !== "string" ||
      !item.caseId.trim() ||
      (!options.allowMissingExpected && item.expected === undefined)
    )
      throw new Error(
        "Each case needs caseId and expected JSON unless inference-only mode is enabled.",
      );
    if (ids.has(item.caseId))
      throw new Error(`Duplicate caseId: ${item.caseId}`);
    ids.add(item.caseId);
    if (item.inputText !== undefined && typeof item.inputText !== "string")
      throw new Error(`Case ${item.caseId}: inputText must be a string.`);
    if (
      item.referenceTranscription !== undefined &&
      typeof item.referenceTranscription !== "string"
    )
      throw new Error("referenceTranscription must be a string.");
    if (taskKind === "document-json" && item.imagePath === undefined)
      throw new Error(`Case ${item.caseId}: document-json requires imagePath.`);
    if (
      (taskKind === "text-json" || taskKind === "tool-calling") &&
      typeof item.inputText !== "string"
    )
      throw new Error(`Case ${item.caseId}: ${taskKind} requires inputText.`);
    if (taskKind === "tool-calling" && item.expected !== undefined)
      validateToolExpected(item.expected, item.caseId);
    await resolveImage(base, item);
  }
  const versionCases = cases.map(({ imagePath, ...rest }) => rest);
  const versionInput =
    taskKind === "document-json"
      ? versionCases
      : { taskKind, cases: versionCases };
  return {
    name:
      (Array.isArray(parsed) ? undefined : parsed.name) ??
      (Array.isArray(parsed) ? undefined : parsed.version) ??
      path.basename(file),
    version: hash(stable(versionInput)),
    taskKind,
    cases: cases as DatasetCase[],
  };
}

export async function importManifest(
  file: string,
  assetRoot: string,
  options: { allowMissingExpected?: boolean; taskKind?: TaskKind } = {},
): Promise<DatasetManifest> {
  const manifest = await loadManifest(file, options);
  await mkdir(assetRoot, { recursive: true });
  for (const item of manifest.cases) {
    if (!item.imagePath) continue;
    const destination = path.join(
      assetRoot,
      (item.imageHash ?? hash(item.imagePath)) +
        path.extname(item.imagePath).toLowerCase(),
    );
    await copyFile(item.imagePath, destination);
    item.imagePath = destination;
  }
  return manifest;
}
