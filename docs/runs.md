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

Setup opens as a guided wizard with six steps. Use **Full form** at the top to see every setting on one page; both views share the same values.

1. **Type**: choose Document → JSON, Text → JSON, or Tool calling.
2. **Data**: pick a dataset, or add the sample or import a file without leaving Setup. Choose **Graded** or **Save outputs only**.
3. **Model**: pick the model(s), or select **+ Add a model** to connect one inline. Document runs can skip reading images when every case already includes its text.
4. **Instructions**: choose **Edit in the app** to write the prompts and schema (or tool definitions) in Setup, or **Use a configuration file** to read them from a `.json` file in the project. Setup previews the file's prompts, schema, and grading rules. **Use example** fills in the sample settings, and **Save as file…** writes the current settings to a new or existing file (never including API keys).
5. **Grading**: choose how strict the checks are. Fields without a rule must match exactly; add field rules (`exact`, `normalized`, `number` with a `tolerance`, `date`, `ignore` for free text, or `"required": false`), or select **Suggest rules from schema**. Optionally pick a **judge model** and describe what it should check. Tool-calling runs choose whether call order matters. Runs that only save outputs skip grading.
6. **Review & run**: check the summary, optionally choose or create an experiment ([about experiments](experiments.md)), open **Advanced options** if needed, then select **Run evaluation**.

Open **Runs** to inspect cases, outputs, logs, timing, and grading evidence. Run controls include stopping an active evaluation.

| Evaluation type | Required stages and definitions |
| --- | --- |
| Document → JSON | OCR model, extraction model, stage prompts, JSON Schema |
| Text → JSON | Extraction model and instructions; JSON Schema required for schema-constrained output |
| Tool calling | Tool-capable model, instructions, tool definitions and argument schemas |

**Advanced options** (open by default on the last step) hold JSON mode, temperature, max tokens, and tool choice. An active configuration file owns its schema, prompts, and grading definitions; select **Edit in the app** to copy them into the editors.

Choose **Save outputs only** for unlabeled datasets: outputs are stored without expected-output grading. For extraction-only document evaluation, tick **My cases already include the document text**; every case must contain a reference transcription. Ordinary document runs use model OCR.

## Output and grading settings

- `prompted-json` includes the schema in the extraction prompt.
- `schema-constrained-json` sends strict `response_format.json_schema` and needs a target that supports it. Preflight includes the schema in its prompt and allows up to 512 output tokens, including reasoning. A completed response that violates the schema triggers `prompted-json` fallback and a `preflight_warning` event. A token-limit finish stops the run with a truncation diagnostic instead of declaring incompatibility. This preflight budget is separate from run generation settings; a successful probe does not prove strict enforcement for every request.
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
