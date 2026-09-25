/**
 * The events workflow as a project resolves it (decision 0010 §4; REFERENCES.md §4.2a; the rulings of
 * 2026-09-25).
 *
 * What ships has no automations. Shared's copy follows the built-in and adds lines; a project's copy
 * follows Shared's by `$BASE`, its own lines FIRST, then Shared's minus the ones it ignores, and its
 * children beside Shared's. Every line enters an async child whose state is `system/events/<name>` —
 * ONE state whose operation is a list of `start_task` / `notify` calls — found through the layers by
 * its id, so a project's own copy of that one file changes that automation for that project alone.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automationStateOf, jairaBasePaths, type AutomationStep } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { validateBundle } from "@declarative-ai/hw";
import { hostCalleeSignatures } from "@jaira/runtime";
import { browseWorkflows, EVENTS_WORKFLOW, ensureBaseEventsCopy, initProject, openProject, readEventsWorkflow, type Project } from "../src/index";

let dir: string;
let project: Project | undefined;

function write(root: string, relPath: string, body: unknown): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

/** One automation as the Automations editor writes it: a named line into one async child, and the child's state. */
function automation(name: string, event: string, workflow: string): { line: Record<string, unknown>; children: Record<string, unknown>; state: Record<string, unknown> } {
  const steps: AutomationStep[] = [
    { kind: "start", workflow, inputs: { issue: { event: "payload.commits[0].message" }, ask_below: { literal: 0.8 } } },
    { kind: "notify", text: `started ${workflow}` },
  ];
  return {
    line: { name, when: `on_event('${event}', { branch: 'main' })`, to: name, inputs: { event: ".event" } },
    children: { [name]: { async: true } },
    state: automationStateOf(name, steps),
  };
}

const push = automation("push_main", "git.push", "feature/review");
const nightly = automation("nightly", "git.merge_request.opened", "review/merge-request");
const release = automation("release_push", "git.push", "release/build");

function sharedCopy(): Record<string, unknown> {
  return {
    $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`,
    transitions: [push.line, nightly.line],
    children: { ...push.children, ...nightly.children },
  };
}

/** Shared's copy and its automations' states, in Shared. */
function writeShared(): void {
  write(base(), `${EVENTS_WORKFLOW}.json`, sharedCopy());
  write(base(), `${EVENTS_WORKFLOW}/push_main.json`, push.state);
  write(base(), `${EVENTS_WORKFLOW}/nightly.json`, nightly.state);
}

function projectCopy(ignored: string[]): Record<string, unknown> {
  return {
    $ref: `$BASE/workflows/${EVENTS_WORKFLOW}`,
    transitions: [
      release.line,
      { $ref: `...filter($BASE/workflows/${EVENTS_WORKFLOW}.transitions, (t) => !${JSON.stringify(ignored).replace(/"/g, "'")}.includes(t.name))` },
    ],
    children: { $ref: `$BASE/workflows/${EVENTS_WORKFLOW}.children`, ...release.children },
  };
}

beforeEach(() => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-events-wf-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const open = (): Project => (project = openProject(dir, { baseDir: testHome() }));
const base = (): string => jairaBasePaths(testHome()).workflowsDir;
const own = (): string => join(dir, ".jaira", "workflows");
const functions = (): Map<string, { kind: "host"; capabilities: { interactive: false; readOnly: false; memoizable: false } }> =>
  new Map([...hostCalleeSignatures()].map(([name]) => [name, { kind: "host" as const, capabilities: { interactive: false, readOnly: false, memoizable: false } as const }]));
/** A loaded automation state's calls, by the function each names and the text a notify says. */
const callsOf = (reading: ReturnType<typeof readEventsWorkflow>, name: string): unknown[] =>
  (reading.bundle.states[`${EVENTS_WORKFLOW}/${name}`]?.operation as unknown as Array<{ functionRef?: string; input?: Record<string, { binding?: unknown }> }>).map((call) =>
    call.functionRef === "notify" ? ["notify", (call.input?.["text"]?.binding as { text?: string } | undefined)?.text] : [call.functionRef],
  );

describe("the events workflow", () => {
  it("ships with no automations: the built-in loads, with nothing to listen for", () => {
    const reading = readEventsWorkflow(open());
    expect(reading.bundle.rootId).toBe(EVENTS_WORKFLOW);
    expect(reading.lines).toEqual([]);
    expect(reading.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("a project with no copy of its own runs Shared's — which follows the built-in and adds lines, each ONE state with an operation list", () => {
    writeShared();
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["push_main", "nightly"]);
    // The automations' states are Shared's files beside its root, found by their ids.
    expect(Object.keys(reading.bundle.states).sort()).toEqual([EVENTS_WORKFLOW, `${EVENTS_WORKFLOW}/nightly`, `${EVENTS_WORKFLOW}/push_main`]);
    expect(callsOf(reading, "push_main")).toEqual([["start_task"], ["notify", "started feature/review"]]);
    expect(validateBundle(reading.bundle, { functions: functions() }).errors).toEqual([]);
  });

  it("a project's copy: its own lines first, then Shared's minus the ones it ignores, and every child from both", () => {
    writeShared();
    write(own(), `${EVENTS_WORKFLOW}.json`, projectCopy(["nightly"]));
    write(own(), `${EVENTS_WORKFLOW}/release_push.json`, release.state);
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["release_push", "push_main"]);
    const root = reading.bundle.states[EVENTS_WORKFLOW] as { children?: Record<string, unknown>; sequence?: unknown; transitions?: Array<Record<string, unknown>> };
    expect(Object.keys(root.children ?? {}).sort()).toEqual(["nightly", "push_main", "release_push"]);
    // The built-in's shape is kept under both layers: no spine.
    expect(root.sequence).toEqual([]);
    // Shared's line arrives whole: it hands its child the event, and nothing else.
    expect(root.transitions?.[1]).toMatchObject({ name: "push_main", to: "push_main" });
    // And the whole of it validates as a run would: `.event` in, `.inputs.event` read in `args`.
    expect(validateBundle(reading.bundle, { functions: functions() }).errors).toEqual([]);
  });

  it("a project's own system/events/<name> overrides Shared's for THAT project only — with or without a copy of the root", () => {
    writeShared();
    const other = mkdtempSync(join(tmpdir(), "jaira-events-other-"));
    try {
      initProject(other, testHome());
      write(own(), `${EVENTS_WORKFLOW}/push_main.json`, automationStateOf("push_main", [{ kind: "notify", text: "this project only" }]));
      // No copy of the root here: Shared's line, this project's steps.
      expect(callsOf(readEventsWorkflow(open()), "push_main")).toEqual([["notify", "this project only"]]);
      // With a copy that splices Shared's lines in, the same.
      write(own(), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
      write(own(), `${EVENTS_WORKFLOW}/release_push.json`, release.state);
      const reading = readEventsWorkflow(project!);
      expect(callsOf(reading, "push_main")).toEqual([["notify", "this project only"]]);
      expect(validateBundle(reading.bundle, { functions: functions() }).errors).toEqual([]);
      // Another project runs Shared's steps, untouched.
      const neighbour = openProject(other, { baseDir: testHome() });
      try {
        expect(callsOf(readEventsWorkflow(neighbour), "push_main")).toEqual([["start_task"], ["notify", "started feature/review"]]);
      } finally {
        neighbour.close();
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("Shared's copy spells its lists out: a copy that is ONLY a `$ref` has no `transitions` of its own for a project's copy to read", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, { $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}` });
    write(own(), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
    write(own(), `${EVENTS_WORKFLOW}/release_push.json`, release.state);
    expect(() => readEventsWorkflow(open())).toThrow(/has no 'transitions'/);
  });

  it("the lint names a line whose event Settings switch off", () => {
    write(own(), `${EVENTS_WORKFLOW}.json`, { $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`, transitions: [push.line], children: push.children });
    write(own(), `${EVENTS_WORKFLOW}/push_main.json`, push.state);
    const issues = browseWorkflows(open()).workflows.find((w) => w.rootId === EVENTS_WORKFLOW)?.issues ?? [];
    expect(issues).toContainEqual({ stateId: EVENTS_WORKFLOW, path: "transitions.0.when", message: "git.push is switched off in Settings → Tools → Events, so this never fires", severity: "warning" });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("ignoring nothing keeps every one of Shared's lines, after the project's", () => {
    writeShared();
    write(own(), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
    write(own(), `${EVENTS_WORKFLOW}/release_push.json`, release.state);
    expect(readEventsWorkflow(open()).lines).toEqual(["release_push", "push_main", "nightly"]);
  });

  it("a project's copy names Shared's by $BASE, which names ONE place: with no copy in Shared it does not load until one is written", () => {
    write(own(), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
    write(own(), `${EVENTS_WORKFLOW}/release_push.json`, release.state);
    expect(() => readEventsWorkflow(open())).toThrow(/system\/events/);
    project?.close();
    project = undefined;

    const made = ensureBaseEventsCopy(jairaBasePaths(testHome()));
    expect(made.created).toBe(true);
    // Idempotent: an existing copy is never replaced.
    expect(ensureBaseEventsCopy(jairaBasePaths(testHome()))).toEqual({ file: made.file, created: false });
    expect(readEventsWorkflow(open()).lines).toEqual(["release_push"]);
  });

  it("changing a line — or only its steps — changes the version a task would pin; nothing changed, nothing moves", () => {
    writeShared();
    const first = readEventsWorkflow(open()).hash;
    expect(readEventsWorkflow(project!).hash).toBe(first);
    write(base(), `${EVENTS_WORKFLOW}/push_main.json`, automationStateOf("push_main", [{ kind: "notify", text: "only this now" }]));
    const second = readEventsWorkflow(project!).hash;
    expect(second).not.toBe(first);
    write(base(), `${EVENTS_WORKFLOW}.json`, { ...sharedCopy(), transitions: [push.line] });
    expect(readEventsWorkflow(project!).hash).not.toBe(second);
  });
});
