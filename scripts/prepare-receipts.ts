import { createHash, randomInt } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadManifest } from "../src/core/manifest.js";

const datasetRoot = path.resolve(process.cwd(), "datasets/receipts");
const assetsRoot = path.join(datasetRoot, "assets");
const inventoryPath = path.join(datasetRoot, "inventory.json");
const imageExtensions = new Set([".png", ".jpg", ".jpeg"]);
const usage =
  "Usage: npm run receipts:prepare -- <image-or-folder>... [--sample N] [--seed S]";

type ReceiptGroup = {
  extension: "png" | "jpeg";
  hash: string;
  byteSize: number;
  sourcePaths: string[];
  sourceExtensions: string[];
  sourceCount: number;
};

async function imageFiles(input: string): Promise<string[]> {
  if ((await stat(input)).isFile()) {
    if (!imageExtensions.has(path.extname(input).toLowerCase()))
      throw new Error(`Not a PNG/JPEG file: ${input}`);
    return [input];
  }
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (
        entry.isFile() &&
        imageExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        result.push(filePath);
      }
    }
  }
  await visit(input);
  return result;
}

async function loadInventory(): Promise<Map<string, ReceiptGroup>> {
  try {
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    const root: string | undefined = inventory.sourceRoot;
    return new Map(
      (inventory.uniqueImages as ReceiptGroup[]).map((group) => [
        group.hash,
        {
          ...group,
          sourcePaths: group.sourcePaths.map((sourcePath) =>
            root ? path.resolve(root, sourcePath) : sourcePath,
          ),
        },
      ]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return new Map();
  }
}

function sample<T>(items: T[], count: number, seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count);
}

function integerOption(
  name: string,
  value: string | undefined,
  min: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min)
    throw new Error(`--${name} must be an integer >= ${min}. ${usage}`);
  return parsed;
}

async function writeAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, filePath);
}

async function copyIfSafe(
  sourcePath: string,
  destinationPath: string,
  bytes: Buffer,
): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath, 0x1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(destinationPath);
    if (!existing.equals(bytes)) {
      throw new Error(
        `Refusing to overwrite non-matching asset: ${destinationPath}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { sample: { type: "string" }, seed: { type: "string" } },
  });
  if (!positionals.length) throw new Error(usage);
  const sampleSize = integerOption("sample", values.sample, 1);
  const seed = integerOption("seed", values.seed, 0) ?? randomInt(2 ** 32);

  const files = [
    ...new Set(
      (
        await Promise.all(
          positionals.map((input) => imageFiles(path.resolve(input))),
        )
      ).flat(),
    ),
  ];
  const found = new Map<string, ReceiptGroup>();
  for (const filePath of files) {
    const bytes = await readFile(filePath);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new Error(`Invalid PNG/JPEG: ${filePath}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const group = found.get(hash);
    if (group) {
      group.sourcePaths.push(filePath);
    } else {
      found.set(hash, {
        extension: png ? "png" : "jpeg",
        hash,
        byteSize: bytes.byteLength,
        sourcePaths: [filePath],
        sourceExtensions: [],
        sourceCount: 0,
      });
    }
  }

  const groups = await loadInventory();
  const fresh = [...found.values()]
    .filter((group) => !groups.has(group.hash))
    .sort((left, right) => left.hash.localeCompare(right.hash));
  const added =
    sampleSize === undefined ? fresh : sample(fresh, sampleSize, seed);
  if (sampleSize === undefined) {
    for (const group of found.values()) {
      const existing = groups.get(group.hash);
      if (existing)
        existing.sourcePaths = [
          ...new Set([...existing.sourcePaths, ...group.sourcePaths]),
        ];
    }
  }
  await mkdir(assetsRoot, { recursive: true });
  for (const group of added) {
    groups.set(group.hash, group);
    await copyIfSafe(
      group.sourcePaths[0],
      path.join(assetsRoot, `${group.hash}.${group.extension}`),
      await readFile(group.sourcePaths[0]),
    );
  }

  const unique = [...groups.values()]
    .map((group) => ({
      ...group,
      sourceExtensions: group.sourcePaths.map((sourcePath) =>
        path.extname(sourcePath).toLowerCase().slice(1),
      ),
      sourceCount: group.sourcePaths.length,
    }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
  const extensions = unique.flatMap((group) => group.sourceExtensions);
  const totalBytes = unique.reduce(
    (sum, group) => sum + group.byteSize * group.sourceCount,
    0,
  );
  const uniqueBytes = unique.reduce((sum, group) => sum + group.byteSize, 0);

  const inventory = {
    generatedAt: new Date().toISOString(),
    fileCount: extensions.length,
    pngCount: extensions.filter((extension) => extension === "png").length,
    jpegCount: extensions.filter((extension) =>
      ["jpg", "jpeg"].includes(extension),
    ).length,
    totalBytes,
    uniqueCount: unique.length,
    uniqueBytes,
    duplicateFileCount: extensions.length - unique.length,
    duplicateBytes: totalBytes - uniqueBytes,
    jpegOrientation:
      "Source bytes are copied unchanged; EXIF orientation is not normalized during staging.",
    uniqueImages: unique,
  };
  await writeAtomically(
    inventoryPath,
    `${JSON.stringify(inventory, null, 2)}\n`,
  );

  let annotatedHashes = new Set<string>();
  const annotatedByHash = new Map<
    string,
    (typeof unique)[number] & Record<string, unknown>
  >();
  try {
    const annotated = await loadManifest(
      path.join(datasetRoot, "manifest.json"),
    );
    annotatedHashes = new Set(annotated.cases.map((item) => item.imageHash!));
    for (const item of annotated.cases) {
      if (item.imageHash) annotatedByHash.set(item.imageHash, item as any);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = unique
    .filter((group) => !annotatedHashes.has(group.hash))
    .map((group) => ({
      caseId: `receipt-${group.hash.slice(0, 12)}`,
      imagePath: `assets/${group.hash}.${group.extension}`,
      metadata: {
        sourcePaths: group.sourcePaths,
        annotationStatus: "pending",
      },
    }));
  await writeAtomically(
    path.join(datasetRoot, "pending.jsonl"),
    pending.map((entry) => JSON.stringify(entry)).join("\n") +
      (pending.length ? "\n" : ""),
  );
  const inferenceCases = unique.map((group) => {
    const annotated = annotatedByHash.get(group.hash);
    return annotated
      ? {
          ...annotated,
          imagePath: `assets/${group.hash}.${group.extension}`,
          originalImagePath: undefined,
        }
      : {
          caseId: `receipt-${group.hash.slice(0, 12)}`,
          imagePath: `assets/${group.hash}.${group.extension}`,
          metadata: {
            sourcePaths: group.sourcePaths,
            annotationStatus: "pending",
          },
        };
  });
  await writeAtomically(
    path.join(datasetRoot, "inference.jsonl"),
    inferenceCases.map((entry) => JSON.stringify(entry)).join("\n") +
      (inferenceCases.length ? "\n" : ""),
  );

  console.log(
    JSON.stringify(
      {
        added: added.length,
        alreadyStaged: found.size - fresh.length,
        ...(sampleSize === undefined
          ? {}
          : { notSampled: fresh.length - added.length, seed }),
        uniqueCount: unique.length,
        totalBytes,
        uniqueBytes,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
