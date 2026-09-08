import { readFile, writeFile } from "node:fs/promises";
import { DatabaseStore } from "../src/storage/db.js";

const [
  dbPath,
  runId,
  sourcePath,
  outputPath = ".evalforge/receipts-retry.jsonl",
] = process.argv.slice(2);
if (!dbPath || !runId || !sourcePath) {
  throw new Error(
    "Usage: tsx scripts/select-failed-cases.ts <db> <run-id> <manifest> [output]",
  );
}

const db = new DatabaseStore(dbPath);
const run = db.getRun(runId);
db.close();
if (!run) throw new Error(`Run not found: ${runId}`);
const failed = new Set(
  run.cases.filter((item) => item.error).map((item) => item.caseId),
);
const rows = (await readFile(sourcePath, "utf8"))
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((item) => failed.has(item.caseId));
await writeFile(
  outputPath,
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
console.log(JSON.stringify({ failed: rows.length, outputPath }, null, 2));
