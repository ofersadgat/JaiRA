/**
 * Running a state from the Files inspector — what the form asks for and what it sends.
 *
 * The property under test throughout is that a box's TEXT and a slot's VALUE are different things,
 * and the mapping between them is decided by the slot's schema. Getting it wrong is silent in the
 * worst way: `"3"` where a number was declared, or `""` where the slot has a default that would have
 * been perfectly good, produces a run that starts, does the wrong thing, and reports success.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard, SessionRef, StateView, TaskSummary, WorkflowEntry } from "@jaira/shared/browser";
import {
  createBlocker,
  initialRunValues,
  instanceAt,
  isFilled,
  newestRunOf,
  runBlocker,
  runFieldsOf,
  runHistoryOf,
  runInputsOf,
  runTargetOf,
  runTitle,
  runValuesOf,
  workflowLayerOf,
  workflowMimeOf,
  type RunContext,
  type RunField,
} from "../src/renderer/runForm";
import { WORKFLOW_JSON, WORKFLOW_YAML } from "@jaira/shared/browser";

/** A state using each shape the form has to render, in one document. */
const PLAN = {
  label: "Planning",
  inputs: {
    issue: { schema: { type: "string", contentMediaType: "text/markdown" }, description: "what to do" },
    depth: { schema: { type: "integer" }, default: 3 },
    strict: { schema: { type: "boolean" }, optional: true },
    tags: { schema: { type: "array", items: { type: "string" } }, optional: true },
    shape: { schema: { type: "object", properties: { a: { type: "string" } } }, optional: true },
    loose: { optional: true },
    wired: { binding: ".inputs.other" },
  },
};

const fieldsOf = (doc: unknown): RunField[] => {
  const fields = runFieldsOf(JSON.stringify(doc), WORKFLOW_JSON);
  expect(fields).not.toBeNull();
  return fields!;
};

const byName = (doc: unknown, name: string): RunField => fieldsOf(doc).find((f) => f.name === name)!;

describe("reading a state's inputs", () => {
  it("gives every declared input a box, in declaration order", () => {
    expect(fieldsOf(PLAN).map((f) => f.name)).toEqual([
      "issue",
      "depth",
      "strict",
      "tags",
      "shape",
      "loose",
      "wired",
    ]);
  });

  it("picks the control from the slot's schema", () => {
    const control = Object.fromEntries(fieldsOf(PLAN).map((f) => [f.name, f.control]));
    expect(control).toMatchObject({
      // An artifact is content with a media type — usually a paragraph, so a multi-line box.
      issue: "multiline",
      depth: "number",
      strict: "boolean",
      // A list, and a schema with `properties` — both outside what a single typed control can hold.
      tags: "json",
      shape: "json",
      loose: "json",
    });
  });

  it("treats a slot with a default as satisfied, and prefills the box with it", () => {
    expect(byName(PLAN, "depth")).toMatchObject({ required: false, initial: "3" });
    expect(byName(PLAN, "issue")).toMatchObject({ required: true, initial: "" });
    expect(byName(PLAN, "strict").required).toBe(false);
  });

  it("does not ask for a slot that binds itself", () => {
    expect(isFilled(byName(PLAN, "wired"))).toBe(false);
    expect(byName(PLAN, "wired").binding).toBe(".inputs.other");
  });

  it("does not ask for a spread — it stands for N slots, not one value", () => {
    const fields = fieldsOf({ inputs: { "ctx*": { binding: ".children.gather.output" } } });
    expect(fields[0]).toMatchObject({ name: "ctx*", spread: true });
    expect(isFilled(fields[0]!)).toBe(false);
  });

  it("reads a YAML state as readily as a JSON one", () => {
    const fields = runFieldsOf("inputs:\n  issue:\n    schema:\n      type: string\n", WORKFLOW_YAML);
    expect(fields?.map((f) => [f.name, f.control])).toEqual([["issue", "text"]]);
  });

  it("answers null for a document that does not parse — not an empty form", () => {
    expect(runFieldsOf("{ not json", WORKFLOW_JSON)).toBeNull();
    expect(runFieldsOf("", WORKFLOW_JSON)).toBeNull();
    // A state with no inputs IS an empty form, and must not be confused with the above.
    expect(runFieldsOf('{"label":"x"}', WORKFLOW_JSON)).toEqual([]);
  });

  it("opens every box at its declared default", () => {
    expect(initialRunValues(fieldsOf(PLAN))).toMatchObject({ issue: "", depth: "3", strict: "" });
  });

  /**
   * The form describing a run that ALREADY happened — what the workflow link in a conversation's
   * gutter opens. The round trip is the property: what a run was called with, put in the boxes, has
   * to read back as the same inputs.
   */
  it("fills the boxes with what one run was actually called with", () => {
    const fields = fieldsOf(PLAN);
    const called = { issue: "fix the parser", depth: 7, strict: true, tags: ["a", "b"] };
    const values = runValuesOf(fields, called);
    // Prose as prose. Quoting it would put a pair of quotes in a textarea somebody is about to edit.
    expect(values["issue"]).toBe("fix the parser");
    expect(values["depth"]).toBe("7");
    expect(values["strict"]).toBe("true");
    expect(values["tags"]).toBe('["a","b"]');
    // A slot the run carried nothing for keeps its default — which is what actually applied.
    expect(values["shape"]).toBe("");
    expect(runInputsOf(fields, values).inputs).toEqual(called);
  });
});

describe("reading the boxes back", () => {
  const read = (values: Record<string, string>): ReturnType<typeof runInputsOf> =>
    runInputsOf(fieldsOf(PLAN), { issue: "fix the parser", ...values });

  it("sends a string slot's text verbatim, digits and all", () => {
    // The trap this guards: a helpful JSON parse here would send the NUMBER 123 into a slot the
    // state declared as a string, and the mismatch would surface as a type error mid-run.
    expect(read({ issue: "123" }).inputs["issue"]).toBe("123");
  });

  it("sends a number slot as a number, and refuses text that is not one", () => {
    expect(read({ depth: "5" }).inputs["depth"]).toBe(5);
    expect(read({ depth: "deep" }).bad).toEqual([{ name: "depth", reason: "'deep' is not a number" }]);
    expect(read({ depth: "2.5" }).bad).toEqual([{ name: "depth", reason: "must be a whole number" }]);
  });

  it("sends a boolean slot as a boolean", () => {
    expect(read({ strict: "true" }).inputs["strict"]).toBe(true);
    expect(read({ strict: "false" }).inputs["strict"]).toBe(false);
  });

  it("parses a JSON box strictly, so a typo is refused rather than sent as a string", () => {
    expect(read({ tags: '["a","b"]' }).inputs["tags"]).toEqual(["a", "b"]);
    expect(read({ tags: "[a,b]" }).bad.map((b) => b.name)).toEqual(["tags"]);
  });

  it("reads an unschema'd slot leniently — it has no type to disappoint", () => {
    expect(read({ loose: "hello" }).inputs["loose"]).toBe("hello");
    expect(read({ loose: "7" }).inputs["loose"]).toBe(7);
  });

  it("treats an empty box as absent, never as an empty value", () => {
    const result = read({ depth: "", strict: "" });
    expect("depth" in result.inputs).toBe(false);
    expect("strict" in result.inputs).toBe(false);
    // `depth` has a default, so clearing it is legal and the engine supplies 3.
    expect(result.missing).toEqual([]);
  });

  it("reports a required slot left empty", () => {
    expect(read({ issue: "  " }).missing).toEqual(["issue"]);
  });

  it("sends nothing for a slot the state binds itself", () => {
    expect("wired" in read({ wired: "ignored" }).inputs).toBe(false);
  });
});

describe("where a run goes", () => {
  it("sends a shared-root state to the root's own project, not JaiRA's", () => {
    // The rule the whole shared-root story rests on, and the distinction that took two goes to get
    // right: these runs belong to THIS root and go when it is repointed, where a description sync's
    // history is about the installation and must not.
    expect(runTargetOf("base", "/home/me/repo")).toEqual({
      project: "shared",
      label: "the shared root",
      open: true,
    });
  });

  it("sends it there with no project open at all — that is the point", () => {
    expect(runTargetOf("base", null).open).toBe(true);
  });

  it("sends a project state to the open checkout, named by its directory", () => {
    expect(runTargetOf("project", "/home/me/repo")).toEqual({ label: "repo", open: true });
    // A Windows path, because that is what the project directory actually looks like on half the
    // machines this runs on and `split("/")` alone would have called the whole thing the label.
    expect(runTargetOf("project", "C:\\work\\repo").label).toBe("repo");
  });

  it("has nowhere to send a project state with nothing open", () => {
    expect(runTargetOf("project", null).open).toBe(false);
  });
});

describe("whether it can run", () => {
  const state = (patch: Partial<StateView> = {}): StateView =>
    ({
      stateId: "feature/plan",
      layer: "project",
      file: "/p/.jaira/workflows/feature/plan.json",
      exists: true,
      children: [],
      board: null,
      tasksHere: [],
      tasksRecent: [],
      transitions: [],
      environment: { available: true },
      issues: [],
      references: [],
      referencedBy: [],
      driftedTasks: [],
      ...patch,
    }) as StateView;

  const ok = { inputs: {}, missing: [], bad: [] };
  const here = runTargetOf("project", "/home/me/repo");
  const shared = runTargetOf("base", null);
  const ctx = (patch: Partial<RunContext> = {}): RunContext => ({
    state: state(),
    target: here,
    exists: true,
    fields: [],
    inputs: ok,
    busy: false,
    ...patch,
  });

  it("runs when nothing is in the way", () => {
    expect(runBlocker(ctx())).toBeNull();
  });

  it("refuses when there is nowhere to run, before mentioning anything about the form", () => {
    const blocked = runBlocker(
      ctx({
        target: runTargetOf("project", null),
        inputs: { inputs: {}, missing: ["issue"], bad: [] },
      }),
    );
    expect(blocked).toBe("open a project to run this");
  });

  it("runs a shared state read without a project — `fileOnly` is not a refusal", () => {
    // The regression this guards: the first cut refused on `fileOnly`, which is exactly the mode
    // the shared root is browsed in. JaiRA's own project supplies everything the run needs.
    expect(runBlocker(ctx({ state: state({ layer: "base", fileOnly: true }), target: shared }))).toBeNull();
  });

  it("refuses a file that has never been saved — there is nothing to snapshot", () => {
    expect(runBlocker(ctx({ exists: false }))).toBe("save this file before running it");
  });

  it("refuses on a validation error and says how many", () => {
    const issues = [
      { stateId: "feature/plan", path: "operation", message: "no", severity: "error" as const },
      { stateId: "feature/plan", path: "outputs", message: "hm", severity: "warning" as const },
    ];
    expect(runBlocker(ctx({ state: state({ issues }) }))).toBe("1 validation error — fix them first");
  });

  it("runs with warnings — a warning that refused would just be an error", () => {
    const issues = [{ stateId: "feature/plan", path: "o", message: "hm", severity: "warning" as const }];
    expect(runBlocker(ctx({ state: state({ issues }) }))).toBeNull();
  });

  it("names the missing inputs, then the first unreadable one", () => {
    expect(runBlocker(ctx({ inputs: { inputs: {}, missing: ["issue", "goal"], bad: [] } }))).toBe(
      "issue, goal are required",
    );
    expect(
      runBlocker(ctx({ inputs: { inputs: {}, missing: [], bad: [{ name: "depth", reason: "'deep' is not a number" }] } })),
    ).toBe("depth: 'deep' is not a number");
  });
});

describe("the generated title", () => {
  it("numbers runs from what is already listed above the button", () => {
    expect(runTitle("feature/plan", 0)).toBe("feature/plan #1");
    expect(runTitle("feature/plan", 2)).toBe("feature/plan #3");
  });
});

describe("previous runs", () => {
  const task = (taskId: string, workflow: string, updatedAt: number): TaskSummary => ({
    taskId,
    title: taskId,
    status: "completed",
    workflow,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  });
  const card = (taskId: string, updatedAt: number): BoardCard => ({
    taskId,
    title: taskId,
    status: "running",
    workflow: "feature",
    activePath: [],
    hasSubBoard: false,
    updatedAt,
  });

  const tasks = [task("t1", "feature/plan", 10), task("t2", "other", 20), task("t3", "feature/plan", 30)];

  it("groups the runs started here, newest first", () => {
    const { startedHere } = runHistoryOf("feature/plan", tasks, null);
    expect(startedHere.map((t) => t.taskId)).toEqual(["t3", "t1"]);
  });

  it("puts everything that merely passed through in the second group", () => {
    const state = { tasksHere: [card("t9", 5)], tasksRecent: [card("t8", 40)] } as unknown as StateView;
    const { passedThrough } = runHistoryOf("feature/plan", tasks, state);
    expect(passedThrough.map((c) => c.taskId)).toEqual(["t8", "t9"]);
  });

  it("never lists a run twice", () => {
    // `t1` was started here AND is sitting in the state; `t9` is in both board projections at once.
    const state = {
      tasksHere: [card("t1", 10), card("t9", 5)],
      tasksRecent: [card("t9", 5)],
    } as unknown as StateView;
    const { startedHere, passedThrough } = runHistoryOf("feature/plan", tasks, state);
    expect(startedHere.map((t) => t.taskId)).toEqual(["t3", "t1"]);
    expect(passedThrough.map((c) => c.taskId)).toEqual(["t9"]);
  });
});

/**
 * Which run, and which of its conversations, a click opens.
 *
 * Both rules exist because the panel used to answer a question nobody asked: selecting a state left
 * the transcript saying "select a task", and selecting a task opened the deepest state it reached
 * rather than the one you were standing on.
 */
describe("what a click opens", () => {
  const card = (taskId: string, updatedAt: number): BoardCard => ({
    taskId,
    title: taskId,
    status: "running",
    workflow: "feature/plan",
    activePath: [],
    hasSubBoard: false,
    updatedAt,
  });
  const view = (here: BoardCard[], recent: BoardCard[]): StateView =>
    ({ stateId: "feature/plan", tasksHere: here, tasksRecent: recent }) as unknown as StateView;

  it("opens the newest run of the state", () => {
    expect(newestRunOf(view([], [card("old", 1), card("new", 9)]))?.taskId).toBe("new");
  });

  it("prefers a run parked here now over one that merely finished later", () => {
    // The timestamps say otherwise on purpose: "what is happening in this state" beats "what was
    // touched most recently anywhere".
    expect(newestRunOf(view([card("here", 1)], [card("done", 9)]))?.taskId).toBe("here");
  });

  it("has nothing to open for a state that has never run", () => {
    expect(newestRunOf(view([], []))).toBeNull();
    expect(newestRunOf(null)).toBeNull();
  });

  const ref = (instanceId: number, stateId: string): SessionRef =>
    ({ instanceId: String(instanceId), stateId, sessionId: `#i`, seq: 0 }) as unknown as SessionRef;
  const history = [ref(1, "feature/plan"), ref(2, "feature/plan/goals"), ref(3, "feature/plan/goals"), ref(4, "feature/plan/critique")];

  it("opens the conversation of the state you are standing on, not the deepest one reached", () => {
    expect(instanceAt(history, "feature/plan")).toBe("1");
  });

  it("takes the LAST pass through a state, because a loop runs it more than once", () => {
    expect(instanceAt(history, "feature/plan/goals")).toBe("3");
  });

  it("has no opinion when the task never reached the state, or no state is named", () => {
    // Null lets `session:view` pick the latest — a labelled conversation beats an empty panel.
    expect(instanceAt(history, "feature/plan/nowhere")).toBeNull();
    expect(instanceAt(history, null)).toBeNull();
  });
});

/**
 * Reads have to name the same project the run was written to.
 *
 * The failure this guards is not subtle once seen and invisible until then: selecting a shared run
 * set `selected` but resolved `task:detail`, `task:conversation` and `session:history` against the
 * FOCUSED project, which with no checkout open is none at all. Main throws `no project is open` for
 * a task sitting perfectly well in the shared database, and the window shows three empty panels and
 * a log full of errors. One rule decides both halves, so they cannot drift apart.
 */
describe("which project a read names", () => {
  it("reads a shared state's runs from the shared project, checkout or not", () => {
    expect(runTargetOf("base", null).project).toBe("shared");
    expect(runTargetOf("base", "/home/me/repo").project).toBe("shared");
  });

  it("reads a checkout's runs from the checkout, by naming nothing", () => {
    // Absent, not the directory: `undefined` means "the focused project", which is what every
    // task-scoped channel already defaults to.
    expect(runTargetOf("project", "/home/me/repo").project).toBeUndefined();
  });
});

/**
 * The New-task form, which is the run form with no file open.
 *
 * Same boxes, same reading of them, and two things it cannot borrow: the MIME comes from the file's
 * own name rather than from a tree that classified it, and the button is refused for the two things
 * a picker can be wrong about instead of for the six a document can.
 *
 * The state under test throughout is the third one — "not read yet". A form that reports a round
 * trip in flight as "this file does not parse" is a form that accuses the user's workflow of being
 * broken for as long as the read takes, and then quietly stops.
 */
describe("starting a run with nothing open", () => {
  it("reads a workflow's spelling from its own file name", () => {
    expect(workflowMimeOf("/home/me/.jaira/workflows/feature/plan.yaml")).toBe(WORKFLOW_YAML);
    expect(workflowMimeOf("C:\repo\.jaira\workflows\plan.yml")).toBe(WORKFLOW_YAML);
    expect(workflowMimeOf("/home/me/.jaira/workflows/plan.json")).toBe(WORKFLOW_JSON);
  });

  it("treats an unrecognised extension as JSON, which is what a state is", () => {
    expect(workflowMimeOf("/tmp/plan")).toBe(WORKFLOW_JSON);
  });

  it("parses a YAML workflow into the same boxes as its JSON twin", () => {
    const yaml = "inputs:\n  issue:\n    description: what to do\n  depth:\n    schema:\n      type: integer\n    default: 3\n";
    const fields = runFieldsOf(yaml, WORKFLOW_YAML);
    expect(fields?.map((f) => [f.name, f.control, f.required])).toEqual([
      ["issue", "json", true],
      ["depth", "number", false],
    ]);
  });

  const blockerFor = (over: Partial<Parameters<typeof createBlocker>[0]> = {}): string | null =>
    createBlocker({
      workflow: "feature/plan",
      fields: [],
      inputs: { inputs: {}, missing: [], bad: [] },
      busy: false,
      ...over,
    });

  it("asks for a workflow before anything else", () => {
    expect(blockerFor({ workflow: "" })).toBe("choose a workflow");
    // Whitespace is not a choice. The picker cannot produce it, but the blocker is what the button
    // reads and it must not be the only thing standing between a stray value and a failed create.
    expect(blockerFor({ workflow: "   " })).toBe("choose a workflow");
  });

  it("distinguishes 'not read yet' from 'does not parse'", () => {
    expect(blockerFor({ fields: undefined })).toBe("reading its inputs");
    expect(blockerFor({ fields: null })).toBe("that workflow's file does not parse");
  });

  it("names the required inputs that are still empty, and the first bad one", () => {
    expect(blockerFor({ inputs: { inputs: {}, missing: ["issue"], bad: [] } })).toBe("issue is required");
    expect(blockerFor({ inputs: { inputs: {}, missing: ["issue", "depth"], bad: [] } })).toBe(
      "issue, depth are required",
    );
    expect(
      blockerFor({ inputs: { inputs: {}, missing: [], bad: [{ name: "depth", reason: "'x' is not a number" }] } }),
    ).toBe("depth: 'x' is not a number");
  });

  it("lets a workflow with no inputs through, and refuses one mid-create", () => {
    expect(blockerFor()).toBeNull();
    expect(blockerFor({ busy: true })).toBe("busy");
  });

  it("does not refuse a workflow for its lint results, which it has none of", () => {
    // Deliberate, and the opposite of `runBlocker`: this form has no state view to read issues from,
    // and a workflow with errors starts here exactly as it always did — failing where it fails.
    const errored = { workflow: "feature/plan", fields: fieldsOf(PLAN), busy: false };
    const filled = { issue: "ship it", depth: "3", wired: "ignored" };
    expect(createBlocker({ ...errored, inputs: runInputsOf(errored.fields, filled) })).toBeNull();
  });

  it("numbers the title from the runs this workflow has already had", () => {
    const task = (workflow: string): TaskSummary =>
      ({ taskId: `#${workflow}`, title: workflow, workflow, status: "completed", updatedAt: 1 }) as TaskSummary;
    const tasks = [task("feature/plan"), task("feature/plan"), task("chat/agent")];
    // What `createTask` generates: the same count the Run button's title uses, so a task made from
    // either surface reads the same on the board.
    expect(runTitle("feature/plan", runHistoryOf("feature/plan", tasks, null).startedHere.length)).toBe(
      "feature/plan #3",
    );
    expect(runTitle("nothing/yet", runHistoryOf("nothing/yet", tasks, null).startedHere.length)).toBe(
      "nothing/yet #1",
    );
  });
});

/**
 * Which layer a state's file is in — the question the run form has to answer before it can read one.
 *
 * The bug this closes: only ROOTS have a row in the browse listing, so every state below one was
 * assumed to be the project's. A workflow living in the shared root — which is where they normally
 * live once more than one checkout uses them — then had its children read out of a project directory
 * that has no such file, and a missing file reads back as empty text. The panel reported "this file
 * does not parse" about a file it had never opened.
 */
describe("finding a state's layer", () => {
  const entry = (patch: Partial<WorkflowEntry> & Pick<WorkflowEntry, "rootId" | "layer">): WorkflowEntry =>
    ({ states: [], issues: [], taskIds: [], driftedTasks: [], ...patch }) as WorkflowEntry;

  const WORKFLOWS = [
    entry({ rootId: "feature", layer: "base", states: ["feature", "feature/product", "feature/product/context"] }),
    entry({ rootId: "local", layer: "project", states: ["local", "local/step"] }),
  ];

  it("takes a root's own row, which says which copy would run", () => {
    expect(workflowLayerOf(WORKFLOWS, "feature")).toBe("base");
    expect(workflowLayerOf(WORKFLOWS, "local")).toBe("project");
  });

  it("takes a child's layer from the root that lists it — the bug", () => {
    expect(workflowLayerOf(WORKFLOWS, "feature/product/context")).toBe("base");
    expect(workflowLayerOf(WORKFLOWS, "local/step")).toBe("project");
  });

  it("falls back to the project for a state no root lists", () => {
    // Not a wrong answer so much as the only one available — and the caller checks it against the
    // disk, which is what makes an unlisted state readable at all.
    expect(workflowLayerOf(WORKFLOWS, "nobody/knows")).toBe("project");
    expect(workflowLayerOf([], "feature")).toBe("project");
  });
});
