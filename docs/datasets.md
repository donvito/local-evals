# Prepare datasets

[← README](../README.md) · [Next: configure providers](providers.md)

Open **Datasets** to import a manifest, browse cases, and inspect their inputs and expected outputs. Keep private data under the ignored `datasets/` directory.

Right-click a dataset to rename, duplicate, or delete it. Rename edits the title in place: Enter saves and Escape cancels. Duplicate creates a separate library entry with the same cases and shared imported assets. Deleting a dataset also removes its completed creation records, but keeps evaluation history and imported files. Deletion requires confirmation. Generation-job menus offer Stop or retry/delete actions according to their status.

## Start with sample data

Use the quick-sample import buttons in Datasets, or import one of these paths:

| Workflow | Manifest | Example run configuration |
| --- | --- | --- |
| Document → JSON | `sample-data/manifest.jsonl` | [Document config](../sample-data/config.json) |
| Text → JSON | `sample-data/text-json/manifest.json` | [Text config](../sample-data/text-json/config.json) |
| Tool calling | `sample-data/tool-calling/manifest.json` | [Tool config](../sample-data/tool-calling/config.json) |

These fixtures use fictional data. Their mock responses test the app's behavior; they are not model-quality benchmarks. The text/tool fixtures include `CASE_ID=...` markers for the mock's deterministic responses.

## Document images

Create a JSONL file with one complete JSON object per line:

```jsonl
{"caseId":"invoice-001","imagePath":"assets/invoice.png","expected":{"total":104.5},"referenceTranscription":"Total: $104.50","metadata":{"source":"synthetic"}}
```

- Give each case a unique `caseId`.
- Use PNG or JPEG files. Image paths are relative to the manifest's directory and must stay inside it.
- `expected` is the human-reviewed JSON used for grading. Omit it for unlabeled data and enable inference-only mode when running.
- `referenceTranscription` is optional; it enables OCR scoring or extraction from reference text.
- `metadata` is optional source/annotation information.

A JSON manifest with `{ "cases": [...] }` is also supported. Import copies image assets into local storage and computes a version from the dataset contents, including labels and image hashes. Changing those contents creates a different version.

### Prepare a folder of receipts

```bash
npm run receipts:prepare -- /absolute/path/to/receipt-images
```

This recursively finds PNG/JPEG images, deduplicates identical bytes, and stages them under `datasets/receipts/`:

| Output | Purpose |
| --- | --- |
| `assets/` | Copied images named by content hash |
| `inventory.json` | Source paths, image counts, and duplicate statistics |
| `pending.jsonl` | Images still awaiting annotations |
| `inference.jsonl` | All staged images, ready for inference-only runs |

Import `datasets/receipts/inference.jsonl` in Datasets. If `datasets/receipts/manifest.json` already contains annotations for matching image hashes, the script reuses them. Generated inventories and JSONL files are refreshed on each invocation; source image bytes are preserved, including EXIF orientation.

## Text inputs

Use a JSON manifest that declares the workflow:

```json
{
  "taskKind": "text-json",
  "cases": [
    {
      "caseId": "record-001",
      "inputText": "Avery ordered 3 notebooks at $4 each.",
      "expected": { "customer": "Avery", "quantity": 3, "total": 12 }
    }
  ]
}
```

Choose the same evaluation type in Setup. Define the output schema and instructions there, or in a run configuration file.

## Tool-call expectations

Declare `taskKind: "tool-calling"`. Each expected result is an array of function names and argument objects:

```json
{
  "taskKind": "tool-calling",
  "cases": [
    {
      "caseId": "weather-001",
      "inputText": "Look up the weather in Example City.",
      "expected": [
        { "name": "lookup_weather", "arguments": { "city": "Example City" } }
      ]
    }
  ]
}
```

Use `[]` when no call should be proposed. The run configuration must define the corresponding tools and argument schemas. Calls are graded as proposals; the app does not execute functions.

## Generate a dataset with a provider

In Datasets, choose **Create with a provider**, select a configured provider/model, choose Text → JSON or Tool calling, and enter a brief. Review the generated inputs and expected outputs before using them as a benchmark. Document images must be imported from files.

Generation runs as a background job saved in the app's database. You can refresh or leave the page and return to Datasets to see its status, open the completed dataset, or read a failure message. New requests join a persistent queue and run one at a time in submission order, without stopping the current generation. The creation form is saved in this browser so a refresh also preserves your draft.

Set **Generation timeout (minutes)** when creating a dataset. It defaults to 10 minutes and accepts 0.5 to 60 minutes. Each job retains its timeout in the queue; the clock starts when generation begins, not while waiting. Restarting the server interrupts the running job; its status remains visible, but partial model output is not saved or resumed. Waiting jobs retain their briefs and resume from the queue after restart. Start a new generation to retry an interrupted job.

Select a generation job in the dataset list to view its status and any error in the main pane. Failed or interrupted jobs offer **Retry generation**, which queues a new attempt with the original settings, and **Delete failed job**, which removes only that job record. Saved datasets and active jobs are not deleted.

Use **Stop generation** for a running job or **Remove from queue** for a waiting job. Stopped jobs remain in history as interrupted and can be retried or deleted. Partial output is not saved, and the next waiting job proceeds once the running request has stopped. Deletion asks for confirmation before removing the attempt and its error history.

## Import from the command line

```bash
npm run localevals -- import datasets/receipts/inference.jsonl --db .localevals/receipts.db
```

Use the same database when serving the dashboard or running evaluations. After import, the dataset browser supports search, row inspection, an expanded viewer, and raw JSONL viewing/export.
