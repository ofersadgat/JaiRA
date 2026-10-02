/**
 * Settings → Tools → Automations as data (decision 0010 §4, the rulings of 2026-09-25): a layer's events
 * workflow read into lines and written back — the rule into ONE async child, whose state
 * (`system/events/<name>`) runs the line's steps as one operation list; the literal and `$binding`
 * spellings of `args`; a project's `$ref` copy with Shared's lines spliced in minus the ignored ones;
 * a Shared line changed from a project page (its steps: the project's own copy of that one state; its
 * event: a project line in its place) — and the flags a line carries. The written files are loaded and
 * validated by the engine itself, so the shape is one the events task can run.
 */
import { describe, expect, it } from "vitest";
import { loadBundle, validateBundle } from "@declarative-ai/hw";
import { hostCalleeSignatures } from "@jaira/runtime";
import { automationStateOf, stepsOfAutomationState } from "@jaira/shared";
import {
  EVENTS_STATE_ID,
  SYSTEM_EVENTS,
  automationStateIdOf,
  automationsReadOf,
  automationsWritesOf,
  eventPicksOf,
  eventsTaskOf,
  filterCovers,
  filterFormOf,
  filterOfForm,
  filterSchemaOf,
  filtersMeet,
  flagText,
  freshLineName,
  ignoredOfSplice,
  lineFlagsOf,
  linesProblem,
  moveLine,
  parseEventsDoc,
  parseWhen,
  rebaseLines,
  sharedStepsWritesOf,
  shownLinesOf,
  spliceRefOf,
  stepFormOf,
  stepOfForm,
  stepsReaderOf,
  stepSummary,
  whenOf,
  writeEventsDoc,
  writeLine,
  type AutomationLine,
  type AutomationWrite,
  type Copies,
} from "../src/renderer/automationsModel";

/** The decision's own example: a push to main starts a review, then docs sync. */
const pushMainDocs: AutomationLine = {
  name: "push_main_docs",
  event: "git.pushed",
  filter: { branch: "main" },
  steps: [
    { kind: "start", workflow: "feature/review", inputs: { issue: { event: "payload.commits[0].message" }, branch: { event: "payload.branch" }, ask_below: { literal: 0.8 } } },
    { kind: "start", workflow: "docs/sync", inputs: { branch: { event: "payload.branch" } }, topLevel: true },
  ],
};

const mrOpened: AutomationLine = {
  name: "mr_opened",
  event: "merge_request.opened",
  filter: {},
  steps: [
    { kind: "start", workflow: "review/merge-request", inputs: { request: { event: "payload.merge_request" } }, title: "Review the request" },
    { kind: "notify", text: "Review started" },
  ],
};

const on = { "git.pushed": { enabled: true }, "merge_request.opened": { enabled: true } } as const;

/** Each line's state as a layer holds it, by name. */
const statesOf = (...lines: AutomationLine[]): Record<string, unknown> => Object.fromEntries(lines.map((line) => [line.name, automationStateOf(line.name, line.steps)]));
/** A page's steps, read from `states` alone. */
const readerOf = (states: Record<string, unknown>) => stepsReaderOf([{ layer: "base", states }]);
/** The text of the write to one state, parsed. */
const written = (writes: readonly AutomationWrite[], layer: string, stateId: string): unknown => {
  const found = writes.find((w) => w.layer === layer && w.stateId === stateId && !("remove" in w));
  return found !== undefined && "text" in found ? JSON.parse(found.text) : undefined;
};

describe("a line's guard", () => {
  it("writes on_event with the filter, and reads it back", () => {
    expect(whenOf("git.pushed", {})).toBe("on_event('git.pushed')");
    expect(whenOf("git.pushed", { branch: "main" })).toBe("on_event('git.pushed', { branch: 'main' })");
    expect(whenOf("git.pushed", { branch: ["main", "release/*"], author: "ofer" })).toBe("on_event('git.pushed', { branch: ['main', 'release/*'], author: 'ofer' })");
    for (const filter of [{}, { branch: "main" }, { branch: ["main", "release/*"], author: "o'hara" }]) {
      expect(parseWhen(whenOf("git.pushed", filter))).toEqual({ event: "git.pushed", filter });
    }
  });

  it("reads a hand-written guard of the same form, and refuses anything else", () => {
    expect(parseWhen(`on_event("git.pushed",{branch:"main",})`)).toEqual({ event: "git.pushed", filter: { branch: "main" } });
    expect(parseWhen("on_event('git.pushed') && .inputs.x")).toBeUndefined();
    expect(parseWhen("true")).toBeUndefined();
    expect(parseWhen(undefined)).toBeUndefined();
  });
});

describe("one line with two steps", () => {
  it("is one named rule handing in the event, to ONE async child — the steps are that child's state", () => {
    const { rule, children } = writeLine(pushMainDocs);
    expect(rule).toEqual({ name: "push_main_docs", when: "on_event('git.pushed', { branch: 'main' })", to: "push_main_docs", inputs: { event: ".event" } });
    expect(children).toEqual({ push_main_docs: { async: true } });
  });

  it("writes the state as one operation list: literals as they are, picks from the event wrapped `$binding`", () => {
    expect(automationStateOf(pushMainDocs.name, pushMainDocs.steps)).toEqual({
      label: "push_main_docs",
      inputs: { event: { schema: {}, optional: true, description: "The event the automation fired on — its rule hands `.event` in." } },
      operation: [
        {
          function: "start_task",
          args: {
            workflow: "feature/review",
            inputs: { issue: { $binding: { $expr: ".inputs.event.payload.commits[0].message" } }, branch: { $binding: { $expr: ".inputs.event.payload.branch" } }, ask_below: 0.8 },
          },
        },
        { function: "start_task", args: { workflow: "docs/sync", inputs: { branch: { $binding: { $expr: ".inputs.event.payload.branch" } } }, top_level: true } },
      ],
    });
    // A notify is its text; a title rides as its own argument. No outputs: a list must bind each one.
    const state = automationStateOf(mrOpened.name, mrOpened.steps);
    expect(state["operation"]).toEqual([
      { function: "start_task", args: { workflow: "review/merge-request", inputs: { request: { $binding: { $expr: ".inputs.event.payload.merge_request" } } }, title: "Review the request" } },
      { function: "notify", args: { text: "Review started" } },
    ]);
    expect(state["outputs"]).toBeUndefined();
  });

  it("round-trips through the root and the states, a notify and a start on its own included", () => {
    const doc = writeEventsDoc(undefined, [pushMainDocs, mrOpened]);
    expect(doc["sequence"]).toEqual([]);
    expect(parseEventsDoc(doc, readerOf(statesOf(pushMainDocs, mrOpened)))).toEqual({ lines: [pushMainDocs, mrOpened], follows: false });
    for (const line of [pushMainDocs, mrOpened]) expect(stepsOfAutomationState(automationStateOf(line.name, line.steps))).toEqual(line.steps);
    // A state hand-edited to keep its label and a description keeps them when its steps are rewritten.
    const edited = { ...automationStateOf("x", mrOpened.steps), label: "Mine", description: "by hand" };
    expect(automationStateOf("x", pushMainDocs.steps, edited)).toMatchObject({ label: "Mine", description: "by hand", operation: automationStateOf("x", pushMainDocs.steps)["operation"] });
  });

  it("keeps what it does not write — other keys, other children, a hand-written rule", () => {
    const hand = { name: "odd", when: "on_event('git.pushed') && true", to: "odd_child" };
    const previous = { label: "Mine", transitions: [hand], children: { odd_child: { state: "x/y", async: true }, spare: { state: "a/b" } } };
    const read = parseEventsDoc(previous);
    expect(read.lines).toHaveLength(1);
    expect(read.lines[0]!.raw).toEqual({ rule: hand, children: { odd_child: { state: "x/y", async: true } } });
    const doc = writeEventsDoc(previous, [...read.lines, pushMainDocs]);
    expect(doc["label"]).toBe("Mine");
    expect(doc["transitions"]).toEqual([hand, writeLine(pushMainDocs).rule]);
    expect(Object.keys(doc["children"] as object).sort()).toEqual(["odd_child", "push_main_docs", "spare"]);
    // Removing a line removes its child and nothing else.
    const without = writeEventsDoc(doc, [read.lines[0]!]);
    expect(Object.keys(without["children"] as object).sort()).toEqual(["odd_child", "spare"]);
  });

  it("is a raw line when its rule, its child or its state is not one this editor writes", () => {
    const doc = writeEventsDoc(undefined, [pushMainDocs]);
    const withState = (state: unknown) => parseEventsDoc(doc, readerOf({ push_main_docs: state })).lines[0]!;
    expect(withState(automationStateOf(pushMainDocs.name, pushMainDocs.steps)).raw).toBeUndefined();
    // A call of some other function, or a state with outputs: edited as a file.
    expect(withState({ operation: [{ function: "claude-code", args: {} }] }).raw).toBeDefined();
    expect(withState({ ...automationStateOf("x", mrOpened.steps), outputs: { a: { binding: ".operation[0].output" } } }).raw).toBeDefined();
    const wired = { ...doc, children: { push_main_docs: { async: true, inputs: { x: ".event" } } } };
    expect(parseEventsDoc(wired).lines[0]!.raw).toEqual({ rule: writeLine(pushMainDocs).rule, children: { push_main_docs: { async: true, inputs: { x: ".event" } } } });
  });

  it("loads and validates in the engine: `.event` in, `.inputs.event` read in `args`, calls in order", () => {
    const files = {
      [`${EVENTS_STATE_ID}.json`]: writeEventsDoc(undefined, [pushMainDocs, mrOpened]),
      [`${automationStateIdOf(pushMainDocs.name)}.json`]: automationStateOf(pushMainDocs.name, pushMainDocs.steps),
      [`${automationStateIdOf(mrOpened.name)}.json`]: automationStateOf(mrOpened.name, mrOpened.steps),
    };
    const bundle = loadBundle(files as never, EVENTS_STATE_ID, { functions: hostCalleeSignatures() });
    expect(Object.keys(bundle.states).sort()).toEqual([EVENTS_STATE_ID, "system/events/mr_opened", "system/events/push_main_docs"]);
    expect(validateBundle(bundle).errors).toEqual([]);
  });
});

describe("a project's copy", () => {
  it("follows Shared's and splices its lines in after its own, minus the ignored", () => {
    const doc = writeEventsDoc({}, [pushMainDocs], { ignored: ["push_main"] });
    expect(doc["$ref"]).toBe("$BASE/workflows/system/events");
    expect((doc["transitions"] as unknown[]).at(-1)).toEqual({
      $ref: "...filter($BASE/workflows/system/events.transitions, (t) => !['push_main'].includes(t.name))",
    });
    expect((doc["children"] as Record<string, unknown>)["$ref"]).toBe("$BASE/workflows/system/events.children");
    const read = parseEventsDoc(doc, readerOf(statesOf(pushMainDocs)));
    expect(read).toEqual({ lines: [pushMainDocs], splice: { ignored: ["push_main"] }, follows: true });
  });

  it("splices every Shared line with nothing ignored", () => {
    expect(spliceRefOf([])).toEqual({ $ref: "...$BASE/workflows/system/events.transitions" });
    expect(ignoredOfSplice(spliceRefOf([]).$ref)).toEqual([]);
    expect(ignoredOfSplice(spliceRefOf(["a", "b's"]).$ref)).toEqual(["a", "b's"]);
    expect(ignoredOfSplice("...filter($BASE/x.transitions, (t) => true)")).toBeUndefined();
  });

  it("shows its own lines, then Shared's, the ignored ones marked — and one standing in for Shared's of its name", () => {
    const shared = [{ ...pushMainDocs, name: "push_main" }, mrOpened];
    const shown = shownLinesOf(parseEventsDoc(writeEventsDoc({}, [pushMainDocs, { ...mrOpened, filter: { author: "ofer" } }], { ignored: ["push_main", "mr_opened"] })), shared);
    expect(shown.map((s) => [s.line.name, s.from, s.ignored, s.replaces === true])).toEqual([
      ["push_main_docs", "own", false, false],
      ["mr_opened", "own", false, true],
      ["push_main", "shared", true, false],
      ["mr_opened", "shared", true, false],
    ]);
  });
});

describe("the layers the section reads and writes", () => {
  const builtIn = writeEventsDoc(undefined, []);

  it("Shared with no copy reads the built-in, and its first write is each line's state, then Shared's copy of the root", () => {
    const copies: Copies = { base: { states: {} }, system: { root: builtIn } };
    const read = automationsReadOf(copies, "base");
    expect(read.source).toBe("built in");
    expect(read.own.lines).toEqual([]);
    const writes = automationsWritesOf(copies, "base", [], [mrOpened, pushMainDocs]);
    expect(writes.map((w) => [w.layer, w.stateId])).toEqual([
      ["base", "system/events/mr_opened"],
      ["base", "system/events/push_main_docs"],
      ["base", EVENTS_STATE_ID],
    ]);
    const root = written(writes, "base", EVENTS_STATE_ID) as Record<string, unknown>;
    expect(root["$ref"]).toBe(SYSTEM_EVENTS);
    expect(Object.keys(root).sort()).toEqual(["$ref", "children", "transitions"]);
    expect(written(writes, "base", "system/events/push_main_docs")).toEqual(automationStateOf(pushMainDocs.name, pushMainDocs.steps));
    // Taking every line out keeps both keys: a project's copy reads them off this file.
    expect(writeEventsDoc(root, [])).toEqual({ $ref: SYSTEM_EVENTS, transitions: [], children: {} });
  });

  it("a change to a line's steps alone writes its state and not the root; a line taken out takes its state with it", () => {
    const root = writeEventsDoc({ $ref: SYSTEM_EVENTS }, [pushMainDocs, mrOpened]);
    const copies: Copies = { base: { root, states: statesOf(pushMainDocs, mrOpened) } };
    const quicker = { ...mrOpened, steps: [{ kind: "notify" as const, text: "a request opened" }] };
    expect(automationsWritesOf(copies, "base", [pushMainDocs, mrOpened], [pushMainDocs, quicker]).map((w) => w.stateId)).toEqual(["system/events/mr_opened"]);
    const gone = automationsWritesOf(copies, "base", [pushMainDocs, mrOpened], [pushMainDocs]);
    expect(gone.map((w) => [w.stateId, "remove" in w])).toEqual([
      [EVENTS_STATE_ID, false],
      ["system/events/mr_opened", true],
    ]);
    // A rename is a new state, and the old one goes.
    const renamed = automationsWritesOf(copies, "base", [pushMainDocs, mrOpened], [pushMainDocs, { ...mrOpened, name: "mr_new" }]);
    expect(renamed.map((w) => [w.stateId, "remove" in w])).toEqual([
      ["system/events/mr_new", false],
      [EVENTS_STATE_ID, false],
      ["system/events/mr_opened", true],
    ]);
  });

  it("a project with no copy shows Shared's lines, and its first write makes Shared's copy from the built-in first", () => {
    const copies: Copies = { project: { states: {} }, base: { states: {} }, system: { root: writeEventsDoc(undefined, [mrOpened]) } };
    const read = automationsReadOf(copies, "project");
    expect(read.source).toBe("none");
    expect(shownLinesOf(read.own, read.shared).map((s) => s.from)).toEqual(["shared"]);
    const writes = automationsWritesOf(copies, "project", [], [pushMainDocs], ["mr_opened"]);
    expect(writes.map((w) => [w.layer, w.stateId])).toEqual([
      ["base", EVENTS_STATE_ID],
      ["project", "system/events/push_main_docs"],
      ["project", EVENTS_STATE_ID],
    ]);
    const seed = written(writes, "base", EVENTS_STATE_ID) as Record<string, unknown>;
    expect(seed).toEqual({ $ref: SYSTEM_EVENTS, transitions: (copies.system!.root as Record<string, unknown>)["transitions"], children: (copies.system!.root as Record<string, unknown>)["children"] });
    expect(parseEventsDoc(written(writes, "project", EVENTS_STATE_ID), readerOf(statesOf(pushMainDocs)))).toEqual({ lines: [pushMainDocs], splice: { ignored: ["mr_opened"] }, follows: true });
  });

  it("a project whose Shared has a copy writes only its own, and keeps its ignored lines when its own change", () => {
    const shared: Copies["base"] = { root: writeEventsDoc({ $ref: SYSTEM_EVENTS }, [mrOpened]), states: statesOf(mrOpened) };
    expect(automationsWritesOf({ project: { states: {} }, base: shared }, "project", [], [pushMainDocs]).every((w) => w.layer === "project")).toBe(true);
    const project = writeEventsDoc({}, [], { ignored: ["x"] });
    const writes = automationsWritesOf({ project: { root: project, states: {} }, base: shared }, "project", [], [pushMainDocs]);
    expect(parseEventsDoc(written(writes, "project", EVENTS_STATE_ID)).splice).toEqual({ ignored: ["x"] });
  });
});

describe("a Shared line, changed from a project page", () => {
  const sharedRoot = writeEventsDoc({ $ref: SYSTEM_EVENTS }, [mrOpened]);
  const shared = (): Copies => ({ project: { states: {} }, base: { root: sharedRoot, states: statesOf(mrOpened) } });

  it("its STEPS: the project's own copy of that one state — no copy of the root, and nothing in Shared", () => {
    const steps = [{ kind: "notify" as const, text: "only here" }];
    const writes = sharedStepsWritesOf(shared(), "mr_opened", steps);
    expect(writes).toEqual([{ layer: "project", stateId: "system/events/mr_opened", text: expect.any(String) }]);
    // A copy of Shared's file, its operation list replaced.
    expect(written(writes, "project", "system/events/mr_opened")).toEqual(automationStateOf("mr_opened", steps, automationStateOf("mr_opened", mrOpened.steps)));
    // The project page then reads that line's steps from the project, and says so.
    const copies: Copies = { ...shared(), project: { states: { mr_opened: automationStateOf("mr_opened", steps) } } };
    const read = automationsReadOf(copies, "project");
    const shown = shownLinesOf(read.own, read.shared, read.stepsOf);
    expect(shown.map((s) => [s.line.name, s.from, s.stepsFrom])).toEqual([["mr_opened", "shared", "project"]]);
    expect(shown[0]!.line.steps).toEqual(steps);
    // Back to Shared's own steps: the project's copy goes.
    expect(sharedStepsWritesOf(copies, "mr_opened", mrOpened.steps)).toEqual([{ layer: "project", stateId: "system/events/mr_opened", remove: true }]);
    expect(sharedStepsWritesOf(shared(), "mr_opened", mrOpened.steps)).toEqual([]);
  });

  it("its EVENT or filter: a line of the project's own of that name, Shared's ignored here — its steps still Shared's", () => {
    const mine = { ...mrOpened, filter: { author: "ofer" } };
    const writes = automationsWritesOf(shared(), "project", [], [mine], ["mr_opened"]);
    // No copy of the steps: through the layers, the project's line runs Shared's state already.
    expect(writes.map((w) => [w.layer, w.stateId])).toEqual([["project", EVENTS_STATE_ID]]);
    const root = written(writes, "project", EVENTS_STATE_ID);
    const read = parseEventsDoc(root, readerOf(statesOf(mrOpened)));
    expect(read.splice).toEqual({ ignored: ["mr_opened"] });
    expect(read.lines).toEqual([mine]);
  });

  it("a project line taken out that stood in for Shared's leaves the project's steps copy, which is Shared's line's now", () => {
    const copies: Copies = { project: { root: writeEventsDoc({}, [mrOpened], { ignored: ["mr_opened"] }), states: { mr_opened: automationStateOf("mr_opened", []) } }, base: shared().base! };
    const writes = automationsWritesOf(copies, "project", [mrOpened], [], []);
    expect(writes.some((w) => "remove" in w)).toBe(false);
  });
});


describe("flags", () => {
  const line = (name: string, event: string, filter: AutomationLine["filter"] = {}): AutomationLine => ({ name, event, filter, steps: [{ kind: "notify", text: "x" }] });
  const own = (lines: AutomationLine[]) => lines.map((l) => ({ line: l, from: "own" as const, ignored: false }));

  it("says a line an earlier one always catches is never reached", () => {
    const flags = lineFlagsOf(own([line("any", "git.pushed"), line("main", "git.pushed", { branch: "main" })]), on);
    expect(flags[0]).toEqual([]);
    expect(flags[1]).toEqual([{ kind: "never", by: "any" }]);
    expect(flagText(flags[1]![0]!)).toContain("Never reached: any");
  });

  it("says a line an earlier one sometimes catches is not reached then", () => {
    const flags = lineFlagsOf(own([line("main", "git.pushed", { branch: "main" }), line("release", "git.pushed", { branch: "release/*" }), line("any", "git.pushed", { branch: "*" })]), on);
    expect(flags[1]).toEqual([]);
    expect(flags[2]).toEqual([{ kind: "shadowed", by: ["main"] }]);
    expect(flagText(flags[2]![0]!)).toBe("Not reached when main matches: the first line that matches wins.");
  });

  it("reads globs: * stops at a slash, ** does not, a literal is matched", () => {
    expect(filterCovers({ branch: "release/*" }, { branch: "release/2.0" })).toBe(true);
    expect(filterCovers({ branch: "*" }, { branch: "release/*" })).toBe(false);
    expect(filterCovers({ branch: "**" }, { branch: "release/*" })).toBe(true);
    expect(filterCovers({ author: "Ofer" }, { author: "ofer" })).toBe(true);
    expect(filterCovers({ branch: "main" }, {})).toBe(false);
    expect(filtersMeet({ branch: "main" }, { branch: "develop" })).toBe(false);
    expect(filtersMeet({ branch: "main" }, { author: "x" })).toBe(true);
  });

  it("ignores other events, ignored lines and raw lines", () => {
    const shown = [
      { line: line("any", "git.pushed"), from: "shared" as const, ignored: true },
      { line: line("mr", "merge_request.opened"), from: "own" as const, ignored: false },
      { line: line("main", "git.pushed", { branch: "main" }), from: "own" as const, ignored: false },
    ];
    expect(lineFlagsOf(shown, on)).toEqual([[], [], []]);
  });

  it("flags an event switched off, one JaiRA does not raise, and a repeated name", () => {
    const flags = lineFlagsOf(own([line("a", "pipeline.failed"), line("b", "git.push"), line("a", "task.failed")]), { "task.failed": { enabled: false, remotes: {} } } as never);
    expect(flags[0]).toEqual([{ kind: "off", event: "pipeline.failed" }]);
    // The name before decision 0016: gone, so nothing raises it.
    expect(flags[1]).toEqual([{ kind: "unknown", event: "git.push" }]);
    expect(flags[2]).toEqual([{ kind: "duplicate" }, { kind: "off", event: "task.failed" }]);
    const perRemote = lineFlagsOf(own([line("a", "git.pushed")]), { "git.pushed": { enabled: false, remotes: { origin: true } } });
    expect(perRemote[0]).toEqual([]);
  });
});

describe("editing a line", () => {
  it("offers the payload's fields, and the first item's of a list", () => {
    const ids = eventPicksOf("git.pushed").map((pick) => pick.id);
    expect(ids).toEqual(expect.arrayContaining(["", "payload.branch", "payload.commits", "payload.commits[0].message", "payload.remote"]));
    expect(eventPicksOf("merge_request.opened").map((p) => p.label)).toContain("← event.merge_request.title");
    expect(eventPicksOf("nope").map((p) => p.id)).toEqual([""]);
  });

  it("takes the filter keys the event takes, as lists", () => {
    expect(Object.keys((filterSchemaOf("git.pushed")["properties"] ?? {}) as object)).toEqual(["branch", "remote", "author"]);
    expect(Object.keys((filterSchemaOf("task.finished")["properties"] ?? {}) as object)).toEqual([]);
    expect(filterFormOf({ branch: "main", author: ["a", "b"] })).toEqual({ branch: ["main"], author: ["a", "b"] });
    expect(filterOfForm({ branch: ["main"], author: ["a", " ", "b"], remote: [] })).toEqual({ branch: "main", author: ["a", "b"] });
  });

  it("holds a step's typed values and its picks apart", () => {
    const step = pushMainDocs.steps[0] as Extract<AutomationLine["steps"][number], { kind: "start" }>;
    const form = stepFormOf(step);
    expect(form).toEqual({ values: { ask_below: 0.8 }, picked: { issue: "payload.commits[0].message", branch: "payload.branch" } });
    expect(stepOfForm(step, form.values, form.picked)).toEqual({ ...step, inputs: { ask_below: { literal: 0.8 }, issue: step.inputs["issue"], branch: step.inputs["branch"] } });
    expect(stepSummary(pushMainDocs.steps[1]!)).toBe("branch ← event.branch · on its own");
  });

  it("says what stops a set of lines being written", () => {
    expect(linesProblem([pushMainDocs])).toBeUndefined();
    expect(linesProblem([{ ...pushMainDocs, name: "2x" }])).toContain("letters, digits");
    expect(linesProblem([pushMainDocs, pushMainDocs])).toContain("Another line has this name");
    expect(linesProblem([{ ...pushMainDocs, steps: [{ kind: "start", workflow: "", inputs: {} }] }])).toContain("needs the workflow");
    expect(freshLineName(["automation_1"])).toBe("automation_2");
  });

  it("moves a line by drag, and replays a change onto another layer's lines by name", () => {
    expect(moveLine(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveLine(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
    const changed = { ...mrOpened, filter: { author: "x" } };
    expect(rebaseLines([pushMainDocs, mrOpened], [changed], [mrOpened, { ...pushMainDocs, name: "other" }]).map((l) => l.name)).toEqual(["mr_opened", "other"]);
    expect(rebaseLines([], [pushMainDocs], [mrOpened]).map((l) => l.name)).toEqual(["mr_opened", "push_main_docs"]);
  });

  it("finds the events task by its title and workflow", () => {
    expect(eventsTaskOf([{ title: "events", workflow: "feature/plan" }, { title: "events", workflow: EVENTS_STATE_ID }])).toEqual({ title: "events", workflow: EVENTS_STATE_ID });
    expect(eventsTaskOf([])).toBeUndefined();
    expect(eventsTaskOf([{ title: "events", workflow: EVENTS_STATE_ID }, { title: "listener", workflow: EVENTS_STATE_ID, system: "events" }])).toMatchObject({ system: "events" });
  });
});
