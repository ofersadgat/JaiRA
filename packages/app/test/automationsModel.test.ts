/**
 * Settings → Tools → Automations as data (decision 0010 §4): a layer's events workflow read into lines
 * and written back — the rule and its chain of async step children, the literal spellings, a
 * project's `$ref` copy with Shared's lines spliced in minus the ignored ones — and the flags a line
 * carries (not reached, switched off). The written file is loaded and validated by the engine itself,
 * over stand-in step states, so the shape is one the events task can run.
 */
import { describe, expect, it } from "vitest";
import { loadBundle, validateBundle } from "@declarative-ai/hw";
import { hostCalleeSignatures } from "@jaira/runtime";
import {
  EVENTS_STATE_ID,
  NOTIFY_STEP,
  START_STEP,
  SYSTEM_EVENTS,
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
  shownLinesOf,
  spliceRefOf,
  stepFormOf,
  stepOfForm,
  stepSummary,
  whenOf,
  writeEventsDoc,
  writeLine,
  type AutomationLine,
} from "../src/renderer/automationsModel";
import { automationsReadOf, automationsWritesOf } from "../src/renderer/automationsPane";

/** The decision's own example: a push to main starts a review, then docs sync. */
const pushMainDocs: AutomationLine = {
  name: "push_main_docs",
  event: "git.push",
  filter: { branch: "main" },
  steps: [
    { kind: "start", workflow: "feature/review", inputs: { issue: { event: "payload.commits[0].message" }, branch: { event: "payload.branch" }, ask_below: { literal: 0.8 } } },
    { kind: "start", workflow: "docs/sync", inputs: { branch: { event: "payload.branch" } } },
  ],
};

const mrOpened: AutomationLine = {
  name: "mr_opened",
  event: "git.merge_request.opened",
  filter: {},
  steps: [
    { kind: "start", workflow: "review/merge-request", inputs: { request: { event: "payload.merge_request" } } },
    { kind: "notify", text: "Review started" },
  ],
};

const on = { "git.push": { enabled: true }, "git.merge_request.opened": { enabled: true } } as const;

describe("a line's guard", () => {
  it("writes on_event with the filter, and reads it back", () => {
    expect(whenOf("git.push", {})).toBe("on_event('git.push')");
    expect(whenOf("git.push", { branch: "main" })).toBe("on_event('git.push', { branch: 'main' })");
    expect(whenOf("git.push", { branch: ["main", "release/*"], author: "ofer" })).toBe("on_event('git.push', { branch: ['main', 'release/*'], author: 'ofer' })");
    for (const filter of [{}, { branch: "main" }, { branch: ["main", "release/*"], author: "o'hara" }]) {
      expect(parseWhen(whenOf("git.push", filter))).toEqual({ event: "git.push", filter });
    }
  });

  it("reads a hand-written guard of the same form, and refuses anything else", () => {
    expect(parseWhen(`on_event("git.push",{branch:"main",})`)).toEqual({ event: "git.push", filter: { branch: "main" } });
    expect(parseWhen("on_event('git.push') && .inputs.x")).toBeUndefined();
    expect(parseWhen("true")).toBeUndefined();
    expect(parseWhen(undefined)).toBeUndefined();
  });
});

describe("one line with two steps", () => {
  it("is one named rule to an async child, and a second child the first chains to", () => {
    const { rule, children } = writeLine(pushMainDocs);
    expect(rule).toEqual({
      name: "push_main_docs",
      when: "on_event('git.push', { branch: 'main' })",
      to: "push_main_docs",
      inputs: {
        event: ".event",
        workflow: { text: "feature/review" },
        inputs: { $literal: { issue: { $binding: ".event.payload.commits[0].message" }, branch: { $binding: ".event.payload.branch" }, ask_below: 0.8 } },
      },
    });
    expect(children).toEqual({
      push_main_docs: { state: START_STEP, async: true, transitions: [{ when: "true", to: "push_main_docs_2" }] },
      push_main_docs_2: {
        state: START_STEP,
        async: true,
        inputs: {
          event: ".children.push_main_docs.output.event",
          workflow: { text: "docs/sync" },
          inputs: { $literal: { branch: { $binding: ".children.push_main_docs.output.event.payload.branch" } } },
        },
      },
    });
  });

  it("round-trips through the document, a notify step included", () => {
    const doc = writeEventsDoc(undefined, [pushMainDocs, mrOpened]);
    expect(doc["sequence"]).toEqual([]);
    expect(parseEventsDoc(doc)).toEqual({ lines: [pushMainDocs, mrOpened], follows: false });
    expect(writeLine(mrOpened).children["mr_opened_2"]).toEqual({
      state: NOTIFY_STEP,
      async: true,
      inputs: { event: ".children.mr_opened.output.event", text: { text: "Review started" } },
    });
  });

  it("keeps what it does not write — other keys, other children, a hand-written rule", () => {
    const hand = { name: "odd", when: "on_event('git.push') && true", to: "odd_child" };
    const previous = { label: "Mine", transitions: [hand], children: { odd_child: { state: "x/y", async: true }, spare: { state: "a/b" } } };
    const read = parseEventsDoc(previous);
    expect(read.lines).toHaveLength(1);
    expect(read.lines[0]!.raw).toEqual({ rule: hand, children: { odd_child: { state: "x/y", async: true } } });
    const doc = writeEventsDoc(previous, [...read.lines, pushMainDocs]);
    expect(doc["label"]).toBe("Mine");
    expect(doc["transitions"]).toEqual([hand, writeLine(pushMainDocs).rule]);
    expect(Object.keys(doc["children"] as object).sort()).toEqual(["odd_child", "push_main_docs", "push_main_docs_2", "spare"]);
    // Removing a line removes its children and nothing else.
    const without = writeEventsDoc(doc, [read.lines[0]!]);
    expect(Object.keys(without["children"] as object).sort()).toEqual(["odd_child", "spare"]);
  });

  it("is a raw line when its chain is not one this editor writes", () => {
    const doc = writeEventsDoc(undefined, [pushMainDocs]);
    (doc["children"] as Record<string, Record<string, unknown>>)["push_main_docs_2"]!["state"] = "somewhere/else";
    const [line] = parseEventsDoc(doc).lines;
    expect(line!.raw).toBeDefined();
    expect(Object.keys(line!.raw!.children)).toEqual(["push_main_docs", "push_main_docs_2"]);
  });

  it("loads and validates in the engine, over stand-in step states", () => {
    // Every input optional: step 1's mount wires nothing (only its rule can read `.event`), and the
    // validator asks a mount to wire a REQUIRED input even when the rule's own inputs give it.
    const step = (text: boolean) => ({
      inputs: text
        ? { text: { schema: { type: "string" }, optional: true }, event: { schema: {}, optional: true } }
        : { workflow: { schema: { type: "string" }, optional: true }, inputs: { schema: { type: "object" }, optional: true }, event: { schema: {}, optional: true } },
      outputs: { event: { schema: {}, binding: ".inputs.event" } },
    });
    const files = {
      [`${EVENTS_STATE_ID}.json`]: writeEventsDoc(undefined, [pushMainDocs, mrOpened]),
      [`${START_STEP}.json`]: step(false),
      [`${NOTIFY_STEP}.json`]: step(true),
    };
    const bundle = loadBundle(files as never, EVENTS_STATE_ID, { functions: hostCalleeSignatures() });
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
    const read = parseEventsDoc(doc);
    expect(read).toEqual({ lines: [pushMainDocs], splice: { ignored: ["push_main"] }, follows: true });
  });

  it("splices every Shared line with nothing ignored", () => {
    expect(spliceRefOf([])).toEqual({ $ref: "...$BASE/workflows/system/events.transitions" });
    expect(ignoredOfSplice(spliceRefOf([]).$ref)).toEqual([]);
    expect(ignoredOfSplice(spliceRefOf(["a", "b's"]).$ref)).toEqual(["a", "b's"]);
    expect(ignoredOfSplice("...filter($BASE/x.transitions, (t) => true)")).toBeUndefined();
  });

  it("shows its own lines, then Shared's, the ignored ones marked", () => {
    const shared = [{ ...pushMainDocs, name: "push_main" }, mrOpened];
    const shown = shownLinesOf(parseEventsDoc(writeEventsDoc({}, [pushMainDocs], { ignored: ["push_main"] })), shared);
    expect(shown.map((s) => [s.line.name, s.from, s.ignored])).toEqual([
      ["push_main_docs", "own", false],
      ["push_main", "shared", true],
      ["mr_opened", "shared", false],
    ]);
  });
});

describe("the layers the section reads and writes", () => {
  const source = (doc: unknown, layer: "project" | "base" | "system") => ({ stateId: EVENTS_STATE_ID, layer, file: `${layer}/events.json`, text: doc === undefined ? "" : JSON.stringify(doc), exists: doc !== undefined });
  const builtIn = writeEventsDoc(undefined, [mrOpened]);

  it("Shared with no copy reads the built-in, and its first write is Shared's copy — following the built-in, stating its own lines", () => {
    const copies = { base: source(undefined, "base"), system: source(builtIn, "system") };
    const read = automationsReadOf(copies, "base");
    expect(read.source).toBe("built in");
    expect(read.own.lines).toEqual([mrOpened]);
    const writes = automationsWritesOf(copies, "base", [mrOpened, pushMainDocs], undefined);
    expect(writes.map((w) => w.layer)).toEqual(["base"]);
    const written = JSON.parse(writes[0]!.text) as Record<string, unknown>;
    expect(written["$ref"]).toBe(SYSTEM_EVENTS);
    expect(Object.keys(written).sort()).toEqual(["$ref", "children", "transitions"]);
    expect(parseEventsDoc(written).lines).toEqual([mrOpened, pushMainDocs]);
    // Taking every line out keeps both keys: a project's copy reads them off this file.
    expect(writeEventsDoc(written, [])).toEqual({ $ref: SYSTEM_EVENTS, transitions: [], children: {} });
  });

  it("a project with no copy shows Shared's lines, and its first write makes Shared's copy from the built-in first", () => {
    const copies = { project: source(undefined, "project"), base: source(undefined, "base"), system: source(builtIn, "system") };
    const read = automationsReadOf(copies, "project");
    expect(read.source).toBe("none");
    expect(shownLinesOf(read.own, read.shared).map((s) => s.from)).toEqual(["shared"]);
    const writes = automationsWritesOf(copies, "project", [pushMainDocs], ["mr_opened"]);
    expect(writes.map((w) => w.layer)).toEqual(["base", "project"]);
    expect(JSON.parse(writes[0]!.text)).toEqual({ $ref: SYSTEM_EVENTS, transitions: builtIn["transitions"], children: builtIn["children"] });
    // With no built-in (or an empty one), Shared's copy is the rule `ensureBaseEventsCopy` writes.
    expect(JSON.parse(automationsWritesOf({ system: source(undefined, "system") }, "project", [pushMainDocs], undefined)[0]!.text)).toEqual({
      $ref: SYSTEM_EVENTS,
      transitions: [],
      children: {},
    });
    expect(parseEventsDoc(JSON.parse(writes[1]!.text))).toEqual({ lines: [pushMainDocs], splice: { ignored: ["mr_opened"] }, follows: true });
  });

  it("a project whose Shared has a copy writes only its own", () => {
    const copies = { project: source(undefined, "project"), base: source(builtIn, "base") };
    expect(automationsWritesOf(copies, "project", [pushMainDocs], undefined).map((w) => w.layer)).toEqual(["project"]);
  });

  it("keeps a project's ignored lines when its own lines change", () => {
    const project = writeEventsDoc({}, [], { ignored: ["x"] });
    const copies = { project: source(project, "project"), base: source(builtIn, "base") };
    const [write] = automationsWritesOf(copies, "project", [pushMainDocs], undefined);
    expect(parseEventsDoc(JSON.parse(write!.text)).splice).toEqual({ ignored: ["x"] });
  });
});

describe("flags", () => {
  const line = (name: string, event: string, filter: AutomationLine["filter"] = {}): AutomationLine => ({ name, event, filter, steps: [{ kind: "notify", text: "x" }] });
  const own = (lines: AutomationLine[]) => lines.map((l) => ({ line: l, from: "own" as const, ignored: false }));

  it("says a line an earlier one always catches is never reached", () => {
    const flags = lineFlagsOf(own([line("any", "git.push"), line("main", "git.push", { branch: "main" })]), on);
    expect(flags[0]).toEqual([]);
    expect(flags[1]).toEqual([{ kind: "never", by: "any" }]);
    expect(flagText(flags[1]![0]!)).toContain("Never reached: any");
  });

  it("says a line an earlier one sometimes catches is not reached then", () => {
    const flags = lineFlagsOf(own([line("main", "git.push", { branch: "main" }), line("release", "git.push", { branch: "release/*" }), line("any", "git.push", { branch: "*" })]), on);
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
      { line: line("any", "git.push"), from: "shared" as const, ignored: true },
      { line: line("mr", "git.merge_request.opened"), from: "own" as const, ignored: false },
      { line: line("main", "git.push", { branch: "main" }), from: "own" as const, ignored: false },
    ];
    expect(lineFlagsOf(shown, on)).toEqual([[], [], []]);
  });

  it("flags an event switched off, one JaiRA does not raise, and a repeated name", () => {
    const flags = lineFlagsOf(own([line("a", "git.checks.failed"), line("b", "git.pushed"), line("a", "task.failed")]), { "task.failed": { enabled: false, remotes: {} } } as never);
    expect(flags[0]).toEqual([{ kind: "off", event: "git.checks.failed" }]);
    expect(flags[1]).toEqual([{ kind: "unknown", event: "git.pushed" }]);
    expect(flags[2]).toEqual([{ kind: "duplicate" }, { kind: "off", event: "task.failed" }]);
    const perRemote = lineFlagsOf(own([line("a", "git.push")]), { "git.push": { enabled: false, remotes: { origin: true } } });
    expect(perRemote[0]).toEqual([]);
  });
});

describe("editing a line", () => {
  it("offers the payload's fields, and the first item's of a list", () => {
    const ids = eventPicksOf("git.push").map((pick) => pick.id);
    expect(ids).toEqual(expect.arrayContaining(["", "payload.branch", "payload.commits", "payload.commits[0].message", "payload.remote"]));
    expect(eventPicksOf("git.merge_request.opened").map((p) => p.label)).toContain("← event.merge_request.title");
    expect(eventPicksOf("nope").map((p) => p.id)).toEqual([""]);
  });

  it("takes the filter keys the event takes, as lists", () => {
    expect(Object.keys((filterSchemaOf("git.push")["properties"] ?? {}) as object)).toEqual(["branch", "remote", "author"]);
    expect(Object.keys((filterSchemaOf("task.finished")["properties"] ?? {}) as object)).toEqual([]);
    expect(filterFormOf({ branch: "main", author: ["a", "b"] })).toEqual({ branch: ["main"], author: ["a", "b"] });
    expect(filterOfForm({ branch: ["main"], author: ["a", " ", "b"], remote: [] })).toEqual({ branch: "main", author: ["a", "b"] });
  });

  it("holds a step's typed values and its picks apart", () => {
    const step = pushMainDocs.steps[0] as Extract<AutomationLine["steps"][number], { kind: "start" }>;
    const form = stepFormOf(step);
    expect(form).toEqual({ values: { ask_below: 0.8 }, picked: { issue: "payload.commits[0].message", branch: "payload.branch" } });
    expect(stepOfForm(step.workflow, form.values, form.picked)).toEqual({ ...step, inputs: { ask_below: { literal: 0.8 }, issue: step.inputs["issue"], branch: step.inputs["branch"] } });
    expect(stepSummary(pushMainDocs.steps[1]!)).toBe("branch ← event.branch");
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
