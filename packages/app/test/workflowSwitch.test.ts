/**
 * The renderer's rules for decision 0021: the Disable / Enable items in the words a file's layer calls
 * for, what the empty Chat room starts a conversation as, what a conversation opened with, and the
 * choices Settings → Runs → Conversations offers.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowEntry } from "@jaira/shared/browser";
import { switchItems } from "../src/renderer/workflowSwitch";
import { conversationStartOf, conversationsSchemaOf, openingOf } from "../src/renderer/chatWorkflow";

const labels = (items: ReturnType<typeof switchItems>): string[] => items.map((item) => `${item.label}${item.disabled === true ? " (off)" : ""}`);

describe("switchItems", () => {
  it("switches a project's own file in place", () => {
    const writes: Array<[string, boolean]> = [];
    const items = switchItems({ stateId: "release/notes", layer: "project", hasProject: true }, (layer, disabled) => writes.push([layer, disabled]));
    expect(labels(items)).toEqual(["Disable"]);
    items[0]!.onSelect();
    expect(writes).toEqual([["project", true]]);
    expect(labels(switchItems({ stateId: "release/notes", layer: "project", disabledBy: "release/notes", hasProject: true }, () => undefined))).toEqual(["Enable"]);
  });

  it("offers an inherited one for this project or for every project", () => {
    const writes: Array<[string, boolean]> = [];
    const items = switchItems({ stateId: "session", layer: "system", hasProject: true }, (layer, disabled) => writes.push([layer, disabled]));
    expect(labels(items)).toEqual(["Disable in this project", "Disable in every project"]);
    items.forEach((item) => item.onSelect());
    expect(writes).toEqual([
      ["project", true],
      ["base", true],
    ]);
    expect(labels(switchItems({ stateId: "feature", layer: "base", disabledBy: "feature", hasProject: true }, () => undefined))).toEqual(["Enable in this project", "Enable in every project"]);
  });

  it("writes Shared alone where no project is open, and says nothing it cannot do", () => {
    expect(labels(switchItems({ stateId: "feature", layer: "base", hasProject: false }, () => undefined))).toEqual(["Disable"]);
    // A state switched off by one above it comes back on with that one.
    expect(labels(switchItems({ stateId: "feature/review", layer: "base", disabledBy: "feature", hasProject: true }, () => undefined))).toEqual(["Enable (off)"]);
  });
});

const entry = (rootId: string, extra: Partial<WorkflowEntry> = {}): WorkflowEntry => ({ rootId, states: [rootId], issues: [], taskIds: [], driftedTasks: [], layer: "project", ...extra });

describe("conversationStartOf", () => {
  const workflows = [
    entry("session", { label: "Session", layer: "system", conversationInput: "message" }),
    entry("planning/plan", { label: "Planning", conversationInput: "goal" }),
    entry("feature", { label: "Feature" }),
  ];

  it("runs what the settings name, session by default", () => {
    expect(conversationStartOf({}, workflows)).toMatchObject({ workflow: "session", input: "message", disabled: false });
    expect(conversationStartOf({ conversations: { workflow: "planning/plan" } }, workflows)).toMatchObject({ workflow: "planning/plan", input: "goal", label: "Planning" });
  });

  it("says when that one is disabled, and offers only the enabled ones that can be a conversation", () => {
    const off = [{ ...workflows[0]!, disabled: true as const }, workflows[1]!, workflows[2]!];
    const start = conversationStartOf({}, off);
    expect(start.disabled).toBe(true);
    expect(start.choices).toEqual([{ stateId: "planning/plan", label: "Planning", input: "goal" }]);
  });
});

describe("openingOf", () => {
  it("reads the one text input, whatever it is called", () => {
    expect(openingOf({ message: "hello" })).toBe("hello");
    expect(openingOf({ goal: "ship it", depth: 3 })).toBe("ship it");
    expect(openingOf({ a: "x", b: "y" })).toBeNull();
    expect(openingOf(undefined)).toBeNull();
  });
});

describe("conversationsSchemaOf", () => {
  it("offers the workflows that can be a conversation by name, and keeps the value set", () => {
    const schema = { type: "object", properties: { workflow: { type: "string", default: "session" } } };
    const workflows = [entry("session", { label: "Session", conversationInput: "message" }), entry("feature")];
    type Out = { properties: Record<string, { enum: string[]; enumDescriptions: string[] }> };
    const unset = conversationsSchemaOf(schema, workflows, {}) as unknown as Out;
    expect(unset.properties["workflow"]).toMatchObject({ enum: ["session"], enumDescriptions: ["Session — session"] });
    const kept = conversationsSchemaOf(schema, workflows, { workflow: "lost/one" }) as unknown as Out;
    expect(kept.properties["workflow"]).toMatchObject({ enum: ["session", "lost/one"], enumDescriptions: ["Session — session", "lost/one — cannot be a conversation"] });
  });
});
