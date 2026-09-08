import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

type LegacyCase = {
  caseId: string;
  imagePath: string;
  referenceTranscription: string;
  expected: Record<string, unknown>;
  manifestPath: string;
};

type SyntheticCase = {
  caseId: string;
  inputText: string;
  expected: unknown;
  taskKind?: string;
};

type Fixture = LegacyCase | SyntheticCase;

const port = Number(process.env.EVALFORGE_MOCK_PORT ?? process.argv[2] ?? 8099);
const requestedManifest = path.resolve(
  process.env.EVALFORGE_FIXTURES ??
    process.argv[3] ??
    "sample-data/manifest.jsonl",
);
const defaultLegacyManifest = path.resolve("sample-data/manifest.jsonl");
const model = process.env.EVALFORGE_MOCK_MODEL ?? "mock-vision-extraction";

async function manifestCases(file: string): Promise<any[]> {
  const raw = await readFile(file, "utf8");
  if (file.toLowerCase().endsWith(".jsonl"))
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.cases ?? []);
}

const manifestFiles = [
  ...new Set([
    defaultLegacyManifest,
    path.resolve("sample-data/text-json/manifest.json"),
    path.resolve("sample-data/tool-calling/manifest.json"),
    requestedManifest,
  ]),
];
const legacyCases: LegacyCase[] = [];
const syntheticCases: SyntheticCase[] = [];
for (const manifestFile of manifestFiles) {
  for (const item of await manifestCases(manifestFile)) {
    if (typeof item?.imagePath === "string")
      legacyCases.push({ ...item, manifestPath: manifestFile });
    else if (typeof item?.inputText === "string")
      syntheticCases.push(item as SyntheticCase);
  }
}

const byHash = new Map<string, LegacyCase>();
for (const item of legacyCases) {
  byHash.set(
    createHash("sha256")
      .update(
        await readFile(
          path.resolve(path.dirname(item.manifestPath), item.imagePath),
        ),
      )
      .digest("hex"),
    item,
  );
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function completion(
  responseModel: string,
  content: string | null,
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>,
) {
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: "mock-response",
    object: "chat.completion",
    model: responseModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls?.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: Math.ceil(
        (content?.length ?? 0) + JSON.stringify(toolCalls ?? []).length,
      ),
    },
  };
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function extractionPrompt(request: any): string {
  return (request.messages ?? [])
    .map((message: any) => {
      const content = message?.content;
      if (Array.isArray(content))
        return content
          .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
          .join("\n");
      return typeof content === "string" ? content : "";
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findCaseFromText(text: string): Fixture | undefined {
  const synthetic = syntheticCases.find(
    (item) => text.includes(item.caseId) || text.includes(item.inputText),
  );
  if (synthetic) return synthetic;
  return legacyCases.find((item) =>
    text.includes(String(item.expected?.invoiceNumber)),
  );
}

function isRegressed(request: any): boolean {
  return (
    process.env.EVALFORGE_MOCK_MODE === "regressed" ||
    /regressed/i.test(String(request.model ?? "")) ||
    /regressed/i.test(model)
  );
}

/** Change one deterministic value while preserving the shape of ordinary JSON. */
function regressedJson(value: unknown): unknown {
  const actual = clone(value);
  if (isRecord(actual) && typeof actual.total === "number") {
    actual.total += 1;
    return actual;
  }
  let changed = false;
  const visit = (node: any): any => {
    if (changed) return node;
    if (typeof node === "number" && Number.isFinite(node)) {
      changed = true;
      return node + 1;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (isRecord(node)) {
      for (const key of Object.keys(node)) node[key] = visit(node[key]);
      return node;
    }
    return node;
  };
  const changedValue = visit(actual);
  if (changed) return changedValue;
  if (isRecord(changedValue)) changedValue.__regressed = true;
  return changedValue;
}

function defaultForSchema(schema: any, propertyName = ""): any {
  if (!schema || typeof schema !== "object") return "regressed";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === "object") {
    const result: Record<string, unknown> = {};
    for (const name of schema.required ?? [])
      result[name] = defaultForSchema(schema.properties?.[name], name);
    return result;
  }
  if (schema.type === "integer" || schema.type === "number")
    return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.format === "date" || /date|day/i.test(propertyName))
    return "2099-01-01";
  return "Regressed fictional value";
}

function toolCall(name: string, args: Record<string, unknown>, index: number) {
  return {
    id: `mock-call-${index + 1}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function regressedToolCalls(expected: unknown[], request: any) {
  if (!expected.length) {
    const definition = request.tools?.[0]?.function ?? {};
    return [
      toolCall(
        String(definition.name ?? "lookup_fictional_weather"),
        defaultForSchema(definition.parameters),
        0,
      ),
    ];
  }
  const calls = clone(expected) as Array<{
    name: string;
    arguments: Record<string, any>;
  }>;
  const args = calls[0]?.arguments;
  if (isRecord(args)) {
    const firstKey = Object.keys(args)[0];
    if (firstKey) {
      if (typeof args[firstKey] === "number") args[firstKey] += 1;
      else if (typeof args[firstKey] === "string")
        args[firstKey] += " (regressed)";
      else args.__regressed = true;
    } else args.__regressed = true;
  }
  return calls.map((call, index) =>
    toolCall(String(call.name), call.arguments ?? {}, index),
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
  const responseModel = String(request.model ?? model);
  const hasImage =
    Array.isArray(request.messages?.[0]?.content) &&
    request.messages[0].content.some((part: any) => part.type === "image_url");

  if (
    prompt.includes("Reply with a JSON object matching the supplied schema.")
  ) {
    json(res, 200, completion(responseModel, '{"ok":true}'));
    return;
  }
  if (prompt.includes("Reply with OK.")) {
    json(res, 200, completion(responseModel, "OK"));
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
    json(res, 200, completion(responseModel, item.referenceTranscription));
    return;
  }

  const item = findCaseFromText(prompt);
  if (Array.isArray(request.tools) && request.tools.length) {
    // A capability probe has no dataset case. Honor required calls without
    // running any function; regression models still pass capability checks.
    if (!item && request.tool_choice === "required") {
      const definition = request.tools[0].function;
      json(
        res,
        200,
        completion(responseModel, null, [
          toolCall(definition.name, defaultForSchema(definition.parameters), 0),
        ]),
      );
      return;
    }
    const expected = item && "inputText" in item ? item.expected : [];
    const calls = Array.isArray(expected)
      ? isRegressed(request)
        ? regressedToolCalls(expected, request)
        : expected.map((call: any, index: number) =>
            toolCall(String(call.name), call.arguments ?? {}, index),
          )
      : [];
    json(
      res,
      200,
      completion(
        responseModel,
        calls.length ? null : "No tool call is needed for this request.",
        calls,
      ),
    );
    return;
  }

  if (!item) {
    json(res, 200, completion(responseModel, "OK"));
    return;
  }
  const actual = isRegressed(request)
    ? regressedJson(item.expected)
    : clone(item.expected);
  json(res, 200, completion(responseModel, JSON.stringify(actual)));
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
