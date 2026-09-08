# Compare evaluation results

[← README](../README.md) · [Prepare datasets](datasets.md) · [Set up runs](runs.md)

The app compares **evaluation runs on the same dataset**, not arbitrary datasets against one another. Use comparison to measure the effect of changing a model or prompt while keeping the evaluation inputs and grading rules fixed.

## Compare in the app

1. Run a baseline evaluation.
2. Run a candidate with the same dataset and compatible grading configuration, changing the target model or prompt you want to test.
3. Open **Compare**, or select a run in Runs and use **Compare** in its toolbar.
4. Select the baseline on the left and candidate on the right, then start the comparison.
5. Inspect metric changes, case regressions/improvements, and field-level movement. Return to Runs for source inputs, outputs, and execution evidence.

The comparison uses matching completed case IDs. Check the sample count, especially when either run was stopped or failed partway through.

## Keep comparisons compatible

Compatibility includes the dataset version, schema and schema version, grader version, field/cross-field rules, task kind, and extraction source. Tool runs also need matching tool definitions, order, and choice settings. Model targets and prompts may differ.

Editing images, inputs, expected labels, or metadata can create a new dataset version. Runs on different versions are rejected as incompatible. To test a revised dataset, run both the baseline and candidate models again on that new version.

The Compare action rejects inference-only runs because they have no deterministic quality scores. Inspect their stored outputs and timing in Runs instead; missing scores are not zero.

## CLI comparison and exports

```bash
npm run localevals -- inspect --db .localevals/receipts.db
npm run localevals -- compare BASELINE_RUN_ID CANDIDATE_RUN_ID --db .localevals/receipts.db
npm run localevals -- export RUN_ID --format json --out report.json --db .localevals/receipts.db
npm run localevals -- export RUN_ID --format markdown --out report.md --db .localevals/receipts.db
```

Replace the run ID placeholders with IDs from `inspect`. Export commands write reports for an individual run; they refuse to overwrite an existing file. The Runs toolbar also offers JSON and Markdown downloads.

Snapshots retain configuration and available execution evidence, including model responses and request attempts. Use this evidence to explain a change in results rather than relying on a single aggregate score.
