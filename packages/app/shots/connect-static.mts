/**
 * The board's drop preview and the board after a drop, server-rendered to one static page — the real
 * components over the real stylesheet, with no Electron (decision 0005, "What draws → The drop
 * preview").
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/connect-static.mts <out.html> [light|dark]`
 *
 * A drag is pointer state a static render cannot have, so the one thing done by hand is the
 * `drop-over` class on the hovered column; the column, its cards, the lit `drop-target` edge and the
 * preview inside it are `Column`, `Card` and `ConnectPop` as the app draws them, and the words come
 * from `previewOf` over plans shaped as `task:connect`'s dry run answers them.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardCard, BoardColumn, ConnectPlan, TaskConnectResult } from "@jaira/shared/browser";
import { Board, Card, Column, ConnectPop } from "../src/renderer/board";
import { previewOf } from "../src/renderer/connectDrag";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: connect-static.mts <out.html> [light|dark]");

const now = Date.now();
const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId" | "title">): BoardCard => ({ status: "completed", workflow: "feature/product", activePath: [{ instanceId: "i", stateId: "feature/product" }], hasSubBoard: true, updatedAt: now, ...patch });

const pause = card({ taskId: "t-pause", title: "Pause and stop", endedAt: now - 2 * 3_600_000 });
const usage = card({ taskId: "t-usage", title: "Usage readings", status: "running", activeStatus: "waiting_for_user", activeStateId: "feature/product/ask" });
const rewind = card({ taskId: "t-rewind", title: "Rewind a run", status: "running", activeStatus: "running", activeStateId: "feature/ux/draft", workflow: "feature" });
const forge = card({ taskId: "t-forge", title: "Forge event sources", workflow: "explore", activeStateId: "explore/verdict", endedAt: now - 26 * 3_600_000 });

const plan = (patch: Partial<ConnectPlan>): ConnectPlan => ({ resolution: "move", workflow: "feature", standsAt: { path: ["ux"], stateId: "feature/ux" }, inputs: [], asks: [], ...patch });
const dry = (p: ConnectPlan): TaskConnectResult => ({ ok: true, dryRun: true, plan: p });

const adopt = dry(
  plan({
    resolution: "adopt",
    workflowLabel: "Feature workflow",
    adoptedAs: "product",
    branch: "jaira/pause-and-stop",
    inputs: [{ name: "brief", via: "wire", from: "product" }],
    asks: [{ state: "feature", name: "audience", reason: "the adopted task does not determine it" }],
    adopt: { workflow: "feature", title: "Pause and stop", adopted: [], cursor: "product", next: "ux", inputs: {}, provenance: { issue: { via: "bound", from: { taskId: "t-pause", input: "issue" } } }, asks: [], waitsFor: [] },
  }),
);
const within: TaskConnectResult = {
  ok: false,
  dryRun: true,
  refusal: { code: "fast-forward", message: "'implementation' is ahead of where the task stands, past 'ux', 'ui', 'engineering'." },
  plan: plan({ standsAt: { path: ["implementation"], stateId: "feature/implementation" }, move: { direction: "forward", to: "implementation", path: [], passes: ["ux", "ui", "engineering"] } }),
};
const back = dry(plan({ standsAt: { path: ["product"], stateId: "feature/product" }, move: { direction: "backward", to: "product", path: [], passes: [] }, inputs: [{ name: "issue", via: "wire", from: "inputs.issue" }] }));
const fresh = dry(plan({ resolution: "modify", modification: "new", adoptedAs: "product", mount: "plain", workflow: "jaira:dynamic:…", standsAt: { path: ["explore"], stateId: "explore" }, inputs: [{ name: "brief", via: "wire", from: "product.brief" }] }));
const split = dry(plan({ resolution: "modify", modification: "new", adoptedAs: "product", mount: "split", workflow: "jaira:dynamic:…", standsAt: { path: ["item"], stateId: "feature/ux/item" }, inputs: [{ name: "item", via: "wire", from: "product.items", each: "split" }] }));
const unbound: TaskConnectResult = {
  ok: false,
  dryRun: true,
  refusal: { code: "inputs-missing", message: "…", missing: [{ state: "explore", name: "question", schema: { type: "string" }, reason: "nothing the task produced fits it" }] },
  plan: plan({ resolution: "modify", modification: "cloned", standsAt: { path: ["explore"], stateId: "explore" }, inputs: [{ name: "brief", via: "wire", from: "product.brief" }] }),
};

const col = (key: string, label: string): Pick<BoardColumn, "key" | "stateId" | "label"> => ({ key, stateId: key, label });
const pop = (result: TaskConnectResult, column: Pick<BoardColumn, "key" | "stateId" | "label">, from: BoardCard = pause): ReactElement =>
  h(ConnectPop, { preview: previewOf({ status: "answered", result }, from, column) });
const tile = (c: BoardCard, extra: Record<string, unknown> = {}): ReactElement => h(Card, { key: c.taskId, card: c, selected: false, onSelect: () => undefined, ...extra });

const noop = (): void => undefined;
const dragging = h(
  "div",
  { className: "board-body" },
  h(
    "div",
    { className: "columns wrap" },
    h(Column, { name: "product", count: 2, empty: "—" }, tile(pause, { onDragStart: noop }), tile(usage)),
    h(Column, { name: "feature", count: 1, empty: "—", drop: { accepts: true, onDrop: noop } }, tile(rewind), pop(adopt, col("feature", "feature"))),
    h(Column, { name: "explore", count: 1, empty: "—", drop: { accepts: true, onDrop: noop } }, tile(forge)),
  ),
);

const parent = card({ taskId: "t-parent", title: "Pause and stop", status: "queued", workflow: "feature", activePath: [{ instanceId: "r", stateId: "feature" }] });
const adopted: BoardCard = { ...pause, under: "t-parent", origin: { kind: "adopt", taskId: "t-parent", key: "product", at: 0, boundary: 0, boundaryAt: 0, label: "" } };
const after = h(Board, {
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
});

const section = (title: string, body: ReactElement, bare = false): ReactElement =>
  h("section", { style: { margin: "0 0 26px" } }, h("h4", { style: { margin: "0 0 8px", font: "600 12px var(--font-app)", color: "var(--dim)" } }, title), bare ? body : h("div", { className: "col mid", style: { border: "1px solid var(--line)", borderRadius: 10 } }, body));

const page = h(
  "div",
  { style: { width: 1000, margin: "24px auto", padding: 16 } },
  section("dragging the finished product task over feature — every column that can take it lights; the one under the pointer says what a drop will do", dragging),
  section("after the drop — nothing was confirmed; the adopted task files under the new one, which carries Undo", after),
  section(
    "what a hover can say",
    h(
      "div",
      { style: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" } },
      ...[pop(adopt, col("feature", "feature")), pop(back, col("product", "product"), rewind), pop(fresh, col("explore", "explore")), pop(split, col("item", "item"))].map((el, i) => h("div", { key: i, style: { width: 300 } }, el)),
    ),
    true,
  ),
  section(
    "what a hover says when the drop would be refused — no accent line, because letting go does nothing",
    h(
      "div",
      { style: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" } },
      ...[pop(within, col("implementation", "implementation"), rewind), pop(unbound, col("explore", "explore"), rewind), h(ConnectPop, { preview: "asking" })].map((el, i) => h("div", { key: i, style: { width: 300 } }, el)),
    ),
    true,
  ),
);

// The one thing a static render cannot have: the pointer. The hovered column is the second one.
let seen = 0;
const html = renderToStaticMarkup(page).replace(/class="column drop-target"/g, (match) => (++seen === 1 ? 'class="column drop-target drop-over"' : match));
const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(out, `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head><body>${html}</body></html>`);
console.log(`wrote ${out}`);
