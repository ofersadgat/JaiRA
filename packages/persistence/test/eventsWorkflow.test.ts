/**
 * The events workflow as a project resolves it (decision 0010 §4; REFERENCES.md §4.2a).
 *
 * What ships has no automations. Shared's copy follows the built-in and adds lines; a project's copy
 * follows Shared's by `$BASE`, its own lines FIRST, then Shared's minus the ones it ignores, and its
 * children beside Shared's. Every line enters a child naming a built-in step state
 * (`system/events/start`, `/notify`) — found from any layer's copy by its bare id.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaBasePaths } from "@jaira/shared";
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

/** One automation as the Automations editor writes it: a named line into a start step, and a notify step after it. */
function automation(name: string, event: string, workflow: string): { line: Record<string, unknown>; children: Record<string, unknown> } {
  return {
    line: {
      name,
      when: `on_event('${event}', { branch: 'main' })`,
      to: name,
      inputs: {
        event: ".event",
        workflow: { text: workflow },
        inputs: { $literal: { issue: { $binding: ".event.payload.commits[0].message" }, ask_below: 0.8 } },
      },
    },
    children: {
      [name]: { state: "system/events/start", async: true, transitions: [{ when: "true", to: `${name}_2` }] },
      [`${name}_2`]: {
        state: "system/events/notify",
        async: true,
        inputs: { event: ".children." + name + ".output.event", text: { text: `started ${workflow}` } },
      },
    },
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

describe("the events workflow", () => {
  it("ships with no automations: the built-in loads, with nothing to listen for", () => {
    const reading = readEventsWorkflow(open());
    expect(reading.bundle.rootId).toBe(EVENTS_WORKFLOW);
    expect(reading.lines).toEqual([]);
    expect(reading.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("a project with no copy of its own runs Shared's — which follows the built-in and adds lines", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, sharedCopy());
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["push_main", "nightly"]);
    // The step states are the built-in ones, found by their bare ids.
    expect(Object.keys(reading.bundle.states)).toEqual(expect.arrayContaining(["system/events/start", "system/events/notify"]));
    const root = reading.bundle.states[EVENTS_WORKFLOW] as { children?: Record<string, { state?: string }> };
    expect(root.children?.["push_main"]?.state).toBe("system/events/start");
  });

  it("a project's copy: its own lines first, then Shared's minus the ones it ignores, and every child from both", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, sharedCopy());
    write(join(dir, ".jaira", "workflows"), `${EVENTS_WORKFLOW}.json`, projectCopy(["nightly"]));
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["release_push", "push_main"]);
    const root = reading.bundle.states[EVENTS_WORKFLOW] as { children?: Record<string, unknown>; sequence?: unknown; transitions?: Array<Record<string, unknown>> };
    expect(Object.keys(root.children ?? {}).sort()).toEqual(["nightly", "nightly_2", "push_main", "push_main_2", "release_push", "release_push_2"]);
    // The built-in's shape is kept under both layers: no spine.
    expect(root.sequence).toEqual([]);
    // Shared's line arrives whole, its inputs included.
    expect(root.transitions?.[1]).toMatchObject({ name: "push_main", to: "push_main" });
    // And the whole of it validates as a run would: the step states' wiring, `.event`, `$literal`.
    const functions = new Map([...hostCalleeSignatures()].map(([name]) => [name, { interactive: false, readOnly: false, memoizable: false }]));
    expect(validateBundle(reading.bundle, { functions }).errors).toEqual([]);
  });

  it("Shared's copy spells its lists out: a copy that is ONLY a `$ref` has no `transitions` of its own for a project's copy to read", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, { $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}` });
    write(join(dir, ".jaira", "workflows"), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
    expect(() => readEventsWorkflow(open())).toThrow(/has no 'transitions'/);
  });

  it("the lint names a line whose event Settings switch off", () => {
    write(join(dir, ".jaira", "workflows"), `${EVENTS_WORKFLOW}.json`, { $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`, transitions: [push.line], children: push.children });
    const issues = browseWorkflows(open()).workflows.find((w) => w.rootId === EVENTS_WORKFLOW)?.issues ?? [];
    expect(issues).toContainEqual({ stateId: EVENTS_WORKFLOW, path: "transitions.0.when", message: "git.push is switched off in Settings → Tools → Events, so this never fires", severity: "warning" });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("ignoring nothing keeps every one of Shared's lines, after the project's", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, sharedCopy());
    write(join(dir, ".jaira", "workflows"), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
    expect(readEventsWorkflow(open()).lines).toEqual(["release_push", "push_main", "nightly"]);
  });

  it("a project's copy names Shared's by $BASE, which names ONE place: with no copy in Shared it does not load until one is written", () => {
    write(join(dir, ".jaira", "workflows"), `${EVENTS_WORKFLOW}.json`, projectCopy([]));
    expect(() => readEventsWorkflow(open())).toThrow(/system\/events/);
    project?.close();
    project = undefined;

    const made = ensureBaseEventsCopy(jairaBasePaths(testHome()));
    expect(made.created).toBe(true);
    // Idempotent: an existing copy is never replaced.
    expect(ensureBaseEventsCopy(jairaBasePaths(testHome()))).toEqual({ file: made.file, created: false });
    expect(readEventsWorkflow(open()).lines).toEqual(["release_push"]);
  });

  it("changing a line changes the version a task would pin; nothing changed, nothing moves", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, sharedCopy());
    const first = readEventsWorkflow(open()).hash;
    expect(readEventsWorkflow(project!).hash).toBe(first);
    write(base(), `${EVENTS_WORKFLOW}.json`, { ...sharedCopy(), transitions: [push.line] });
    expect(readEventsWorkflow(project!).hash).not.toBe(first);
  });
});
