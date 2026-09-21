/**
 * The catalog mockups for the board's connect states (decision 0005, step 5), rendered from the real
 * components so the docs cannot drift from what ships.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/connect-mockups.mts`
 *
 * Writes `docs/ui/assets/task-board/{connecting,refused,after-drop}.html` and
 * `docs/ui/assets/task-card/{adopted,undo}.html`, each with the catalog head (`reflects: shipped`)
 * and the app's own stylesheet. As in `connect-static.mts`, the one thing done by hand is the
 * `drop-over` class: a static page has no pointer.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardCard, BoardColumn, ConnectPlan, TaskConnectResult } from "@jaira/shared/browser";
import { Board, Card, Column, ConnectPop } from "../src/renderer/board";
import { previewOf } from "../src/renderer/connectDrag";

const docs = join(import.meta.dirname, "..", "..", "..", "docs", "ui", "assets");
const captured = "2026-09-21";
const now = Date.parse("2026-09-21T12:00:00Z");
const noop = (): void => undefined;

const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId" | "title">): BoardCard => ({ status: "completed", workflow: "feature/product", activePath: [{ instanceId: "i", stateId: "feature/product" }], hasSubBoard: true, updatedAt: now, ...patch });
const pause = card({ taskId: "t-pause", title: "Pause and stop", activeStateId: "feature/product" });
const usage = card({ taskId: "t-usage", title: "Usage readings", status: "running", activeStatus: "waiting_for_user", activeStateId: "feature/product/ask" });
const rewind = card({ taskId: "t-rewind", title: "Rewind a run", status: "running", activeStatus: "running", activeStateId: "feature/ux/draft", workflow: "feature" });
const forge = card({ taskId: "t-forge", title: "Forge event sources", workflow: "explore", activeStateId: "explore/verdict" });
const parent = card({ taskId: "t-parent", title: "Pause and stop", status: "queued", workflow: "feature", activePath: [{ instanceId: "r", stateId: "feature" }] });
const adopted: BoardCard = { ...pause, under: "t-parent", origin: { kind: "adopt", taskId: "t-parent", key: "product", at: 0, boundary: 0, boundaryAt: 0, label: "" } };

const plan = (patch: Partial<ConnectPlan>): ConnectPlan => ({ resolution: "move", workflow: "feature", standsAt: { path: ["ux"], stateId: "feature/ux" }, inputs: [], asks: [], ...patch });
const adopt: TaskConnectResult = {
  ok: true,
  dryRun: true,
  plan: plan({
    resolution: "adopt",
    workflowLabel: "Feature workflow",
    adoptedAs: "product",
    branch: "jaira/pause-and-stop",
    inputs: [{ name: "brief", via: "wire", from: "product" }],
    asks: [{ state: "feature", name: "audience", reason: "the adopted task does not determine it" }],
    adopt: { workflow: "feature", title: "Pause and stop", adopted: [], cursor: "product", next: "ux", inputs: {}, provenance: { issue: { via: "bound", from: { taskId: "t-pause", input: "issue" } } }, asks: [], waitsFor: [] },
  }),
};
const refused: TaskConnectResult = {
  ok: false,
  dryRun: true,
  refusal: { code: "inputs-missing", message: "…", missing: [{ state: "explore", name: "question", schema: { type: "string" }, reason: "nothing the task produced fits it" }] },
  plan: plan({ resolution: "modify", modification: "new", adoptedAs: "product", standsAt: { path: ["explore"], stateId: "explore" } }),
};

const col = (key: string): Pick<BoardColumn, "key" | "stateId" | "label"> => ({ key, stateId: key, label: key });
const tile = (c: BoardCard, extra: Record<string, unknown> = {}): ReactElement => h(Card, { key: c.taskId, card: c, selected: false, onSelect: noop, ...extra });
const pop = (result: TaskConnectResult, key: string): ReactElement => h(ConnectPop, { preview: previewOf({ status: "answered", result }, pause, col(key)) });

function write(component: "task-board" | "task-card", state: string, width: number, body: ReactElement, hover?: number): void {
  let seen = 0;
  const html = renderToStaticMarkup(body)
    .replace(/class="column drop-target"/g, (match) => (++seen === hover ? 'class="column drop-target drop-over"' : match))
    // Ages are relative to the clock; a captured mockup says what the app would have said that day.
    .replace(/ title="[^"]*\d{4}[^"]*"/g, "");
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="doc" content="ui/components/${component}">
<meta name="state" content="${state}">
<meta name="captured" content="${captured}">
<meta name="reflects" content="shipped">
<title>${component} · ${state}</title>
<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">
<link rel="stylesheet" href="../mockup.css">
<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>
</head>
<body class="mockup">
<p class="mockup-caption">ui/components/${component} · ${state}</p>
<div class="mockup-stage" style="width: ${width}px">${html}</div>
</body>
</html>
`;
  writeFileSync(join(docs, component, `${state}.html`), page);
  console.log(`wrote ${component}/${state}.html`);
}

const stage = (body: ReactElement): ReactElement => h("div", { className: "col mid" }, body);

// The card is in the air over `feature`: every column that can take it lights, and the hovered one
// says what a drop does.
write(
  "task-board",
  "connecting",
  960,
  stage(
    h(
      "div",
      { className: "board-body" },
      h(
        "div",
        { className: "columns wrap" },
        h(Column, { name: "product", count: 2, empty: "—" }, tile(pause, { onDragStart: noop }), tile(usage)),
        h(Column, { name: "feature", count: 1, empty: "—", drop: { accepts: true, onDrop: noop } }, tile(rewind), pop(adopt, "feature")),
        h(Column, { name: "explore", count: 1, empty: "—", drop: { accepts: true, onDrop: noop } }, tile(forge)),
      ),
    ),
  ),
  1,
);

// The pointer is over a column that would REFUSE: it is not lit, the browser will not take the drop,
// and the same box says why — without the accent line, because letting go does nothing.
write(
  "task-board",
  "refused",
  960,
  stage(
    h(
      "div",
      { className: "board-body" },
      h(
        "div",
        { className: "columns wrap" },
        h(Column, { name: "product", count: 2, empty: "—" }, tile(pause, { onDragStart: noop }), tile(usage)),
        h(Column, { name: "feature", count: 1, empty: "—", drop: { accepts: true, onDrop: noop } }, tile(rewind)),
        h(Column, { name: "explore", count: 1, empty: "—", drop: { accepts: false, onDrop: noop } }, tile(forge), pop(refused, "explore")),
      ),
    ),
  ),
);

write(
  "task-board",
  "after-drop",
  960,
  stage(
    h(Board, {
      board: {
        level: "",
        breadcrumb: [],
        columns: [
          { key: "product", stateId: "feature/product", label: "product", cards: [usage] },
          { key: "feature", stateId: "feature", label: "feature", cards: [rewind, parent, adopted] },
          { key: "explore", stateId: "explore", label: "explore", cards: [forge] },
        ],
        atLevel: [],
        finished: [],
      },
      selected: null,
      numbered: false,
      onSelectTask: noop,
      onDrill: noop,
      onTaskDrop: noop,
      connect: { ask: async () => adopt, onDrop: noop, undoable: new Set(["t-parent"]), onUndo: noop },
    }),
  ),
);

const column = (body: ReactElement): ReactElement => stage(h("div", { className: "board-body" }, h("div", { className: "columns" }, h(Column, { name: "feature", count: 2, empty: "—" }, body))));
write("task-card", "adopted", 320, column(h("div", null, tile(parent), tile(adopted, { child: true }))));
write("task-card", "undo", 320, column(tile(parent, { onUndo: noop })));
