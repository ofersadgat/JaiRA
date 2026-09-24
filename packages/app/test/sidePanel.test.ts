/**
 * The side panel's frame and faces, rendered on the server (the panel rulings, 2026-09-24).
 *
 * What is pinned here is the furniture the person ruled on: the root's head carries its verbs as
 * icons on the name's line, a pushed entry has ‹ and the trail it came from, a pinned stack shows the
 * waiting selection on the offer bar, and a folded panel is the 48px rail of the root's tabs with the
 * name under each. And the two rules a face owns: a state's Configuration tab is hidden while the
 * editor has the file, and a conversation's context has no Conversation tab.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StateView } from "@jaira/shared/browser";
import { SidePanel, type PanelFace } from "../src/renderer/sidePanel";
import { EMPTY_STACK, pin, push, reconcile, type PanelEntry, type PanelStack } from "../src/renderer/panelStack";
import { faceOf, type PanelHost } from "../src/renderer/panelFaces";

const task: PanelEntry = { kind: "task", key: "task:t1", taskId: "t1", tab: "conversation" };
const config: PanelEntry = { kind: "config", key: "config:x", stateId: "feature/plan/critique" };

const face = (entry: PanelEntry): PanelFace =>
  entry.kind === "task"
    ? {
        glyph: "●",
        title: entry.taskId === "t1" ? "Tighten the plan" : "Add dark mode",
        titleText: entry.taskId === "t1" ? "Tighten the plan" : "Add dark mode",
        sub: "t1 · feature",
        verbs: [{ icon: "play", label: "Re-run", primary: true, onClick: () => undefined }],
        tabs: [
          { id: "conversation", label: "Conversation", icon: "comment" },
          { id: "steps", label: "Steps", icon: "plan", count: 12 },
        ],
        tab: entry.tab,
        body: "the conversation",
      }
    : { title: "critique", titleText: "critique · configuration", body: "the form" };

const draw = (stack: PanelStack, folded = false): string =>
  renderToStaticMarkup(createElement(SidePanel, { stack, onStack: () => undefined, face, folded, onFold: () => undefined }));

describe("the frame", () => {
  const root = reconcile(EMPTY_STACK, task);

  it("draws nothing for an empty stack", () => {
    expect(draw(EMPTY_STACK)).toBe("");
  });

  it("puts the root's verbs on the name's line, as icons, before pin · fold · close", () => {
    const html = draw(root);
    expect(html).toContain("Tighten the plan");
    expect(html).toContain('aria-label="Re-run"');
    expect(html).toMatch(/sp-verbs[\s\S]*sp-controls/);
    expect(html).toContain("Pin — keep this");
    expect(html).toContain("Fold the panel");
    expect(html).toContain("Close the panel");
    // No row of text buttons under the head any more.
    expect(html).not.toContain(">Re-run</button>");
  });

  it("draws the root's tabs, the open one marked", () => {
    const html = draw(root);
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?Conversation/);
    expect(html).toContain(">12<");
  });

  it("gives a pushed entry a way back and the trail it came from", () => {
    const html = draw(push(root, config));
    expect(html).toContain('title="Back"');
    expect(html).toContain("Back to t1");
    expect(html).toContain("as it ran");
    // The tabs stay: choosing one is a way back to the root.
    expect(html).toContain("Conversation");
  });

  it("pinned, keeps the stack and names the new selection on the offer bar", () => {
    const pinned = reconcile(pin(root, true), { kind: "task", key: "task:t2", taskId: "t2", tab: "conversation" });
    const html = draw(pinned);
    expect(html).toContain("Tighten the plan");
    // Named as its own face names it, not by its id.
    expect(html).toContain("<b>Add dark mode</b> is selected");
    expect(html).toContain("Show it here");
  });

  it("folded, is the rail: the root's tabs with the name under each, and pin and unfold at the foot", () => {
    const html = draw(root, true);
    expect(html).toContain("sp-rail");
    expect(html).toContain('<span class="sp-rail-name">Steps</span>');
    expect(html).toContain('class="sp-rail-badge">12<');
    expect(html).toContain("Unfold the panel");
    expect(html).not.toContain("the conversation");
  });
});

/** The least a host needs to answer for entries that never reach its task data. */
const host = (patch: Partial<PanelHost> = {}): PanelHost =>
  ({
    detail: null,
    detailOf: () => null,
    gateOf: () => undefined,
    project: undefined,
    context: {} as PanelHost["context"],
    onStack: () => undefined,
    select: () => undefined,
    startAgain: () => undefined,
    cancel: () => undefined,
    reviewChanges: () => undefined,
    adoptTask: () => undefined,
    adoptSubagent: () => undefined,
    rerunSurface: () => undefined as never,
    stateOf: () => undefined,
    inEditor: () => false,
    openInFiles: () => undefined,
    config: { tree: null, executors: [], busy: false, services: {} },
    held: [],
    hold: () => undefined,
    unhold: () => undefined,
    serveOf: () => ({ serve: async () => ({ url: "", interactive: false }) as never }),
    stepsHeight: 300,
    setStepsHeight: () => undefined,
    newTask: null,
    ...patch,
  }) as PanelHost;

const state: PanelEntry = { kind: "state", key: "state:p:feature/plan", stateId: "feature/plan", project: "p", tab: "configuration" };
const view = { stateId: "feature/plan", issues: [{ severity: "error", path: "", message: "bad" }], children: [], transitions: [], references: [], referencedBy: [], driftedTasks: [], environment: {} } as unknown as StateView;

describe("a state's face", () => {
  it("offers Run · Checks · Configuration, Checks counting the errors", () => {
    const tabs = faceOf(host({ stateOf: () => ({ view }) }), state).tabs!.map((tab) => tab.id);
    expect(tabs).toEqual(["run", "checks", "configuration"]);
    expect(faceOf(host({ stateOf: () => ({ view }) }), state).tabs![1]).toMatchObject({ count: 1, tone: "red" });
  });

  it("hides Configuration while the Files editor has the file — and falls back to Run", () => {
    const face = faceOf(host({ stateOf: () => ({ view }), inEditor: () => true }), state);
    expect(face.tabs!.map((tab) => tab.id)).toEqual(["run", "checks"]);
    expect(face.tab).toBe("run");
    // And no ⇤: it is already in the main view.
    expect(face.verbs).toEqual([]);
  });

  it("offers ⇤ to the Files view when the editor does not have it", () => {
    const face = faceOf(host({ stateOf: () => ({ view }) }), state);
    expect(face.verbs!.map((verb) => verb.label)).toEqual(["Open in the Files view"]);
  });
});

describe("the conversation's context", () => {
  it("has no Conversation tab — the conversation is in the main view", () => {
    const tabs = faceOf(host(), { kind: "convo", key: "convo:t1", taskId: "t1", tab: "steps" }).tabs!.map((tab) => tab.id);
    expect(tabs).toEqual(["steps", "produced", "changes", "held"]);
  });

  it("beside a plain chat has no Steps either", () => {
    const tabs = faceOf(host(), { kind: "chat", key: "chat:c1", taskId: "c1", tab: "produced" }).tabs!.map((tab) => tab.id);
    expect(tabs).toEqual(["produced", "changes", "held"]);
  });
});

describe("a letterhead is a way to its step's card", () => {
  it("makes the name pickable, apart from the fold", async () => {
    const { StateHeader } = await import("../src/renderer/stateSurface");
    const html = renderToStaticMarkup(createElement(StateHeader, { open: true, name: "critique", onToggle: () => undefined, onPick: () => undefined }));
    expect(html).toContain("lh-name mono pickable");
    expect(html).toContain("Show this step");
    const plain = renderToStaticMarkup(createElement(StateHeader, { open: true, name: "critique", onToggle: () => undefined }));
    expect(plain).not.toContain("pickable");
  });
});

describe("a re-run with changes", () => {
  it("offers to start from the beginning or before any state the task entered", async () => {
    const { RerunForm } = await import("../src/renderer/panelViews");
    const html = renderToStaticMarkup(
      createElement(RerunForm, {
        run: {
          workflow: "feature/plan",
          fields: [],
          values: {},
          busy: false,
          onChange: () => undefined,
          onRun: () => undefined,
          starts: [{ seq: 7, label: "plan › critique" }],
          onFork: () => undefined,
        },
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain("Start from");
    expect(html).toContain("the beginning");
    expect(html).toContain("before plan › critique");
  });
});
