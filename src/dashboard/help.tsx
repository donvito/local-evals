import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CLI_COMMANDS,
  CLI_PREFIX,
  DEFAULT_DB_PATH,
  commandSignature,
  type CliCommand,
} from "../cli-help.js";
import { anchorFromHash, helpText, matchesHelpQuery } from "./help-search.js";
import { HighlightedJson, looksLikeJson } from "./json-highlight.js";
import { PageTitle } from "./page-title.js";

export type HelpDestination =
  | "setup"
  | "targets"
  | "datasets"
  | "experiments"
  | "runs"
  | "compare"
  | "help"
  | "cli";
type DocRoute = "help" | "cli";
type HelpTopic = {
  id: string;
  title: string;
  heading?: ReactNode;
  body: ReactNode;
  keywords?: string;
};
type HelpSection = {
  id: string;
  nav: string;
  title: string;
  intro?: ReactNode;
  content?: ReactNode;
  topics?: HelpTopic[];
  keywords?: string;
  variant?: "fixes";
};

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const routeHash = (route: DocRoute, anchor: string | null) =>
  `#${route}${anchor ? `/${anchor}` : ""}`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-button help-copy"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        })
      }
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

function HelpCode({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="help-code">
      <pre>
        {looksLikeJson(children) ? <HighlightedJson text={children} /> : <code>{children}</code>}
      </pre>
      {copy && <CopyButton text={children} label="Copy" />}
    </div>
  );
}

function OptionList({ options }: { options: { flag: string; description: string }[] }) {
  return (
    <dl className="help-options">
      {options.map((option) => (
        <div key={option.flag}>
          <dt>
            <code>{option.flag}</code>
          </dt>
          <dd>{option.description}</dd>
        </div>
      ))}
    </dl>
  );
}

const DB_OPTION = {
  flag: "--db <path>",
  description: `Database file to use (default: ${DEFAULT_DB_PATH})`,
};

type PipelineNode = { label: string; detail?: string; kind?: "data" | "model" | "result" };
function Pipeline({ nodes, label }: { nodes: PipelineNode[]; label: string }) {
  return (
    <ol className="help-pipeline" aria-label={label}>
      {nodes.map((node) => (
        <li key={node.label} className={`help-pipeline-node is-${node.kind ?? "data"}`}>
          <strong>{node.label}</strong>
          {node.detail && <span>{node.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

type WorkflowStep = {
  tab: HelpDestination;
  icon: string;
  title: string;
  place: string;
  tip: string;
};
type WorkflowStage = { label: string; steps: WorkflowStep[] };
function Workflow({
  stages,
  onTab,
}: {
  stages: WorkflowStage[];
  onTab: (tab: HelpDestination) => void;
}) {
  let number = 0;
  return (
    <div className="help-workflow">
      {stages.map((stage, index) => (
        <section key={stage.label} className="help-workflow-stage" aria-label={stage.label}>
          <header>
            <span className="help-workflow-badge">{index + 1}</span>
            {stage.label}
          </header>
          <ol>
            {stage.steps.map((step) => (
              <li key={step.title}>
                <button type="button" onClick={() => onTab(step.tab)}>
                  <span className="help-workflow-icon" aria-hidden="true">
                    <span className={`nav-icon icon-${step.icon}`} />
                  </span>
                  <span className="help-workflow-copy">
                    <small>Step {++number}</small>
                    <strong>{step.title}</strong>
                    <span>{step.tip}</span>
                  </span>
                  <span className="help-workflow-place">{step.place} →</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

type AnatomyField = { name: string; badge: "required" | "optional"; text: string };
function CaseAnatomy({ fields }: { fields: AnatomyField[] }) {
  return (
    <dl className="help-anatomy" aria-label="Fields in one case">
      {fields.map((field) => (
        <div key={field.name}>
          <dt>
            <code>{field.name}</code>
            <span className={`help-badge is-${field.badge}`}>{field.badge}</span>
          </dt>
          <dd>{field.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function buildGuide(onTab: (tab: HelpDestination) => void): HelpSection[] {
  const open = (tab: HelpDestination, label: string) => (
    <button className="button mini" type="button" onClick={() => onTab(tab)}>
      {label}
    </button>
  );
  return [
    {
      id: "overview",
      nav: "How it works",
      title: "How it works",
      intro:
        "Each case goes to a model, and its answer is checked against the answer you expected.",
      content: (
        <>
          <figure className="help-flow" aria-labelledby="help-flow-caption">
            <figcaption id="help-flow-caption">One case, from input to result</figcaption>
            <ol aria-label="From input to result">
              <li>
                <span>1 · Input</span>
                <strong>“3 notebooks, $4 each”</strong>
                <small>From your dataset</small>
              </li>
              <li>
                <span>2 · Model</span>
                <strong>Your target</strong>
                <small>Local or cloud</small>
              </li>
              <li>
                <span>3 · Output</span>
                <code>{'{"item": "notebook", "total": 12}'}</code>
                <small>Saved for review</small>
              </li>
              <li>
                <span>4 · Check</span>
                <ul className="help-checks" aria-label="Field checks">
                  <li className="is-pass">item = notebook</li>
                  <li className="is-pass">total = 12</li>
                </ul>
                <b className="help-verdict">Pass</b>
              </li>
            </ol>
          </figure>
          <div className="help-equation" aria-label="How the pieces fit together">
            <div className="help-tile">
              <span className="nav-icon icon-datasets" aria-hidden="true" />
              <strong>Dataset</strong>
              <small>Many cases</small>
            </div>
            <span className="help-operator" aria-hidden="true">+</span>
            <div className="help-tile">
              <span className="nav-icon icon-targets" aria-hidden="true" />
              <strong>Target</strong>
              <small>A model in Providers</small>
            </div>
            <span className="help-operator" aria-hidden="true">=</span>
            <div className="help-tile is-accent">
              <span className="nav-icon icon-runs" aria-hidden="true" />
              <strong>Run</strong>
              <small>A score for every case</small>
            </div>
            <span className="help-operator" aria-hidden="true">→</span>
            <div className="help-tile">
              <span className="nav-icon icon-experiments" aria-hidden="true" />
              <strong>Experiment</strong>
              <small>Related runs, grouped</small>
            </div>
          </div>
        </>
      ),
    },
    {
      id: "first-run",
      nav: "Your first evaluation",
      title: "Your first evaluation",
      intro: "Follow the sidebar from top to bottom. Select a step to open it.",
      content: (
        <>
          <Workflow
            onTab={onTab}
            stages={[
              {
                label: "Prepare",
                steps: [
                  {
                    tab: "targets",
                    icon: "targets",
                    title: "Connect a model",
                    place: "Providers",
                    tip: "Pick where it runs, enter the model, then Save & test.",
                  },
                  {
                    tab: "datasets",
                    icon: "datasets",
                    title: "Add examples",
                    place: "Datasets",
                    tip: "Select Add dataset and start with a quick sample.",
                  },
                ],
              },
              {
                label: "Evaluate",
                steps: [
                  {
                    tab: "setup",
                    icon: "setup",
                    title: "Configure and run",
                    place: "Setup",
                    tip: "The guided setup walks you through six short steps.",
                  },
                  {
                    tab: "runs",
                    icon: "runs",
                    title: "Review results",
                    place: "Runs",
                    tip: "Open a case to see the answer, scores, and logs.",
                  },
                ],
              },
              {
                label: "Analyze",
                steps: [
                  {
                    tab: "compare",
                    icon: "compare",
                    title: "Compare runs",
                    place: "Compare",
                    tip: "Find what improved or regressed between two runs.",
                  },
                  {
                    tab: "experiments",
                    icon: "experiments",
                    title: "Group your tries",
                    place: "Experiments",
                    tip: "Keep runs for one question together.",
                  },
                ],
              },
            ]}
          />
          <div className="help-mode-choice" aria-label="Two kinds of runs">
            <p>
              <span className="help-mode-visual" aria-hidden="true">
                <i className="is-pass">✓</i>
                <i className="is-fail">✗</i>
                <i className="is-pass">✓</i>
              </span>
              <strong>Graded evaluation</strong>
              <span>Every case has an expected answer. You get pass/fail and scores.</span>
            </p>
            <p>
              <span className="help-mode-visual" aria-hidden="true">
                <i>{"{ }"}</i>
                <i>{"{ }"}</i>
                <i>{"{ }"}</i>
              </span>
              <strong>Save outputs only</strong>
              <span>No expected answers yet. Outputs are saved without scores.</span>
            </p>
          </div>
        </>
      ),
    },
    {
      id: "types",
      nav: "Evaluation types",
      title: "Choose an evaluation type",
      intro: "Pick the type that matches what's in your dataset.",
      content: (
        <div className="help-type-list">
          <div>
            <h4>Document → JSON</h4>
            <p>Receipts, invoices, forms</p>
            <Pipeline
              label="Document to JSON pipeline"
              nodes={[
                { label: "Image", detail: "PNG or JPEG" },
                { label: "OCR model", detail: "Needs Vision", kind: "model" },
                { label: "Text" },
                { label: "Extraction model", kind: "model" },
                { label: "JSON fields", kind: "result" },
              ]}
            />
          </div>
          <div>
            <h4>Text → JSON</h4>
            <p>Messages, notes, records</p>
            <Pipeline
              label="Text to JSON pipeline"
              nodes={[
                { label: "Text" },
                { label: "Extraction model", kind: "model" },
                { label: "JSON fields", kind: "result" },
              ]}
            />
          </div>
          <div>
            <h4>Tool calling</h4>
            <p>Agents and assistants</p>
            <Pipeline
              label="Tool calling pipeline"
              nodes={[
                { label: "Text + tool list" },
                { label: "Model", detail: "Needs Tool calling", kind: "model" },
                { label: "Proposed call", detail: "Recorded, never executed", kind: "result" },
              ]}
            />
          </div>
        </div>
      ),
    },
    {
      id: "own-data",
      nav: "Use your own data",
      title: "Use your own data",
      intro: "Three ways to add cases. Every case follows the same shape.",
      content: (
        <>
          <div className="help-choices" aria-label="Ways to add data">
            <div>
              <span className="help-choice-icon" aria-hidden="true">⚡</span>
              <strong>Quick sample</strong>
              <span>One click in Datasets. Best for learning.</span>
            </div>
            <div>
              <span className="help-choice-icon" aria-hidden="true">⇪</span>
              <strong>Import a file</strong>
              <span>A dataset ZIP, or a JSONL or JSON manifest with your own cases.</span>
            </div>
            <div>
              <span className="help-choice-icon" aria-hidden="true">✦</span>
              <strong>Generate</strong>
              <span>A model drafts text or tool-calling cases.</span>
            </div>
          </div>
          <CaseAnatomy
            fields={[
              { name: "caseId", badge: "required", text: "A unique name for the case." },
              {
                name: "imagePath / inputText",
                badge: "required",
                text: "What the model reads: an image file or plain text.",
              },
              {
                name: "expected",
                badge: "optional",
                text: "The correct answer. Leave it out for inference-only runs.",
              },
              {
                name: "referenceTranscription",
                badge: "optional",
                text: "Document text you already have, to score OCR or skip it.",
              },
              { name: "metadata", badge: "optional", text: "Notes such as the source." },
            ]}
          />
        </>
      ),
      topics: [
        {
          id: "import-file",
          title: "Import a dataset file",
          keywords: "manifest path upload jsonl",
          body: (
            <>
              <p>
                In <strong>Datasets</strong>, select <strong>Add dataset</strong>,
                then <strong>Import a file</strong>. Drop or choose a dataset ZIP,
                or enter the path of a manifest or ZIP.
                You can also enter a path in the Data step of the guided setup. Use a path relative to the project
                folder, such as <code>datasets/receipts.jsonl</code>. Keep
                private files in <code>datasets/</code>, which Git ignores.
              </p>
              <p>
                Import copies images into local storage and versions the
                dataset by its contents. Changing cases or labels and importing
                again creates a new version, so earlier runs stay comparable.
              </p>
              {open("datasets", "Open Datasets")}
            </>
          ),
        },
        {
          id: "dataset-zip",
          title: "Dataset ZIP files",
          keywords: "zip upload archive bundle example folder layout images manifest drag drop",
          body: (
            <>
              <p>
                A dataset ZIP bundles a manifest with the images it lists, so
                one file holds the whole dataset:
              </p>
              <HelpCode>
                {`my-receipts.zip
├── manifest.jsonl     one case per line (or manifest.json)
├── assets/
│   ├── receipt-001.jpeg
│   └── receipt-002.png
├── README.md          optional, ignored
└── AGENTS.md          optional, ignored`}
              </HelpCode>
              <ul>
                <li>
                  Each <code>imagePath</code> is relative to the manifest and
                  must point to a PNG or JPEG inside the ZIP, such as{" "}
                  <code>assets/receipt-001.jpeg</code>.
                </li>
                <li>
                  The manifest can also sit inside one top-level folder, as
                  when you compress a folder in Finder or Explorer. If it isn&apos;t
                  named <code>manifest.jsonl</code> or <code>manifest.json</code>,
                  it must be the only <code>.jsonl</code>/<code>.json</code> file there.
                </li>
                <li>
                  A JSONL dataset is named after the ZIP. In{" "}
                  <code>manifest.json</code>, set <code>name</code> to choose one.
                </li>
                <li>
                  Uploads can be up to 512 MB. Standard ZIPs work; encrypted
                  ZIPs and symlinks are rejected.
                </li>
              </ul>
              <p>
                The quickest start is the example: three synthetic invoices,
                their manifest, a <code>README.md</code> describing every field,
                and an <code>AGENTS.md</code> with step-by-step rules for an AI
                coding agent building a new dataset from it. Replace the images,
                edit the manifest, and zip the files again, or hand the example
                to your agent.
              </p>
              <p>
                <a className="button secondary" href="/api/datasets/example.zip" download>
                  Download example ZIP
                </a>
              </p>
            </>
          ),
        },
        {
          id: "document-cases",
          title: "Document → JSON cases",
          keywords: "image receipt invoice png jpeg imagePath referenceTranscription",
          body: (
            <>
              <p>Write one JSON object per line in a <code>.jsonl</code> file:</p>
              <HelpCode>
                {'{"caseId":"invoice-001","imagePath":"assets/invoice.png","expected":{"total":104.5},"referenceTranscription":"Total: $104.50"}'}
              </HelpCode>
              <p>
                Give each case a unique <code>caseId</code>. Images must be PNG
                or JPEG, stored inside the manifest's folder (for example{" "}
                <code>datasets/receipts/assets/</code> next to{" "}
                <code>datasets/receipts/manifest.jsonl</code>). To add images,
                copy them there, add a line for each, and import again.{" "}
                <code>referenceTranscription</code> is optional and enables OCR
                scoring or extraction from reference text.
              </p>
            </>
          ),
        },
        {
          id: "text-cases",
          title: "Text → JSON cases",
          keywords: "inputText taskKind text-json",
          body: (
            <>
              <p>Use a JSON manifest that declares the evaluation type:</p>
              <HelpCode>
                {`{
  "taskKind": "text-json",
  "cases": [
    {
      "caseId": "inquiry-001",
      "inputText": "I was charged twice for order ORD-10482. Please refund the duplicate.",
      "expected": {
        "category": "billing",
        "urgency": "high",
        "sentiment": "negative",
        "orderNumber": "ORD-10482",
        "needsHuman": true
      }
    }
  ]
}`}
              </HelpCode>
              <p>
                Every case shares one schema, which you define in Setup with the
                instructions. Each <code>expected</code> lists the answer for
                that case. Extra fields in the model's answer count as errors,
                so give free-text fields like a summary an{" "}
                <code>"ignore"</code> rule in the Grading step.
              </p>
            </>
          ),
        },
        {
          id: "tool-cases",
          title: "Tool-calling cases",
          keywords: "function arguments taskKind tool-calling",
          body: (
            <>
              <p>
                Each expected answer is a list of function names and arguments:
              </p>
              <HelpCode>
                {`{
  "taskKind": "tool-calling",
  "cases": [
    {
      "caseId": "weather-001",
      "inputText": "Look up the weather in Example City.",
      "expected": [
        { "name": "lookup_weather", "arguments": { "city": "Example City" } }
      ]
    }
  ]
}`}
              </HelpCode>
              <p>
                Use <code>[]</code> when no call should be proposed. Define the
                matching tools and argument schemas in Setup.
              </p>
            </>
          ),
        },
        {
          id: "generate-dataset",
          title: "Have a model create a dataset",
          keywords: "synthetic generate brief create new dataset",
          body: (
            <>
              <p>
                In Datasets, select <strong>Add dataset</strong>, then{" "}
                <strong>Generate</strong>. Choose a model and a type, and describe
                the cases you want. Generation runs in the background, so you can leave the
                page and come back.
              </p>
              <p>
                This works for Text → JSON and Tool calling. Review the
                generated inputs and expected answers before relying on them.
              </p>
            </>
          ),
        },
        {
          id: "unlabeled-data",
          title: "No expected answers yet?",
          keywords: "unlabeled inference-only expected missing",
          body: (
            <p>
              Leave out <code>expected</code> and choose{" "}
              <strong>Save outputs only</strong> in Setup. The run saves every
              answer without scoring, so you can review outputs and label cases
              later.
            </p>
          ),
        },
      ],
    },
    {
      id: "settings",
      nav: "Settings explained",
      title: "Settings explained",
      intro:
        "You can start with sample settings. Open a topic when you need more control.",
      topics: [
        {
          id: "prompts-schemas",
          title: "Prompts, schemas, and tool definitions",
          body: (
            <>
              <p>
                A <strong>prompt</strong> tells the model what to do. A{" "}
                <strong>JSON schema</strong> defines the fields and types you
                want back, such as a number for <code>total</code>.{" "}
                <strong>Tool definitions</strong> describe the functions the
                model can suggest and the arguments they accept.
              </p>
              <p>
                For Text → JSON and Tool calling, review the editable
                instructions and definitions before using your own data.
                Document prompts and schemas come from a configuration file or
                sample settings.
              </p>
            </>
          ),
        },
        {
          id: "capabilities-json",
          title: "Model capabilities and JSON output",
          keywords: "vision structured output",
          body: (
            <>
              <p>
                In Providers, under <strong>Advanced options</strong>, tick only
                what your model supports: <strong>Can read images</strong>,{" "}
                <strong>Follows a JSON schema</strong>, and{" "}
                <strong>Can call tools</strong>. Picking a model from the list
                fills these in when the provider reports them.
              </p>
              <p>
                The <strong>JSON mode</strong> advanced option either asks for
                JSON in the prompt (the default) or asks the provider to enforce
                the schema, which needs a model that follows a JSON schema. If
                the provider can't enforce it, check the run warning or switch
                back.
              </p>
            </>
          ),
        },
        {
          id: "config-file",
          title: "Using a configuration file",
          body: (
            <>
              <p>
                In the Instructions step, choose <strong>Edit in the app</strong>{" "}
                to write the prompts and schema in Setup, or{" "}
                <strong>Use a configuration file</strong> to read them from a{" "}
                <code>.json</code> file in the project. Setup shows the file's
                prompts, schema, and grading rules so you can review them.
              </p>
              <p>
                Select <strong>Edit in the app</strong> on a file to copy it into
                the editors, then <strong>Save as file…</strong> to update it or
                save a new one. Saved files never contain API keys. Your dataset,
                models, and JSON mode always come from Setup.
              </p>
            </>
          ),
        },
        {
          id: "ocr-reference",
          title: "Document runs: OCR or reference text",
          body: (
            <div className="help-compare">
              <div>
                <h5>OCR</h5>
                <Pipeline
                  label="OCR source"
                  nodes={[
                    { label: "Image" },
                    { label: "OCR model", detail: "Needs Vision", kind: "model" },
                    { label: "Extraction model", kind: "model" },
                    { label: "JSON", kind: "result" },
                  ]}
                />
                <p>Tests reading and extraction together. Both stages can use the same model.</p>
              </div>
              <div>
                <h5>Reference transcription</h5>
                <Pipeline
                  label="Reference transcription source"
                  nodes={[
                    { label: "Text you supply", detail: "referenceTranscription" },
                    { label: "Extraction model", kind: "model" },
                    { label: "JSON", kind: "result" },
                  ]}
                />
                <p>Skips OCR to test extraction alone. Every case needs reference text.</p>
              </div>
            </div>
          ),
        },
        {
          id: "judges-limits",
          title: "Model judges and generation limits",
          keywords: "temperature max tokens rubric",
          body: (
            <>
              <p>
                A <strong>judge model</strong> (in the Grading step) gives a
                second model's opinion on document or text answers. It runs only
                when you also describe <strong>what the judge should check</strong>.
                Its verdict appears separately from the direct checks against
                expected answers.
              </p>
              <p>
                You can leave Temperature and Max tokens at their defaults for a
                first run. Increase Max tokens if an answer is cut off.
              </p>
            </>
          ),
        },
        {
          id: "experiments-compare",
          title: "Experiments and comparing runs",
          body: (
            <>
              <p>
                An <strong>experiment</strong> is a named group of related runs.
                Pick or create one on the last step of the guided setup, or open
                an experiment and select <strong>Add existing runs</strong>. Tick
                two runs in an experiment and select{" "}
                <strong>Compare selected</strong> to see what changed.
              </p>
              <p>
                <strong>Compare</strong> requires graded runs with the same
                dataset and compatible schema, grading rules, extraction source,
                and tool settings. Models and prompts may differ. Grouping runs
                in an experiment does not change these checks.
              </p>
              {open("experiments", "Open Experiments")}
            </>
          ),
        },
      ],
    },
    {
      id: "data-privacy",
      nav: "Data & privacy",
      title: "Data & privacy",
      intro: "Everything stays on your computer. Only case content goes to the models you choose.",
      content: (
        <div className="help-privacy" aria-label="Where data lives and travels">
          <div className="help-privacy-zone is-local">
            <span className="eyebrow">Your computer</span>
            <ul>
              <li>
                <strong>Dashboard & CLI</strong>
                <span>Runs locally</span>
              </li>
              <li>
                <strong>Datasets, runs, images</strong>
                <span>
                  <code>.localevals/</code>
                </span>
              </li>
              <li>
                <strong>API keys</strong>
                <span>Encrypted on disk</span>
              </li>
            </ul>
          </div>
          <div className="help-privacy-link" aria-hidden="true">
            <span>case content</span>
            <i>⇄</i>
            <span>answers</span>
          </div>
          <div className="help-privacy-zone">
            <span className="eyebrow">Your targets</span>
            <ul>
              <li>
                <strong>Local server</strong>
                <span>Stays on your machine</span>
              </li>
              <li>
                <strong>Cloud endpoint</strong>
                <span>Receives what it processes</span>
              </li>
            </ul>
          </div>
        </div>
      ),
      topics: [
        {
          id: "storage-location",
          title: "Where your data is stored",
          keywords: "database folder localevals sqlite",
          body: (
            <p>
              Datasets, imported images, runs, and saved setup live in{" "}
              <code>.localevals/</code> inside the project folder. The
              database is <code>{DEFAULT_DB_PATH}</code> unless you start the
              app with <code>--db</code> to choose another file.
            </p>
          ),
        },
        {
          id: "provider-data",
          title: "What model providers receive",
          keywords: "remote cloud openrouter send privacy",
          body: (
            <>
              <p>
                The app sends case content only to the targets you choose. OCR
                receives document images, and extraction receives text and any
                tool definitions. A judge receives your rubric, the expected
                answer, and the model's answer.
              </p>
              <p>
                Local servers keep everything on your machine. Cloud endpoints
                such as OpenRouter receive the content they process. Proposed
                tool calls are never executed.
              </p>
            </>
          ),
        },
        {
          id: "api-keys",
          title: "How API keys are stored",
          keywords: "credentials secret encrypted vault apiKeyEnv shared provider key openrouter once",
          body: (
            <>
              <p>
                Each provider's key is saved once, in <strong>Providers → API keys</strong> or
                the first time you add one of its models. Every model on the same server URL
                uses it, so adding another OpenRouter model needs no key. To use a different
                key for one model, edit it and choose <strong>Use a different key for this model</strong>.
              </p>
              <p>
                Keys are encrypted with a key file stored next to the database
                (<code>{`${DEFAULT_DB_PATH}.credentials.key`}</code>). Keep that file private:
                anyone with it and the database can read your saved keys. Target files used with
                the CLI must reference an environment variable with <code>apiKeyEnv</code> instead
                of containing a key.
              </p>
            </>
          ),
        },
        {
          id: "backups",
          title: "Back up or move your data",
          keywords: "backup restore migrate transfer",
          body: (
            <>
              <p>
                Stop the app, then create a backup in a new folder. The backup
                includes the credential key and is not encrypted, so store it
                somewhere private.
              </p>
              <HelpCode copy>{`${CLI_PREFIX} backup --out ../local-evals-backup`}</HelpCode>
              <p>
                Restore always creates a new data folder and never overwrites
                existing data. Keys stored in environment variables are not
                included.
              </p>
              <HelpCode copy>{`${CLI_PREFIX} restore ../local-evals-backup --to .localevals-restored`}</HelpCode>
            </>
          ),
        },
      ],
    },
    {
      id: "command-line",
      nav: "Command line",
      title: "Use the command line",
      keywords: "terminal cli script ci",
      content: (
        <>
          <p>
            You can import datasets, run evaluations, export reports, and back
            up your data from a terminal. With the same database, terminal runs
            appear in Runs too.
          </p>
          <HelpCode copy>{`${CLI_PREFIX} run sample-data/manifest.jsonl sample-data/config.json`}</HelpCode>
          {open("cli", "Open CLI reference")}
        </>
      ),
    },
    {
      id: "troubleshooting",
      nav: "Troubleshooting",
      title: "Troubleshooting",
      intro: "Find the symptom, then apply the fix.",
      variant: "fixes",
      topics: [
        {
          id: "missing-dataset",
          title: "My dataset is missing from Setup",
          body: (
            <p>
              Choose the same evaluation type as your dataset. A text dataset
              appears under Text → JSON, for example.
            </p>
          ),
        },
        {
          id: "missing-ocr-model",
          title: "My model is missing from the OCR picker",
          body: (
            <p>
              Open Providers, edit the model, and tick{" "}
              <strong>Can read images</strong> under Advanced options. Only do
              this for models that really accept images.
            </p>
          ),
        },
        {
          id: "connection-fails",
          title: "The connection test fails",
          body: (
            <p>
              Check the Base URL, Model ID, and API key. For a local provider,
              make sure its model server is running and reachable from the app.
              Most local servers expect a Base URL ending in <code>/v1</code>.
            </p>
          ),
        },
        {
          id: "editor-disabled",
          title: "The prompt or schema editor is disabled",
          body: (
            <p>
              A configuration file is supplying the settings. In the
              Instructions step, select <strong>Edit in the app</strong> to copy
              it into the editors.
            </p>
          ),
        },
        {
          id: "invalid-json",
          title: "The answer is incomplete or invalid JSON",
          body: (
            <p>
              Open the case in Runs and check Execution for a provider error or
              output limit. If the answer was cut off, increase Max tokens and
              run again. Check that your instructions ask for the fields in your
              schema.
            </p>
          ),
        },
        {
          id: "compare-unavailable",
          title: "I can't compare two runs",
          body: (
            <p>
              Compare needs two graded runs of the same dataset version with
              compatible schema, grading rules, extraction source, and tool
              settings. Runs that only save outputs can't be compared. If you edited
              the dataset, re-run both models on the new version.
            </p>
          ),
        },
      ],
    },
  ];
}

function buildCli(): HelpSection[] {
  const groups = [...new Set(CLI_COMMANDS.map((command) => command.group))];
  return [
    {
      id: "basics",
      nav: "Getting started",
      title: "Getting started",
      keywords: "terminal npm",
      content: (
        <>
          <p>
            Run commands from the project folder. Commands and the dashboard
            share the same database by default, so runs started in a terminal
            appear in Runs.
          </p>
          <HelpCode copy>{`${CLI_PREFIX} help`}</HelpCode>
          <p>
            Add <code>--help</code> after any command, or run{" "}
            <code>help &lt;command&gt;</code>, to see its options in the
            terminal. Most commands also accept:
          </p>
          <OptionList
            options={[
              DB_OPTION,
              { flag: "--help, -h", description: "Show help for a command" },
            ]}
          />
          <p className="help-note">
            <strong>Running in CI?</strong> <code>run</code> exits with code 2
            when the pass rate falls below <code>--threshold</code>, so a build
            can fail on a regression.
          </p>
        </>
      ),
    },
    ...groups.map(
      (group): HelpSection => ({
        id: slug(group),
        nav: group,
        title: group,
        topics: CLI_COMMANDS.filter((command) => command.group === group).map(
          (command: CliCommand) => ({
            id: slug(command.name),
            title: command.name,
            heading: <code>{commandSignature(command)}</code>,
            keywords: `${commandSignature(command)} ${command.group}`,
            body: (
              <>
                <p>
                  {command.summary}.
                  {command.description ? ` ${command.description}` : ""}
                </p>
                {command.options && <OptionList options={command.options} />}
                {command.notes?.map((note) => (
                  <p key={note} className="help-section-intro">
                    {note}
                  </p>
                ))}
                {command.examples?.map((example) => (
                  <HelpCode key={example} copy>
                    {example}
                  </HelpCode>
                ))}
              </>
            ),
          }),
        ),
      }),
    ),
  ];
}

type AnchorTarget = { section: string; texts: string[] };
const sectionText = (section: HelpSection) =>
  [section.nav, section.title, section.keywords, helpText(section.intro), helpText(section.content)].join(" ");
const topicText = (topic: HelpTopic) =>
  [topic.title, topic.keywords, helpText(topic.body)].join(" ");

function indexAnchors(sections: HelpSection[]) {
  const anchors = new Map<string, AnchorTarget>();
  for (const section of sections) {
    const topics = section.topics ?? [];
    anchors.set(section.id, {
      section: section.id,
      texts: [sectionText(section), ...topics.map(topicText)],
    });
    for (const topic of topics)
      anchors.set(topic.id, {
        section: section.id,
        texts: [sectionText(section), topicText(topic)],
      });
  }
  return anchors;
}
const visibleWhileSearching = (target: AnchorTarget | undefined, query: string) =>
  !query.trim() || !target || target.texts.some((text) => matchesHelpQuery(text, query));

function filterSections(sections: HelpSection[], query: string) {
  const visible: { section: HelpSection; topics: HelpTopic[]; showContent: boolean }[] = [];
  let count = 0;
  for (const section of sections) {
    const topics = section.topics ?? [];
    if (!query) {
      visible.push({ section, topics, showContent: true });
      continue;
    }
    const sectionHit = matchesHelpQuery(sectionText(section), query);
    const hits = topics.filter((topic) => matchesHelpQuery(topicText(topic), query));
    count += hits.length + (sectionHit ? 1 : 0);
    if (sectionHit) visible.push({ section, topics: hits.length ? hits : topics, showContent: true });
    else if (hits.length) visible.push({ section, topics: hits, showContent: false });
  }
  return { visible, count };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "es"}`;
let carriedQuery = "";

type DocPageProps = {
  route: DocRoute;
  title: string;
  sub: string;
  sections: HelpSection[];
  related: { route: DocRoute; label: string; sections: HelpSection[] };
  onTab: (tab: HelpDestination) => void;
};

function DocPage({ route, title, sub, sections, related, onTab }: DocPageProps) {
  const anchors = useRef(indexAnchors(sections)).current;
  const initialAnchor = anchorFromHash(window.location.hash, route);
  const [query, setQuery] = useState(() => {
    const carried = carriedQuery;
    carriedQuery = "";
    return carried;
  });
  const [active, setActive] = useState(initialAnchor ?? "");
  const [scrollRequest, setScrollRequest] = useState<{ anchor: string | null } | null>(
    initialAnchor ? { anchor: initialAnchor } : null,
  );
  const skipSpy = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const q = query.trim();
  const result = filterSections(sections, q);
  const relatedCount = q ? filterSections(related.sections, q).count : 0;
  const activeSection = anchors.get(active)?.section;
  const domId = (anchor: string) => `${route}-${anchor}`;

  const navigate = (anchor: string | null, updateHash = true) => {
    const target = anchor ? anchors.get(anchor) : undefined;
    if (anchor && !target) return;
    setQuery((current) => (visibleWhileSearching(target, current) ? current : ""));
    setActive(anchor ?? "");
    if (updateHash && window.location.hash !== routeHash(route, anchor))
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${routeHash(route, anchor)}`,
      );
    setScrollRequest({ anchor });
  };

  useEffect(() => {
    const pattern = new RegExp(`^#${route}(/|$)`);
    const sync = () => {
      if (pattern.test(window.location.hash))
        navigate(anchorFromHash(window.location.hash, route), false);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    if (!scrollRequest) return;
    const { anchor } = scrollRequest;
    const element = anchor
      ? document.getElementById(domId(anchor))
      : document.querySelector<HTMLElement>(".help-guide");
    if (!element) return;
    skipSpy.current = true;
    const timer = window.setTimeout(() => {
      skipSpy.current = false;
    }, 400);
    element.scrollIntoView({ block: "start" });
    element
      .querySelector<HTMLElement>(anchor ? "h3, h4" : "h2")
      ?.focus({ preventScroll: true });
    return () => window.clearTimeout(timer);
  }, [scrollRequest]);

  useEffect(() => {
    const container = document.querySelector<HTMLElement>(".help-guide");
    const main = document.querySelector<HTMLElement>("main.content");
    if (!container) return;
    const scroller =
      main &&
      /(auto|scroll)/.test(getComputedStyle(main).overflowY) &&
      main.scrollHeight > main.clientHeight
        ? main
        : window;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (skipSpy.current) return;
      const limit =
        (scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top) + 96;
      let current = "";
      for (const node of container.querySelectorAll<HTMLElement>("[data-doc-anchor]")) {
        if (node.getBoundingClientRect().top > limit) break;
        current = node.dataset.docAnchor ?? "";
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [q]);

  const anchorLink = (anchor: string, label: string) => (
    <a className="help-anchor" href={routeHash(route, anchor)} aria-label={`Link to ${label}`}>
      #
    </a>
  );
  const showRelated = () => {
    carriedQuery = query;
    onTab(related.route);
  };
  const clearSearch = () => {
    setQuery("");
    searchInput.current?.focus();
  };
  const firstVisible = result.visible[0]?.section.id;

  return (
    <div className="help-guide">
      <PageTitle
        eyebrow={route === "cli" ? "COMMAND LINE" : "HELP & GUIDES"}
        title={title}
        sub={sub}
        action={
          <button className="button secondary" type="button" onClick={() => onTab(related.route)}>
            {related.label} →
          </button>
        }
      />
      <div className="help-layout">
        <aside className="help-sidebar">
          <div className="help-search">
            <label className="sr-only" htmlFor={`${route}-search`}>
              Search this page
            </label>
            <input
              id={`${route}-search`}
              ref={searchInput}
              type="search"
              placeholder={route === "cli" ? "Search commands" : "Search the guide"}
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
            />
            <p className="help-search-status" role="status">
              {q ? (result.count ? plural(result.count, "match") : "No matches") : ""}
            </p>
            {q && result.count > 0 && relatedCount > 0 && (
              <button type="button" className="text-button help-search-more" onClick={showRelated}>
                {plural(relatedCount, "match")} in {related.label} →
              </button>
            )}
          </div>
          {result.visible.length > 0 && (
            <nav className="help-contents" aria-labelledby={`${route}-contents-title`}>
              <h3 id={`${route}-contents-title`} className="eyebrow">
                On this page
              </h3>
              <ul>
                {result.visible.map(({ section, topics }) => {
                  const current = (activeSection ?? firstVisible) === section.id;
                  return (
                    <li key={section.id}>
                      <button
                        type="button"
                        aria-current={current && active === section.id ? "true" : undefined}
                        data-active-section={current ? "true" : undefined}
                        onClick={() => navigate(section.id)}
                      >
                        {section.nav}
                      </button>
                      {current && topics.length > 0 && (
                        <ul className="help-contents-topics">
                          {topics.map((topic) => (
                            <li key={topic.id}>
                              <button
                                type="button"
                                aria-current={active === topic.id ? "true" : undefined}
                                onClick={() => navigate(topic.id)}
                              >
                                {topic.title}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}
        </aside>

        <article className="help-document" aria-label={title}>
          {result.visible.length === 0 && (
            <div className="help-empty">
              <p>
                <strong>No matches for “{q}”.</strong>
              </p>
              <p>
                {relatedCount
                  ? `${related.label} has ${plural(relatedCount, "match")}.`
                  : "Try a different word, or clear the search to see everything."}
              </p>
              <div className="help-empty-actions">
                {relatedCount > 0 && (
                  <button type="button" className="button mini" onClick={showRelated}>
                    Show matches in {related.label}
                  </button>
                )}
                <button type="button" className="text-button" onClick={clearSearch}>
                  Clear search
                </button>
              </div>
            </div>
          )}
          {result.visible.map(({ section, topics, showContent }) => (
            <section
              key={section.id}
              className={`help-section${section.variant ? ` help-section-${section.variant}` : ""}`}
              id={domId(section.id)}
              data-doc-anchor={section.id}
              aria-labelledby={`${domId(section.id)}-heading`}
            >
              <div className="help-section-head">
                <h3 id={`${domId(section.id)}-heading`} tabIndex={-1}>
                  {section.title}
                </h3>
                {anchorLink(section.id, section.title)}
              </div>
              {section.intro && <p className="help-section-intro">{section.intro}</p>}
              {showContent && section.content}
              {topics.map((topic) => (
                <article
                  key={topic.id}
                  id={domId(topic.id)}
                  className="help-topic"
                  data-doc-anchor={topic.id}
                  aria-labelledby={`${domId(topic.id)}-heading`}
                >
                  <div className="help-section-head">
                    <h4 id={`${domId(topic.id)}-heading`} tabIndex={-1}>
                      {topic.heading ?? topic.title}
                    </h4>
                    {anchorLink(topic.id, topic.title)}
                  </div>
                  {topic.body}
                </article>
              ))}
            </section>
          ))}
          {result.visible.length > 0 && (
            <button className="text-button help-back-top" type="button" onClick={() => navigate(null)}>
              Back to top ↑
            </button>
          )}
        </article>
      </div>
    </div>
  );
}

const CLI_SECTIONS = buildCli();
const GUIDE_INDEX_SECTIONS = buildGuide(() => {});

export function Help({ onTab }: { onTab: (tab: HelpDestination) => void }) {
  return (
    <DocPage
      route="help"
      title="Get started with Local Evals"
      sub="Learn the basics, run a sample, then explore the settings you need."
      sections={buildGuide(onTab)}
      related={{ route: "cli", label: "CLI reference", sections: CLI_SECTIONS }}
      onTab={onTab}
    />
  );
}

export function CliHelp({ onTab }: { onTab: (tab: HelpDestination) => void }) {
  return (
    <DocPage
      route="cli"
      title="Command-line reference"
      sub="Import data, run evaluations, and export results from a terminal or CI."
      sections={CLI_SECTIONS}
      related={{ route: "help", label: "Guide", sections: GUIDE_INDEX_SECTIONS }}
      onTab={onTab}
    />
  );
}
