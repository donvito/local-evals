export type RunErrorDescription = {
  title: string;
  message: string;
  action: string;
};

const IMAGE_DIMENSIONS: RunErrorDescription = {
  title: "Image dimensions rejected",
  message:
    "The provider reports that an image may be too small in width or height for this model.",
  action:
    "Check whether a tiny test image caused this; otherwise inspect the original image, replace or re-export it at a valid full size, or choose a compatible model.",
};

const AUTHENTICATION: RunErrorDescription = {
  title: "Authentication failed",
  message: "The provider rejected the request credentials.",
  action: "Check the configured API key and provider permissions, then retry.",
};

const RATE_LIMIT: RunErrorDescription = {
  title: "Rate limit reached",
  message: "The provider is temporarily rate limiting requests.",
  action: "Wait a moment and retry, or reduce request concurrency.",
};

const TIMEOUT: RunErrorDescription = {
  title: "Request timed out",
  message: "The provider did not respond before the request deadline.",
  action: "Retry the run; if it persists, check the provider status.",
};

const CONNECTION: RunErrorDescription = {
  title: "Provider connection failed",
  message: "The dashboard could not connect to the provider.",
  action: "Check the provider URL and network connection, then retry.",
};

const ENDPOINT: RunErrorDescription = {
  title: "Provider endpoint needs attention",
  message:
    "The provider answered, but the configured URL is not its OpenAI-compatible API endpoint.",
  action:
    "For LM Studio, set the Base URL to http://127.0.0.1:1234/v1, test the target, then retry.",
};

const TOOL_CALLING: RunErrorDescription = {
  title: "Model did not return a tool call",
  message:
    "The selected model did not produce a native tool call during the capability check.",
  action:
    "Choose a model with tool/function calling support, keep the target on its /v1 endpoint, and retry.",
};

const UNAVAILABLE: RunErrorDescription = {
  title: "Provider unavailable",
  message: "The provider returned a temporary server error.",
  action: "Check the provider status and retry later.",
};

const RUNNER_EXITED: RunErrorDescription = {
  title: "Runner exited before completion",
  message: "The evaluation runner stopped before it finished the run.",
  action:
    "Restart the run and consult the technical details if it happens again.",
};

const UNKNOWN: RunErrorDescription = {
  title: "Run failed",
  message: "The run could not be completed.",
  action: "Consult the technical details for more context, then retry the run.",
};

const decodeEscapeLayer = (value: string): string =>
  value
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isNaN(point) || point > 0x10ffff
        ? _match
        : String.fromCodePoint(point);
    })
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\(["'/\\])/g, "$1")
    .replace(/\\n/gi, " ")
    .replace(/\\r/gi, " ")
    .replace(/\\t/gi, " ");

const normalizeForMatching = (raw: string): string => {
  let value = typeof raw === "string" ? raw : "";
  // Provider responses are sometimes JSON-wrapped more than once. A bounded
  // pass keeps matching tolerant of that nesting without trying to display or
  // parse an untrusted payload.
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = decodeEscapeLayer(value);
    if (decoded === value) break;
    value = decoded;
  }
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
};

const hasStatus = (text: string, status: number): boolean =>
  new RegExp(`\\b${status}\\b`).test(text);

const hasImageDimensionError = (text: string): boolean =>
  // Keep these patterns independent of closing JSON quotes/brackets: logs are
  // commonly truncated after the provider's useful diagnostic text.
  /\bimage\s+(?:length\s+and\s+)?width\b[\s\S]{0,120}\b(?:do\s+not|does\s+not|don't|doesn't)\s+meet\b/.test(
    text,
  ) ||
  /\b(?:image|photo|picture|input)\b[\s\S]{0,100}\bdimensions?\b[\s\S]{0,120}\b(?:restric\w*|too\s+small|must\s+be\s+(?:larger|greater)|minimum|min\b)/.test(
    text,
  ) ||
  (/\b(?:height|width)\s*[:=]\s*\d+\b[\s\S]{0,100}\b(?:must\s+be\s+(?:larger|greater)|too\s+small|minimum|min\b)/.test(
    text,
  ) &&
    /\b(?:image|model|dimension|width|height|length)\b/.test(text));

const hasAuthenticationError = (text: string): boolean =>
  hasStatus(text, 401) ||
  hasStatus(text, 403) ||
  /\b(?:unauthori[sz]ed|forbidden|authentication\s+failed|invalid\s+(?:api\s+)?key)\b/.test(
    text,
  );

const hasRateLimitError = (text: string): boolean =>
  hasStatus(text, 429) ||
  /\b(?:rate[- ]?limit(?:ed|ing)?|too\s+many\s+requests|quota\s+exceeded)\b/.test(
    text,
  );

const hasUnavailableError = (text: string): boolean =>
  /\b5\d{2}\b/.test(text) ||
  /\b(?:internal\s+server\s+error|bad\s+gateway|service\s+unavailable|provider\s+unavailable)\b/.test(
    text,
  );

const hasTimeoutError = (text: string): boolean =>
  /\b(?:timed\s+out|timeout|deadline\s+exceeded|etimedout)\b/.test(text);

const hasConnectionError = (text: string): boolean =>
  /\b(?:fetch\s+failed|failed\s+to\s+fetch|network\s+error|connection\s+(?:refused|reset|closed|failed)|econn(?:refused|reset)|enotfound|eai_again|socket\s+hang\s+up|could\s+not\s+connect|unable\s+to\s+connect)\b/.test(
    text,
  );

const hasEndpointError = (text: string): boolean =>
  /\b(?:unexpected\s+endpoint|unexpected\s+method|invalid\s+endpoint)\b/.test(
    text,
  ) ||
  (/post\s+\/chat\/completions/.test(text) &&
    /\b(?:base\s*url|endpoint|\/v1)\b/.test(text));

const hasToolCallingError = (text: string): boolean =>
  /\b(?:required\s+tool\s+preflight\s+call|did\s+not\s+return\s+(?:a\s+)?tool\s+call|tool[- ]calling\s+support)\b/.test(
    text,
  );

const hasRunnerExit = (text: string): boolean =>
  /\b(?:foreground\s+)?runner\s+exited\s+before\s+completion\b/.test(text) ||
  /\b(?:process|evaluation)\s+(?:runner\s+)?(?:stopped|exited)\s+before\s+completion\b/.test(
    text,
  );

export function describeRunError(raw: string): RunErrorDescription {
  const text = normalizeForMatching(raw);

  // Specific provider diagnostics are more useful than the wrapper error that
  // often surrounds them. HTTP status classes follow before transport and
  // runner fallbacks, so e.g. a 504 is presented as provider unavailability.
  if (hasImageDimensionError(text)) return IMAGE_DIMENSIONS;
  if (hasAuthenticationError(text)) return AUTHENTICATION;
  if (hasRateLimitError(text)) return RATE_LIMIT;
  if (hasUnavailableError(text)) return UNAVAILABLE;
  if (hasTimeoutError(text)) return TIMEOUT;
  if (hasEndpointError(text)) return ENDPOINT;
  if (hasToolCallingError(text)) return TOOL_CALLING;
  if (hasConnectionError(text)) return CONNECTION;
  if (hasRunnerExit(text)) return RUNNER_EXITED;
  return UNKNOWN;
}
