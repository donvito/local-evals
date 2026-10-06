import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  anchorFromHash,
  helpText,
  matchesHelpQuery,
} from "../src/dashboard/help-search.js";

describe("helpText", () => {
  it("collects text from nested elements and arrays", () => {
    const node = createElement(
      "p",
      null,
      "In ",
      createElement("strong", null, "Providers"),
      [", enable ", createElement("code", { key: "v" }, "Vision")],
      false,
      null,
      3,
    );
    expect(helpText(node)).toContain("Providers");
    expect(helpText(node)).toContain("Vision");
    expect(helpText(node)).toContain("3");
  });

  it("collects text passed as data to visual components, not attributes", () => {
    const Diagram = (_: { nodes: { label: string; kind: string }[] }) => null;
    const node = createElement(
      "div",
      { className: "secret-class", "aria-label": "hidden label" },
      createElement(Diagram, { nodes: [{ label: "OCR model", kind: "model" }] }),
    );
    const text = helpText(node);
    expect(text).toContain("OCR model");
    expect(text).not.toContain("secret-class");
    expect(text).not.toContain("hidden label");
    expect(text).not.toContain("model model");
  });
});

describe("matchesHelpQuery", () => {
  it("requires every term, ignoring case, accents, and order", () => {
    expect(matchesHelpQuery("Schema-constrained JSON output", "json SCHEMA")).toBe(true);
    expect(matchesHelpQuery("Résumé fields", "resume")).toBe(true);
    expect(matchesHelpQuery("Schema-constrained JSON", "json vision")).toBe(false);
  });

  it("matches everything for a blank query", () => {
    expect(matchesHelpQuery("anything", "   ")).toBe(true);
  });
});

describe("anchorFromHash", () => {
  it.each([
    ["#help/troubleshooting", "help", "troubleshooting"],
    ["#help/api-keys", "help", "api-keys"],
    ["#cli/target-add", "cli", "target-add"],
    ["#cli/run", "help", null],
    ["#help", "help", null],
    ["#help/", "help", null],
    ["#help/a/b", "help", null],
    ["#helpx/run", "help", null],
    ["#help/<script>", "help", null],
  ])("parses %s for #%s", (hash, route, expected) => {
    expect(anchorFromHash(hash, route)).toBe(expected);
  });
});
