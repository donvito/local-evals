import { describe, expect, it } from "vitest";
import { jsonTokens, looksLikeJson } from "../src/dashboard/json-highlight.js";

describe("jsonTokens", () => {
  it("classifies keys, strings, numbers, literals, and punctuation", () => {
    const tokens = jsonTokens('{"total": -12.5, "tags": ["a\\"b", true, null], "n": 1e3}').filter(
      (token) => token.type !== "text",
    );
    expect(tokens).toEqual([
      { type: "punctuation", text: "{" },
      { type: "key", text: '"total"' },
      { type: "punctuation", text: ":" },
      { type: "number", text: "-12.5" },
      { type: "punctuation", text: "," },
      { type: "key", text: '"tags"' },
      { type: "punctuation", text: ":" },
      { type: "punctuation", text: "[" },
      { type: "string", text: '"a\\"b"' },
      { type: "punctuation", text: "," },
      { type: "literal", text: "true" },
      { type: "punctuation", text: "," },
      { type: "literal", text: "null" },
      { type: "punctuation", text: "]" },
      { type: "punctuation", text: "," },
      { type: "key", text: '"n"' },
      { type: "punctuation", text: ":" },
      { type: "number", text: "1e3" },
      { type: "punctuation", text: "}" },
    ]);
  });

  it("keeps every character so the text is unchanged", () => {
    const text = '{\n  "a": "x y",\n  "b": [1, 2]\n}';
    expect(jsonTokens(text).map((token) => token.text).join("")).toBe(text);
  });
});

describe("looksLikeJson", () => {
  it("accepts JSON values and JSON Lines but not prose", () => {
    expect(looksLikeJson('{"a": 1}')).toBe(true);
    expect(looksLikeJson('{"a": 1}\n{"a": 2}\n')).toBe(true);
    expect(looksLikeJson("[1, 2]")).toBe(true);
    expect(looksLikeJson("Total: $104.50")).toBe(false);
    expect(looksLikeJson("npm run localevals -- help")).toBe(false);
    expect(looksLikeJson("")).toBe(false);
  });
});
