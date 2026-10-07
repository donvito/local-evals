export const DATASET_ZIP_README = `# Local Evals dataset ZIP

This ZIP is a complete, importable example dataset. Copy its layout to build your own.

## Import it

- Dashboard: **Datasets → Add dataset → Import a file**, then drop or choose the ZIP.
- Terminal: \`npm run localevals -- import <file>.zip\`

## Layout

\`\`\`text
manifest.jsonl   One case per line (or manifest.json: {"name": "...", "cases": [...]})
assets/          The images the cases point to (PNG or JPEG)
README.md        This file. Optional; ignored on import
AGENTS.md        Instructions for AI coding agents. Optional; ignored on import
\`\`\`

The manifest may also sit inside one top-level folder. If it is not named
\`manifest.jsonl\` or \`manifest.json\`, it must be the only \`.jsonl\`/\`.json\` file there.

## One case

\`\`\`json
{"caseId":"invoice-001","imagePath":"assets/invoice-001.png","expected":{"vendor":"PINECONE OFFICE CO.","total":72.6}}
\`\`\`

| Field | Required | Meaning |
| --- | --- | --- |
| \`caseId\` | yes | A unique name for the case. |
| \`imagePath\` | yes, for images | Relative to the manifest; must point to a PNG/JPEG inside the ZIP. |
| \`expected\` | no | The correct JSON answer, used for grading. Leave it out for unlabeled cases (inference-only runs). |
| \`referenceTranscription\` | no | The text in the image; enables OCR scoring. |
| \`metadata\` | no | Free-form notes such as the source. |

In this example every \`expected\` object has the same keys: \`vendor\`, \`invoiceNumber\`,
\`date\`, \`billTo\`, \`purchaseOrder\`, \`lineItems\`, \`subtotal\`, \`tax\`, \`total\`. When
you run the dataset, define an output schema in **Setup** with those same keys.

Text and tool-calling datasets use \`manifest.json\` with \`"taskKind"\` and an
\`"inputText"\` per case instead of images.

## Make your own

1. Replace the images in \`assets/\`.
2. Edit \`manifest.jsonl\` so each line points to one image and, if you know it, its correct answer.
3. Zip the files (or the folder that holds them) and import the ZIP.

Importing the same contents again gives the same dataset version; any change creates a new one.
`;

export const DATASET_ZIP_AGENTS = `# Instructions for agents: building a Local Evals dataset

You are creating a dataset that Local Evals imports as a ZIP. Use this example
as the template. README.md describes the format for people; follow the rules
below exactly.

## Output

Produce one ZIP with this layout:

\`\`\`text
manifest.jsonl
assets/<image files>
README.md        (optional: describe the source and how labels were made)
\`\`\`

Do not include AGENTS.md, schema files, or any other \`.json\`/\`.jsonl\` file at the
manifest's level, and no symlinks, absolute paths, or \`..\` segments.

## manifest.jsonl rules

- Exactly one JSON object per line, UTF-8, no trailing commas, no blank lines in between.
- \`caseId\`: required, unique, stable. Use lowercase kebab-case, e.g. \`receipt-001\`.
- \`imagePath\`: required for image datasets. Relative to manifest.jsonl, using
  forward slashes, e.g. \`assets/receipt-001.jpeg\`. The file must exist in the ZIP.
- Images must be real PNG or JPEG files whose extension matches their bytes
  (\`.png\` for PNG; \`.jpg\`/\`.jpeg\` for JPEG). Convert HEIC/WebP/PDF first.
- \`expected\`: the correct answer as JSON.
  - Use the same keys in every case. Ask the user for the field list if it is
    not given; otherwise mirror the example's keys only if they fit the documents.
  - Numbers are JSON numbers (\`26\`, not \`"26.00"\` or \`"$26"\`). Dates are ISO
    \`YYYY-MM-DD\`. Use \`null\` for a field that is genuinely absent from the document.
  - Only label what is clearly visible. **Never guess.** If you cannot read a
    case reliably, omit \`expected\` for that case and say so in \`metadata\`.
- \`referenceTranscription\` (optional): the document's text, only if you have it verbatim.
- \`metadata\` (optional): record provenance, e.g.
  \`{"source":"user-upload","annotationStatus":"agent-labeled","humanApproved":false,"notes":"..."}\`.
  Never mark \`humanApproved: true\` yourself.

## Privacy

Receipts and documents often contain names, addresses, card digits, and other
personal data. Do not upload them anywhere, do not add data the user did not
provide, and keep the dataset under the project's ignored \`datasets/\` folder.
Ask before redacting or altering images.

## Build and verify

1. Put the files in a working folder, e.g. \`datasets/<name>/\`.
2. Check every line parses as JSON, every \`caseId\` is unique, and every
   \`imagePath\` exists.
3. Zip from inside the folder, excluding OS clutter:
   \`cd datasets/<name> && zip -r ../<name>.zip manifest.jsonl assets README.md -x '*.DS_Store'\`
4. Verify the import against a throwaway database so real data is untouched:
   \`npm run localevals -- import datasets/<name>.zip --db "$(mktemp -d)/check.db"\`
   It prints the dataset version and case count. Fix any error it reports and retry.
   Never import into the user's real database unless they ask.
5. Report to the user: case count, how many cases are labeled vs unlabeled,
   which fields \`expected\` uses, and any cases you skipped or were unsure about.
`;
