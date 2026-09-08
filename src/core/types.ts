export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type TaskKind = "document-json" | "text-json" | "tool-calling";
export type ToolChoice = "auto" | "required" | "none";
export type ToolCallOrder = "ordered" | "unordered";

/** OpenAI-compatible function tool definition. */
export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: object;
  };
};

/** The deterministic expectation stored in a tool-calling dataset case. */
export type ToolCallExpectation = {
  name: string;
  arguments: JsonObject;
};

export type FieldRule = {
  path: string;
  match?: "exact" | "normalized" | "number" | "date";
  tolerance?: number;
  required?: boolean;
  uniqueKey?: string;
};

export type CrossFieldRule =
  | {
      name: string;
      type: "sum_equals";
      fields: string[];
      total: string;
      tolerance?: number;
    }
  | {
      name: string;
      type: "equals";
      left: string;
      right: string;
      tolerance?: number;
    };

export type DatasetCase = {
  caseId: string;
  imagePath?: string;
  inputText?: string;
  expected?: Json | ToolCallExpectation[];
  referenceTranscription?: string;
  metadata?: Record<string, Json>;
  imageHash?: string;
  originalImagePath?: string;
};

export type DatasetManifest = {
  version?: string;
  name?: string;
  taskKind?: TaskKind;
  cases: DatasetCase[];
};

export type TargetConfig = {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  supportsVision?: boolean;
  supportsStructuredOutput?: boolean;
  supportsTools?: boolean;
  provider?: "openai-compatible" | "llama.cpp" | "openrouter";
  metadata?: Record<string, unknown>;
  generation?: Record<string, unknown>;
  /** Runtime-only decrypted credential; never serialize or persist this field. */
  apiKey?: string;
  hasApiKey?: boolean;
};

export type RunConfig = {
  datasetVersion: string;
  schemaVersion: string;
  taskKind?: TaskKind;
  stagePrompts: { ocr?: string; extraction: string };
  outputMode?: "prompted-json" | "schema-constrained-json";
  extractionSource?: "ocr" | "reference";
  ocrTarget?: TargetConfig;
  extractionTarget: TargetConfig;
  judgeTarget?: TargetConfig;
  fieldRules: FieldRule[];
  crossFieldRules?: CrossFieldRule[];
  concurrency?: number;
  schema?: object;
  generation?: Record<string, unknown>;
  judgeRubric?: string;
  requestTimeoutMs?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  toolCallOrder?: ToolCallOrder;
  /** Run OCR/extraction and persist outputs without requiring ground truth. */
  inferenceOnly?: boolean;
};

export type FieldFailure = {
  path: string;
  kind: string;
  expected?: Json;
  actual?: Json;
  message: string;
};
export type Grade = {
  parseSuccess: boolean;
  schemaValid: boolean;
  fieldAccuracy: number;
  passed: boolean;
  failures: FieldFailure[];
  checks?: number;
  passedChecks?: number;
  taskKind?: TaskKind;
  actualToolCalls?: unknown[];
  expectedToolCalls?: ToolCallExpectation[];
  toolCallOrder?: ToolCallOrder;
};

export type CaseResult = {
  caseId: string;
  imagePath?: string;
  inputText?: string;
  expected?: Json | ToolCallExpectation[];
  ocrText?: string;
  rawExtraction?: string;
  parsedJson?: Json;
  /** Raw provider tool_calls, including malformed argument strings. */
  toolCalls?: unknown[];
  rawToolCalls?: unknown[];
  grade?: Grade;
  error?: string;
  timings: { ocrMs?: number; extractionMs?: number };
  [key: string]: any;
};
