/**
 * MOVING a task (decision 0005, the rulings of 2026-09-22) — server-rendered to one static page, the
 * real components over the real stylesheet, no Electron:
 *
 *  - today's card and drop preview, the baseline;
 *  - a card's NEXT-TRANSITION chips (`NextChips` inside `Card`, from `BoardCard.next` as main computes it);
 *  - the move table in the hover preview: an illegal column, the two ASK columns, and inputs that will
 *    be asked (`previewOf` over dry-run answers);
 *  - the table's question put in front of the commit, in the column the task lands in (`MoveConfirm`);
 *  - the INPUT QUESTION in the task's own conversation, where the move asked it — open, answered, and
 *    refused when it came to be taken (`NoteRow` over `notesOf`, the gate a `GateSurface`);
 *  - an adopted task's history EXPANDED under the line that adopted it.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/move-static.mts <out.html> [light|dark] [--inline] [--catalog]`
 *
 * `--catalog` also writes the catalog mockups (`reflects: shipped`) of the conversation's two new rows:
 * `docs/ui/assets/run-step-note/{asked,asked-answered,adopted-history}.html`.
 *
 * `--inline` puts the stylesheet into the page and the faces on Google Fonts, for a page that has to
 * stand on its own (the published mockup). A drag is pointer state a static page cannot have, so the
 * `drop-over` class on the hovered column is set by hand, as `connect-static.mts` does.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  moveQuestionPrompt,
  moveQuestionSchema,
  parseComponentConfig,
  type BoardCard,
  type BoardColumn,
  type ConnectMissingInput,
  type ConnectPlan,
  type ConversationTurn,
  type MoveQuestionView,
  type NextMove,
  type PendingInteraction,
  type TaskConnectResult,
} from "@jaira/shared/browser";
import { Card, Column, ConnectPop, MoveConfirm } from "../src/renderer/board";
import { previewOf } from "../src/renderer/connectDrag";
import { GateSurface } from "../src/renderer/components";
import { notesOf } from "../src/renderer/sessionBands";
import { NoteRow } from "../src/renderer/sessionPanels";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: move-static.mts <out.html> [light|dark] [--inline]");
const theme = process.argv[3] === "dark" ? "dark" : "light";
const inline = process.argv.includes("--inline");

const now = Date.parse("2026-09-22T12:00:00Z");
const noop = (): void => undefined;
const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId" | "title">): BoardCard => ({
  status: "running",
  workflow: "feature",
  activePath: [{ instanceId: "i", stateId: "feature" }],
  hasSubBoard: true,
  updatedAt: now,
  ...patch,
});
const tile = (c: BoardCard, extra: Record<string, unknown> = {}): ReactElement => h(Card, { key: c.taskId, card: c, selected: false, onSelect: noop, ...extra });

// --- the chips ------------------------------------------------------------------------------------

const next = (patch: Partial<NextMove> & Pick<NextMove, "target" | "path" | "way">): NextMove => ({ label: patch.path.at(-1)!, ...patch });
const drafting = card({ taskId: "t-a", title: "Usage readings", activeStatus: "waiting_for_user", activeStateId: "feature/product", next: [next({ target: "feature/ux", path: ["ux"], way: "next" })] });
const deciding = card({
  taskId: "t-b",
  title: "Rewind a run",
  activeStatus: "waiting_for_user",
  activeStateId: "feature/review",
  next: [
    next({ target: "feature/ship", path: ["ship"], way: "next" }),
    next({ target: "feature/revise", path: ["revise"], way: "fast-forward", blocked: "'Rewind a run' is running and has no conversation to answer what comes up on the way — pause it, then move it, or say skip to go there directly" }),
  ],
});
const waiting = card({
  taskId: "t-c",
  title: "Forge event sources",
  activeStatus: "waiting_for_user",
  activeStateId: "explore/verdict",
  workflow: "explore",
  next: [next({ target: "explore/publish", path: ["publish"], way: "event", event: true }), next({ target: "explore/archive", path: ["archive"], way: "next" })],
});
const looping = card({
  taskId: "t-d",
  title: "Pause and stop",
  activeStatus: "running",
  activeStateId: "feature/ux/critique",
  next: [
    next({ target: "feature/ux/draft", path: ["ux", "draft"], label: "draft", way: "back", confirm: "stop-and-rewind", sentence: "'Pause and stop' is working. Stop it and go back to 'ux/draft'?" }),
    next({ target: "feature/ux/publish", path: ["ux", "publish"], label: "publish", way: "next" }),
  ],
});
const finished = card({ taskId: "t-e", title: "Docs catalog backfill", status: "completed", activeStateId: "feature", endedAt: now - 3_600_000 });
const baseline = card({ taskId: "t-a0", title: "Usage readings", activeStatus: "waiting_for_user", activeStateId: "feature/product" });

// --- the previews ---------------------------------------------------------------------------------

const plan = (patch: Partial<ConnectPlan>): ConnectPlan => ({ resolution: "move", workflow: "feature", standsAt: { path: ["ux"], stateId: "feature/ux" }, inputs: [], asks: [], ...patch });
const col = (key: string, label = key): Pick<BoardColumn, "key" | "stateId" | "label"> => ({ key, stateId: key, label });
const pop = (result: TaskConnectResult, column: Pick<BoardColumn, "key" | "stateId" | "label">, from: BoardCard = deciding): ReactElement =>
  h(ConnectPop, { preview: previewOf({ status: "answered", result }, from, column) });

const oldBack: TaskConnectResult = { ok: true, dryRun: true, plan: plan({ standsAt: { path: ["product"], stateId: "feature/product" }, move: { direction: "backward", to: "product", path: [], passes: [] } }) };
const decided = "'revise' is reached only by the decision at 'review', which 'Rewind a run' has already made — a move cannot take the other branch. Move it back to that state to decide again.";
const illegal: TaskConnectResult = {
  ok: false,
  dryRun: true,
  refusal: { code: "illegal", message: decided },
  plan: plan({ standsAt: { path: ["revise"], stateId: "feature/revise" }, judgement: { where: "unreachable", activity: "waiting-input", way: "illegal", sentence: decided } }),
};
const stopAsk = "'Pause and stop' is working. Stop it and go back to 'product'? It is entered again as its next pass; what the task did since stays in its history.";
const behindWorking: TaskConnectResult = {
  ok: true,
  dryRun: true,
  plan: plan({ standsAt: { path: ["product"], stateId: "feature/product" }, move: { direction: "backward", to: "product", path: [], passes: [] }, judgement: { where: "behind", activity: "working", way: "back", confirm: "stop-and-rewind", sentence: stopAsk } }),
};
const pauseAsk = "'Pause and stop' is working. Pause it and move it to 'explore'?";
const elsewhereWorking: TaskConnectResult = {
  ok: true,
  dryRun: true,
  plan: plan({ resolution: "modify", modification: "cloned", standsAt: { path: ["explore"], stateId: "explore" }, inputs: [{ name: "brief", via: "wire", from: "product.brief" }], judgement: { where: "elsewhere", activity: "working", way: "move", confirm: "pause-and-move", sentence: pauseAsk } }),
};
const QUESTION: ConnectMissingInput = { state: "explore", name: "question", schema: { type: "string", minLength: 1 }, description: "What to find out, in a sentence.", reason: "nothing the task produced fits it" };
const DEPTH: ConnectMissingInput = { state: "explore", name: "depth", schema: { type: "integer", minimum: 1, maximum: 5 }, description: "How many rounds of looking before a verdict.", reason: "nothing the task produced fits it" };
const needsInputs: TaskConnectResult = {
  ok: true,
  dryRun: true,
  plan: plan({ resolution: "modify", modification: "new", adoptedAs: "product", standsAt: { path: ["explore"], stateId: "explore" }, question: [QUESTION, DEPTH], judgement: { where: "elsewhere", activity: "finished", way: "move" } }),
};

// --- the conversation -----------------------------------------------------------------------------

const turn = (seq: number, patch: Partial<ConversationTurn>): ConversationTurn => ({ seq, at: now + seq * 1000, kind: "entered", ...patch }) as ConversationTurn;
const askedView = { requestId: "move:1", target: "explore", targetLabel: "explore", missing: [QUESTION, DEPTH] };
const gateOf = (requestId: string): PendingInteraction => {
  const inputs = { prompt: moveQuestionPrompt("Forge event sources", "explore", [QUESTION, DEPTH]), schema: moveQuestionSchema([QUESTION, DEPTH]) as never };
  return { requestId, taskId: "t-c", project: "", component: "fill_form", inputs, config: parseComponentConfig("fill_form", inputs), moves: true };
};
const body = (asked: { requestId: string; outcome?: string; answered?: Record<string, unknown>; message?: string }): ReactElement =>
  asked.outcome === undefined
    ? h("div", { className: "inline-gate" }, h(GateSurface, { pending: gateOf(asked.requestId), onSubmit: noop }))
    : h(
        "div",
        null,
        asked.answered !== undefined ? h("div", { className: "inline-gate" }, h(GateSurface, { pending: gateOf(asked.requestId), onSubmit: noop, settled: { value: asked.answered as never } })) : null,
        h(
          "p",
          { className: `sb-move-outcome${asked.outcome === "refused" ? " is-refused" : ""}` },
          asked.outcome === "moved" ? "Answered — the move to explore was taken." : `Answered, and the move could not be taken: ${asked.message ?? ""}`,
        ),
      );
const conversationWith = (asked: MoveQuestionView): ReactElement => {
  const notes = notesOf([
    turn(1, { kind: "entered", path: "verdict", stateId: "explore/verdict", instanceId: "i1" }),
    turn(2, { kind: "terminated", path: "verdict", stateId: "explore/verdict", instanceId: "i1", ok: true, text: "success" }),
    turn(3, { kind: "asked", path: "", text: "move:1", asked }),
  ]);
  return h(
    "div",
    { className: "sb", style: { padding: "8px 12px" } },
    ...notes.map((note, i) => h(NoteRow, { key: i, note, root: "", moveQuestion: (a) => body(a) })),
  );
};

const adoptedNote = notesOf([
  turn(1, {
    kind: "made",
    path: "product",
    stateId: "feature/product",
    instanceId: "r",
    made: { kind: "adopt", runs: [{ taskId: "t-pause", element: 0, title: "Pause and stop", status: "completed", holding: 0, self: false, waitsFor: false }] },
  }),
  turn(9, { kind: "entered", path: "ux", stateId: "feature/ux", instanceId: "i9" }),
]);
const adoptedHistory = notesOf([
  turn(2, { kind: "entered", path: "brief", stateId: "feature/product/brief", instanceId: "a1" }),
  turn(3, { kind: "entered", path: "ask", stateId: "feature/product/ask", instanceId: "a2" }),
  turn(4, { kind: "transition", path: "", stateId: "feature/product", instanceId: "a0", text: "write" }),
]);
const adoptedView = h(
  "div",
  { className: "sb", style: { padding: "8px 12px" } },
  ...adoptedNote.map((note, i) =>
    h(NoteRow, {
      key: i,
      note,
      root: "",
      onSelectTask: noop,
      adopted: () => h("div", { className: "run-convo-nested" }, ...adoptedHistory.map((inner, j) => h(NoteRow, { key: j, note: inner, root: "" }))),
    }),
  ),
);

// --- the page -------------------------------------------------------------------------------------

const section = (title: string, bodyEl: ReactElement, bare = false): ReactElement =>
  h(
    "section",
    { style: { margin: "0 0 26px" } },
    h("h4", { style: { margin: "0 0 8px", font: "600 12px var(--font-app)", color: "var(--dim)" } }, title),
    bare ? bodyEl : h("div", { className: "col mid", style: { border: "1px solid var(--line)", borderRadius: 10 } }, bodyEl),
  );
const row = (...items: ReactElement[]): ReactElement =>
  h("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" } }, ...items.map((el, i) => h("div", { key: i, style: { width: 300 } }, el)));
const columns = (...cols: ReactElement[]): ReactElement => h("div", { className: "board-body" }, h("div", { className: "columns wrap" }, ...cols));

const page = h(
  "div",
  { style: { width: 1000, margin: "24px auto", padding: 16 } },
  section("TODAY — a card has no chips, and a backward drop says nothing about what the task is doing", columns(h(Column, { name: "product", count: 1, empty: "—" }, tile(baseline)), h(Column, { name: "ux", count: 1, empty: "—", drop: { accepts: true, onDrop: noop } }, tile(finished), pop(oldBack, col("product"))))),
  section(
    "next-transition chips — what the workflow defines out of where each task stands; a finished task has none",
    columns(
      h(Column, { name: "product", count: 1, empty: "—" }, tile(drafting, { onMove: noop })),
      h(Column, { name: "review", count: 1, empty: "—" }, tile(deciding, { onMove: noop })),
      h(Column, { name: "verdict", count: 1, empty: "—" }, tile(waiting, { onMove: noop })),
      h(Column, { name: "ux", count: 2, empty: "—" }, tile(looping, { onMove: noop }), tile(finished, { onMove: noop })),
    ),
  ),
  section("the hover preview — the move table's answer", row(pop(illegal, col("revise")), pop(behindWorking, col("product"), looping), pop(elsewhereWorking, col("explore"), looping), pop(needsInputs, col("explore"), waiting)), true),
  section(
    "an ASK column, dropped on — the question stands in front of the commit, in the column the task lands in",
    columns(
      h(Column, { name: "product", count: 1, empty: "—", confirm: h(MoveConfirm, { sentence: stopAsk, yes: "Stop and go back", onYes: noop, onNo: noop }) }, tile(baseline)),
      h(Column, { name: "ux", count: 1, empty: "—" }, tile(looping, { onMove: noop })),
    ),
  ),
  section("the input question, in the task's own conversation where the move asked it — open", conversationWith(askedView)),
  section("…answered: the same form as it was answered, and the move taken", conversationWith({ ...askedView, outcome: "moved", answered: { question: "Which forge events can we poll without a webhook?", depth: 2 } })),
  section(
    "…answered, and refused when it came to be taken (the task had moved on)",
    conversationWith({ ...askedView, outcome: "refused", answered: { question: "Which forge events can we poll without a webhook?", depth: 2 }, message: "'Forge event sources' is running in another process — move it there" }),
  ),
  section("an adoption expands the conversation — the adopted task's history, open where it was adopted", adoptedView),
);

// The pointer: the hovered column of each drop section.
let seen = 0;
const html = renderToStaticMarkup(page).replace(/class="column drop-target"/g, (match) => (++seen >= 1 ? 'class="column drop-target drop-over"' : match));
const cssPath = join(import.meta.dirname, "..", "src", "renderer", "styles.css");
const head = inline
  ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,100..1000&family=JetBrains+Mono:wght@400..800&display=swap" rel="stylesheet"><style>${readFileSync(cssPath, "utf8").replace(/@font-face\s*{[^}]*}/g, "")}</style>`
  : `<link rel="stylesheet" href="${pathToFileURL(cssPath).href}">`;
// A standalone page (the published mockup) is wrapped by its host, and follows the viewer's theme: the
// app's palette keys on `data-theme`, so an unstamped page takes the system's.
const follow = `<script>if (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.theme = "dark";</script>`;
writeFileSync(
  out,
  inline
    ? `<title>Moving a task</title>${head}${follow}<style>body{background:var(--bg);color:var(--text);font-family:var(--font-app)}</style><div style="overflow-x:auto;padding-inline:16px">${html}</div>`
    : `<!doctype html><html data-theme="${theme}"><head><meta charset="utf8"><title>Moving a task</title>${head}</head><body>${html}</body></html>`,
);
console.log(`wrote ${out}`);

if (process.argv.includes("--catalog")) {
  const docs = join(import.meta.dirname, "..", "..", "..", "docs", "ui", "assets", "run-step-note");
  const catalog = (state: string, width: number, bodyEl: ReactElement): void => {
    const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="doc" content="ui/components/run-step-note">
<meta name="state" content="${state}">
<meta name="captured" content="2026-09-22">
<meta name="reflects" content="shipped">
<title>run-step-note · ${state}</title>
<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">
<link rel="stylesheet" href="../mockup.css">
<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>
</head>
<body class="mockup">
<p class="mockup-caption">ui/components/run-step-note · ${state}</p>
<div class="mockup-stage" style="width: ${width}px">${renderToStaticMarkup(bodyEl)}</div>
</body>
</html>
`;
    writeFileSync(join(docs, `${state}.html`), page);
    console.log(`wrote run-step-note/${state}.html`);
  };
  catalog("asked", 720, conversationWith(askedView));
  catalog("asked-answered", 720, conversationWith({ ...askedView, outcome: "moved", answered: { question: "Which forge events can we poll without a webhook?", depth: 2 } }));
  catalog("adopted-history", 720, adoptedView);
}
