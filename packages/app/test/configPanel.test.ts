/**
 * A state's EFFECTIVE configuration, read from the panel describing a run.
 *
 * The panels around a run project a few fields out of a state — an executor, a model — and cannot
 * say what the state is actually configured as. The file cannot say it either: it is written with
 * `$ref`s and an `environment` block that inherits half of itself from wherever the state is
 * mounted. What the engine executes is the resolved document, and this is the panel that shows it.
 *
 * The panel is the Files view's editor under two switches (`reading.ts`): nothing in it changes
 * anything, and the bindings have the run's values under them. And it says WHICH copy it is showing:
 * a run pins its workflow, so "as this run pinned it" and "as it stands on disk now" are different
 * documents the moment anybody edits the file, which is precisely when somebody is reading this.
 *
 * These were read off the rendered panel while the desktop drew it itself. What is held here is what
 * the pure modules decide for a reading — which tabs, whether Save, which of the operation's boxes,
 * which values, which words for the copy. Where the link to the panel is offered, and what is inert,
 * is the drawing's.
 */
import { describe, expect, it } from "vitest";
import type { EffectiveState } from "@jaira/shared/browser";
import { copyWordsOf } from "../src/renderer/configPanelModel";
import { modelKnobsSet, simpleFieldShown } from "../src/renderer/operationFieldsModel";
import { SIMPLE_FIELDS } from "../src/renderer/operationForm";
import { slotValueOf } from "../src/renderer/reading";
import { slotMoreShown } from "../src/renderer/slotTableModel";
import { TABS, TAB_WORDS, savesOf } from "../src/renderer/stateEditorModel";
import { formOf, type FormModel } from "../src/renderer/stateForm";

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
    instanceId: "2",
    inputs: { issue: "the parser drops trailing commas" },
    output: { goals: ["stop dropping commas"] },
  },
  ...patch,
});

/** The form the editor draws for the reading's document — what `useWorkflowEditor` holds. */
const formOfReading = (state: EffectiveState = resolved()): FormModel => formOf(JSON.parse(state.source!.text));

describe("the state's configuration in the side panel", () => {
  it("is the FILES VIEW's editor — the same form, over the same document", () => {
    const form = formOfReading();
    // The form's own rows, not a second rendering of a state written for this panel.
    expect(form.inputs.map((row) => row.name)).toEqual(["issue"]);
    expect(form.outputs.map((row) => [row.name, row.binding])).toEqual([["goals", ".operation.output.goals"]]);
    // …and its three readings, which is the point of reusing it rather than printing a document.
    expect(TABS.map((tab) => TAB_WORDS[tab])).toEqual(["Form", "JSON", "Graph"]);
  });

  it("offers no Save", () => {
    // The bar is ABSENT, not disabled: a greyed-out Save under a finished run is an offer about a
    // document nobody is editing, and it still takes a row of a narrow column. The same file in the
    // Files view, where it is edited, has one.
    expect(savesOf(true, false)).toBe(false);
    expect(savesOf(false, false)).toBe(true);
  });

  it("drops the boxes a state left empty", () => {
    // A form shows every field it COULD hold, because that is how you find the one to fill in. A
    // reading of a state with a prompt and a model should not be a screen of empty labelled boxes.
    const operation = formOfReading().operation;
    const shown = (readOnly: boolean): string[] => SIMPLE_FIELDS.filter((spec) => simpleFieldShown(readOnly, operation, spec)).map((spec) => spec.label);
    // What it DOES say is what the state says.
    expect(shown(true)).toEqual(["Prompt", "Model"]);
    expect(operation.fields["prompt"]).toBe("Extract goals from {{.inputs.issue}}.");
    expect(operation.fields["model"]).toBe("claude-opus-5");
    // "Model settings" is a fold of boxes nobody tuned here, and a reading does not carry it.
    expect(modelKnobsSet(operation)).toBe(false);
    // The form over the same block, for the contrast: Search path and the rest are all there.
    expect(shown(false)).toHaveLength(SIMPLE_FIELDS.length);
    expect(shown(false)).toContain("Search path");
  });

  it("shows a value under a slot that declares nothing else", () => {
    const state = resolved();
    const [issue] = formOfReading(state).inputs;
    // The block under a slot's row holds its default, its description and — in a reading — its value.
    // This slot has neither of the first two, and the block is drawn for the value alone.
    expect([issue!.default, issue!.description]).toEqual(["", ""]);
    const value = slotValueOf(state.values!, "inputs", issue!.name, issue!.binding);
    expect(slotMoreShown(true, false, false, value)).toBe(true);
    expect(slotMoreShown(true, false, false, undefined)).toBe(false);
  });

  it("shows the value behind each binding, not just where it comes from", () => {
    const state = resolved();
    const form = formOfReading(state);
    const [issue] = form.inputs;
    const [goals] = form.outputs;
    // The input the engine resolved on the way in…
    expect(slotValueOf(state.values!, "inputs", issue!.name, issue!.binding)).toBe("the parser drops trailing commas");
    // …and the call's own result, which is where a produced output takes its value by name.
    expect(slotValueOf(state.values!, "outputs", goals!.name, goals!.binding)).toEqual(["stop dropping commas"]);
  });

  it("shows no values at all for a state nobody has run", () => {
    const form = formOfReading(resolved({ values: undefined }));
    // With no run behind it the panel hands the form no reading at all (null), and no slot has a value.
    expect(slotValueOf(null, "inputs", "issue", form.inputs[0]!.binding)).toBeUndefined();
    expect(slotValueOf(null, "outputs", "goals", form.outputs[0]!.binding)).toBeUndefined();
  });

  it("says whether the file on screen is still the one that ran", () => {
    expect(copyWordsOf(resolved())).toBe("the file this run pinned");
    // The case a reader of an old failure must not have to assume: the workflow has moved since.
    expect(copyWordsOf(resolved({ from: "moved" }))).toContain("the workflow has changed since this run");
    // And with no run named, the question does not arise.
    expect(copyWordsOf(resolved({ from: "disk" }))).toBe("as it stands on disk now");
  });
});
