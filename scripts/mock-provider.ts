import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

type Case = {
  caseId: string;
  imagePath: string;
  referenceTranscription: string;
  expected: Record<string, unknown>;
};
const port = Number(process.env.EVALFORGE_MOCK_PORT ?? process.argv[2] ?? 8099);
const manifestPath = path.resolve(
  process.env.EVALFORGE_FIXTURES ??
    process.argv[3] ??
    "sample-data/manifest.jsonl",
);
const model = process.env.EVALFORGE_MOCK_MODEL ?? "mock-vision-extraction";
const cases = (await readFile(manifestPath, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case);
const byHash = new Map<string, Case>();
for (const item of cases)
  byHash.set(
    createHash("sha256")
      .update(
        await readFile(
          path.resolve(path.dirname(manifestPath), item.imagePath),
        ),
      )
      .digest("hex"),
    item,
  );

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}
function message(content: string) {
  return {
    id: "mock-response",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: Math.ceil(content.length / 4),
    },
  };
}
async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function extractionPrompt(request: any): string {
  const content = request.messages?.[0]?.content;
  return Array.isArray(content)
    ? content.map((part: any) => part.text ?? "").join("\n")
    : String(content ?? "");
}
function findCaseFromText(text: string): Case | undefined {
  return cases.find((item) =>
    text.includes(String(item.expected.invoiceNumber)),
  );
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    json(res, 200, {
      object: "list",
      data: [{ id: model, object: "model", owned_by: "evalforge" }],
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    json(res, 404, { error: { message: "mock provider route not found" } });
    return;
  }
  const request = await body(req);
  const prompt = extractionPrompt(request);
  const hasImage =
    Array.isArray(request.messages?.[0]?.content) &&
    request.messages[0].content.some((part: any) => part.type === "image_url");
  if (
    prompt.includes("Reply with a JSON object matching the supplied schema.")
  ) {
    json(res, 200, message('{"ok":true}'));
    return;
  }
  if (prompt.includes("Reply with OK.")) {
    json(res, 200, message("OK"));
    return;
  }
  if (hasImage) {
    const imagePart = request.messages[0].content.find(
      (part: any) => part.type === "image_url",
    );
    const encoded = String(imagePart.image_url?.url ?? "").split(",")[1] ?? "";
    const item = byHash.get(
      createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex"),
    );
    if (!item) {
      json(res, 422, {
        error: { message: "unknown synthetic fixture image hash" },
      });
      return;
    }
    json(res, 200, message(item.referenceTranscription));
    return;
  }
  const item = findCaseFromText(prompt);
  if (!item) {
    json(res, 200, message("OK"));
    return;
  }
  const actual = { ...item.expected };
  if (request.model === "mock-regressed")
    actual.total = Number(actual.total) + 1;
  json(res, 200, message(JSON.stringify(actual)));
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : port;
  console.log(
    `EvalForge synthetic mock listening at http://127.0.0.1:${actualPort}/v1 (model=${model})`,
  );
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(0)));
