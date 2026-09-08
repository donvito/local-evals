# EvalForge synthetic invoice fixtures

This directory contains three deterministic invoice cases. The PNGs are rendered locally from SVG with `@resvg/resvg-js` and system fonts; they contain only synthetic data. Each case has exactly two line items, while optional bill-to, purchase-order, and tax values vary between normal, empty-string, and `null` values.

Regenerate the suite (the existing `northstar-invoice.png` is intentionally preserved):

```bash
npm exec -- tsx scripts/generate-fixtures.ts
```

The generator writes `manifest.jsonl`, `expected.json`, `reference.json`, `schema.json`, and the three `assets/invoice-00*.png` files. The schema is JSON Schema draft-07 and is embedded by `config.json` through `schemaPath`.

`config.json` is the fully offline mock configuration. Copy `config.local.example.json` when connecting to separate local vision and text servers; replace its placeholder model names and URLs.

Run the entirely offline smoke test. It starts `scripts/mock-provider.ts`, imports the images, runs a passing model and `mock-regressed`, compares their results, and exports JSON:

```bash
npm exec -- tsx scripts/smoke.ts
```

To inspect the passing pipeline manually:

```bash
npm exec -- tsx scripts/mock-provider.ts
npm run evalforge -- run sample-data/manifest.jsonl sample-data/config.json --db /tmp/evalforge-demo.db
```

`mock-provider.ts` is a synthetic OpenAI-compatible server. It maps OCR responses by SHA-256 image bytes and maps extraction responses by invoice ID in the transcription. `mock-regressed` intentionally adds 1.00 to each extracted total so comparison output has a known regression. The smoke test also asserts threshold exit code `2` for that run and verifies JSON plus Markdown exports. None of these responses represent a real model.
