/**
 * Seeding a child's required input rows.
 *
 * The property that makes this safe: a seeded row has no value, and `applyBindings` drops a row with
 * no value. So nothing is written, `children.<key>.inputs` stays exactly as authored, and the state
 * still fails to lint with "required child input 'x' is not wired" — which is the point. The row
 * moves WHERE you meet that sentence, from the lint panel after a save to the form while you are
 * still mounting the child. It does not silence it.
 */
import { describe, expect, it } from "vitest";
import type { StateSlotInfo, StateSlots } from "@jaira/shared/browser";
import { seedRequiredBindings } from "../src/renderer/stateEditor";
import { applyForm, emptyChildRow, formOf, type ChildRow } from "../src/renderer/stateForm";

const child = (key: string, inputs: ChildRow["inputs"] = []): ChildRow => ({
  ...emptyChildRow(),
  key,
  inputs,
});

const slot = (name: string, optional = false): StateSlotInfo => ({ name, optional });

/** A child's whole surface. Only `inputs` seeds rows; `outputs` feeds binding completion. */
const declares = (...inputs: StateSlotInfo[]): StateSlots => ({ inputs, outputs: [] });

/** The children table's real resolver is `childStateIdOf`; here the key IS the id. */
const byKey = (row: ChildRow): string => row.key;

describe("seeding required bindings", () => {
  it("adds a blank row per required input", () => {
    const out = seedRequiredBindings([child("goals")], { goals: declares(slot("issue"), slot("depth")) }, byKey);
    expect(out[0]!.inputs).toEqual([
      { name: "issue", value: "" },
      { name: "depth", value: "" },
    ]);
  });

  it("leaves optional inputs alone", () => {
    // A blank row for an optional slot would never resolve into anything — it is not an error, so
    // nothing would ever clear it, and a table of permanent non-problems hides the real ones.
    const out = seedRequiredBindings([child("goals")], { goals: declares(slot("depth", true)) }, byKey);
    expect(out[0]!.inputs).toEqual([]);
  });

  it("does not disturb a wire that is already there", () => {
    const wired = [{ name: "issue", value: ".inputs.issue" }];
    const out = seedRequiredBindings([child("goals", wired)], { goals: declares(slot("issue"), slot("plan")) }, byKey);
    expect(out[0]!.inputs).toEqual([...wired, { name: "plan", value: "" }]);
  });

  it("returns the same array when there is nothing to add", () => {
    // Identity, not deep equality: the effect that calls this writes back only on a real change, and
    // a fresh array every render would loop.
    const rows = [child("goals", [{ name: "issue", value: ".inputs.issue" }])];
    expect(seedRequiredBindings(rows, { goals: declares(slot("issue")) }, byKey)).toBe(rows);
    expect(seedRequiredBindings(rows, {}, byKey)).toBe(rows);
  });

  it("says nothing about a child whose state has not been read", () => {
    // Absent is not the same as "declares nothing" — the id may be half-typed, or unreadable. Only a
    // state that was actually looked at seeds rows.
    expect(seedRequiredBindings([child("goals")], {}, byKey)[0]!.inputs).toEqual([]);
  });

  it("is idempotent", () => {
    const declared = { goals: declares(slot("issue")) };
    const once = seedRequiredBindings([child("goals")], declared, byKey);
    expect(seedRequiredBindings(once, declared, byKey)).toBe(once);
  });
});

describe("what a seeded row does to the document", () => {
  const DOC = { children: { goals: { state: "./goals" } } };

  it("writes nothing, so the state still fails to lint", () => {
    const form = formOf(DOC);
    const seeded = seedRequiredBindings(form.children, { goals: declares(slot("issue")) }, byKey);
    const out = applyForm(DOC, { ...form, children: seeded }) as Record<string, unknown>;

    // No `inputs` key at all — which is precisely the shape hw reports as "required child input
    // 'issue' is not wired". The row is a prompt to the author, not an authored value.
    expect((out["children"] as Record<string, unknown>)["goals"]).toEqual({ state: "./goals" });
  });

  it("leaves the document byte-identical, so validation still runs off the saved file", () => {
    // The seeded row is a PLACEHOLDER. Round-tripping a document through the form with rows added
    // has to produce the same document, or opening a state would mark the file modified before
    // anyone touched it — and the JSON tab would then validate a draft nobody authored.
    const doc = {
      label: "Plan",
      children: { goals: { state: "./goals" }, critique: { inputs: { plan: ".children.goals.outputs.plan" } } },
      sequence: ["goals", "critique"],
    };
    const form = formOf(doc);
    const seeded = seedRequiredBindings(
      form.children,
      { goals: declares(slot("issue"), slot("depth")), critique: declares(slot("plan")) },
      byKey,
    );

    expect(seeded).not.toBe(form.children); // rows really were added
    expect(applyForm(doc, { ...form, children: seeded })).toEqual(applyForm(doc, form));
  });

  it("writes the wire once the author fills it in", () => {
    const form = formOf(DOC);
    const seeded = seedRequiredBindings(form.children, { goals: declares(slot("issue")) }, byKey);
    const filled = seeded.map((row) => ({ ...row, inputs: [{ name: "issue", value: ".inputs.issue" }] }));
    const out = applyForm(DOC, { ...form, children: filled }) as Record<string, unknown>;

    expect((out["children"] as Record<string, unknown>)["goals"]).toEqual({
      state: "./goals",
      inputs: { issue: ".inputs.issue" },
    });
  });
});
