# Prepare datasets

[← README](../README.md) · [Next: configure providers](providers.md)

Open **Datasets** to import a manifest, browse cases, and inspect their inputs and expected outputs. Keep private data under the ignored `datasets/` directory.

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

## Import from the command line

```bash
npm run evalforge -- import datasets/receipts/inference.jsonl --db .localevals/receipts.db
```

Use the same database when serving the dashboard or running evaluations. After import, the dataset browser supports search, row inspection, an expanded viewer, and raw JSONL viewing/export.
