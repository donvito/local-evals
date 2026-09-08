# EvalForge

Local evaluation of **document image → OCR transcription → structured JSON**. Node 22+, TypeScript, React, SQLite.

## Try the offline demo

```bash
npm install
npm run demo
```

This runs the included synthetic invoice suite against a local mock endpoint, creates a passing run and a deliberately regressed run, verifies comparison/export, and serves the dashboard at **http://127.0.0.1:4180**. The demo database is separate: `.evalforge/demo.db`. These are fixture responses, not measurements of a real model.

For your regular workspace:

```bash
npm run dev
```

The dashboard prints its URL (default port 4173). Use Targets to save/test endpoints, Datasets to import a manifest, and Setup to save stage selections and copy the run command. Evaluation executes in your terminal; the dashboard polls persisted progress. Credentials entered in Targets are encrypted locally and resolved by runs using the same database; environment-variable references remain supported for file-based configurations.

## Real evaluations

Start your own llama.cpp server with a vision-capable model and its multimodal projector. Configure a second text endpoint or reuse the vision endpoint for extraction. OpenRouter connections normally use `https://openrouter.ai/api/v1`, `provider: "openrouter"`, a model ID, and `apiKeyEnv: "OPENROUTER_API_KEY"`.

Edit the sample configuration's target URLs/model IDs for your servers; no model is downloaded or started by EvalForge.

```bash
npm run evalforge -- init
npm run evalforge -- import sample-data/manifest.jsonl
npm run evalforge -- run sample-data/manifest.jsonl sample-data/config.json
npm run evalforge -- inspect
npm run evalforge -- serve
```

All commands accept `--db path/to/results.db`. Use the same database for evaluation and serving.

To access the dashboard from a phone on the same Wi-Fi, explicitly enable LAN access:

```bash
npm run evalforge -- serve --db .evalforge/receipts.db --port 4182 --host 0.0.0.0
```

Open the printed **Wi-Fi dashboard** URL on your phone. The default remains localhost-only. LAN mode allows other devices on your network to use the dashboard, including run controls; use it on a trusted network. Keep the Mac awake while using it. Restart the server if its Wi-Fi address changes.

```bash
npm run evalforge -- target add target.json
npm run evalforge -- target list
npm run evalforge -- target test target-name --vision true
npm run evalforge -- run manifest.jsonl config.json --concurrency 2 --threshold 0.9
npm run evalforge -- compare BASELINE_RUN CANDIDATE_RUN
npm run evalforge -- export RUN_ID --format json --out report.json
npm run evalforge -- export RUN_ID --format markdown --out report.md
```

Exports refuse to overwrite existing files. Exit codes: 0 execution completed; 1 configuration/connection/execution failure; 2 below the requested pass-rate threshold; 130 cancelled. Without a threshold, incorrect model output is a stored evaluation result, not a CLI failure.

## Dataset format

One JSON object per line:

```json
{
  "caseId": "invoice-001",
  "imagePath": "assets/invoice.png",
  "expected": { "total": 104.5 },
  "referenceTranscription": "Total: $104.50",
  "metadata": { "source": "synthetic" }
}
```

JSON manifests with `{ "cases": [...] }` are also supported. Image paths are relative to the manifest's directory and must remain within it. PNG/JPEG signatures and extensions are checked. Import copies assets beside the selected database, hashes their bytes, and computes a content-derived dataset version from cases, expected JSON, references, metadata, and hashes. Existing run history is migrated without deletion.

## Configuration and grading

Supply a JSON Schema inline as `schema` or in `schema.json` next to the config (`schemaPath` overrides this). Invalid schemas block startup. Draft 7 and 2020-12 are supported.

Configure `ocrTarget`, `extractionTarget`, optional `judgeTarget`, `stagePrompts`, `outputMode`, `fieldRules`, and `crossFieldRules`. Use `extractionSource: "reference"` to skip OCR and evaluate only extraction; every case must then have a reference transcription. Ordinary pipeline runs always consume model OCR.

Both modes supply the extraction schema: `prompted-json` adds it to the prompt; `schema-constrained-json` sends a strict `response_format.json_schema` request and requires a supported target. There is no fallback, fence stripping, or JSON repair. OpenRouter structured requests require routing support for supplied parameters.

Generation settings are explicit in `generation` and can be overridden per target. `requestTimeoutMs` defaults to 60000. Concurrency defaults to 1 (CLI limit 32). Press Ctrl+C to cancel; completed cases and attempts remain available. A dead foreground owner is shown as interrupted.

Recursive checks compare every expected value and detect invented fields. Strings default to exact; `match: "normalized"` collapses whitespace, trims, and ignores case. Numbers use explicit tolerances; dates accept validated ISO calendar dates. Arrays compare in order unless a rule declares `uniqueKey`. Missing, extra, duplicate, null, empty, wrong-type, and incorrect values are separate failures.

```json
{
  "fieldRules": [
    { "path": "vendor", "match": "normalized" },
    { "path": "lineItems", "uniqueKey": "description" },
    { "path": "lineItems.*.amount", "match": "number", "tolerance": 0.01 }
  ],
  "crossFieldRules": [
    {
      "name": "line totals",
      "type": "sum_equals",
      "fields": ["lineItems.*.amount"],
      "total": "subtotal",
      "tolerance": 0.01
    },
    {
      "name": "invoice total",
      "type": "sum_equals",
      "fields": ["subtotal", "tax"],
      "total": "total",
      "tolerance": 0.01
    }
  ]
}
```

Equality checks use `{ "name": "...", "type": "equals", "left": "a", "right": "b" }`. Optional fields and null/empty values are interpreted according to the expected JSON and schema, not a blanket non-empty requirement.

OCR normalization `whitespace-v2` trims and collapses whitespace while preserving case and punctuation. CER uses Unicode code points; WER uses whitespace-delimited words. Missing references are ungraded. Empty references use a denominator of one for insertions. Raw transcriptions are retained.

Parse rate, schema rate, deterministic field accuracy, and case pass rate are separate. OCR errors reduce pipeline success by preventing extraction. Judge output is optional and never changes deterministic scores: supply a rubric requesting JSON with a `verdict` (boolean or pass/fail) and non-empty `evidence`. Invalid judge output or request errors are ungraded.

Comparisons require compatible dataset, schema, grader, field rules, and extraction source; matching cases determine the reported sample count. Stage models/prompts may differ. Request attempts, raw outputs, hashes, prompts, schema, usage, and available cost are retained. Unavailable server/quantization/routing metadata is labeled unknown. Secrets are encrypted with AES-256-GCM in the local credential vault (`<database>.credentials.key`, mode `0600`), never returned by the API, and redacted from stored/exported responses. The vault key is local to that database; protect it with the database file.

## Your real receipts

The supplied receipt folder has been staged under `datasets/receipts`: 61 source
images, 56 unique images, one assistant-image-reviewed three-field starter case,
and 55 cases awaiting annotation. Originals are unchanged. See
[receipt dataset instructions](datasets/receipts/README.md) for importing, labeling,
and running against real model endpoints. The starter labels need human review;
these images have not been used to claim any model-quality results.

## Verification

```bash
npm run lint
npm test
npm run build
npm run smoke
```

Tests cover grading edge cases, provider payloads, run execution, dataset integrity, SQLite migration, metrics parity, and local API safety. The offline smoke exercises both stages and paired exports. A real 50-image llama.cpp/OpenRouter benchmark needs those endpoints, credentials, and a 50-case dataset; mock runs cannot establish model quality.

Provider references: [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [OpenRouter image input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).
