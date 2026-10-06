export type CliOption = { flag: string; description: string };
export type CliCommand = {
  name: string;
  args?: string;
  group: string;
  summary: string;
  description?: string;
  options?: CliOption[];
  notes?: string[];
  examples?: string[];
  ignoresDb?: boolean;
};

export const CLI_PREFIX = "npm run localevals --";
export const DEFAULT_DB_PATH = ".localevals/evalforge.db";
const DB_OPTION: CliOption = {
  flag: "--db <path>",
  description: `Database file to use (default: ${DEFAULT_DB_PATH})`,
};

export const CLI_COMMANDS: CliCommand[] = [
  {
    name: "init",
    group: "Datasets & models",
    summary: "Create the local database",
    description: "Creates the database file if it does not exist yet.",
  },
  {
    name: "import",
    args: "<manifest>",
    group: "Datasets & models",
    summary: "Import a dataset manifest (.jsonl or .json)",
    description:
      "Imports cases and copies their images into local storage. Expected answers are optional, so unlabeled data can be used for inference-only runs.",
    examples: [`${CLI_PREFIX} import sample-data/manifest.jsonl`],
  },
  {
    name: "target add",
    args: "<target.json>",
    group: "Datasets & models",
    summary: "Save a model target from a JSON file",
    description:
      "Saves a provider endpoint and model. Target files cannot contain API keys; set apiKeyEnv to the name of an environment variable that holds the key.",
  },
  {
    name: "target list",
    group: "Datasets & models",
    summary: "List saved targets",
  },
  {
    name: "target test",
    args: "<name>",
    group: "Datasets & models",
    summary: "Check that a target responds",
    options: [{ flag: "--vision true", description: "Also send a test image" }],
    examples: [`${CLI_PREFIX} target test local-vision --vision true`],
  },
  {
    name: "run",
    args: "<manifest-or-dataset-version> <config.json>",
    group: "Evaluate",
    summary: "Run an evaluation and print its metrics",
    description:
      "Imports the manifest if needed, runs every case, and saves the results. Press Ctrl+C to cancel active requests.",
    options: [
      { flag: "--concurrency <1-32>", description: "Cases to run at once (overrides the config)" },
      { flag: "--threshold <0-1>", description: "Minimum pass rate for graded runs" },
    ],
    notes: [
      "Exit codes: 0 success, 1 run failed or was interrupted, 2 pass rate below --threshold, 130 cancelled.",
    ],
    examples: [
      `${CLI_PREFIX} run sample-data/manifest.jsonl sample-data/config.json`,
      `${CLI_PREFIX} run sample-data/manifest.jsonl sample-data/config.json --threshold 0.9`,
    ],
  },
  {
    name: "inspect",
    args: "[run-id]",
    group: "Results",
    summary: "List runs, or show one run as JSON",
  },
  {
    name: "compare",
    args: "<left-run> <right-run>",
    group: "Results",
    summary: "Compare two runs and print the differences",
  },
  {
    name: "export",
    args: "<run-id>",
    group: "Results",
    summary: "Export a run as JSON or Markdown",
    options: [
      { flag: "--format json|markdown", description: "Report format (default: json)" },
      { flag: "--out <file>", description: "Write to a new file instead of printing" },
    ],
    notes: ["--out never overwrites an existing file."],
    examples: [`${CLI_PREFIX} export <run-id> --format markdown --out report.md`],
  },
  {
    name: "serve",
    group: "App",
    summary: "Start the dashboard",
    options: [
      { flag: "--port <number>", description: "Port to listen on (default: 4173)" },
      { flag: "--host <address>", description: "Address to bind (default: 127.0.0.1)" },
    ],
  },
  {
    name: "backup",
    args: "--out <directory>",
    group: "App",
    summary: "Copy all app data to a new folder",
    description:
      "Stop the app first. The backup includes the credential key that decrypts saved API keys and is not encrypted, so keep it private.",
    options: [{ flag: "--out <directory>", description: "New folder to create (required)" }],
    examples: [`${CLI_PREFIX} backup --out ../local-evals-backup`],
  },
  {
    name: "restore",
    args: "<backup-directory> --to <directory>",
    group: "App",
    summary: "Restore a backup into a new data folder",
    description: "Never overwrites existing data. Start the app with the printed --db path afterwards.",
    options: [{ flag: "--to <directory>", description: "New data folder to create (required)" }],
    ignoresDb: true,
    examples: [`${CLI_PREFIX} restore ../local-evals-backup --to .localevals-restored`],
  },
];

export const commandSignature = (command: CliCommand) =>
  [command.name, command.args].filter(Boolean).join(" ");

const MAX_COLUMN = 30;
const columns = (rows: [string, string][], width?: number) => {
  const column =
    width ?? Math.min(MAX_COLUMN, Math.max(...rows.map(([left]) => left.length))) + 2;
  return rows
    .map(([left, right]) =>
      left.length + 2 > column
        ? `  ${left}\n  ${" ".repeat(column)}${right}`
        : `  ${left.padEnd(column)}${right}`,
    )
    .join("\n");
};

export function formatHelp() {
  const groups = [...new Set(CLI_COMMANDS.map((command) => command.group))];
  const rows = (group: string) =>
    CLI_COMMANDS.filter((command) => command.group === group).map(
      (command): [string, string] => [commandSignature(command), command.summary],
    );
  const width =
    Math.min(
      MAX_COLUMN,
      Math.max(...CLI_COMMANDS.map((command) => commandSignature(command).length)),
    ) + 2;
  return [
    "Local Evals CLI",
    "",
    `Usage: ${CLI_PREFIX} <command> [options]`,
    ...groups.flatMap((group) => ["", group, columns(rows(group), width)]),
    "",
    "Global options",
    columns([[DB_OPTION.flag, DB_OPTION.description]], width),
    "",
    `Run "${CLI_PREFIX} help <command>" for options and examples.`,
  ].join("\n");
}

export function formatCommandHelp(name: string) {
  const matches = CLI_COMMANDS.filter(
    (command) => command.name === name || command.name.split(" ")[0] === name,
  );
  if (!matches.length) return undefined;
  return matches
    .map((command) => {
      const options = [...(command.options ?? []), ...(command.ignoresDb ? [] : [DB_OPTION])];
      return [
        `Usage: ${CLI_PREFIX} ${commandSignature(command)} [options]`,
        "",
        command.description ?? command.summary,
        "",
        "Options",
        columns(options.map((option) => [option.flag, option.description])),
        ...(command.notes?.length ? ["", ...command.notes] : []),
        ...(command.examples?.length
          ? ["", "Examples", ...command.examples.map((example) => "  " + example)]
          : []),
      ].join("\n");
    })
    .join("\n\n");
}
