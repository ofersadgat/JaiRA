/**
 * Automations along the settings' six layers (decision 0023, amended 2026-11-18): Shared < the project <
 * this machine < the project on this machine < Just you < you in the project, most specific wins.
 *
 * An automation's state `system/events/<name>` is found by its id in the most specific layer that holds
 * it; the events workflow `system/events` splices along the chain — each layer's copy says its own lines,
 * then the layer under it's (`EVENTS_FOLLOWS`) less the ones it turns off, and a layer with no copy
 * passes the one under it through. A project and Shared with nothing in the four newer layers load
 * exactly as before (`eventsWorkflow.test.ts` is that, unchanged).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateBundle } from "@declarative-ai/hw";
import { hostCalleeSignatures } from "@jaira/runtime";
import { automationStateOf, baseAsProjectPaths, EVENTS_FOLLOWS, jairaBasePaths, projectSettingsKey, type WritableSetLayer } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import {
  EVENTS_WORKFLOW,
  fileLayerRoots,
  initProject,
  loadWorkflowBundle,
  openProject,
  readEventsWorkflow,
  readRepositoryIdentity,
  readWorkflowFiles,
  workflowLoadOptions,
  type Project,
} from "../src/index";

let dir: string;
let project: Project | undefined;

function write(root: string, relPath: string, body: unknown): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

const line = (name: string, event = "git.pushed"): Record<string, unknown> => ({ name, when: `on_event('${event}', { branch: 'main' })`, to: name, inputs: { event: ".event" } });
const says = (name: string, text: string): Record<string, unknown> => automationStateOf(name, [{ kind: "notify", text }]);

const open = (): Project => (project = openProject(dir, { baseDir: testHome() }));

/** A layer's `workflows/` in this test's project. */
function workflowsOf(layer: WritableSetLayer): string {
  const base = jairaBasePaths(testHome());
  switch (layer) {
    case "base":
      return base.workflowsDir;
    case "project":
      return join(dir, ".jaira", "workflows");
    case "machine":
      return join(base.baseDir, "machine", "workflows");
    case "projectMachine":
      return join(dir, ".jaira", "local", "workflows");
    case "you":
      return join(base.baseDir, "personal", "workflows");
    case "projectYou":
      return join(base.projectSettingsDir, projectSettingsKey(readRepositoryIdentity(dir), dir), "workflows");
  }
}

/** A layer's copy of the events workflow: its own lines, then the layer under it's less `ignored`. */
function copyIn(layer: WritableSetLayer, lines: string[], ignored: string[] = []): void {
  const under = `${EVENTS_FOLLOWS[layer]}/workflows/${EVENTS_WORKFLOW}`;
  const splice = ignored.length === 0 ? `...${under}.transitions` : `...filter(${under}.transitions, (t) => ![${ignored.map((n) => `'${n}'`).join(", ")}].includes(t.name))`;
  write(workflowsOf(layer), `${EVENTS_WORKFLOW}.json`, {
    $ref: under,
    transitions: [...lines.map((name) => line(name)), { $ref: splice }],
    children: { $ref: `${under}.children`, ...Object.fromEntries(lines.map((name) => [name, { async: true }])) },
  });
}

/** Shared's copy — follows the built-in, its lines spelled out — and a state for each. */
function shared(lines: string[]): void {
  write(workflowsOf("base"), `${EVENTS_WORKFLOW}.json`, {
    $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`,
    transitions: lines.map((name) => line(name)),
    children: Object.fromEntries(lines.map((name) => [name, { async: true }])),
  });
  for (const name of lines) state("base", name, `${name} from Shared`);
}

function state(layer: WritableSetLayer, name: string, text: string): void {
  write(workflowsOf(layer), `${EVENTS_WORKFLOW}/${name}.json`, says(name, text));
}

/** What each automation's one notify says, by name. */
function told(reading: ReturnType<typeof readEventsWorkflow>, ...names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    names.map((name) => {
      const call = (reading.bundle.states[`${EVENTS_WORKFLOW}/${name}`]?.operation as unknown as Array<{ input?: Record<string, { binding?: { text?: string } }> }> | undefined)?.[0];
      return [name, call?.input?.["text"]?.binding?.text];
    }),
  );
}

const functions = (): Map<string, { kind: "host"; capabilities: { interactive: false; readOnly: false; memoizable: false } }> =>
  new Map([...hostCalleeSignatures()].map(([name]) => [name, { kind: "host" as const, capabilities: { interactive: false, readOnly: false, memoizable: false } as const }]));

beforeEach(() => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-automation-layers-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("an automation's state, along the six layers", () => {
  it("Just you's copy of a state beats the project's — and the project's still beats Shared's where you have none", () => {
    shared(["push_main", "nightly"]);
    state("project", "push_main", "the project's");
    state("project", "nightly", "the project's");
    state("you", "push_main", "yours");
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["push_main", "nightly"]);
    expect(told(reading, "push_main", "nightly")).toEqual({ push_main: "yours", nightly: "the project's" });
    expect(validateBundle(reading.bundle, { functions: functions() }).errors).toEqual([]);
  });

  it("the project on this machine beats this machine, which beats the project; you in the project beats them all", () => {
    shared(["push_main"]);
    state("project", "push_main", "the project's");
    state("machine", "push_main", "this machine's");
    expect(told(readEventsWorkflow(open()), "push_main")).toEqual({ push_main: "this machine's" });
    state("projectMachine", "push_main", "the project on this machine's");
    expect(told(readEventsWorkflow(project!), "push_main")).toEqual({ push_main: "the project on this machine's" });
    state("you", "push_main", "yours");
    state("projectYou", "push_main", "yours in this project");
    expect(told(readEventsWorkflow(project!), "push_main")).toEqual({ push_main: "yours in this project" });
  });

  it("a state in a newer layer changes the version a task would pin — and the browser's load agrees", () => {
    shared(["push_main"]);
    const first = readEventsWorkflow(open()).hash;
    state("machine", "push_main", "this machine's");
    const second = readEventsWorkflow(project!).hash;
    expect(second).not.toBe(first);
    const paths = project!.paths;
    const again = loadWorkflowBundle(readWorkflowFiles(paths.workflowsDir), EVENTS_WORKFLOW, workflowLoadOptions(paths, { tolerant: true }));
    expect(again.states[`${EVENTS_WORKFLOW}/push_main`]).toEqual(readEventsWorkflow(project!).bundle.states[`${EVENTS_WORKFLOW}/push_main`]);
  });
});

describe("the events workflow, spliced along the chain", () => {
  it("each layer's own lines come first, then the layer under it's — a layer with no copy passes its own under-layer through", () => {
    shared(["push_main", "nightly"]);
    copyIn("project", ["release_push"], ["nightly"]);
    state("project", "release_push", "release");
    // This machine adds a line; the project on this machine has no copy at all.
    copyIn("machine", ["machine_line"]);
    state("machine", "machine_line", "machine");
    // Just you add one and turn the project's off.
    copyIn("you", ["mine"], ["release_push"]);
    state("you", "mine", "mine");
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["mine", "machine_line", "push_main"]);
    const root = reading.bundle.states[EVENTS_WORKFLOW] as { children?: Record<string, unknown>; sequence?: unknown };
    // Every layer's children are mounted; a line turned off is never entered.
    expect(Object.keys(root.children ?? {}).sort()).toEqual(["machine_line", "mine", "nightly", "push_main", "release_push"]);
    expect(root.sequence).toEqual([]);
    expect(validateBundle(reading.bundle, { functions: functions() }).errors).toEqual([]);
  });

  it("a more specific layer overrides a line by turning the lower one off and saying its own of that name", () => {
    shared(["push_main"]);
    write(workflowsOf("machine"), `${EVENTS_WORKFLOW}.json`, {
      $ref: `${EVENTS_FOLLOWS.machine}/workflows/${EVENTS_WORKFLOW}`,
      transitions: [line("push_main", "merge_request.opened"), { $ref: `...filter(${EVENTS_FOLLOWS.machine}/workflows/${EVENTS_WORKFLOW}.transitions, (t) => !['push_main'].includes(t.name))` }],
      children: { $ref: `${EVENTS_FOLLOWS.machine}/workflows/${EVENTS_WORKFLOW}.children`, push_main: { async: true } },
    });
    const reading = readEventsWorkflow(open());
    expect(reading.lines).toEqual(["push_main"]);
    const rules = (reading.bundle.states[EVENTS_WORKFLOW] as { transitions?: Array<{ when?: unknown }> }).transitions ?? [];
    expect(rules).toHaveLength(1);
    expect(JSON.stringify(rules[0]!.when)).toContain("merge_request.opened");
  });

  it("a newer layer's copy with nothing under it but Shared and what ships reads, in a project and in the shared root", () => {
    shared(["push_main"]);
    copyIn("you", ["mine"]);
    state("you", "mine", "mine");
    copyIn("projectYou", ["here"]);
    state("projectYou", "here", "here");
    expect(readEventsWorkflow(open()).lines).toEqual(["here", "mine", "push_main"]);
    // The shared root opened as a project has no project layers: `$PROJECTMACHINE` names the machine's
    // root, which has no copy and passes Shared's through.
    const paths = baseAsProjectPaths(testHome());
    expect(fileLayerRoots(paths).map((one) => one.layer)).toEqual(["you", "machine", "base", "system"]);
    const bundle = loadWorkflowBundle(readWorkflowFiles(paths.workflowsDir), EVENTS_WORKFLOW, workflowLoadOptions(paths));
    const rules = (bundle.states[EVENTS_WORKFLOW] as { transitions?: Array<{ name?: string }> }).transitions ?? [];
    expect(rules.map((rule) => rule.name)).toEqual(["mine", "push_main"]);
  });

  it("an older project and Shared — nothing in the newer layers — load the same lines and version as before", () => {
    shared(["push_main", "nightly"]);
    copyIn("project", ["release_push"], ["nightly"]);
    state("project", "release_push", "release");
    const before = readEventsWorkflow(open());
    expect(before.lines).toEqual(["release_push", "push_main"]);
    // An empty newer layer — the folders there, nothing in them — changes nothing either.
    mkdirSync(workflowsOf("machine"), { recursive: true });
    mkdirSync(workflowsOf("you"), { recursive: true });
    expect(readEventsWorkflow(project!).hash).toBe(before.hash);
  });
});
