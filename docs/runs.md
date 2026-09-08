# Set up and run evaluations

[← README](../README.md) · [Datasets](datasets.md) · [Providers](providers.md) · [Compare results](comparison.md)

## Start the app

With Node.js 22+ installed, run these commands from the repository directory:

```bash
npm install
npm run dev
```

The dashboard opens at [localhost:4173](http://127.0.0.1:4173), with data in `.localevals/evalforge.db`. This legacy database filename is retained so existing saved runs remain available. The dev command builds the UI before starting the server; rerun it after frontend changes.

To choose a database and port:

```bash
npm run build
npm run start -- --db .localevals/receipts.db --port 4182
```

For the offline demo, run `npm run demo` and open [localhost:4180](http://127.0.0.1:4180). It creates passing and deliberately regressed synthetic runs in a separate `.localevals/demo.db`.

## Configure a run in Setup

1. Select the evaluation type and an imported dataset.
2. Assign provider/model targets to the pipeline stages.
3. Set the instructions and output schema, or tool definitions for tool calling.
4. Choose the run settings, save the configuration, and start the evaluation.
5. Open **Runs** to inspect cases, outputs, logs, timing, and grading evidence. Run controls include stopping an active evaluation.

| Evaluation type | Required stages and definitions |
| --- | --- |
| Document → JSON | OCR target, extraction target, stage prompts, JSON Schema |
| Text → JSON | Extraction target and instructions; JSON Schema required for schema-constrained output |
| Tool calling | Tool-capable target, instructions, tool definitions and argument schemas |

Use **Load sample settings** for the selected workflow's fixtures. An active configuration file owns its schema, prompts, and grading definitions; select **Use native editors** to edit those values in the app.

Enable **inference-only** for unlabeled datasets: outputs are stored without expected-output grading. For extraction-only document evaluation, choose reference transcription as the extraction source; every case must contain one. Ordinary document runs use model OCR.

## Output and grading settings

- `prompted-json` includes the schema in the extraction prompt.
- `schema-constrained-json` sends strict `response_format.json_schema` and needs a target that supports it. The app does not repair JSON or silently fall back.
- Tool calling uses its own protocol. Set `toolChoice` to `auto`, `required`, or `none`, and `toolCallOrder` to `ordered` or `unordered`. Calls are recorded and graded without execution.
- Generation options live in `generation` and can be overridden per target. Request timeout defaults to 60 seconds; concurrency defaults to 1.

For file-based configs, supply `schema` inline. If it is absent, the loader reads `schemaPath`, or defaults to `schema.json` beside the config. Prompted text runs may omit the schema file; schema-constrained output requires a schema. Draft 7 and 2020-12 are supported. Start from the [local document example](../sample-data/config.local.example.json), [text config](../sample-data/text-json/config.json), or [tool config](../sample-data/tool-calling/config.json), replacing mock targets as needed.

Deterministic grading distinguishes parse success, schema validity, field accuracy, and case pass rate. Expected values are compared recursively; missing, extra, duplicate, wrong-type, and incorrect values remain distinct failures. Strings default to exact matching and arrays to ordered comparison.

Example rules:

```json
{
  "fieldRules": [
    { "path": "vendor", "match": "normalized" },
    { "path": "lineItems", "uniqueKey": "description" },
    { "path": "lineItems.*.amount", "match": "number", "tolerance": 0.01 }
  ],
  "crossFieldRules": [
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

Normalized strings ignore case and collapse whitespace. Date rules validate ISO calendar dates. Cross-field equality uses `{ "name": "same value", "type": "equals", "left": "a", "right": "b" }`. Optional/null values follow the expected JSON and schema.

OCR scoring uses character and word error rates against reference text; missing references are ungraded. Whitespace normalization preserves case and punctuation. Raw transcriptions remain available.

An optional semantic judge records a verdict and evidence without changing deterministic scores. Provide a rubric requesting JSON with a boolean or pass/fail `verdict` and non-empty `evidence`. Invalid judge responses are ungraded.

## Run from the command line

For this synthetic example, first start `npm run mock` in another terminal:

```bash
npm run localevals -- run sample-data/manifest.jsonl sample-data/config.json --db .localevals/example.db --concurrency 2 --threshold 0.9
npm run localevals -- inspect --db .localevals/example.db
npm run localevals -- serve --db .localevals/example.db --port 4182
```

The first argument to `run` may also be an imported dataset version. Use the same database for running, inspection, comparison, and serving. CLI concurrency is limited to 32. Ctrl+C cancels a run while retaining completed cases and attempts.

| Exit code | Meaning |
| --- | --- |
| 0 | Execution completed |
| 1 | Configuration, connection, or execution failure |
| 2 | Pass rate below the requested threshold |
| 130 | Cancelled |

Without a threshold, incorrect model output is stored as an evaluation result and does not itself cause a failing CLI exit.

## Access from another device

After building, explicitly enable LAN access:

```bash
npm run localevals -- serve --db .localevals/receipts.db --port 4182 --host 0.0.0.0
```

Use the printed Wi-Fi URL on a device connected to the same trusted network. LAN clients can use dashboard run controls. Keep the host awake; restart the server if its network address changes. By default, the server is localhost-only.

## Verify a development checkout

```bash
npm run lint
npm test
npm run build
npm run smoke
npm run smoke:modes
```

The smoke commands start and stop their own mock provider. The first covers documents; the second covers text and tool calling, including deliberate regressions.
