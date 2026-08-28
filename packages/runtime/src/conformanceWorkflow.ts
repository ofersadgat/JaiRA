/**
 * The conformance check, as a workflow: does what `.jaira/workflows/**` runs match
 * the flow a person described in English?
 *
 * It is authored as a workflow rather than written as a bare model call for the
 * same reason the demo workflow is: JaiRA already knows how to run one. Model
 * defaults, output-schema repair, cost roll-up, cancellation and `--fake` all come
 * for free, and the check is scriptable in tests without a provider.
 *
 * **Two states, not one.** Extraction is separated from judgement because a single
 * "does this match?" call answers about the document as a whole, and a document as
 * a whole is always *partly* implemented. Enumerating the requirements first forces
 * the check to be per-claim — which is also what makes the output actionable, since
 * every finding names the requirement it came from and the states that are its
 * evidence.
 *
 * The judge sees the states AS AUTHORED plus their resolved operations (see
 * `workflowDigest`), so it judges what will run rather than what a summary of it
 * would have said.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/exec";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.runtime.conformanceWorkflow");

export const CONFORMANCE_ID = "workflow/conformance";

/** How a single requirement fared. `contradicted` means the workflow does the opposite. */
export type ConformanceStatus = "satisfied" | "partial" | "missing" | "contradicted";

/** `conforms` only when every requirement is satisfied. */
export type ConformanceVerdict = "conforms" | "gaps" | "diverges";

export interface ConformanceRequirement {
  /** `R1`, `R2`, … in document order. */
  id: string;
  requirement: string;
  category: "step" | "order" | "branching" | "human_gate" | "agent" | "data" | "other";
  /** The sentence in the description this came from, so a wrong reading is visible. */
  quote: string;
}

export interface ConformanceFinding {
  id: string;
  requirement: string;
  status: ConformanceStatus;
  /** State ids that are the evidence — empty when nothing implements it. */
  states: string[];
  detail: string;
}

export interface ConformanceExtra {
  states: string[];
  detail: string;
}

export interface ConformanceReport {
  verdict: ConformanceVerdict;
  requirements: ConformanceRequirement[];
  findings: ConformanceFinding[];
  extras: ConformanceExtra[];
}

const STATUSES: ConformanceStatus[] = ["satisfied", "partial", "missing", "contradicted"];
const VERDICTS: ConformanceVerdict[] = ["conforms", "gaps", "diverges"];

const markdown = { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } as const;
const strings = { type: "array", items: { type: "string" } };

const REQUIREMENT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "R1, R2, … in the order the description makes the claim" },
      requirement: { type: "string", description: "one checkable claim, in your own words" },
      category: {
        type: "string",
        enum: ["step", "order", "branching", "human_gate", "agent", "data", "other"],
      },
      quote: { type: "string", description: "the sentence in the description this came from" },
    },
    required: ["id", "requirement", "category", "quote"],
    additionalProperties: false,
  },
};

const FINDING_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "the requirement id this answers" },
      requirement: { type: "string" },
      status: { type: "string", enum: STATUSES },
      states: { ...strings, description: "state ids that are the evidence; empty when nothing implements it" },
      detail: { type: "string", description: "what is there, and for anything unsatisfied what would have to change" },
    },
    required: ["id", "requirement", "status", "states", "detail"],
    additionalProperties: false,
  },
};

const EXTRA_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      states: strings,
      detail: { type: "string" },
    },
    required: ["states", "detail"],
    additionalProperties: false,
  },
};

const VERDICT_SCHEMA = { type: "string", enum: VERDICTS };

export interface ConformanceWorkflowOptions {
  /**
   * Model for both states. Absent ⇒ the project's `models.default` supplies it
   * through the executor's defaults, which is the ordinary case; a fake run needs
   * no model at all.
   */
  model?: string;
}

const EXTRACT_PROMPT = `You are reading a document in which a person describes, in English, the workflow they want a
system to run. Break it into the individual requirements a reviewer could check one at a time.

Cover everything the document actually claims:

- each step of work, and what it produces;
- the ORDER steps happen in, and what must finish before what;
- branching, loops, retries, and the conditions that drive them;
- every point where a HUMAN must decide, approve, or be asked;
- which work is delegated to a coding agent, which is a model call, and which is plain code or a
  tool, where the document says;
- the inputs, outputs, documents and artifacts each step consumes or produces.

Number them R1, R2, … in the order the document makes them. Rules:

- Record only what the document says or clearly implies. Do NOT add requirements from your own idea
  of what a good workflow should do — an unstated step is not a requirement.
- Do not merge two separate claims into one requirement; a reviewer must be able to answer each one
  independently.
- Quote the sentence each requirement came from, verbatim.

The document:

{{.inputs.spec}}`;

const ASSESS_PROMPT = `You are checking whether a set of implemented workflows runs the flow a person described in English.

You are given the description, the requirements extracted from it, and the implemented workflows as
authored. For EACH requirement, decide:

- \`satisfied\` — the workflow does this.
- \`partial\` — some of it is there, but not all: a step exists but nothing enforces the order, a loop
  exists but is capped where the description asked for "until", a review happens but no human sees it.
- \`missing\` — nothing in the workflow does this.
- \`contradicted\` — the workflow does something incompatible with it.

Judge the workflow as it will RUN, not as it reads:

- Order comes from \`sequence\` AND from dataflow — a child whose inputs read a sibling's outputs waits
  for that sibling, and two children with no dependency between them run at the same time. A
  described "then" that is implemented as two independent children is not satisfied.
- Branching, loops and early exits come from \`transitions\` and \`limits\`.
- A state's operation may be inherited from an ancestor or from the mount that declares it; the
  \`resolved:\` line is what the engine will actually run.
- A human decision point must be a state whose function renders a gate to a person. A prompt state
  that merely reviews something is a model, not a human.
- Delegated agents (\`claude-cli\`, \`codex-cli\`, a configured generic CLI) are not the same as a model
  call, and neither is the same as plain code.

Do NOT treat naming differences as divergence: a state called \`critique\` can satisfy a requirement
about "reviewing the plan". Do treat a missing human gate, a missing loop, work in the wrong order, or
work delegated to a different kind of runtime than described, as a real difference.

Cite the state ids that are your evidence. For anything not satisfied, say specifically what the
workflow would have to add or change — name the state and the field.

Some states are marked **described elsewhere**. Another document is the account of how they work
inside, and you have been given their contract instead of their states — deliberately, because this
description is not responsible for them. For such a state:

- judge only what the description claims ABOUT it: what it is for, what it takes and returns, where
  it sits in the order, whether a human is involved at its boundary;
- treat the contract and the quoted prose of the owning document as sufficient evidence. A
  requirement met inside that subtree is \`satisfied\`, not \`missing\` — you cannot see the states,
  and "I was not shown it" is not a finding;
- if a requirement is genuinely about that subtree's internals, it belongs to the other document.
  Say so in the detail, naming that document, and mark it \`satisfied\`.

Also list, as extras, behaviour the implementation has that the description does not mention. Extras
are not failures: they are what the reader should look at to decide whether the document or the
workflow is the thing that is out of date. Do not raise an extra about the inside of a state
described elsewhere.

The verdict is \`conforms\` only when every requirement is satisfied; \`gaps\` when any is partial or
missing; \`diverges\` when any is contradicted.

The description:

{{.inputs.spec}}

The requirements extracted from it:

{{.inputs.requirements}}

The implementation:

{{.inputs.implementation}}`;

/** The state files for the check, keyed by state id — loadable with `loadBundle`. */
export function conformanceWorkflowFiles(options: ConformanceWorkflowOptions = {}): Record<string, unknown> {
  const environment = { kind: "prompt", ...(options.model !== undefined ? { model: options.model } : {}) };
  return {
    [CONFORMANCE_ID]: {
      label: "Workflow conformance",
      description: "Check the project's workflows against an English description of the desired flow.",
      // Both children are prompt states on one model, so the leaves say only what differs.
      environment,
      inputs: { spec: markdown, implementation: markdown },
      // Every output carries its own schema rather than riding on the child's: these are what the
      // CLI renders and what `--json` prints, so the shape is part of the command's contract.
      outputs: {
        requirements: { schema: REQUIREMENT_SCHEMA, binding: ".children.requirements.output.requirements" },
        verdict: { schema: VERDICT_SCHEMA, binding: ".children.assessment.output.verdict" },
        findings: { schema: FINDING_SCHEMA, binding: ".children.assessment.output.findings" },
        extras: { schema: EXTRA_SCHEMA, binding: ".children.assessment.output.extras" },
      },
      children: {
        // No `state`: a child's key names the state it runs (WORKFLOWS.md §6).
        requirements: { inputs: { spec: ".inputs.spec" } },
        assessment: {
          inputs: {
            spec: ".inputs.spec",
            implementation: ".inputs.implementation",
            requirements: ".children.requirements.output.requirements",
          },
        },
      },
      sequence: ["requirements", "assessment"],
    },
    [`${CONFORMANCE_ID}/requirements`]: {
      label: "Extract requirements",
      inputs: { spec: markdown },
      outputs: { requirements: { schema: REQUIREMENT_SCHEMA } },
      operation: { prompt: EXTRACT_PROMPT },
    },
    [`${CONFORMANCE_ID}/assessment`]: {
      label: "Assess conformance",
      inputs: { spec: markdown, implementation: markdown, requirements: { schema: REQUIREMENT_SCHEMA } },
      outputs: {
        verdict: { schema: VERDICT_SCHEMA },
        findings: { schema: FINDING_SCHEMA },
        extras: { schema: EXTRA_SCHEMA },
      },
      operation: { prompt: ASSESS_PROMPT },
    },
  };
}

/**
 * Read a run's outputs as a report.
 *
 * Defensive on purpose: the slots are schema-checked by the engine, but this is
 * the boundary where a model's answer becomes an exit code, and a malformed
 * answer must fail loudly rather than silently score zero findings.
 */
export function conformanceReportOf(value: unknown): ConformanceReport {
  const outputs = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const findings = arrayOf(outputs["findings"]).map((raw, i) => {
    const row = record(raw, `findings[${i}]`);
    return {
      id: text(row["id"]),
      requirement: text(row["requirement"]),
      status: oneOf(row["status"], STATUSES, `findings[${i}].status`),
      states: arrayOf(row["states"]).map(text),
      detail: text(row["detail"]),
    };
  });
  const requirements = arrayOf(outputs["requirements"]).map((raw, i) => {
    const row = record(raw, `requirements[${i}]`);
    return {
      id: text(row["id"]),
      requirement: text(row["requirement"]),
      category: oneOf(
        row["category"],
        ["step", "order", "branching", "human_gate", "agent", "data", "other"] as const,
        `requirements[${i}].category`,
      ),
      quote: text(row["quote"]),
    };
  });
  const extras = arrayOf(outputs["extras"]).map((raw, i) => {
    const row = record(raw, `extras[${i}]`);
    return { states: arrayOf(row["states"]).map(text), detail: text(row["detail"]) };
  });
  return {
    verdict: oneOf(outputs["verdict"], VERDICTS, "verdict"),
    requirements,
    findings,
    extras,
  };
}

/**
 * The verdict the findings themselves support.
 *
 * The check reports a verdict AND its findings, and the two can disagree — a model
 * that lists a missing requirement and then says "conforms" is not a hypothetical.
 * The findings are the evidence, so they win, and the caller reports the
 * disagreement rather than hiding it.
 */
export function verdictOfFindings(findings: readonly ConformanceFinding[]): ConformanceVerdict {
  if (findings.some((f) => f.status === "contradicted")) return "diverges";
  if (findings.some((f) => f.status === "missing" || f.status === "partial")) return "gaps";
  return "conforms";
}

/** Fake rules that drive the check with no provider — the CLI test's script. */
export function conformanceRules(report: {
  requirements: ConformanceRequirement[];
  verdict: ConformanceVerdict;
  findings: ConformanceFinding[];
  extras?: ConformanceExtra[];
}): Array<{ promptIncludes: string; output: JsonValue }> {
  return [
    {
      promptIncludes: "Break it into the individual requirements",
      output: { requirements: report.requirements as unknown as JsonValue },
    },
    {
      promptIncludes: "You are checking whether a set of implemented workflows",
      output: {
        verdict: report.verdict,
        findings: report.findings as unknown as JsonValue,
        extras: (report.extras ?? []) as unknown as JsonValue,
      },
    },
  ];
}

// --- Parsing helpers ---------------------------------------------------------

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal(log, `the check returned a malformed ${at}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw refusal(log, `the check returned '${String(value)}' for ${at}; expected one of ${allowed.join(", ")}`);
}
