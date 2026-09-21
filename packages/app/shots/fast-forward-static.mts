/**
 * Fast-forward, Skip, and the answers given for you (decision 0005 step 7, "What draws") —
 * server-rendered to one static page, the real components over the real stylesheet, no Electron.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/fast-forward-static.mts <out.html> [light|dark]`
 *
 * Nothing is hand-written HTML: the strip is `RunActivity` given a detail with `fastForward`, the gate
 * is `GateSurface` settled with `AnsweredForYou` under it, and the notes after a Skip are `notesOf`
 * over journal turns, drawn by `NoteRow` — the same path the conversation takes.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseComponentConfig, type ConversationTurn, type PendingInteraction, type SessionTurn, type SessionView, type TaskDetail } from "@jaira/shared/browser";
import { AnsweredForYou, RunActivity } from "../src/renderer/runViews";
import { entriesOf } from "../src/renderer/transcript";
import { Transcript } from "../src/renderer/transcriptView";
import { GateSurface } from "../src/renderer/components";
import { notesOf } from "../src/renderer/sessionBands";
import { NoteRow } from "../src/renderer/sessionPanels";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: fast-forward-static.mts <out.html> [light|dark]");

const at = Date.parse("2026-09-21T12:44:01Z");

const detail = (extra: Partial<TaskDetail>): TaskDetail =>
  ({
    taskId: "t-1",
    title: "Pause and stop",
    workflow: "feature",
    status: "running",
    createdAt: new Date(at).toISOString(),
    instances: [],
    activePath: [
      { instanceId: "i1", stateId: "feature" },
      { instanceId: "i2", stateId: "feature/ux", childKey: "ux" },
      { instanceId: "i3", stateId: "feature/ux/draft", childKey: "draft" },
    ],
    blocked: [],
    runs: [{ outcome: "running", startedAt: Date.now() - 242_000 }],
    timeline: [],
    ...extra,
  }) as unknown as TaskDetail;

const today = h("div", { className: "cx-doing" }, h(RunActivity, { detail: detail({}), onStop: () => undefined }));
const forwarding = h(
  "div",
  { className: "cx-doing" },
  h(RunActivity, {
    detail: detail({
      fastForward: {
        taskId: "t-1",
        controlTaskId: "t-1",
        target: "feature/implementation",
        targetLabel: "implementation",
        to: "implementation",
        path: [],
        through: ["ux", "ui", "engineering"],
        step: 1,
        at: "ux → item",
        answered: 1,
        left: 0,
        startedAt: at,
      },
    }),
    onStop: () => undefined,
    onSkip: () => undefined,
  }),
);

const args = { prompt: "Two patterns are reused and one is new. Go ahead?", options: ["go ahead", "change the plan"] };
const gate: PendingInteraction = {
  requestId: "settled:i4",
  taskId: "t-1",
  project: "",
  component: "choose_option",
  inputs: args,
  config: parseComponentConfig("choose_option", args),
};
const answered = h(
  "div",
  { className: "sb-panel" },
  h(
    "section",
    { className: "sb-sheet" },
    h(
      "div",
      { className: "sb-body" },
      h(
        "div",
        { className: "st-block" },
        h(GateSurface, { pending: gate, onSubmit: () => undefined, settled: { value: { decision: "go ahead" } } }),
        h(AnsweredForYou, { by: { via: "control", confidence: 0.86, byTaskId: "t-1", at: 14 }, onAnswerYourself: () => undefined }),
      ),
    ),
  ),
);

/** The journal after a Skip at `ux → item`: `ux` interrupted, `ui` and `engineering` never entered, `implementation` entered. */
const turns: ConversationTurn[] = [
  { seq: 10, at, kind: "entered", stateId: "feature/ux", instanceId: "i2", path: "ux" },
  { seq: 11, at: at + 1_000, kind: "entered", stateId: "feature/ux/item", instanceId: "i3", path: "ux/item" },
  { seq: 20, at: at + 72_000, kind: "terminated", stateId: "feature/ux/item", instanceId: "i3", path: "ux/item", ok: false, text: "skipped" },
  { seq: 21, at: at + 72_001, kind: "entered", stateId: "feature/ui", instanceId: "i5", path: "ui" },
  { seq: 22, at: at + 72_001, kind: "terminated", stateId: "feature/ui", instanceId: "i5", path: "ui", ok: false, text: "skipped" },
  { seq: 23, at: at + 72_002, kind: "entered", stateId: "feature/engineering", instanceId: "i6", path: "engineering" },
  { seq: 24, at: at + 72_002, kind: "terminated", stateId: "feature/engineering", instanceId: "i6", path: "engineering", ok: false, text: "skipped" },
  { seq: 25, at: at + 72_003, kind: "entered", stateId: "feature/implementation", instanceId: "i7", path: "implementation" },
] as unknown as ConversationTurn[];
const notes = h(
  "div",
  { className: "sb" },
  h(
    "div",
    { className: "rail" },
    ...notesOf(turns).map((note) => h("div", { key: note.seq, className: "rail-row rail-turn" }, h("div", { className: "rail-content" }, h(NoteRow, { note, root: "feature" })))),
  ),
);

/** "ok, now implement it" — the `move` row, and the note it leaves: where it is going, and through what. */
const conversation: SessionTurn[] = [
  { role: "user", at, text: "ok, now implement it" },
  { role: "assistant", at: at + 1_000, parts: [{ type: "tool_use", id: "m1", name: "move", input: { to: "feature/implementation" } }] },
  {
    role: "user",
    at: at + 1_400,
    parts: [
      {
        type: "tool_result",
        tool_use_id: "m1",
        content: JSON.stringify({ ok: true, task: "t-1", resolution: "move", workflow: "feature", standsAt: "implementation", moved: "fast-forwarding", answeredBy: "t-1", through: ["ux", "ui", "engineering"] }),
      },
    ],
  },
] as unknown as SessionTurn[];
const moved = h(
  "div",
  { className: "sb-panel" },
  h(
    "section",
    { className: "sb-sheet" },
    h("div", { className: "sb-body" }, h(Transcript, { entries: entriesOf({ taskId: "t", instanceId: "i", stateId: "chat/session", sessionId: "s", seq: 1, turns: conversation } as SessionView), live: null })),
  ),
);

const section = (title: string, body: ReactElement): ReactElement =>
  h(
    "section",
    { style: { margin: "0 0 26px", width: 720 } },
    h("h4", { style: { margin: "0 0 8px", font: "600 12px var(--font-app)", color: "var(--dim)" } }, title),
    body,
  );

const page = h(
  "div",
  { style: { width: 760, margin: "24px auto", padding: 16 } },
  section("the conversation · a forward `move` is a fast-forward, and says so under its row", moved),
  section("today · the activity strip", today),
  section("a fast-forward · the strip with its destination, and Skip beside Stop", forwarding),
  section("a gate the conversation answered · who, how sure, and the way back", answered),
  section("after Skip · what did not run says so, and the target is entered", notes),
);

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(
  out,
  `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head><body>${renderToStaticMarkup(page)}</body></html>`,
);
console.log(`wrote ${out}`);
