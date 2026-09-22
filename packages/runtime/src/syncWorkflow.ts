/**
 * The conformance check, made to act: bring a description and the state files back into step.
 *
 * `workflow check` answers "do these two agree?" and stops there, which is the right shape for a CI
 * gate and the wrong shape for someone sitting in front of both documents. What they want next is
 * the edit — and the edit is the part a person must read before it lands, because one side of this
 * pair is prose somebody wrote and the other is code that will run.
 *
 * So a sync is the check plus one more state, and there are two of them because there are two things
 * that can be out of date:
 *
 *  - {@link SYNC_DOCUMENT_ID} — rewrite the description so it says what the workflows do. Used when
 *    the workflows are what changed.
 *  - {@link SYNC_STATES_ID} — propose the FILES that close the gaps the document describes: state
 *    files under `workflows/`, and the prompt files under `prompts/` they reference. Used when the
 *    description is what changed.
 *
 * Both mount the conformance leaves unchanged (WORKFLOWS.md §11.1) rather than re-asking the same
 * two questions in new words. That reuse is not only economy: the requirements and findings are what
 * make the third state's job specific — "close R4, which nothing implements" rather than "make these
 * match" — and it means the report shown beside a proposal is the same report `jaira workflow check`
 * would have printed, produced by the same prompts.
 *
 * Neither direction writes anything. The states here return TEXT, and what happens to that text is
 * the caller's decision. For the states direction the caller lowers the proposals into a CHANGESET
 * (CHANGESETS.md §1) and walks it through the review gate — the same reviewer a worktree gets — and
 * {@link syncRespondPrompt} is the respond half of that loop: a comment sends the changeset back to
 * a model that revises it under the same authoring rules the proposal was written under.
 */
import { createLogger } from "@declarative-ai/log";
import { lowerToolset, parseToolset, refusal } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/exec";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.runtime.syncWorkflow");
// The wire vocabulary, not a copy of it: the app's IPC contract and these workflows must mean the
// same thing by "document", or a button would run the other direction.
import type { SyncDirection } from "@jaira/shared";
import { claudeAskSettings, CLAUDE_NATIVE_READ_TOOLS } from "./tools";
import {
  CONFORMANCE_ID,
  conformanceReportOf,
  conformanceWorkflowFiles,
  type ConformanceExtra,
  type ConformanceFinding,
  type ConformanceReport,
  type ConformanceRequirement,
  type ConformanceVerdict,
} from "./conformanceWorkflow";

export const SYNC_DOCUMENT_ID = "workflow/sync/document";
export const SYNC_STATES_ID = "workflow/sync/states";

/** The root state id for a direction. */
export function syncRootId(direction: SyncDirection): string {
  return direction === "document" ? SYNC_DOCUMENT_ID : SYNC_STATES_ID;
}

/** One thing the rewritten description says differently, and why. */
export interface DocumentChange {
  summary: string;
  /** The requirement ids behind it. Empty for a change that came from an extra. */
  requirements: string[];
}

export interface DocumentProposal {
  text: string;
  changes: DocumentChange[];
}

/**
 * One proposed file, whole. `path` is layer-root-relative, forward slashes — a state file
 * (`workflows/<state id>.json`) or a prompt file (`prompts/<name>.md`, in a category subfolder when
 * one fits). Path-addressed rather than state-addressed, deliberately: a proposal that can only
 * name states can never move a prompt into `prompts/`, and reusable prompts are the point.
 */
export interface SyncEdit {
  path: string;
  action: "create" | "update";
  text: string;
  reason: string;
  requirements: string[];
}

export interface SyncOutcome extends ConformanceReport {
  document?: DocumentProposal;
  edits?: SyncEdit[];
  /** Anything the run could not express as an edit — a gap that needs a person. */
  notes: string[];
}

const markdown = { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } as const;
const strings = { type: "array", items: { type: "string" } };

/**
 * The rewritten document, as a plain string rather than a blob.
 *
 * A blob output would be placed as an artifact by the run's artifact sink — correct for a state
 * that produces a deliverable, wrong for one whose whole purpose is to hand text back to an editor.
 * The value has to come back inline, because there is nowhere else it is going.
 */
const DOCUMENT_SCHEMA = { type: "string", description: "the complete rewritten description, in markdown" };

const CHANGES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      summary: { type: "string", description: "what you changed, in one line" },
      requirements: { ...strings, description: "the requirement ids this answers; empty for an extra" },
    },
    required: ["summary", "requirements"],
    additionalProperties: false,
  },
};

const EDITS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "where the file lives under the layer root: workflows/<state id>.json for a state file, prompts/<name>.md for a prompt",
      },
      action: { type: "string", enum: ["create", "update"] },
      text: { type: "string", description: "the COMPLETE file" },
      reason: { type: "string", description: "what in the description this closes" },
      requirements: { ...strings, description: "the requirement ids it answers" },
    },
    required: ["path", "action", "text", "reason", "requirements"],
    additionalProperties: false,
  },
};

const NOTES_SCHEMA = {
  ...strings,
  description: "anything that has to change but could not be written as a state file",
};

/**
 * The vocabulary a state file may use, restated for the state that has to WRITE one.
 *
 * The digest teaches by example — every existing state is in it — but example alone leaves the model
 * guessing about the fields no state in this project happens to use yet, and a guess becomes a file
 * that will not load. Short on purpose: this is the authoring surface (WORKFLOWS.md §§5–7), not the
 * whole reference.
 */
const STATE_FILE_RULES = `A state file is one JSON object. The fields that matter:

- \`label\`, \`description\` — for people.
- \`inputs\` / \`outputs\` — declared slots: \`{"name": {"schema": {...}}}\`. An output may carry a
  \`binding\` naming where its value comes from (\`.children.<key>.outputs.<name>\`).
- \`operation\` — \`{"prompt": …}\` for a model call, with the prompt text loaded from a file by
  reference (\`{"prompt": {"$ref": "$/prompts/<name>.md"}}\`) or inline as a string; or
  \`{"kind": "function", "function": "<registered name>"}\` for everything else. Absent for a state
  that only groups its children.
- \`children\` — \`{"<key>": {"inputs": {…}}}\`. The key names the child state
  (\`<this state's id>/<key>\`) unless the mount gives an explicit \`"state": "<id>"\`.
- \`sequence\` — the order children run in. Order also comes from dataflow: a child reading a
  sibling's outputs waits for it.
- \`transitions\` — \`[{"when": "<expression>", "to": "<state id or terminate.success>"}]\`, with
  \`limits.max_iterations\` capping a loop.
- \`environment\` — inherited by every child: \`{"kind": "prompt", "model": "…"}\`, or a function
  \`kind\` plus the executor the children run on.

Rules you must not break:

- A state's id IS its path, and the path you return is relative to the LAYER ROOT — which means it
  begins with \`workflows/\`. A child whose id is \`plan/critique\` is returned as
  \`"path": "workflows/plan/critique.json"\`, never as \`"path": "plan/critique.json"\`. The digest
  names states by id; the proposal names FILES.
- Only name a function that this project already uses somewhere in the digest. Inventing a function
  name produces a workflow that fails at the moment it reaches that state.
- Every input a child needs must be bound by the mount, and every binding must name something that
  exists.`;

/**
 * Where prompt text belongs — stated wherever the sync writes files, and emphasized because a
 * model's path of least resistance is to inline, and an inlined prompt is invisible to the next
 * workflow that needs the same instruction. The reference grammar (REFERENCES.md §1) makes
 * `$/prompts/<name>.md` a first-class spelling, so the sync is the state that decides whether a new
 * prompt becomes a reusable file or a string sealed inside one state.
 */
const PROMPT_FILE_RULES = `Where prompt text goes — this matters:

- Put every non-trivial prompt in its own markdown file under \`prompts/\`, and have the state
  reference it: \`"prompt": {"$ref": "$/prompts/<name>.md"}\`. A prompt in its own file can be read,
  edited and REUSED by the next state that needs the same instruction; one inlined in a state file
  cannot.
- Before writing a new prompt file, look for an existing file under \`prompts/\` that already says
  what the state needs, and reference it instead of writing a near-duplicate.
- Group prompts into subfolders by what they are for — \`prompts/review/critique.md\`,
  \`prompts/planning/goals.md\`, referenced as \`$/prompts/review/critique.md\`. Put a new prompt
  beside the prompts it belongs with, and start a subfolder when a category emerges rather than
  letting the top level become a pile.
- A prompt file is a proposed file like any other: return it whole, with
  \`"path": "prompts/<subfolder>/<name>.md"\`, in the same proposal as the state file that
  references it — a \`$ref\` to a file nobody proposed is a state that fails to load.
- Only a trivial prompt — one sentence that does no more than glue its bound inputs together — may
  stay inline in the state file.`;

const REVISE_PROMPT = `You are updating a document in which a person described, in English, the workflow they wanted —
so that it describes the workflows as they are now actually implemented.

The workflows are the truth here. The document has fallen behind them: work was added that it never
mentions, and things it asks for were implemented differently or not at all.

Rewrite the document so that a reader of it would predict what the workflows actually do.

- Keep the author's structure, voice and level of detail. This is THEIR document with the facts
  corrected, not your description of the workflows. Reuse their headings and their wording wherever
  the wording is still true.
- Where a finding says a requirement is \`missing\` or \`contradicted\`, the document is describing
  something that does not happen. Change that passage to say what happens instead. Do not delete the
  paragraph and leave a hole, and do not quietly keep a sentence that is false.
- Where a finding says \`partial\`, say precisely how far it goes — "the plan is reviewed by a model"
  is not the same claim as "a person approves the plan", and the difference is the point.
- Every extra — behaviour the implementation has that the document does not mention — should end up
  described, in the place a reader would look for it.
- Do NOT invent behaviour. If the implementation does something you cannot explain from the states
  you were given, say what it does in plain terms rather than guessing why.
- Keep it a document a person would want to read. No tables of state ids, no dump of the digest.

Where a state is marked **described elsewhere**, another document is the account of how it works
inside. Describe its CONTRACT here — what it is for, what it takes and produces, where it sits in the
order, what a reader needs to know to use it from outside — and stop there. Do not import that
document's detail into this one: the two would then have to be kept in step with each other as well
as with the code, which is the problem this split exists to avoid. If the passage you are correcting
is really about that subtree's internals, shorten it to the contract and leave the detail where it
lives.

Return the COMPLETE document, ready to replace the file. Then list what you changed, one line each,
naming the requirement ids behind it.

The document as it stands:

{{.inputs.spec}}

The requirements extracted from it:

{{.inputs.requirements}}

How each one fared against the implementation:

{{.inputs.findings}}

Behaviour the document does not mention:

{{.inputs.extras}}

The implementation:

{{.inputs.implementation}}`;

const EDITS_PROMPT = `You are changing a set of implemented workflows so that they run the flow a person described in
English.

The document is the truth here. The workflows have fallen behind it: they were built before it was
written, or it was revised and they were not.

For each requirement that is not satisfied, write the files that would satisfy it. A file is a
state file under \`workflows/\` or a prompt file under \`prompts/\`; each is returned WHOLE, at the
path it belongs at.

${STATE_FILE_RULES}

${PROMPT_FILE_RULES}

How to work:

- Change as little as possible. Prefer editing an existing state over adding one; prefer adding one
  child to rewriting a workflow.
- Return the COMPLETE file for every path you touch, not a fragment. For an \`update\`, start from
  the authored file in the digest and change what has to change — everything you leave out is
  deleted.
- Adding a state is not enough on its own: whatever should reach it has to mount it as a child and
  place it in \`sequence\`, so return the parent too.
- Say, per file, which requirement it answers and what in the document it closes.
- Some things cannot be fixed by writing a file — a human gate needs a function this project
  has registered, a step may need a tool that does not exist. Put those in \`notes\` and do NOT
  invent a state that pretends to do them.
- Requirements already \`satisfied\` need no edit. Extras are not failures: leave behaviour the
  document does not mention alone unless it CONTRADICTS the document.

Some states are marked **described elsewhere**, and neither they nor anything beneath them is yours
to change. You have their contract and not their states, so any file you wrote for one would be
written blind — and it would overwrite work that another document is the authority on. Do not return
an edit whose path names such a state or one beneath it; it will be refused. If closing a
requirement genuinely needs a change in there, put it in \`notes\`, name the owning document, and say
what that document would have to ask for. Changing how such a state is MOUNTED — its inputs, its
place in \`sequence\`, a transition into it — is yours, because the mount lives in a state you own.

The description, which is what the workflows must end up matching:

{{.inputs.spec}}

The requirements extracted from it:

{{.inputs.requirements}}

How each one fared against the implementation:

{{.inputs.findings}}

The implementation as it stands:

{{.inputs.implementation}}`;

/**
 * What a sync state may do — a toolset MAP (decision 0007): three readers, and nothing else.
 *
 * `edit`, `write_file` and `bash` are ABSENT rather than `deny`. In a map, present means offered —
 * the engine would resolve a denied tool against a registry that deliberately does not hold it — and
 * absent is the stronger statement anyway: a map is the whole grant, so a delegated agent loses the
 * built-in of every tool not held, and `other: "deny"` answers for whatever turns up by another name.
 */
export const SYNC_TOOLSET = { read_file: "allow", glob: "allow", grep: "allow", other: "deny" } as const;

export interface SyncWorkflowOptions {
  /** Model for every state. Absent ⇒ the project's `models.default`, as with the check. */
  model?: string;
  /**
   * Make a delegated Claude agent put its OWN read tools to JaiRA's gate — see {@link claudeAskSettings}.
   *
   * Off by default. ⚠️ Largely MOOT since decision 0007 §3: these states hold `read_file`, `glob`
   * and `grep` as JaiRA's own tools, which displace the agent's `Read`, `Glob` and `Grep`, and its
   * web readers are removed because the toolset does not hold them — so there is no native reader
   * left to ask about. Kept because the rule it writes is harmless and a caller may still pass it.
   */
  askNativeReads?: boolean;
}

/**
 * The state files for one direction, keyed by state id — loadable with `loadBundle`.
 *
 * The conformance files come along whole. Both roots are in the map and only the requested one is
 * loaded, which costs nothing and keeps this a single function: the two directions share their first
 * two states, and splitting the map would make that sharing something to maintain rather than
 * something that is simply true.
 */
export function syncWorkflowFiles(options: SyncWorkflowOptions = {}): Record<string, unknown> {
  const model = options.model;
  // `read_file`, inherited by every state below. The digest teaches by example and is the primary
  // evidence, but it CLIPS a long state (the run reports which ones), and a proposal written against a
  // truncation is a proposal against something that does not exist. One read-only tool closes that,
  // and closes nothing else: there is deliberately no `write_file` and no `bash`, because a sync
  // returns text for a human to accept and must not touch disk.
  //
  // A tool set also turns the prompt states into a bounded tool LOOP, which is what makes the same
  // wiring work whether a provider model or a delegated agent is answering.
  //
  // "Must not touch disk" is AUTHORED, not just narrated, and it is authored as the TOOLSET (decision
  // 0007): {@link SYNC_TOOLSET} holds `read_file`, `glob` and `grep` — JaiRA's own, each `allow`, so a
  // read costs no human click — and answers `deny` for every other name. An agent gets that and
  // nothing else: the provider path wraps the held tools, claude loses the built-in of every tool
  // not held (its own `Read`, `Glob` and `Grep` are displaced by ours, `Bash`, `Edit` and `Write` are
  // removed, a sub-agent is refused by `other`), codex is left in its read-only sandbox because
  // nothing here unlocks the writing one, and a transport that can hold the agent to none of it
  // refuses the state.
  //
  // A MAP, lowered here because these files go to `loadBundle` directly and the engine takes a list
  // and a block. Lowered by the same function the loader uses, so the block carries the marks that
  // tell a run a toolset was declared — a bare list would read as a state that declared none, and
  // leave claude every built-in it has.
  const environment = {
    kind: "prompt",
    ...lowerToolset(parseToolset(SYNC_TOOLSET).toolset),
    ...(options.askNativeReads === true ? { providerOptions: claudeAskSettings(CLAUDE_NATIVE_READ_TOOLS) } : {}),
    ...(model !== undefined ? { model } : {}),
  };
  const check = conformanceWorkflowFiles(model !== undefined ? { model } : {});

  // The two leaves the check already defines, mounted by explicit id. Their inputs are wired the
  // same way in both directions, so the wiring is written once.
  const requirementsChild = { state: `${CONFORMANCE_ID}/requirements`, inputs: { spec: ".inputs.spec" } };
  const assessmentChild = {
    state: `${CONFORMANCE_ID}/assessment`,
    inputs: {
      spec: ".inputs.spec",
      implementation: ".inputs.implementation",
      requirements: ".children.requirements.output.requirements",
    },
  };
  // What the check produced, re-declared as outputs of the sync root: a caller reading the proposal
  // must be able to read the evidence for it from the same value.
  const reportOutputs = {
    requirements: { schema: REQUIREMENTS_SCHEMA, binding: ".children.requirements.output.requirements" },
    verdict: { schema: VERDICT_SCHEMA, binding: ".children.assessment.output.verdict" },
    findings: { schema: FINDINGS_SCHEMA, binding: ".children.assessment.output.findings" },
    extras: { schema: EXTRAS_SCHEMA, binding: ".children.assessment.output.extras" },
  };

  return {
    ...check,

    [SYNC_DOCUMENT_ID]: {
      label: "Sync the description",
      description: "Rewrite workflow.md so it describes the workflows as they are implemented.",
      environment,
      inputs: { spec: markdown, implementation: markdown },
      outputs: {
        ...reportOutputs,
        document: { schema: DOCUMENT_SCHEMA, binding: ".children.revision.output.document" },
        changes: { schema: CHANGES_SCHEMA, binding: ".children.revision.output.changes" },
        notes: { schema: NOTES_SCHEMA, binding: ".children.revision.output.notes" },
      },
      children: {
        requirements: requirementsChild,
        assessment: assessmentChild,
        revision: {
          inputs: {
            spec: ".inputs.spec",
            implementation: ".inputs.implementation",
            requirements: ".children.requirements.output.requirements",
            findings: ".children.assessment.output.findings",
            extras: ".children.assessment.output.extras",
          },
        },
      },
      sequence: ["requirements", "assessment", "revision"],
    },

    [`${SYNC_DOCUMENT_ID}/revision`]: {
      label: "Rewrite the description",
      inputs: {
        spec: markdown,
        implementation: markdown,
        requirements: { schema: REQUIREMENTS_SCHEMA },
        findings: { schema: FINDINGS_SCHEMA },
        extras: { schema: EXTRAS_SCHEMA },
      },
      outputs: {
        document: { schema: DOCUMENT_SCHEMA },
        changes: { schema: CHANGES_SCHEMA },
        notes: { schema: NOTES_SCHEMA },
      },
      operation: { prompt: REVISE_PROMPT },
    },

    [SYNC_STATES_ID]: {
      label: "Sync the workflows",
      description:
        "Propose the files — state files, and the prompts they reference — that would make the workflows match workflow.md.",
      environment,
      inputs: { spec: markdown, implementation: markdown },
      outputs: {
        ...reportOutputs,
        edits: { schema: EDITS_SCHEMA, binding: ".children.edits.output.edits" },
        notes: { schema: NOTES_SCHEMA, binding: ".children.edits.output.notes" },
      },
      children: {
        requirements: requirementsChild,
        assessment: assessmentChild,
        edits: {
          inputs: {
            spec: ".inputs.spec",
            implementation: ".inputs.implementation",
            requirements: ".children.requirements.output.requirements",
            findings: ".children.assessment.output.findings",
          },
        },
      },
      sequence: ["requirements", "assessment", "edits"],
    },

    [`${SYNC_STATES_ID}/edits`]: {
      label: "Propose files",
      inputs: {
        spec: markdown,
        implementation: markdown,
        requirements: { schema: REQUIREMENTS_SCHEMA },
        findings: { schema: FINDINGS_SCHEMA },
      },
      outputs: { edits: { schema: EDITS_SCHEMA }, notes: { schema: NOTES_SCHEMA } },
      operation: { prompt: EDITS_PROMPT },
    },
  };
}

/**
 * Read a sync run's outputs.
 *
 * The report half goes through {@link conformanceReportOf} — the same defensive parse the CLI uses,
 * for the same reason: this is where a model's answer becomes text in someone's editor, and a
 * malformed answer must fail loudly rather than quietly propose an empty document.
 */
export function syncOutcomeOf(value: unknown, direction: SyncDirection): SyncOutcome {
  const outputs = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const report = conformanceReportOf(outputs);
  const notes = Array.isArray(outputs["notes"]) ? outputs["notes"].filter((n): n is string => typeof n === "string") : [];

  if (direction === "document") {
    const text = outputs["document"];
    if (typeof text !== "string" || text.trim() === "") {
      throw refusal(log, "the sync returned no document to put in the editor");
    }
    const changes = arrayOf(outputs["changes"]).map((raw) => {
      const row = record(raw);
      return {
        summary: typeof row["summary"] === "string" ? row["summary"] : "",
        requirements: arrayOf(row["requirements"]).filter((r): r is string => typeof r === "string"),
      };
    });
    return { ...report, document: { text, changes }, notes };
  }

  const edits = arrayOf(outputs["edits"]).map((raw, i) => {
    const row = record(raw);
    const path = typeof row["path"] === "string" ? row["path"] : "";
    const text = typeof row["text"] === "string" ? row["text"] : "";
    if (path === "" || text === "") throw refusal(log, `the sync returned an edit with no path or no file (edits[${i}])`);
    return {
      path,
      action: row["action"] === "create" ? ("create" as const) : ("update" as const),
      text,
      reason: typeof row["reason"] === "string" ? row["reason"] : "",
      requirements: arrayOf(row["requirements"]).filter((r): r is string => typeof r === "string"),
    };
  });
  return { ...report, edits, notes };
}

/**
 * The respond prompt for a sync proposal's review loop (CHANGESETS.md §3.3, flow 1).
 *
 * The generic loop answers comments knowing nothing beyond the changeset itself. A sync's revision
 * is writing state files, so it needs the same vocabulary and the same prompts-folder rules the
 * proposal was written under — and the description the proposal exists to satisfy, because "address
 * this comment" is meaningless without the truth the file is being held to.
 *
 * `{{` in the embedded description is widened to `{ {`, because a description that quotes a
 * template slot (`{{.inputs.issue}}` in a documented example) would otherwise become a slot of THIS
 * prompt and fail the round on an input that does not exist.
 */
export function syncRespondPrompt(spec: string): string {
  const safe = spec.replaceAll("{{", "{ {");
  return `You proposed files to bring a set of implemented workflows in step with the description below, and a
reviewer answered some of the changes with comments instead of accepting them. Answer the comments by
revising your proposal.

${STATE_FILE_RULES}

${PROMPT_FILE_RULES}

The description the proposal must satisfy:

${safe}

The changeset you proposed:

{{.inputs.changeset}}

The reviewer's decisions — every change, decided; the \`comment\` ones are yours to answer:

{{.inputs.decisions}}

For each commented change, return the COMPLETE revised file for that path — the whole file, not a
fragment or a diff, because everything you leave out is deleted. Leave changes the reviewer merged
or reverted alone. If a comment asks for something you cannot express as a file, say so in notes
rather than inventing content.`;
}

/**
 * Fake rules that drive a sync with no provider — what the tests script.
 *
 * Keyed on a distinctive line of each prompt, like {@link conformanceRules}, and it carries the two
 * check rules itself rather than asking the caller to concatenate them: a sync is three states, and
 * a script that covered two of them would fail in the one that matters.
 */
export function syncRules(script: {
  requirements: ConformanceRequirement[];
  verdict: ConformanceVerdict;
  findings: ConformanceFinding[];
  extras?: ConformanceExtra[];
  document?: DocumentProposal;
  edits?: SyncEdit[];
  notes?: string[];
}): Array<{ promptIncludes: string; output: JsonValue }> {
  return [
    {
      promptIncludes: "Break it into the individual requirements",
      output: { requirements: script.requirements as unknown as JsonValue },
    },
    {
      promptIncludes: "You are checking whether a set of implemented workflows",
      output: {
        verdict: script.verdict,
        findings: script.findings as unknown as JsonValue,
        extras: (script.extras ?? []) as unknown as JsonValue,
      },
    },
    {
      promptIncludes: "so that it describes the workflows as they are now actually implemented",
      output: {
        document: script.document?.text ?? "",
        changes: (script.document?.changes ?? []) as unknown as JsonValue,
        notes: (script.notes ?? []) as unknown as JsonValue,
      },
    },
    {
      promptIncludes: "so that they run the flow a person described",
      output: {
        edits: (script.edits ?? []) as unknown as JsonValue,
        notes: (script.notes ?? []) as unknown as JsonValue,
      },
    },
  ];
}

// --- schemas shared with the check -------------------------------------------

/**
 * The check's own output schemas, restated for the states that CONSUME them.
 *
 * They are not exported from `conformanceWorkflow.ts` and should not be: they are that command's
 * contract. What is needed here is the shape of an input slot, and declaring it loosely — an array
 * of objects — would drop the field descriptions the third state reads to know what a `status` is.
 */
const REQUIREMENTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      requirement: { type: "string" },
      category: { type: "string" },
      quote: { type: "string" },
    },
    required: ["id", "requirement", "category", "quote"],
    additionalProperties: false,
  },
};

const FINDINGS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      requirement: { type: "string" },
      status: { type: "string", enum: ["satisfied", "partial", "missing", "contradicted"] },
      states: strings,
      detail: { type: "string" },
    },
    required: ["id", "requirement", "status", "states", "detail"],
    additionalProperties: false,
  },
};

const EXTRAS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { states: strings, detail: { type: "string" } },
    required: ["states", "detail"],
    additionalProperties: false,
  },
};

const VERDICT_SCHEMA = { type: "string", enum: ["conforms", "gaps", "diverges"] };

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal(log, "the sync returned a malformed proposal");
  }
  return value as Record<string, unknown>;
}
