/**
 * The side panel beside a workflow SCRIPT's file in the Files view (the person, 2026-11-24: opening
 * `.jaira/workflows/session.ts` put a chat's "conversation, steps, changes, outputs, configuration" beside
 * it, and that Configuration was a run's, read-only). The file is code, so the panel is the state it
 * compiles to, open on its Configuration — and selecting it opens no run (`selectFile`).
 */
import { describe, expect, it } from "vitest";
import type { FileSource } from "@jaira/shared/browser";
import { isWorkflowScriptPath } from "../src/renderer/filesModel";
import { panelRuleOf } from "../src/renderer/panelHost";

const doc = (path: string, stateId?: string): FileSource => ({ layer: "project", path, file: path, mime: "text/plain", text: "", exists: true, ...(stateId !== undefined ? { stateId } : {}) });
const files = (stateId: string | null, open: FileSource) =>
  panelRuleOf(
    "files",
    { trail: [], detail: null, debug: { taskId: null } as never, taskFocus: null, stateId, doc: open, at: "/w/topodiff", taskWorkflow: null, inspect: "path", taskWorkflowProject: null, selectedProject: null },
    { taskId: null, project: "" },
    false,
  );

describe("the side panel beside a workflow script's file", () => {
  it("is the state it compiles to, open on its Configuration", () => {
    expect(files("session", doc(".jaira/workflows/session.ts"))).toMatchObject({ kind: "state", stateId: "session", tab: "configuration" });
  });

  it("is a state file's state on Run, as before, and nothing for code that names no state", () => {
    expect(files("review", doc(".jaira/workflows/review.json", "review"))).toMatchObject({ kind: "state", stateId: "review", tab: "run" });
    expect(files(null, doc("packages/service/src/session.ts"))).toBeNull();
  });

  it("tells a script's file by its suffix, never a declaration file", () => {
    expect(isWorkflowScriptPath(".jaira/workflows/session.ts")).toBe(true);
    expect(isWorkflowScriptPath("workflows/x.js")).toBe(true);
    expect(isWorkflowScriptPath("workflows/types.d.ts")).toBe(false);
    expect(isWorkflowScriptPath("workflows/x.json")).toBe(false);
  });
});
