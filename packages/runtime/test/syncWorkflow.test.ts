/**
 * The two sync workflows: do they load, and do they wire the check's answers into the state that
 * has to act on them?
 *
 * Both questions are load-bearing and neither is visible by reading the file. A binding that names
 * something that does not exist fails at RUN time, in the app, after a model call has been paid
 * for — and the third state is the one whose inputs are all bindings into the other two. So the
 * bundle is loaded here, which is the same resolution the engine does.
 *
 * The rest is the parse at the other end. `syncOutcomeOf` is where a model's answer becomes text in
 * somebody's editor, so the cases that matter are the malformed ones: an empty document and an edit
 * with no file must fail loudly rather than quietly propose nothing.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import {
  SYNC_DOCUMENT_ID,
  SYNC_STATES_ID,
  syncOutcomeOf,
  syncRootId,
  syncRules,
  syncWorkflowFiles,
} from "../src/syncWorkflow";
import { CONFORMANCE_ID, type ConformanceFinding, type ConformanceRequirement } from "../src/conformanceWorkflow";

const REQUIREMENTS: ConformanceRequirement[] = [
  { id: "R1", requirement: "the issue becomes goals", category: "step", quote: "Turn the issue into goals" },
];

const MISSING: ConformanceFinding = {
  id: "R1",
  requirement: "the issue becomes goals",
  status: "missing",
  states: [],
  detail: "nothing does this",
};

describe("syncWorkflowFiles", () => {
  it("loads both directions, each reusing the check's two states", () => {
    const files = syncWorkflowFiles();
    for (const direction of ["document", "states"] as const) {
      const bundle = loadBundle(files, syncRootId(direction));
      const ids = Object.keys(bundle.states);
      // The check is mounted, not re-implemented: a second copy of "extract the requirements" would
      // drift from the one `jaira workflow check` runs, and the two must agree.
      expect(ids).toContain(`${CONFORMANCE_ID}/requirements`);
      expect(ids).toContain(`${CONFORMANCE_ID}/assessment`);
    }
  });

  it("runs the check first and the proposal last", () => {
    const bundle = loadBundle(syncWorkflowFiles(), SYNC_DOCUMENT_ID);
    expect(bundle.states[SYNC_DOCUMENT_ID]?.sequence).toEqual(["requirements", "assessment", "revision"]);
    expect(loadBundle(syncWorkflowFiles(), SYNC_STATES_ID).states[SYNC_STATES_ID]?.sequence).toEqual([
      "requirements",
      "assessment",
      "edits",
    ]);
  });

  it("gives the proposal the findings, not just the description", () => {
    // The whole reason the check is reused: "close R4, which nothing implements" is a job, and
    // "make these match" is not.
    const authored = syncWorkflowFiles()[SYNC_STATES_ID] as {
      children: { edits: { inputs: Record<string, string> } };
    };
    expect(authored.children.edits.inputs).toEqual({
      spec: ".inputs.spec",
      implementation: ".inputs.implementation",
      requirements: ".children.requirements.outputs.requirements",
      findings: ".children.assessment.outputs.findings",
    });
    // And those bindings resolve: a dangling one fails at RUN time, in the app, after two model
    // calls have already been paid for.
    const compiled = loadBundle(syncWorkflowFiles(), SYNC_STATES_ID).states[SYNC_STATES_ID]?.children?.["edits"]
      ?.inputs?.["findings"];
    expect(JSON.stringify(compiled)).toContain("assessment");
  });

  it("carries the model onto every state, so one option decides the whole run", () => {
    const bundle = loadBundle(syncWorkflowFiles({ model: "a-model" }), SYNC_DOCUMENT_ID);
    for (const id of [`${CONFORMANCE_ID}/requirements`, `${SYNC_DOCUMENT_ID}/revision`]) {
      const operation = bundle.states[id]?.operation as { config?: { model?: string } } | undefined;
      expect(operation?.config?.model).toBe("a-model");
    }
  });

  it("exposes the report beside the proposal", () => {
    // A proposal with no evidence next to it is a document that changed for reasons of its own.
    const outputs = loadBundle(syncWorkflowFiles(), SYNC_DOCUMENT_ID).states[SYNC_DOCUMENT_ID]?.outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual([
      "changes",
      "document",
      "extras",
      "findings",
      "notes",
      "requirements",
      "verdict",
    ]);
  });
});

describe("syncOutcomeOf", () => {
  const report = { verdict: "gaps", requirements: REQUIREMENTS, findings: [MISSING], extras: [] };

  it("reads a rewritten document and what changed in it", () => {
    const outcome = syncOutcomeOf(
      { ...report, document: "# The flow\n", changes: [{ summary: "said what the critique state does", requirements: ["R1"] }], notes: [] },
      "document",
    );
    expect(outcome.document?.text).toBe("# The flow\n");
    expect(outcome.document?.changes[0]?.requirements).toEqual(["R1"]);
    expect(outcome.findings[0]?.status).toBe("missing");
  });

  it("refuses an empty rewrite rather than proposing nothing at all", () => {
    // A blank document would arrive in the editor as a draft that empties the file, which is the
    // one outcome nobody asked for.
    expect(() => syncOutcomeOf({ ...report, document: "   ", changes: [] }, "document")).toThrow(/no document/);
  });

  it("reads proposed state files", () => {
    const outcome = syncOutcomeOf(
      {
        ...report,
        edits: [{ stateId: "plan/goals", action: "create", text: '{"label":"Goals"}', reason: "R1 needs it", requirements: ["R1"] }],
        notes: ["a human gate needs a registered function"],
      },
      "states",
    );
    expect(outcome.edits).toHaveLength(1);
    expect(outcome.edits?.[0]?.stateId).toBe("plan/goals");
    expect(outcome.notes).toEqual(["a human gate needs a registered function"]);
  });

  it("refuses an edit with no file in it", () => {
    expect(() =>
      syncOutcomeOf({ ...report, edits: [{ stateId: "plan", action: "update", text: "", reason: "", requirements: [] }] }, "states"),
    ).toThrow(/no state id or no file/);
  });

  it("refuses a report that is not one", () => {
    // The same defensive parse the check makes: this is where an answer becomes an edit.
    expect(() => syncOutcomeOf({ verdict: "maybe" }, "document")).toThrow(/verdict/);
  });
});

describe("syncRules", () => {
  it("scripts all three states, so a fake run reaches the proposal", () => {
    const rules = syncRules({
      requirements: REQUIREMENTS,
      verdict: "gaps",
      findings: [MISSING],
      document: { text: "# rewritten", changes: [] },
      edits: [],
    });
    // Two for the check, one per direction — a script covering only the check would fail in exactly
    // the state this feature exists for.
    expect(rules).toHaveLength(4);
    expect(rules.map((r) => r.promptIncludes).some((p) => p.includes("Break it into"))).toBe(true);
  });
});
