/**
 * A state's EFFECTIVE configuration, read from the panel describing a run.
 *
 * The panels around a run project a few fields out of a state — an executor, a model — and cannot
 * say what the state is actually configured as. The file cannot say it either: it is written with
 * `$ref`s and an `environment` block that inherits half of itself from wherever the state is
 * mounted. What the engine executes is the resolved document, and this is the panel that shows it.
 *
 * Two claims are worth holding down. The link is offered from every panel that raises the question
 * — a run's, a workflow's, an open state file's — because the same question answered from one door
 * and not another is exactly the gap this closes. And the panel says WHICH copy it is showing: a run
 * pins its workflow, so "as this run pinned it" and "as it stands on disk now" are different
 * documents the moment anybody edits the file, which is precisely when somebody is reading this.
 *
 * Rendered to static markup, like the other view tests here — which is also why the drawing is split
 * from the fetch: a server render runs no effects, so `ConfigPanel` alone would only ever be caught
 * mid-read.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EffectiveState, InstanceNode, StateView } from "@jaira/shared/browser";
import { ConfigReading } from "../src/renderer/configPanel";
import { RunInspector, StateInspector } from "../src/renderer/files";
import { ReadOnlyContext } from "../src/renderer/reading";
import { WorkflowEditor } from "../src/renderer/stateEditor";

const SOURCE = {
  label: "Goals",
  inputs: { issue: { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } },
  outputs: { goals: { schema: { type: "array", items: { type: "string" } }, binding: ".operation.output.goals" } },
  operation: {
    prompt: "Extract goals from {{.inputs.issue}}.",
    model: "claude-opus-5",
    output: { goals: { schema: { type: "array" } } },
  },
};

const resolved = (patch: Partial<EffectiveState> = {}): EffectiveState => ({
  stateId: "feature/plan/goals",
  from: "pinned",
  rootId: "feature/plan",
  snapshotHash: "1d80c2ba054ac061f7b2a4c22fe864be17ae5128f",
  source: {
    stateId: "feature/plan/goals",
    layer: "project",
    file: "C:/repo/.jaira/workflows/feature/plan/goals.json",
    text: JSON.stringify(SOURCE, null, 2),
    exists: true,
  },
  values: {
    instanceId: 2,
    inputs: { issue: "the parser drops trailing commas" },
    output: { goals: ["stop dropping commas"] },
  },
  ...patch,
});

const drawPanel = (patch: Partial<EffectiveState> = {}, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(ConfigReading, { state: resolved(patch), ...props }));

const node = (patch: Partial<InstanceNode> = {}): InstanceNode => ({
  instanceId: 2,
  stateId: "feature/plan/goals",
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 1,
  children: [],
  ...patch,
});

const drawRun = (props: Partial<Parameters<typeof RunInspector>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(RunInspector, {
      node: node(),
      stateId: "feature/plan/goals",
      detail: null,
      stream: [],
      states: [],
      depth: 1,
      onBack: () => undefined,
      onShowTask: () => undefined,
      onStart: () => undefined,
      onCancel: () => undefined,
      onOpenState: () => undefined,
      ...props,
    }),
  );

const stateView = (patch: Partial<StateView> = {}): StateView =>
  ({
    stateId: "feature/plan/goals",
    children: [],
    board: null,
    tasksHere: [],
    tasksRecent: [],
    transitions: [],
    environment: {},
    issues: [],
    references: [],
    referencedBy: [],
    driftedTasks: [],
    ...patch,
  }) as unknown as StateView;

const drawState = (props: Partial<Parameters<typeof StateInspector>[0]> = {}): string =>
  renderToStaticMarkup(createElement(StateInspector, { state: stateView(), ...props }));

describe("the state's configuration in the side panel", () => {
  it("is the FILES VIEW's editor — the same form, over the same document", () => {
    const html = drawPanel();
    // The form's own furniture, not a second rendering of a state written for this panel.
    expect(html).toContain("Inputs");
    expect(html).toContain("Outputs");
    expect(html).toContain(".operation.output.goals");
    // …and its three readings, which is the point of reusing it rather than printing a document.
    expect(html).toContain(">Form<");
    expect(html).toContain(">JSON<");
    expect(html).toContain(">Graph<");
  });

  it("renders nothing that changes anything", () => {
    const html = drawPanel();
    // The chrome is ABSENT, not disabled: a greyed-out Save under a finished run is an offer about
    // a document nobody is editing, and it still takes a row of a narrow column.
    expect(html).not.toContain(">Save<");
    expect(html).not.toContain("+ Add");
    expect(html).not.toContain("+ Wire");
    // Linking MOVES a value into a file, which is one of the larger edits the form makes.
    expect(html).not.toContain("🔗");
    // The backstop for the boxes that remain — they show values and must not take any.
    expect(html).toContain("<fieldset");
    expect(html).toContain("disabled");
  });

  it("leaves the tab bar OUTSIDE the inert part, so the readings can still be switched", () => {
    // The bug this pins: a `fieldset[disabled]` around the whole editor reaches the tab buttons too,
    // and a panel that promises three readings then offers one.
    const html = drawPanel();
    expect(html.indexOf(">Form<")).toBeLessThan(html.indexOf("<fieldset"));
    expect(html.indexOf(">Graph<")).toBeLessThan(html.indexOf("<fieldset"));
  });

  it("drops the boxes a state left empty, and the pickers that say nothing was picked", () => {
    // A form shows every field it COULD hold, because that is how you find the one to fill in. A
    // reading of a state with a prompt and a model should not be a screen of empty labelled boxes.
    const html = drawPanel();
    expect(html).not.toContain("Search path");
    expect(html).not.toContain("Model settings");
    expect(html).not.toContain(">Description<");
    expect(html).not.toContain(">Session<");
    expect(html).not.toContain(">Limits<");
    // What it DOES say is what the state says.
    expect(html).toContain("Extract goals from");
    expect(html).toContain("claude-opus-5");
  });

  it("shows a value without a fold to open first", () => {
    const html = drawPanel();
    // In the slot's own block, beside `default` and `description` — not a control of its own.
    expect(html).toContain("run-value");
    expect(html).not.toContain("<summary>default");
  });

  it("shows the value behind each binding, not just where it comes from", () => {
    const html = drawPanel();
    // The input the engine resolved on the way in…
    expect(html).toContain("the parser drops trailing commas");
    // …and the call's own result, which is where a produced output takes its value by name.
    expect(html).toContain("stop dropping commas");
  });

  it("shows no values at all for a state nobody has run", () => {
    const html = drawPanel({ values: undefined });
    expect(html).not.toContain("slot-value");
  });

  it("says whether the file on screen is still the one that ran", () => {
    expect(drawPanel()).toContain("the file this run pinned");
    // The case a reader of an old failure must not have to assume: the workflow has moved since.
    expect(drawPanel({ from: "moved" })).toContain("the workflow has changed since this run");
    // And with no run named, the question does not arise.
    expect(drawPanel({ from: "disk" })).toContain("as it stands on disk now");
  });

  it("answers plainly when nothing defines that state any more", () => {
    expect(drawPanel({ source: undefined })).toContain("has no state called");
  });
});

describe("the link on a run's panel", () => {
  it("offers the configuration beside what the run was called with", () => {
    expect(drawRun({ onOpenConfig: () => undefined })).toContain("the effective configuration");
  });

  it("omits it where there is no panel to open one in", () => {
    // Optional rather than inert: a control that cannot do its one thing is worse than its absence.
    expect(drawRun()).not.toContain("the effective configuration");
  });
});

describe("the link on a workflow's panel", () => {
  it("offers the configuration in the section that names what it decides", () => {
    const html = drawState({ onOpenConfig: () => undefined });
    expect(html).toContain("Environment");
    expect(html).toContain("the effective configuration");
  });

  it("offers it even where no executor is named — which is when it is most wanted", () => {
    // "inherited" is exactly the answer that sends somebody looking for what it was inherited from.
    const html = drawState({ onOpenConfig: () => undefined });
    expect(html).toContain("no executor named");
    expect(html).toContain("the effective configuration");
  });

  it("omits it where there is no panel to open one in", () => {
    expect(drawState()).not.toContain("the effective configuration");
  });
});

/**
 * The other two readings.
 *
 * A reading is inert BELOW the tab bar and not everywhere: the form is what must not take input, and
 * the drawing is not a form at all — its controls pan, zoom and fit, which are ways of looking. Both
 * of those were inside one `fieldset[disabled]` for a round, which left the graph's three buttons
 * dead; and the JSON tab went through the authoring editor, whose schema picker and validation
 * report are about writing the file correctly rather than reading it.
 */
const readingTab = (tab: "form" | "json" | "graph"): string =>
  renderToStaticMarkup(
    createElement(
      ReadOnlyContext.Provider,
      { value: true },
      createElement(WorkflowEditor, {
        source: resolved().source!,
        tree: null,
        executors: [],
        busy: false,
        onSave: () => undefined,
        validate: undefined,
        tab,
      } as unknown as Parameters<typeof WorkflowEditor>[0]),
    ),
  );

describe("the JSON and graph readings", () => {
  it("shows the JSON as a document rather than through the authoring editor", () => {
    const html = readingTab("json");
    expect(html).toContain("reading-doc");
    expect(html).toMatch(/readOnly|readonly/);
    // The schema picker and its violation report are for writing the file, not for reading it.
    expect(html).not.toContain("schema-edit");
  });

  it("leaves the drawing out of the inert part, so it can still be panned and zoomed", () => {
    const html = readingTab("graph");
    expect(html).toContain("sg-map");
    expect(html).toContain("zoom in");
    // The one that mattered: three buttons inside a disabled fieldset are three dead buttons.
    expect(html).not.toContain("<fieldset");
  });

  it("keeps the form inert", () => {
    expect(readingTab("form")).toContain("<fieldset");
  });
});
