/**
 * The events workflow's automations, rewritten from the shape they were first built in — one child per
 * step, naming the built-in `system/events/start` / `/notify`, chained `<name>_2`… — into one state per
 * automation whose operation is a list (the rulings of 2026-09-25). Run at every open; dry, it says what
 * it would write and writes nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaBasePaths, jairaPaths } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { validateBundle } from "@declarative-ai/hw";
import { hostCalleeSignatures } from "@jaira/runtime";
import { EVENTS_WORKFLOW, initProject, migrateEventsWorkflows, openProject, readEventsWorkflow, rewriteEventsDoc, type Project } from "../src/index";

let dir: string;
let project: Project | undefined;

function write(root: string, relPath: string, body: unknown): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  return file;
}
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** A line as 7c92fc93's editor wrote it: step 1 wired by the rule, step 2 chained from step 1's output. */
function oldLine(name: string, event: string, workflow: string): { line: Record<string, unknown>; children: Record<string, unknown> } {
  return {
    line: {
      name,
      when: `on_event('${event}', { branch: 'main' })`,
      to: name,
      inputs: {
        event: ".event",
        workflow: { text: workflow },
        title: { text: `Review ${name}` },
        inputs: { $literal: { issue: { $binding: ".event.payload.commits[0].message" }, ask_below: 0.8 } },
      },
    },
    children: {
      [name]: { state: "system/events/start", async: true, transitions: [{ when: "true", to: `${name}_2` }] },
      [`${name}_2`]: {
        state: "system/events/notify",
        async: true,
        inputs: { event: `.children.${name}.output.event`, text: { text: `started ${workflow}` } },
      },
    },
  };
}

const push = oldLine("push_main", "git.push", "feature/review");
const nightly = oldLine("nightly", "git.merge_request.opened", "review/merge-request");
/** A line nobody's editor wrote: a guard wired its own way, into a state of the project's. */
const handWritten = { line: { name: "by_hand", when: "on_event('git.push')", to: "by_hand", inputs: { event: ".event", extra: { text: "x" } } }, children: { by_hand: { state: "system/events/start", async: true } } };

const oldShared = (): Record<string, unknown> => ({
  $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`,
  transitions: [push.line, nightly.line],
  children: { ...push.children, ...nightly.children },
});

beforeEach(() => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-events-mig-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const base = (): string => jairaBasePaths(testHome()).workflowsDir;
const own = (): string => join(dir, ".jaira", "workflows");
const paths = () => jairaPaths(dir, testHome());

describe("migrating the events workflow's automations", () => {
  it("dry: says what it would write — each automation's state, then the root — and writes nothing", () => {
    const file = write(base(), `${EVENTS_WORKFLOW}.json`, oldShared());
    const before = readFileSync(file, "utf8");
    const [report, ...more] = migrateEventsWorkflows(paths(), { dryRun: true });
    expect(more).toEqual([]);
    expect(report).toMatchObject({ file, lines: ["push_main", "nightly"], kept: [] });
    expect(report!.keptAt).toBeUndefined();
    expect(report!.writes.map((w) => w.file)).toEqual([join(base(), EVENTS_WORKFLOW, "push_main.json"), join(base(), EVENTS_WORKFLOW, "nightly.json"), file]);
    // Nothing touched.
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(base(), EVENTS_WORKFLOW, "push_main.json"))).toBe(false);

    // What it would write: the rule hands in the event only, the child is bare, and the state is a list.
    const root = JSON.parse(report!.writes.at(-1)!.text) as { transitions: unknown[]; children: Record<string, unknown> };
    expect(root.transitions[0]).toEqual({ name: "push_main", when: "on_event('git.push', { branch: 'main' })", to: "push_main", inputs: { event: ".event" } });
    expect(root.children).toEqual({ push_main: { async: true }, nightly: { async: true } });
    const state = JSON.parse(report!.writes[0]!.text) as Record<string, unknown>;
    expect(state).toEqual({
      label: "push_main",
      inputs: { event: { schema: {}, optional: true, description: "The event the automation fired on — its rule hands `.event` in." } },
      operation: [
        {
          function: "start_task",
          args: { workflow: "feature/review", inputs: { issue: { $binding: { $expr: ".inputs.event.payload.commits[0].message" } }, ask_below: 0.8 }, title: "Review push_main" },
        },
        { function: "notify", args: { text: "started feature/review" } },
      ],
    });
  });

  it("writes them, keeps the original, loads and validates — and a second open finds nothing to do", () => {
    const file = write(base(), `${EVENTS_WORKFLOW}.json`, oldShared());
    const [report] = migrateEventsWorkflows(paths(), { now: () => Date.parse("2026-09-25T12:00:00Z") });
    expect(report!.keptAt).toBeDefined();
    expect(read(join(report!.keptAt!, "events.json"))).toEqual(oldShared());
    expect(existsSync(join(base(), EVENTS_WORKFLOW, "nightly.json"))).toBe(true);
    expect(read(file)).toMatchObject({ $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`, children: { push_main: { async: true }, nightly: { async: true } } });

    const reading = readEventsWorkflow((project = openProject(dir, { baseDir: testHome() })));
    expect(reading.lines).toEqual(["push_main", "nightly"]);
    const functions = new Map([...hostCalleeSignatures()].map(([name]) => [name, { kind: "host" as const, capabilities: { interactive: false, readOnly: false, memoizable: false } }]));
    expect(validateBundle(reading.bundle, { functions }).errors).toEqual([]);
    expect(migrateEventsWorkflows(paths())).toEqual([]);
  });

  it("runs at open, on Shared's copy and the project's — a project's own lines only, its splice of Shared's kept", () => {
    write(base(), `${EVENTS_WORKFLOW}.json`, oldShared());
    const release = oldLine("release_push", "git.push", "release/build");
    const splice = { $ref: `...filter($BASE/workflows/${EVENTS_WORKFLOW}.transitions, (t) => !['nightly'].includes(t.name))` };
    write(own(), `${EVENTS_WORKFLOW}.json`, {
      $ref: `$BASE/workflows/${EVENTS_WORKFLOW}`,
      transitions: [release.line, splice],
      children: { $ref: `$BASE/workflows/${EVENTS_WORKFLOW}.children`, ...release.children },
    });
    project = openProject(dir, { baseDir: testHome() });
    expect(read(join(own(), `${EVENTS_WORKFLOW}.json`))).toEqual({
      $ref: `$BASE/workflows/${EVENTS_WORKFLOW}`,
      transitions: [{ name: "release_push", when: "on_event('git.push', { branch: 'main' })", to: "release_push", inputs: { event: ".event" } }, splice],
      children: { $ref: `$BASE/workflows/${EVENTS_WORKFLOW}.children`, release_push: { async: true } },
    });
    expect(existsSync(join(own(), EVENTS_WORKFLOW, "release_push.json"))).toBe(true);
    expect(readEventsWorkflow(project).lines).toEqual(["release_push", "push_main"]);
  });

  it("leaves a line it cannot take apart as it stands, and names it", () => {
    const rewritten = rewriteEventsDoc({ ...oldShared(), transitions: [push.line, handWritten.line], children: { ...push.children, ...handWritten.children } });
    expect(rewritten?.lines).toEqual(["push_main"]);
    expect(rewritten?.kept).toEqual(["by_hand"]);
    expect(rewritten?.root["transitions"]).toContainEqual(handWritten.line);
    expect((rewritten?.root["children"] as Record<string, unknown>)["by_hand"]).toEqual(handWritten.children.by_hand);
  });

  it("does nothing to a copy already in the new shape, or with no automations", () => {
    expect(rewriteEventsDoc({ $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`, transitions: [], children: {} })).toBeUndefined();
    expect(rewriteEventsDoc({ transitions: [{ name: "a", when: "on_event('git.push')", to: "a", inputs: { event: ".event" } }], children: { a: { async: true } } })).toBeUndefined();
  });
});
