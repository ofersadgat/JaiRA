import { useState, type ComponentType, type JSX } from "react";
import type { FileSource, SessionRef, SessionView, WorkflowSyncResult, WorkflowSyncStatus } from "@jaira/shared/browser";
import type { FileSurfaceContext, FileSurfaceProps, SyncSurface } from "@jaira/ui/fileTypes";
import { FormInput, SessionPanel, WorkflowSyncSurface } from "@jaira/universal";

/**
 * Forms, the Files room's remaining surfaces and the Debug room's session panel as specimens
 * (decision 0015), each from a fixture.
 *
 *  - `suggest` — a monospace config box with suggestions (`FormInput`): shut, it is the box with the 16
 *    kept at its end. Opened (focus it, ↓), it draws its own type-ahead (`form/Suggest.tsx`) in place of
 *    a `<datalist>`, whose popup in Chromium is a window of Electron's that no capture of the page
 *    holds; its figures were measured from a photograph of that window. The options are those the
 *    photograph was taken with, one of them labelled and one wider than the box.
 *  - `debug-session`, `debug-session-empty`, `debug-session-none` — the Debug room's "What was actually
 *    said" (`SessionPanel`): the states down one side (a
 *    success with its cost, a failure, one running), the chosen one's conversation down the other —
 *    a prompt the workflow wrote, a reply, a turn of tool calls (one opened), a tool's result and the
 *    answer being written; a state that ran no model call; no task chosen.
 *  - `sync-report`, `sync-report-document`, `sync-running` — a workflow description's sync panel
 *    (`WorkflowSyncSurface`) with a report: proposed files (one refused, one to open), notes, every kind of
 *    finding and what the document does not describe; a rewritten description; a run in progress,
 *    narrating itself, over the rendering, with an error and both sides moved.
 */
export interface FormsFilesSpecimen {
  width: number;
  rn: ComponentType;
}

const OPTIONS = ["claude-haiku-4-5", "claude-opus-5-5", "gpt-5.6-luna", "gpt-5.6-terra", "claude-fable-5-1", "codex-mini", "a very long model identifier that is wider than the box itself"];
const LABELS: Record<string, string> = { "claude-opus-5-5": "Opus, the big one" };

function RnSuggest(): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <div style={{ padding: 20 }}>
      <FormInput value={value} mono onChange={setValue} placeholder="a model id, or a preset" suggest={OPTIONS.map((o) => ({ value: o, ...(LABELS[o] !== undefined ? { label: LABELS[o] } : {}) }))} />
    </div>
  );
}

const AT = Date.parse("2026-09-30T09:00:00Z");
const HISTORY: SessionRef[] = [
  { instanceId: "i-draft", stateId: "draft", sessionId: "s-1", seq: 1, at: AT, status: "success", costUsd: 0.0123 },
  { instanceId: "i-critique", stateId: "critique_with_a_long_name_that_runs_out", sessionId: "s-1", seq: 2, at: AT + 60_000, status: "error", costUsd: 0.4 },
  { instanceId: "i-review", stateId: "review", sessionId: "s-1", seq: 3, at: AT + 120_000, status: "running" },
] as SessionRef[];
const SESSION: SessionView = {
  taskId: "t-1",
  instanceId: "i-draft",
  stateId: "draft",
  sessionId: "s-1",
  seq: 1,
  providerSessionId: "8f0c2d1e-4b7a-4c55-9d2e-0a1b2c3d4e5f",
  status: "success",
  costUsd: 0.0123,
  turns: [
    { role: "system", by: "workflow", text: "You draft plans. Keep them short." },
    { role: "user", by: "workflow", text: "Draft a plan for: rebuild the docs site.\nThe site is under docs/ and builds with `npm run docs`." },
    {
      role: "assistant",
      parts: [
        { type: "tool-call", toolName: "read_file", args: { path: "docs/index.md" } },
        { type: "tool-call", toolName: "list_dir", args: { path: "docs" } },
      ],
    },
    { role: "tool", parts: [{ type: "tool-result", toolName: "read_file", result: "# Docs\n\nWelcome." }] },
    { role: "assistant", text: "1. Move the pages under docs/site.\n2. Replace the generator.\n3. Check every link — a_very_long_identifier_without_any_break_in_it_at_all_to_see_it_wrap_anywhere." },
  ],
} as SessionView;
const LIVE = { sessionId: "s-1", seq: 1, text: "And one more thing" };

function RnDebugSession({ session, live }: { session: SessionView | null; live?: boolean }): JSX.Element {
  const [showing, setShowing] = useState<string | null>(null);
  return <SessionPanel history={HISTORY} session={session} showing={showing} live={live === true ? LIVE : null} onShow={setShowing} />;
}

const none = (): void => undefined;
const DESCRIPTION: FileSource = {
  layer: "project",
  path: "workflows/feature/plan.md",
  file: "/home/me/work/checkout/.jaira/workflows/feature/plan.md",
  mime: "text/vnd.jaira.workflow-description+markdown",
  text: "# Plan a feature\n\nTurns an issue into a plan somebody can build from.\n\n- **goals** — what the issue asks for\n- **critique** — a second reading\n",
  exists: true,
};
const SYNCED: WorkflowSyncStatus = {
  layer: "project",
  path: "workflows/feature/plan.md",
  exists: true,
  synced: true,
  at: Date.now() - 3 * 3600_000,
  documentChanged: false,
  statesChanged: true,
  changedStates: [{ stateId: "feature/plan/goals" }, { stateId: "feature/plan/critique" }],
  suggested: "document",
} as unknown as WorkflowSyncStatus;
const STATES_RESULT: WorkflowSyncResult = {
  taskId: "t-sync",
  direction: "states",
  workflows: ["feature/plan"],
  verdict: "gaps",
  costUsd: 0.0421,
  requirements: [],
  findings: [
    { id: "R1", requirement: "Goals are listed before any context is read", status: "satisfied", states: ["feature/plan/goals"], detail: "" },
    { id: "R2", requirement: "A human reviews the plan", status: "missing", states: [], detail: "No state asks a person anything." },
    { id: "R3", requirement: "The critique reads the draft", status: "partial", states: ["feature/plan/critique", "feature/plan/context"], detail: "It reads the goals, not the draft." },
    { id: "R4", requirement: "Nothing is built before the review", status: "contradicted", states: ["feature/plan/build"], detail: "A build state runs right after the critique." },
  ],
  extras: [{ states: ["feature/plan/lint"], detail: "A lint pass the description never mentions." }],
  edits: [
    { stateId: "feature/plan/review", layer: "project", path: "workflows/feature/plan/review.json", action: "create", text: '{\n  "label": "Review"\n}\n', reason: "R2: a person reviews the plan", requirements: ["R2"], applicable: true },
    { stateId: "feature/plan/critique", layer: "project", path: "workflows/feature/plan/critique.json", action: "update", text: '{\n  "label": "Critique"\n}\n', reason: "", requirements: ["R3"], applicable: false, blocked: "the file is built in" },
  ],
  notes: ["The build state may belong to another workflow."],
} as unknown as WorkflowSyncResult;
const DOCUMENT_RESULT: WorkflowSyncResult = {
  taskId: "t-sync-2",
  direction: "document",
  workflows: ["feature/plan", "feature/review"],
  verdict: "conforms",
  requirements: [],
  findings: [],
  extras: [],
  document: { text: "# Plan a feature\n", changes: [{ summary: "Names the review step", requirements: ["R2"] }, { summary: "Drops the build step it no longer runs", requirements: [] }] },
  notes: [],
} as unknown as WorkflowSyncResult;

function syncOf(over: Partial<SyncSurface>): SyncSurface {
  return { status: SYNCED, result: null, running: false, error: null, progress: [], refresh: none, run: none, cancel: none, openEdit: none, openDocument: none, reviewChangeset: none, ...over };
}
function syncSpecimen(sync: SyncSurface): FormsFilesSpecimen {
  const props: FileSurfaceProps = { doc: DESCRIPTION, busy: false, onSave: none, context: { sync, drafts: {} } as unknown as FileSurfaceContext };
  return {
    width: 720,
    rn: () => (
      <div style={{ height: 520, display: "flex", flexDirection: "column" }}>
        <WorkflowSyncSurface {...props} />
      </div>
    ),
  };
}

export const FORMS_FILES_SPECIMENS: Record<string, FormsFilesSpecimen> = {
  "sync-report": syncSpecimen(syncOf({ result: STATES_RESULT })),
  "sync-report-document": syncSpecimen(syncOf({ result: DOCUMENT_RESULT, status: { ...SYNCED, documentChanged: true, statesChanged: false, changedStates: [], pending: "document" } as unknown as WorkflowSyncStatus })),
  "sync-running": syncSpecimen(
    syncOf({
      running: true,
      error: "The model answered with something that was not a proposal.",
      progress: ["reading 6 states", "reading the description", "asking the model which requirements hold", "asking the model for the edits"],
      status: { ...SYNCED, documentChanged: true, delegated: [{ root: "feature/review", states: 3, document: "workflows/feature/review.md" }] } as unknown as WorkflowSyncStatus,
    }),
  ),
  suggest: { width: 300, rn: RnSuggest },
  "debug-session": { width: 720, rn: () => <RnDebugSession session={SESSION} live /> },
  "debug-session-empty": {
    width: 720,
    rn: () => <RnDebugSession session={{ ...SESSION, turns: [], empty: "This state ran no model call — a function operation." }} />,
  },
  "debug-session-none": { width: 720, rn: () => <RnDebugSession session={null} /> },
};
