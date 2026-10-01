/**
 * What the side panel's frame and faces SAY, asserted on the models they draw from (the panel
 * rulings, 2026-09-24).
 *
 * This file rendered the DOM frame (`sidePanel.tsx`) and built faces with `panelFaces.tsx`'s `faceOf`;
 * both went with the DOM renderer. The universal frame and faces
 * (`packages/universal/src/components/panel/SidePanel.tsx`, `faces.tsx`) draw from the same pure
 * modules, and what is pinned here is what those modules decide: what a pushed entry's trail and kind
 * word read, where ✕ folds rather than closes, a state's Checks count, a chat's tabs, which task's
 * Configuration is called Automations, and where a copy of a task may start. The stack's own rules are
 * in `panelStack.test.ts`. The furniture — icons on the name's line, the rail, the offer bar's words —
 * is the frame's, and is not tested here.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, StateView, TaskDetail } from "@jaira/shared/browser";
import { chatTabs, isEventsTask, tab, taskTabs } from "../src/renderer/panelFaceModel";
import { closeFoldsOf, rerunStartsOf } from "../src/renderer/panelHost";
import { EMPTY_STACK, crumbOf, kindWordOf, push, reconcile, topOf, type PanelEntry } from "../src/renderer/panelStack";
import { checksCountOf } from "../src/renderer/panelViewsModel";

const task: PanelEntry = { kind: "task", key: "task:t1", taskId: "t1", tab: "conversation" };
const config: PanelEntry = { kind: "config", key: "config:x", stateId: "feature/plan/critique" };

describe("the frame", () => {
  const root = reconcile(EMPTY_STACK, task);

  it("draws nothing for an empty stack", () => {
    // The frame asks for what is on top and draws nothing when there is none.
    expect(topOf(EMPTY_STACK)).toBeUndefined();
    expect(topOf(root)).toBe(task);
  });

  it("beside a conversation, ✕ folds to the rail instead of closing", () => {
    // The rule the shell hands the frame as `closeFolds`: a panel whose root stands beside a
    // conversation — a task's in the main view, or a chat — folds; one standing on a task closes.
    expect(closeFoldsOf(reconcile(EMPTY_STACK, { kind: "convo", key: "convo:t1", taskId: "t1", tab: "steps" }))).toBe(true);
    expect(closeFoldsOf(reconcile(EMPTY_STACK, { kind: "chat", key: "chat:c1", taskId: "c1", tab: "produced" }))).toBe(true);
    expect(closeFoldsOf(root)).toBe(false);
    // It is the ROOT that decides: a card pushed on a task's panel does not make it fold.
    expect(closeFoldsOf(push(root, config))).toBe(false);
  });

  it("gives a pushed entry a way back and the trail it came from", () => {
    const [under, top] = push(root, config).entries;
    // The crumb, and "Back to t1" on it.
    expect(crumbOf(under!)).toBe("t1");
    // What kind of thing is on top, after its name.
    expect(kindWordOf(top!)).toBe("as it ran");
  });
});

const view = { stateId: "feature/plan", issues: [{ severity: "error", path: "", message: "bad" }], children: [], transitions: [], references: [], referencedBy: [], driftedTasks: [], environment: {} } as unknown as StateView;

describe("a state's face", () => {
  it("counts the errors on its Checks tab", () => {
    expect(checksCountOf(view)).toEqual({ count: 1, tone: "red" });
    expect(tab("checks", "Checks", checksCountOf(view))).toEqual({ id: "checks", label: "Checks", icon: "check", count: 1, tone: "red" });
  });
});

const eventsTask = { taskId: "e1", title: "events", workflow: "system/events", status: "running", createdAt: "2026-09-25T00:00:00Z", instances: [], timeline: [], runs: [] } as unknown as TaskDetail;

describe("the conversation's context", () => {
  it("beside the events task's conversation, adds its Automations", () => {
    // The one question the face asks before adding the tab.
    expect(isEventsTask(eventsTask)).toBe(true);
    expect(isEventsTask({ ...eventsTask, workflow: "feature" })).toBe(false);
    expect(isEventsTask(null)).toBe(false);
  });

  it("beside a plain chat has no Steps either", () => {
    expect(chatTabs(0).map((one) => one.id)).toEqual(["produced", "changes", "held"]);
  });
});

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

describe("a re-run with changes", () => {
  it("offers to start from the beginning or before any state the task entered", () => {
    const critique = node({ instanceId: "3", stateId: "feature/plan/critique", childKey: "critique", parentInstanceId: "2" });
    const plan = node({ instanceId: "2", stateId: "feature/plan", childKey: "plan", parentInstanceId: "1", children: [critique] });
    const detail = { ...eventsTask, taskId: "t1", workflow: "feature", instances: [node({ instanceId: "1", stateId: "feature", children: [plan] })] } as TaskDetail;
    const starts = rerunStartsOf(detail, [
      { kind: "entered", instanceId: "1", seq: 1 },
      { kind: "entered", instanceId: "2", seq: 3 },
      { kind: "said", instanceId: "2", seq: 5 },
      { kind: "entered", instanceId: "3", seq: 7 },
      // An entry the tree has no node for is not a place to start.
      { kind: "entered", instanceId: "9", seq: 9 },
    ]);
    // The root is not in the list: starting there is "the beginning", which the form offers itself.
    // Each of the others is named by its path under the root, at its entry's journal position.
    expect(starts).toEqual([
      { seq: 3, label: "plan" },
      { seq: 7, label: "plan › critique" },
    ]);
  });
});

describe("the events task's face", () => {
  it("calls its Configuration tab Automations", () => {
    expect(taskTabs(undefined, eventsTask, true).find((one) => one.id === "configuration")!.label).toBe("Automations");
  });

  it("leaves any other task's Configuration as it was", () => {
    const other = { ...eventsTask, workflow: "feature" } as TaskDetail;
    expect(taskTabs(undefined, other, true).find((one) => one.id === "configuration")!.label).toBe("Configuration");
  });
});
