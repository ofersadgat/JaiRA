/**
 * Running a state from the Files inspector — what the form asks for and what it sends.
 *
 * The form is the app's one schema form, and it holds JSON VALUES: nothing in this module parses a
 * box any more. So the properties under test are the ones that are still decisions — which slots are
 * required, what the form opens holding, that NOT SET is an absent key rather than an empty value,
 * that what is sent is exactly what is held, and that the check goes out against the schema the slot
 * declares (so its verdict is the run's). What the form used to get wrong silently was the parsing:
 * a JSON box for any schema richer than a bare type, which refused `significant` in an enum slot.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard, SessionRef, StateView, TaskSummary, WorkflowEntry } from "@jaira/shared/browser";
import {
  createBlocker,
  initialRunValues,
  instanceAt,
  isFilled,
  keptSources,
  missingOf,
  newestRunOf,
  runBlocker,
  runChecksOf,
  runFieldsOf,
  runHistoryOf,
  runInputsOf,
  runSchemaOf,
  runTargetOf,
  runTitle,
  runValuesOf,
  settledMarkOf,
  sourceIdOf,
  sourceOptionsOf,
  sourceRefOf,
  sourceSlotsOf,
  workflowLayerOf,
  workflowMimeOf,
  type RunContext,
  type RunField,
} from "../src/renderer/runForm";
import { WORKFLOW_JSON, WORKFLOW_YAML } from "@jaira/shared/browser";
import { leafControlOf, settledCheck } from "../src/renderer/schemaForm/model";

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

  it("draws each slot with its declared schema, and the member says its description and default", () => {
    const issue = byName(PLAN, "issue");
    expect(issue.schema).toEqual({ type: "string", contentMediaType: "text/markdown", description: "what to do" });
    // What is CHECKED is exactly what the slot declares — nothing folded in — so the verdict is the run's.
    expect(issue.declared).toEqual({ type: "string", contentMediaType: "text/markdown" });
    expect(byName(PLAN, "depth").schema).toEqual({ type: "integer", default: 3 });
    // No schema at all takes anything, and says so as an empty schema rather than a guess.
    expect(byName(PLAN, "loose").schema).toEqual({});
  });

  it("picks each slot's control from its schema — a list and an object are fields, not JSON boxes", () => {
    expect(leafControlOf(byName(PLAN, "issue").schema)).toBe("multiline");
    expect(leafControlOf(byName(PLAN, "depth").schema)).toBe("integer");
    expect(leafControlOf(byName(PLAN, "strict").schema)).toBe("boolean");
    // The case this whole rework is about: an enum is a choice box that takes typing.
    const severity = runFieldsOf(
      JSON.stringify({ inputs: { severity: { schema: { type: "string", enum: ["blocker", "significant"] }, default: "significant" } } }),
      WORKFLOW_JSON,
    )![0]!;
    expect(leafControlOf(severity.schema)).toBe("choice");
  });

  it("makes the run form one object schema, requiring only the slots with no default and no switch", () => {
    const schema = runSchemaOf(fieldsOf(PLAN));
    expect(Object.keys(schema["properties"] as object)).toEqual(["issue", "depth", "strict", "tags", "shape", "loose"]);
    expect(schema["required"]).toEqual(["issue"]);
  });

  it("treats a slot with a default as satisfied", () => {
    expect(byName(PLAN, "depth")).toMatchObject({ required: false, default: 3 });
    expect(byName(PLAN, "issue").required).toBe(true);
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
    expect(fields?.map((f) => [f.name, f.schema])).toEqual([["issue", { type: "string" }]]);
  });

  it("answers null for a document that does not parse — not an empty form", () => {
    expect(runFieldsOf("{ not json", WORKFLOW_JSON)).toBeNull();
    expect(runFieldsOf("", WORKFLOW_JSON)).toBeNull();
    // A state with no inputs IS an empty form, and must not be confused with the above.
    expect(runFieldsOf('{"label":"x"}', WORKFLOW_JSON)).toEqual([]);
  });

  it("opens with every required slot at a value of its shape, and everything else NOT SET", () => {
    // Not the defaults: a slot with a default starts switched off, which is what sends the default.
    // And not `""` for the optional ones — an absent key is what not set IS.
    expect(initialRunValues(fieldsOf(PLAN))).toEqual({ issue: "" });
  });

  /**
   * The form describing a run that ALREADY happened — what the workflow link in a conversation's
   * gutter opens. The round trip is the property: what a run was called with, put in the form, has
   * to read back as the same inputs.
   */
  it("fills the form with what one run was actually called with", () => {
    const fields = fieldsOf(PLAN);
    const called = { issue: "fix the parser", depth: 7, strict: true, tags: ["a", "b"] };
    const values = runValuesOf(fields, called);
    expect(values).toEqual(called);
    // A slot the run carried nothing for is not set — which is what "its default applied" looks like.
    expect("shape" in values).toBe(false);
    expect(runInputsOf(fields, values)).toEqual(called);
  });
});

describe("what the form sends", () => {
  const fields = fieldsOf(PLAN);

  it("sends what it holds, as it holds it — digits in a text slot stay text", () => {
    // The trap the old text boxes had to dodge by hand: a helpful JSON parse would send the NUMBER 123
    // into a slot declared as a string. There is no parse any more to be helpful with.
    expect(runInputsOf(fields, { issue: "123", depth: 5, strict: false, tags: ["a"] })).toEqual({
      issue: "123",
      depth: 5,
      strict: false,
      tags: ["a"],
    });
  });

  it("sends nothing for a slot that is not set, and an empty string for one set to empty text", () => {
    const sent = runInputsOf(fields, { issue: "" });
    expect(sent).toEqual({ issue: "" });
    expect("depth" in sent).toBe(false);
  });

  it("sends nothing for a slot the state binds itself", () => {
    expect("wired" in runInputsOf(fields, { issue: "x", wired: "ignored" })).toBe(false);
  });

  it("asks for a check of every set slot against the schema it DECLARES", () => {
    const checks = runChecksOf(fields, { issue: "", depth: "deep", wired: "ignored" });
    expect(checks).toEqual([
      { path: "issue", schema: { type: "string", contentMediaType: "text/markdown" }, value: "" },
      // Raw text in a number slot is sent as the text, and comes back "'deep' is not a number".
      { path: "depth", schema: { type: "integer" }, value: "deep" },
    ]);
  });

  it("leaves a linked type to the run, which has it expanded", () => {
    const linked = fieldsOf({ inputs: { plan: { schema: "$/types/plan" } } });
    expect(linked[0]).toMatchObject({ typeRef: "$/types/plan" });
    expect(runChecksOf(linked, { plan: { steps: [] } })).toEqual([]);
  });

  it("reports a required slot with no value at all", () => {
    expect(missingOf(fields, {})).toEqual([{ path: "issue", message: "required" }]);
    expect(missingOf(fields, { issue: "" })).toEqual([]);
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

  const ok = settledCheck();
  const here = runTargetOf("project", "/home/me/repo");
  const shared = runTargetOf("base", null);
  const ctx = (patch: Partial<RunContext> = {}): RunContext => ({
    state: state(),
    target: here,
    exists: true,
    fields: [],
    check: ok,
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
        check: settledCheck([{ path: "issue", message: "required" }]),
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

  it("names the first complaint with its path, and how many there are", () => {
    expect(runBlocker(ctx({ check: settledCheck([{ path: "issue", message: "can't be empty" }]) }))).toBe("issue: can't be empty");
    expect(
      runBlocker(
        ctx({
          check: settledCheck([
            { path: "criteria[1].id", message: "must match ^AC-[0-9]+$" },
            { path: "ask_below", message: "must be at most 1" },
          ]),
        }),
      ),
    ).toBe("2 problems — criteria[1].id: must match ^AC-[0-9]+$");
  });

  it("waits for a check, saying so only before the first answer", () => {
    // Before anything has answered there is nothing to show, so it says what it is doing. After, a
    // re-check of a form that was fine keeps the button off without flashing text on every keystroke.
    expect(runBlocker(ctx({ check: { pending: true, answered: false, errors: [] } }))).toBe("checking…");
    expect(runBlocker(ctx({ check: { pending: true, answered: true, errors: [] } }))).toBe("");
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
    expect(fields?.map((f) => [f.name, f.schema, f.required])).toEqual([
      ["issue", { description: "what to do" }, true],
      ["depth", { type: "integer", default: 3 }, false],
    ]);
  });

  const blockerFor = (over: Partial<Parameters<typeof createBlocker>[0]> = {}): string | null =>
    createBlocker({
      workflow: "feature/plan",
      fields: [],
      check: settledCheck(),
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

  it("names the first complaint about the inputs", () => {
    expect(blockerFor({ check: settledCheck([{ path: "issue", message: "required" }]) })).toBe("issue: required");
    expect(blockerFor({ check: settledCheck([{ path: "depth", message: "'x' is not a number" }]) })).toBe(
      "depth: 'x' is not a number",
    );
  });

  it("lets a workflow with no inputs through, and refuses one mid-create", () => {
    expect(blockerFor()).toBeNull();
    expect(blockerFor({ busy: true })).toBe("busy");
  });

  it("does not refuse a workflow for its lint results, which it has none of", () => {
    // Deliberate, and the opposite of `runBlocker`: this form has no state view to read issues from,
    // and a workflow with errors starts here exactly as it always did — failing where it fails.
    const errored = { workflow: "feature/plan", fields: fieldsOf(PLAN), busy: false };
    expect(createBlocker({ ...errored, check: settledCheck() })).toBeNull();
  });

  it("numbers the title from the runs this workflow has already had", () => {
    const task = (workflow: string): TaskSummary =>
      ({ taskId: `#${workflow}`, title: workflow, workflow, status: "completed", updatedAt: 1 }) as TaskSummary;
    const tasks = [task("feature/plan"), task("feature/plan"), task("chat/session")];
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

describe("a slot taken from a task (decision 0005 §2)", () => {
  const FIELDS = runFieldsOf(
    JSON.stringify({
      inputs: {
        brief: { schema: { type: "string", minLength: 1 } },
        plan: { schema: "$/types/plan" },
        note: { schema: { type: "string" }, optional: true },
      },
    }),
    WORKFLOW_JSON,
  )!;
  const FROM = { brief: { taskId: "t-aaaaaaaaaa", output: "brief" } };

  it("asks about the slots whose schema it can read, and not about a linked type", () => {
    expect(sourceSlotsOf(FIELDS)).toEqual([
      { key: "brief", schema: { type: "string", minLength: 1 } },
      { key: "note", schema: { type: "string" } },
    ]);
  });

  it("sends a sourced slot as a source and never as a value, and neither checks it nor calls it missing", () => {
    const values = { brief: "", note: "n" };
    expect(runInputsOf(FIELDS, values, FROM)).toEqual({ note: "n" });
    expect(runChecksOf(FIELDS, values, FROM).map((c) => c.path)).toEqual(["note"]);
    expect(missingOf(FIELDS, { note: "n" }, FROM)).toEqual([{ path: "plan", message: "required" }]);
    // With nothing sourced the required slot is back to being the form's to fill.
    expect(missingOf(FIELDS, { note: "n" }).map((e) => e.path)).toEqual(["brief", "plan"]);
  });

  it("names an option by its task and output, round-trips its id, and says when the task is still on its way", () => {
    const options = sourceOptionsOf([
      { taskId: "t-aaaaaaaaaa", title: "Product", status: "completed", workflow: "feat/product", output: "brief", preview: "the brief", pending: false },
      { taskId: "t-bbbbbbbbbb", title: "Other", status: "running", workflow: "feat/product", output: "brief", pending: true },
    ]);
    expect(options).toEqual([
      { id: "t-aaaaaaaaaa#brief", label: "Product · brief", note: "the brief" },
      { id: "t-bbbbbbbbbb#brief", label: "Other · brief", note: "running — the new task waits for it to complete" },
    ]);
    expect(sourceRefOf(sourceIdOf(FROM.brief))).toEqual(FROM.brief);
    expect(sourceOptionsOf(undefined)).toEqual([]);
  });

  it("drops a pick the main process no longer offers", () => {
    const offered = { brief: [{ taskId: "t-aaaaaaaaaa", title: "P", status: "completed" as const, workflow: "w", output: "brief", pending: false }] };
    expect(keptSources(FROM, offered)).toEqual(FROM);
    expect(keptSources(FROM, { brief: [] })).toEqual({});
    expect(keptSources(FROM, undefined)).toEqual({});
  });

  it("says how a recorded value was settled, naming the task a bound one came from", () => {
    const titleOf = (id: string): string | undefined => (id === "t-aaaaaaaaaa" ? "Product" : undefined);
    expect(settledMarkOf(undefined, titleOf)).toBeUndefined();
    expect(settledMarkOf({ via: "bound" }, titleOf)).toEqual({ via: "bound", note: "bound — the workflow's wiring resolved it" });
    expect(settledMarkOf({ via: "bound", from: { taskId: "t-aaaaaaaaaa", output: "brief" } }, titleOf)).toEqual({ via: "bound", note: "bound — from Product · brief" });
    expect(settledMarkOf({ via: "inferred", confidence: 0.78 }, titleOf)).toEqual({ via: "inferred", confidence: 0.78, note: "inferred — a conversation supplied it" });
    expect(settledMarkOf({ via: "asked" }, titleOf)?.via).toBe("asked");
  });
});
