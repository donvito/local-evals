import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(process.cwd(), "sample-data");
const assets = path.join(root, "assets");

type Fixture = {
  caseId: string;
  invoiceNumber: string;
  date: string;
  vendor: string;
  billTo: string | null;
  purchaseOrder: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  subtotal: number;
  tax: number | null;
  total: number;
};

const fixtures: Fixture[] = [
  {
    caseId: "invoice-001",
    invoiceNumber: "SYN-1001",
    date: "2025-01-15",
    vendor: "PINECONE OFFICE CO.",
    billTo: "Harbor Labs",
    purchaseOrder: "PO-77",
    items: [
      { description: "Notebook", quantity: 4, unitPrice: 7.5, amount: 30 },
      { description: "Desk Lamp", quantity: 2, unitPrice: 18, amount: 36 },
    ],
    subtotal: 66,
    tax: 6.6,
    total: 72.6,
  },
  {
    caseId: "invoice-002",
    invoiceNumber: "SYN-2048",
    date: "2025-06-30",
    vendor: "RIVERSTONE GOODS",
    billTo: null,
    purchaseOrder: "",
    items: [
      {
        description: "Packing Tape",
        quantity: 10,
        unitPrice: 3.25,
        amount: 32.5,
      },
      {
        description: "Shipping Labels",
        quantity: 5,
        unitPrice: 4.4,
        amount: 22,
      },
    ],
    subtotal: 54.5,
    tax: null,
    total: 54.5,
  },
  {
    caseId: "invoice-003",
    invoiceNumber: "SYN-3099",
    date: "2026-02-03",
    vendor: "ORBITAL RESEARCH SUPPLY",
    billTo: "Northwind Analytics",
    purchaseOrder: "PO-902",
    items: [
      {
        description: "Calibration Kit",
        quantity: 1,
        unitPrice: 125,
        amount: 125,
      },
      {
        description: "Sensor Cable",
        quantity: 6,
        unitPrice: 14.75,
        amount: 88.5,
      },
    ],
    subtotal: 213.5,
    tax: 21.35,
    total: 234.85,
  },
];

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [
    "vendor",
    "invoiceNumber",
    "date",
    "billTo",
    "purchaseOrder",
    "lineItems",
    "subtotal",
    "tax",
    "total",
  ],
  properties: {
    vendor: { type: "string" },
    invoiceNumber: { type: "string" },
    date: { type: "string", format: "date" },
    billTo: { type: ["string", "null"] },
    purchaseOrder: { type: "string" },
    lineItems: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unitPrice", "amount"],
        properties: {
          description: { type: "string" },
          quantity: { type: "number" },
          unitPrice: { type: "number" },
          amount: { type: "number" },
        },
      },
    },
    subtotal: { type: "number" },
    tax: { type: ["number", "null"] },
    total: { type: "number" },
  },
};

function money(value: number | null): string {
  return value === null ? "" : `$${value.toFixed(2)}`;
}
function textFor(fixture: Fixture): string {
  const lines = [
    "EVALFORGE / SYNTHETIC FIXTURE",
    fixture.vendor,
    "SYNTHETIC INVOICE",
    `Invoice No: ${fixture.invoiceNumber}`,
    `Date: ${fixture.date}`,
    `Bill To: ${fixture.billTo ?? ""}`,
    `Purchase Order: ${fixture.purchaseOrder}`,
    "Item | Quantity | Unit Price | Amount",
  ];
  for (const item of fixture.items)
    lines.push(
      `${item.description} | ${item.quantity} | ${money(item.unitPrice)} | ${money(item.amount)}`,
    );
  lines.push(
    `Subtotal: ${money(fixture.subtotal)}`,
    `Tax: ${money(fixture.tax)}`,
    `Total: ${money(fixture.total)}`,
  );
  return lines.join("\n");
}
function expectedFor(fixture: Fixture) {
  return {
    vendor: fixture.vendor,
    invoiceNumber: fixture.invoiceNumber,
    date: fixture.date,
    billTo: fixture.billTo,
    purchaseOrder: fixture.purchaseOrder,
    lineItems: fixture.items,
    subtotal: fixture.subtotal,
    tax: fixture.tax,
    total: fixture.total,
  };
}
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function svgFor(fixture: Fixture): string {
  const lines = textFor(fixture).split("\n");
  const rows = lines
    .map((line, index) => {
      const y = 88 + index * 42;
      if (index === 0)
        return `<text x="72" y="${y}" font-family="Arial" font-size="18" letter-spacing="3" fill="#68806d">${esc(line)}</text>`;
      if (index === 1)
        return `<text x="72" y="${y}" font-family="Arial" font-size="34" font-weight="700" fill="#16271f">${esc(line)}</text>`;
      return `<text x="72" y="${y}" font-family="DejaVu Sans Mono" font-size="30" fill="#18221d">${esc(line)}</text>`;
    })
    .join("");
  const height = Math.max(760, 150 + lines.length * 42);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="100%" height="100%" fill="#fffdf8"/><rect x="42" y="35" width="1116" height="${height - 70}" fill="none" stroke="#22352c" stroke-width="2"/>${rows}</svg>`;
}

async function main() {
  await mkdir(assets, { recursive: true });
  const cases: Array<Record<string, unknown>> = [];
  const expected: Record<string, unknown> = {};
  const references: Record<string, string> = {};
  for (const fixture of fixtures) {
    const imagePath = path.join(assets, `${fixture.caseId}.png`);
    const png = new Resvg(svgFor(fixture), {
      font: {
        loadSystemFonts: true,
        sansSerifFamily: "Arial",
        monospace: "DejaVu Sans Mono",
      },
      logLevel: "off",
    })
      .render()
      .asPng();
    await writeFile(imagePath, png);
    cases.push({
      caseId: fixture.caseId,
      imagePath: `assets/${fixture.caseId}.png`,
      referenceTranscription: textFor(fixture),
      expected: expectedFor(fixture),
      metadata: {
        documentType: "invoice",
        source: "synthetic",
        fixtureVersion: "v2",
      },
    });
    expected[fixture.caseId] = expectedFor(fixture);
    references[fixture.caseId] = textFor(fixture);
  }
  await writeFile(
    path.join(root, "manifest.jsonl"),
    cases.map((item) => JSON.stringify(item)).join("\n") + "\n",
  );
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        name: "Synthetic invoice suite",
        version: "synthetic-invoices-v3",
        cases,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(root, "expected.json"),
    JSON.stringify(expected, null, 2) + "\n",
  );
  await writeFile(
    path.join(root, "reference.json"),
    JSON.stringify(references, null, 2) + "\n",
  );
  await writeFile(
    path.join(root, "schema.json"),
    JSON.stringify(schema, null, 2) + "\n",
  );
  console.log(
    `Generated ${fixtures.length} deterministic invoice fixtures in ${root}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
