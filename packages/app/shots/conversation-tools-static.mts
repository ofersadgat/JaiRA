/**
 * The workflow tools as they DRAW in a conversation (decision 0005 step 6, "What draws") —
 * server-rendered to one static page, the real components over the real stylesheet, no Electron.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/conversation-tools-static.mts <out.html> [light|dark]`
 *
 * Everything here goes through the shipped path: `entriesOf` turns recorded turns into work rows, so
 * the glyph is `iconOf`'s and the line beside each name is `workflowToolSummary`'s, and the note
 * under a `start` or a `move` is the component the transcript renders from what the tool answered.
 * Nothing is hand-written HTML.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowOutcomeOf, type ConversationTurn, type InstanceNode, type SessionRef, type SessionTurn, type SessionView } from "@jaira/shared/browser";
import { entriesOf, entriesOfPart } from "../src/renderer/transcript";
import { Transcript } from "../src/renderer/transcriptView";
import { bandsOf, notesOf, piecesOf } from "../src/renderer/sessionBands";
import { SessionBandsView } from "../src/renderer/sessionPanels";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: conversation-tools-static.mts <out.html> [light|dark]");

const at = Date.parse("2026-09-21T10:01:52Z");

/** One recorded turn, in the shape the record store holds it. */
const turn = (role: string, body: { text?: string; parts?: unknown }, ms = 0): SessionTurn =>
  ({ role, at: at + ms, ...(body.text !== undefined ? { text: body.text } : {}), ...(body.parts !== undefined ? { parts: body.parts } : {}) }) as SessionTurn;

const said = (role: string, text: string, ms = 0): SessionTurn => turn(role, { text }, ms);
const call = (id: string, name: string, input: unknown, ms: number): SessionTurn =>
  turn("assistant", { parts: [{ type: "tool_use", id, name, input }] }, ms);
const result = (id: string, output: unknown, ms: number): SessionTurn =>
  turn("user", { parts: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(output) }] }, ms);

/** A session that started the product state, then moved the task it made across workflows. */
const session: SessionTurn[] = [
  said("user", "design pause and stop with me"),
  call("c1", "list_workflows", {}, 1_000),
  result("c1", { workflows: [{ id: "feature", label: "Feature workflow" }, { id: "explore" }, { id: "review" }] }, 1_200),
  call("c2", "start_task", { state: "feature/product", inputs: { issue: "Let a person pause a running task and pick it up later" }, asked: ["issue"] }, 3_000),
  result("c2", { ok: true, task: "t-1", key: "product", state: "feature/product", status: "started", mount: "plain", inputs: [{ name: "issue", via: "asked" }] }, 3_400),
  said("assistant", "I've started **Product** on it. It will ask us a few things as it goes.", 4_000),
];

const later: SessionTurn[] = [
  said("user", "let's think about the ux for this"),
  call("c3", "move_task", { task: "t-1", to: "feature/ux" }, 900),
  result(
    "c3",
    { ok: true, task: "t-2", resolution: "adopt", workflow: "Feature workflow", standsAt: "ux", adoptedAs: "product", moved: "reopened" },
    1_500,
  ),
  call("c4", "list_tasks", {}, 2_000),
  result("c4", { tasks: [{ task: "t-3", title: "Pause and stop", status: "queued", workflow: "feature", held: true }] }, 2_200),
  said("assistant", "Product gave us three features, so there are three ux tasks, all held. Start them all, or tell me which.", 2_600),
  said("user", "just the first two", 60_000),
  call("c5", "release_task", { tasks: ["t-3", "t-4"] }, 61_000),
  result("c5", { results: [{ task: "t-3", ok: true, did: "started" }, { task: "t-4", ok: true, did: "started" }] }, 61_400),
];

/** A control conversation: a task was moved somewhere no workflow related it to. */
const control: SessionTurn[] = [
  call("c6", "list_tasks", {}, 0),
  result("c6", { tasks: [{ task: "t-9", title: "Rewind a run", status: "completed", relation: "adopted", outputs: { units: "task-lifecycle, process-exec" } }] }, 300),
  call("c7", "list_workflows", { state: "explore" }, 600),
  result("c7", { state: { id: "explore", inputs: { brief: { schema: { type: "string" }, required: true }, question: { schema: { type: "string" }, required: true } } } }, 800),
  said("assistant", "**Rewind a run** is now followed by **explore**. I've written its brief from what the feature shipped. What should it look into?", 1_200),
  said("user", "whether a fork should copy the worktree or branch from it", 90_000),
  call("c8", "start_task", { state: "explore", inputs: { brief: "Rewind and fork shipped with…", question: "whether a fork should copy the worktree" }, asked: ["question"], confidence: 0.8 }, 91_000),
  result("c8", { ok: true, task: "t-10", key: "explore", state: "explore", status: "started", mount: "plain", inputs: [{ name: "brief", via: "inferred" }, { name: "question", via: "asked" }] }, 91_500),
];

/** A `start` that could not settle a required input: the row is `bad`, and the refusal is the result. */
const asking: SessionTurn[] = [
  said("user", "now implement it"),
  call("c9", "start_task", { state: "feature/implementation" }, 800),
  result(
    "c9",
    {
      ok: false,
      code: "inputs-missing",
      reason: "'feature/implementation' was not started: required inputs are open",
      missing: [{ state: "feature/implementation", name: "units", description: "The units this touches.", reason: "the workflow binds nothing to it" }],
    },
    1_100,
  ),
  said("assistant", "Engineering was skipped, so nothing named the units this touches. From what we said I'd guess `task-lifecycle` and `process-exec` — is that right?", 1_600),
];

const view = (turns: SessionTurn[], stateId: string): SessionView => ({ taskId: "t", instanceId: "i", stateId, sessionId: "s", seq: 1, turns });

const sheet = (turns: SessionTurn[], stateId = "chat/session"): ReactElement =>
  h(
    "div",
    { className: "sb-panel" },
    h("section", { className: "sb-sheet" }, h("div", { className: "sb-body" }, h(Transcript, { entries: entriesOf(view(turns, stateId)), live: null }))),
  );

/**
 * The same move in the TASKS view, where the conversation has a rail: the note is the `jaira.moved`
 * row the host journaled, drawn by `notesOf` → `NoteRow` right after the `move_task` call that did it
 * (the row names the call, and `splitAtNotes` cuts the turn there) and before the reply, and the
 * call's row says nothing more (`calls.outcomes: "rail"`).
 */
const railTurns: Record<string, SessionTurn[]> = {
  // One turn: the move, a look at the tasks, and the reply — the note belongs after the FIRST call.
  "i-t1": later.slice(0, 6),
  "i-t2": later.slice(6),
};
const railRoot: InstanceNode = {
  instanceId: "i-root",
  stateId: "chat/session",
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: at - 60_000,
  // What the earlier `start_task` made: a child in its own conversation, finished before these turns.
  children: [{ instanceId: "i-product", stateId: "feature/product", childKey: "product", status: "completed", index: 0, superseded: false, startedAt: at - 50_000, endedAt: at - 40_000, operation: { kind: "prompt", status: "completed" }, children: [] }],
};
railTurns["i-product"] = [said("assistant", "Three features: pause, resume, and the stop reasons.", -45_000)];
const railRefs: SessionRef[] = [
  { instanceId: "i-product", stateId: "feature/product", sessionId: "product", seq: 1, startedAt: at - 50_000, at: at - 40_000, status: "success" },
  { instanceId: "i-t1", stateId: "chat/session", sessionId: "session", seq: 1, startedAt: at, at: at + 3_000, status: "success" },
  { instanceId: "i-t2", stateId: "chat/session", sessionId: "session", seq: 2, startedAt: at + 60_000, at: at + 62_000, status: "success" },
];
const railNotes = notesOf([
  {
    seq: 40,
    at: at + 1_500,
    kind: "moved",
    path: "",
    text: "move_task",
    moved: workflowOutcomeOf({ ok: true, task: "t-2", resolution: "adopt", workflow: "Feature workflow", standsAt: "feature → ux", adoptedAs: "product" })!,
    toolCallId: "c3",
  },
] as ConversationTurn[]);
const rail = h(SessionBandsView, {
  bands: bandsOf(piecesOf(railRoot, railRefs)),
  notes: railNotes,
  render: (piece) =>
    h(Transcript, {
      entries: entriesOfPart(entriesOf(view(railTurns[piece.instanceId ?? piece.node.instanceId] ?? [], "chat/session")), piece.part),
      live: null,
      calls: { outcomes: "rail" },
    }),
});

const section = (title: string, body: ReactElement): ReactElement =>
  h(
    "section",
    { style: { margin: "0 0 26px" } },
    h("h4", { style: { margin: "0 0 8px", font: "600 12px var(--font-app)", color: "var(--dim)" } }, title),
    body,
  );

const page = h(
  "div",
  { style: { width: 760, margin: "24px auto", padding: 16 } },
  section("chat/session — the tool rows, and the note a `start` leaves under its own row", sheet(session)),
  section("…and later: a move that adopted the task, the tasks it made held, and the release that started two", sheet(later)),
  section("the same move in the Tasks view — the note is a row on the rail, right after the call that moved and before the reply", rail),
  section("chat/control — a conversation made by a move: it reads, asks in words, and starts with what it was told", sheet(control, "chat/control")),
  section("a `start` whose required input nothing binds — the call did nothing, and says what to supply", sheet(asking)),
);

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(
  out,
  `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head><body>${renderToStaticMarkup(page)}</body></html>`,
);
console.log(`wrote ${out}`);
