import type { TargetConfig } from "./types.js";
const secrets = new Set<string>();
export function registerSecrets(targets: TargetConfig[]) {
  for (const t of targets) if (t.apiKey) secrets.add(t.apiKey);
  for (const t of targets)
    if (t.apiKeyEnv && process.env[t.apiKeyEnv])
      secrets.add(process.env[t.apiKeyEnv]!);
}
export function sanitize<T>(value: T): T {
  function clean(v: any): any {
    if (typeof v === "string") {
      for (const secret of secrets) v = v.split(secret).join("[REDACTED]");
      return v;
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, c]) => [k, clean(c)]),
      );
    return v;
  }
  return clean(value);
}
export function validateTarget(value: any): asserts value is TargetConfig {
  if (typeof value?.apiKeyEnv === "string")
    value.apiKeyEnv = value.apiKeyEnv.trim();
  if (
    typeof value?.apiKeyEnv === "string" &&
    /^(sk-|bearer\s)/i.test(value.apiKeyEnv)
  )
    throw new Error(
      "API key env must be a variable name such as OPENROUTER_API_KEY; do not paste the API key here.",
    );
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim()
  )
    throw new Error("Target name and model are required.");
  const url = new URL(value.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Target URL must be HTTP(S) without credentials or query parameters.",
    );
  const hasLiteral = (v: any): boolean =>
    !!v &&
    typeof v === "object" &&
    Object.entries(v).some(
      ([k, c]) =>
        /^(api[_-]?key|authorization|password|secret|token)$/i.test(k) ||
        hasLiteral(c),
    );
  if (hasLiteral(value))
    throw new Error("Use apiKeyEnv rather than a literal credential.");
  if (value.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))
    throw new Error("Invalid API key environment variable name.");
  if (
    value.provider &&
    !["llama.cpp", "openrouter", "openai-compatible"].includes(value.provider)
  )
    throw new Error("Unknown provider.");
}
