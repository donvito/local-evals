import type { ReactNode } from "react";

export type JsonTokenType = "key" | "string" | "number" | "literal" | "punctuation" | "text";
export type JsonToken = { type: JsonTokenType; text: string };

const TOKEN =
  /("(?:\\.|[^"\\\n])*")(\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}[\],:]/g;
const MAX_HIGHLIGHT_LENGTH = 200_000;

/** True for text that is a JSON value or JSON Lines (every non-empty line starts with { or [). */
export const looksLikeJson = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_HIGHLIGHT_LENGTH) return false;
  if (!/^[[{]/.test(trimmed)) return false;
  return trimmed
    .split("\n")
    .filter((line) => line.trim())
    .every((line) => /^\s*[[{\]},"]|^\s*[-\d]|^\s*(true|false|null)/.test(line));
};

export function jsonTokens(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "text", text: text.slice(last, index) });
    const [whole, quoted, colon] = match;
    if (quoted && colon) {
      tokens.push({ type: "key", text: quoted });
      tokens.push({ type: "punctuation", text: colon });
    } else if (quoted) tokens.push({ type: "string", text: quoted });
    else if (/^(true|false|null)$/.test(whole)) tokens.push({ type: "literal", text: whole });
    else if (/^[{}[\],:]$/.test(whole)) tokens.push({ type: "punctuation", text: whole });
    else tokens.push({ type: "number", text: whole });
    last = index + whole.length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens;
}

/** Renders JSON with syntax colours; anything that isn't JSON is shown as plain text. */
export function HighlightedJson({ text }: { text: string }): ReactNode {
  if (!looksLikeJson(text)) return text;
  return (
    <code className="json-highlight">
      {jsonTokens(text).map((token, index) =>
        token.type === "text" ? (
          token.text
        ) : (
          <span key={index} className={`json-${token.type}`}>
            {token.text}
          </span>
        ),
      )}
    </code>
  );
}
