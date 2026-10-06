import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, formatCommandHelp, formatHelp } from "../src/cli-help.js";

describe("CLI help", () => {
  it("lists every command with its summary", () => {
    const help = formatHelp();
    for (const command of CLI_COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.summary);
    }
    expect(help).toContain("--db <path>");
  });

  it("documents only commands the CLI dispatches", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    for (const command of CLI_COMMANDS) {
      const [name, sub] = command.name.split(" ");
      expect(source).toContain(`command === "${name}"`);
      if (sub) expect(source).toContain(`p[0] === "${sub}"`);
    }
  });

  it("shows options, exit codes, and examples for a command", () => {
    const help = formatCommandHelp("run")!;
    expect(help).toContain("--threshold <0-1>");
    expect(help).toContain("Exit codes");
    expect(help).toContain("Examples");
  });

  it("groups subcommands and omits --db where it is ignored", () => {
    expect(formatCommandHelp("target")).toMatch(/target add[\s\S]*target list[\s\S]*target test/);
    expect(formatCommandHelp("restore")).not.toContain("--db <path>");
    expect(formatCommandHelp("backup")).toContain("--db <path>");
  });

  it("returns nothing for an unknown command", () => {
    expect(formatCommandHelp("nope")).toBeUndefined();
  });
});
