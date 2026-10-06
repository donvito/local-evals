import { describe, expect, it } from "vitest";
import { judgePrompt, parseJudgeReply } from "../src/core/runner.js";

describe("judge prompt and reply", () => {
  it("tells the judge exactly how to reply", () => {
    const prompt = judgePrompt("Is the vendor correct?", { vendor: "A" }, '{"vendor":"A"}');
    expect(prompt).toContain("Is the vendor correct?");
    expect(prompt).toContain('Expected:\n{"vendor":"A"}');
    expect(prompt).toMatch(/Reply with only a JSON object/);
    expect(prompt).toContain('"verdict": "pass" or "fail"');
  });

  it("reads plain JSON, fenced JSON, and JSON surrounded by a sentence", () => {
    const reply = { verdict: "pass", evidence: "Vendor matches." };
    expect(parseJudgeReply(JSON.stringify(reply))).toEqual(reply);
    expect(parseJudgeReply("```json\n" + JSON.stringify(reply) + "\n```")).toEqual(reply);
    expect(parseJudgeReply("Here is my verdict: " + JSON.stringify(reply) + " Thanks!")).toEqual(reply);
  });

  it("explains a prose reply instead of a raw parser error", () => {
    expect(() => parseJudgeReply("Yes. The document matches the expected answer.")).toThrow(
      /The judge didn't reply with JSON\. It started with: "Yes\. The document/,
    );
  });
});
