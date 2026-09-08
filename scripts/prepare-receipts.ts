import { createHash } from "node:crypto";
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
import { loadManifest } from "../src/core/manifest.js";

const defaultSource =
  "/Users/melvin/Documents/GitHub/archived/vision-agent/receipts";
const datasetRoot = path.resolve(process.cwd(), "datasets/receipts");
const assetsRoot = path.join(datasetRoot, "assets");
const imageExtensions = new Set([".png", ".jpg", ".jpeg"]);

type ReceiptGroup = {
  extension: "png" | "jpeg";
  hash: string;
  byteSize: number;
  sourcePaths: string[];
  sourceExtensions: string[];
  sourceCount: number;
};

async function imageFiles(root: string): Promise<string[]> {
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
  await visit(root);
  return result;
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
  const sourceRoot = path.resolve(process.argv[2] ?? defaultSource);
  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory())
    throw new Error(`Source is not a directory: ${sourceRoot}`);

  const files = await imageFiles(sourceRoot);
  const groups = new Map<string, ReceiptGroup>();
  let totalBytes = 0;

  for (const filePath of files) {
    const bytes = await readFile(filePath);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new Error(`Invalid PNG/JPEG: ${filePath}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const relativePath = path
      .relative(sourceRoot, filePath)
      .split(path.sep)
      .join("/");
    const extension = path.extname(filePath).toLowerCase().slice(1);
    totalBytes += bytes.byteLength;
    const group = groups.get(hash);
    if (group) {
      group.sourcePaths.push(relativePath);
      group.sourceExtensions.push(extension);
      group.sourceCount += 1;
    } else {
      groups.set(hash, {
        extension: png ? "png" : "jpeg",
        hash,
        byteSize: bytes.byteLength,
        sourcePaths: [relativePath],
        sourceExtensions: [extension],
        sourceCount: 1,
      });
    }
  }

  const unique = [...groups.values()].sort((left, right) =>
    left.hash.localeCompare(right.hash),
  );
  const uniqueBytes = unique.reduce((sum, group) => sum + group.byteSize, 0);
  await mkdir(assetsRoot, { recursive: true });
  for (const group of unique) {
    const sourcePath = path.join(sourceRoot, group.sourcePaths[0]);
    await copyIfSafe(
      sourcePath,
      path.join(assetsRoot, `${group.hash}.${group.extension}`),
      await readFile(sourcePath),
    );
  }

  const inventory = {
    sourceRoot,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    pngCount: files.filter(
      (filePath) => path.extname(filePath).toLowerCase() === ".png",
    ).length,
    jpegCount: files.filter((filePath) =>
      [".jpg", ".jpeg"].includes(path.extname(filePath).toLowerCase()),
    ).length,
    totalBytes,
    uniqueCount: unique.length,
    uniqueBytes,
    duplicateFileCount: files.length - unique.length,
    duplicateBytes: totalBytes - uniqueBytes,
    jpegOrientation:
      "Source bytes are copied unchanged; EXIF orientation is not normalized during staging.",
    uniqueImages: unique,
  };
  await writeAtomically(
    path.join(datasetRoot, "inventory.json"),
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
        fileCount: files.length,
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
