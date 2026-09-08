# EvalForge

Local evaluation of **document → JSON**, **unstructured text → JSON**, and **tool-call proposals**, using local OpenAI-compatible servers or OpenRouter. Node 22+, TypeScript, React, SQLite.

## Try the offline demo

```bash
npm install
npm run demo
```

This runs the included synthetic invoice suite against a local mock endpoint, creates a passing run and a deliberately regressed run, verifies comparison/export, and serves the dashboard at **http://127.0.0.1:4180**. The demo database is separate: `.evalforge/demo.db`. These are fixture responses, not measurements of a real model.

## Synthetic text and tool-call suites

Two small, offline fixtures exercise the native non-document modes. They contain
only fictional data and have no personal information:

- `sample-data/text-json/manifest.json` contains six natural-language and structured-text cases, including missing fields, `null`, ISO dates, zero/negative/large numbers, and decimals. Its config is `sample-data/text-json/config.json`.
- `sample-data/tool-calling/manifest.json` contains six tool-intent cases covering one call, ordered multiple calls, no call, and ambiguous requests that should remain unanswered. Its config is `sample-data/tool-calling/config.json`.

The `CASE_ID=...` line in each input is a deterministic fixture-oracle marker used
only by the local mock. It makes the smoke test reproducible; these runs are not
model-quality benchmarks.

To use the fixtures in the dashboard, start `npm run dev`, open **Datasets**, and
use the **Import Text → JSON** or **Import Tool calling** quick sample button.
The equivalent project-relative paths in the **Import a dataset** field are
`sample-data/text-json/manifest.json` and
`sample-data/tool-calling/manifest.json`. Then open **Setup**, choose the matching
evaluation type and dataset, then click **Load sample settings** to populate the
editable schema, prompts, or tool definitions. Advanced users can instead enter
the corresponding file in **Evaluation configuration**; an active file owns its
schema, prompts, and grading definitions until **Use native editors** is selected.
For the mock target, open **Targets → Add target** and use
`http://127.0.0.1:8099/v1`, model `mock-text-json` or `mock-tool-calling`, and
**OpenAI-compatible**; mark **Tool calling** for the tool suite. Run the mock in
another terminal with `npm run mock` before testing the target.

The command-line path is deterministic and does not require a dashboard target:
for the two direct `run` commands, start `npm run mock` in another terminal
first. `npm run smoke:modes` starts and stops its own mock automatically.

```bash
npm run smoke:modes
npm exec -- tsx src/cli.ts run sample-data/text-json/manifest.json sample-data/text-json/config.json --db /tmp/evalforge-text-json.db --threshold 1
npm exec -- tsx src/cli.ts run sample-data/tool-calling/manifest.json sample-data/tool-calling/config.json --db /tmp/evalforge-tool-calling.db --threshold 1
```

The mode smoke starts the local mock, runs both passing suites, and then changes
the mock model name to produce deliberate failures. Tool calls are proposed and
recorded for grading only; EvalForge never executes a real tool.

For your regular workspace:

```bash
npm run dev
```

The dashboard prints its URL (default port 4173). Use Targets to save/test endpoints, Datasets to import a manifest or a sample, and Setup to start an evaluation directly in the UI. Progress, stop controls, logs, and results are available in the dashboard; the terminal command remains an option. Credentials entered in Targets are encrypted locally and resolved by runs using the same database; environment-variable references remain supported for file-based configurations.

For OpenRouter targets, search the model catalog and filter by Vision, Structured JSON, Tools, Free, or minimum context. Selecting a result fills the model ID and advertised capabilities. Public metadata is cached server-side; credentials and dataset content are never sent with catalog requests. Capability metadata is advisory: actual support also depends on the provider endpoint. Manual model entry remains available for local endpoints or catalog failures.

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

Native text manifests declare `taskKind: "text-json"` and cases with `inputText` instead of `imagePath`. Tool manifests declare `taskKind: "tool-calling"`; each case's `expected` is an array of `{ "name": "function_name", "arguments": { ... } }`, or `[]` when no call is expected. Tool configurations supply OpenAI-format `tools`, `toolChoice` (`auto`, `required`, or `none`), and `toolCallOrder` (`ordered` or `unordered`). The matching `taskKind` belongs in the run config too. Existing image configurations without a task kind continue to work.

Tool evaluations are single-turn and side-effect-free. They check names, call counts, JSON arguments, and argument schemas; they do not run functions or continue a conversation with tool results. Tool calls use their own response protocol, not JSON output mode or the optional semantic judge.

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

## Private datasets

Keep real receipts and other private input data under the ignored `datasets/`
directory. Import their manifests through the dataset library. Use
inference-only mode for unlabeled inputs, and human-review expected outputs
before treating a run as a model-quality benchmark. Local databases, vault keys,
run exports, and private datasets are excluded from Git; synthetic sample data
is included.

## Verification

```bash
npm run lint
npm test
npm run build
npm run smoke
npm run smoke:modes
```

Tests cover grading edge cases, provider payloads, run execution, dataset integrity, SQLite migration, metrics parity, and local API safety. The offline smoke exercises both stages and paired exports. A real 50-image llama.cpp/OpenRouter benchmark needs those endpoints, credentials, and a 50-case dataset; mock runs cannot establish model quality.

Provider references: [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [OpenRouter image input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).
