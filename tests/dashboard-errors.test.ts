import { describe, expect, it } from "vitest";
import { describeRunError } from "../src/dashboard/errors.js";

describe("describeRunError", () => {
  it("recognizes an escaped, nested, truncated image restriction", () => {
    const raw = String.raw`Runner failed: {\"error\":\"<400> InternalError.Algo.InvalidParameter: The image length and width do not meet the model restrictions. [height:1 or width:1 must be larger than 10`;
    const description = describeRunError(raw);

    expect(description).toEqual({
      title: "Image dimensions rejected",
      message:
        "The provider reports that an image may be too small in width or height for this model.",
      action:
        "Check whether a tiny test image caused this; otherwise inspect the original image, replace or re-export it at a valid full size, or choose a compatible model.",
    });
    expect(Object.values(description).join(" ")).not.toContain("height:1");
    expect(Object.values(description).join(" ")).not.toContain("InternalError");
  });

  it("handles nested unicode escapes without requiring complete JSON", () => {
    const raw = String.raw`provider response: {\"error\":\"\\u003c400\\u003e image dimensions are too small for this model`;

    expect(describeRunError(raw).title).toBe("Image dimensions rejected");
  });

  it("ignores malformed unicode escapes without throwing", () => {
    expect(() => describeRunError(String.raw`provider: \\u{ffffff}`)).not.toThrow();
    expect(describeRunError(String.raw`provider: \\u{ffffff}`).title).toBe(
      "Run failed",
    );
  });

  it.each([
    ["401 Unauthorized", "Authentication failed"],
    ["provider returned 403: forbidden", "Authentication failed"],
    ["HTTP 429 Too Many Requests", "Rate limit reached"],
    ["request timed out", "Request timed out"],
    ["TypeError: fetch failed", "Provider connection failed"],
    ["provider returned 503 Internal Server Error", "Provider unavailable"],
    ["Foreground runner exited before completion.", "Runner exited before completion"],
  ])("classifies %s", (raw, title) => {
    expect(describeRunError(raw).title).toBe(title);
  });

  it("returns safe generic copy for an unknown error", () => {
    const secret = "sk-test-secret";
    const description = describeRunError(`opaque provider payload: ${secret}`);

    expect(description).toEqual({
      title: "Run failed",
      message: "The run could not be completed.",
      action: "Consult the technical details for more context, then retry the run.",
    });
    expect(Object.values(description).join(" ")).not.toContain(secret);
  });

  it("prefers a specific nested image diagnosis over wrapper classifiers", () => {
    const raw =
      "runner exited before completion: provider returned 400: image dimensions are too small";

    expect(describeRunError(raw).title).toBe("Image dimensions rejected");
  });

  it("does not invent an exact minimum dimension", () => {
    const description = describeRunError(
      "<400> image length and width do not meet the model restrictions",
    );

    expect(Object.values(description).join(" ")).not.toMatch(/\b\d+\s*[x×]\s*\d+\b/);
    expect(Object.values(description).join(" ")).not.toMatch(/larger than \d+/i);
  });
});
