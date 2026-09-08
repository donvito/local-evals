export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

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
  imagePath: string;
  expected: Json;
  referenceTranscription?: string;
  metadata?: Record<string, Json>;
  imageHash?: string;
  originalImagePath?: string;
};

export type DatasetManifest = {
  version?: string;
  name?: string;
  cases: DatasetCase[];
};

export type TargetConfig = {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  supportsVision?: boolean;
  supportsStructuredOutput?: boolean;
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
  stagePrompts: { ocr: string; extraction: string };
  outputMode: "prompted-json" | "schema-constrained-json";
  extractionSource?: "ocr" | "reference";
  ocrTarget: TargetConfig;
  extractionTarget: TargetConfig;
  judgeTarget?: TargetConfig;
  fieldRules: FieldRule[];
  crossFieldRules?: CrossFieldRule[];
  concurrency?: number;
  schema?: object;
  generation?: Record<string, unknown>;
  judgeRubric?: string;
  requestTimeoutMs?: number;
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
};

export type CaseResult = {
  caseId: string;
  imagePath: string;
  ocrText?: string;
  rawExtraction?: string;
  parsedJson?: Json;
  grade?: Grade;
  error?: string;
  timings: { ocrMs?: number; extractionMs?: number };
  [key: string]: any;
};
