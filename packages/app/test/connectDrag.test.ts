/**
 * The board's half of `connect` (decision 0005, "What draws → The drop preview").
 *
 * Three things the person was explicit about, each pinned here without a DOM:
 *
 *  - a drag resolves through the DRY RUN once per column per drag — never per mouse move, however
 *    often the pointer crosses a column;
 *  - the preview says which of the three a drop is, where the task will stand and what is bound, and
 *    it has NO controls: the drop is the commit;
 *  - an adopted task files beneath the task that adopted it, out of the lane its own status names.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BoardCard, BoardColumn, ConnectPlan, TaskConnectResult } from "@jaira/shared/browser";
import { Board, Card, ConnectPop, lanesOf } from "../src/renderer/board";
import { canConnect, ConnectDrag, nestUnder, ownColumnOf, previewOf, type ColumnAnswer } from "../src/renderer/connectDrag";

const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId">): BoardCard => ({
  title: patch.taskId,
  status: "completed",
  workflow: "feature/product",
  activePath: [{ instanceId: "i", stateId: "feature/product" }],
  hasSubBoard: false,
  updatedAt: 0,
  ...patch,
});
const column = (key: string, cards: BoardCard[] = []): BoardColumn => ({ key, stateId: key, cards });

const plan = (patch: Partial<ConnectPlan>): ConnectPlan => ({ resolution: "move", workflow: "feature", standsAt: { path: ["ux"], stateId: "feature/ux" }, inputs: [], asks: [], ...patch });
const answered = (result: TaskConnectResult): ColumnAnswer => ({ status: "answered", result });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ConnectDrag", () => {
  it("asks the dry run ONCE per column per drag, however often the pointer comes back", async () => {
    const ask = vi.fn(async (_card: BoardCard, col: Pick<BoardColumn, "key">): Promise<TaskConnectResult> => ({ ok: true, dryRun: true, plan: plan({ workflow: col.key }) }));
    const changed = vi.fn();
    const drag = new ConnectDrag(card({ taskId: "t1" }), ask, changed);
    const feature = column("feature");
    const explore = column("explore");

    // Picked up: every column is asked about at once. Then the pointer wanders — dragover fires
    // dozens of times a second over each — and nothing is asked again.
    for (const col of [feature, explore]) drag.resolve(col);
    for (let i = 0; i < 50; i += 1) drag.resolve(i % 2 === 0 ? feature : explore);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(drag.answer("feature")).toEqual({ status: "asking" });
    expect(drag.accepts("feature")).toBe(false);

    await flush();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(drag.accepts("feature")).toBe(true);
    for (let i = 0; i < 50; i += 1) drag.resolve(feature);
    expect(ask).toHaveBeenCalledTimes(2);
    // A NEW drag asks again: the answer is about where the task stands now.
    new ConnectDrag(card({ taskId: "t1" }), ask, changed).resolve(feature);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("lights a column only for an unrefused answer, keeps a failure as an answer, and draws nothing after the card is put down", async () => {
    const results: Record<string, () => Promise<TaskConnectResult>> = {
      yes: async () => ({ ok: true, dryRun: true, plan: plan({}) }),
      no: async () => ({ ok: false, dryRun: true, refusal: { code: "fast-forward", message: "not built" }, plan: plan({}) }),
      broken: async () => Promise.reject(new Error("the workflow does not load")),
    };
    const changed = vi.fn();
    const drag = new ConnectDrag(card({ taskId: "t1" }), (_c, col) => results[col.key]!(), changed);
    for (const key of Object.keys(results)) drag.resolve(column(key));
    await flush();
    expect([drag.accepts("yes"), drag.accepts("no"), drag.accepts("broken"), drag.accepts("never-asked")]).toEqual([true, false, false, false]);
    expect(drag.answer("broken")).toEqual({ status: "failed", message: "the workflow does not load" });

    const late = new ConnectDrag(card({ taskId: "t1" }), results["yes"]!, changed);
    changed.mockClear();
    late.resolve(column("yes"));
    late.end();
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not ask about the column the card is in, and lets only a task that stands somewhere be picked up", () => {
    const mine = card({ taskId: "t1" });
    expect(ownColumnOf([column("product", [mine]), column("feature")], mine)).toBe("product");
    expect(canConnect(mine)).toBe(true);
    expect(canConnect(card({ taskId: "q", status: "queued", activePath: [] }))).toBe(false);
    // Made by an adoption: queued, but standing past the child it took up.
    expect(canConnect(card({ taskId: "p", status: "queued" }))).toBe(true);
    // A task that stands for a child of another is moved by moving that one.
    expect(canConnect(card({ taskId: "a", origin: { kind: "adopt", taskId: "p", at: 0, boundary: 0, boundaryAt: 0, label: "" } }))).toBe(false);
  });
});

describe("previewOf", () => {
  const text = (words: ReadonlyArray<string | { b: string } | { code: string }>): string => words.map((w) => (typeof w === "string" ? w : "b" in w ? w.b : w.code)).join("");
  const mine = card({ taskId: "t1" });

  it("says nothing until the answer is in", () => {
    expect(previewOf(undefined, mine, column("feature"))).toBeUndefined();
    expect(previewOf({ status: "asking" }, mine, column("feature"))).toBeUndefined();
  });

  it("ADOPT INTO: the workflow, the child the task becomes, where it will stand, what was taken from the task", () => {
    const preview = previewOf(
      answered({
        ok: true,
        dryRun: true,
        plan: plan({
          resolution: "adopt",
          workflowLabel: "Feature workflow",
          adoptedAs: "product",
          branch: "jaira/pause-and-stop",
          inputs: [{ name: "brief", via: "wire", from: "product" }],
          asks: [{ state: "feature", name: "audience", reason: "the adopted task does not determine it" }],
          adopt: { workflow: "feature", title: "T", adopted: [], cursor: "product", next: "ux", inputs: { issue: "x" }, provenance: { issue: { via: "bound", from: { taskId: "t1", input: "issue" } } }, asks: [], waitsFor: [] },
        }),
      }),
      mine,
      column("feature"),
    )!;
    expect(preview.kind).toBe("Adopt into");
    expect(text(preview.say)).toBe("Feature workflow mounts this task's state as product. The task becomes that child; nothing runs again.");
    expect(preview.facts.map(text)).toEqual(["stands at ux", "issue taken from what product ran with", "brief comes from product", "1 input can be given afterwards", "works on branch jaira/pause-and-stop"]);
    expect(preview.drop).toBe("Drop to adopt");
    expect(preview.refused).toBeUndefined();
  });

  it("MOVE WITHIN: backward, next, a FAST-FORWARD, a skip, and a forward move a host that cannot run it refuses", () => {
    const back = previewOf(answered({ ok: true, dryRun: true, plan: plan({ move: { direction: "backward", to: "ux", path: [], passes: [] } }) }), mine, column("ux"))!;
    expect([back.kind, text(back.say), back.drop]).toEqual(["Move within", "ux is behind where this task stands. It is entered again, as the next pass.", "Drop to go back"]);
    const next = previewOf(answered({ ok: true, dryRun: true, plan: plan({ move: { direction: "next", to: "ux", path: [], passes: [] } }) }), mine, column("ux"))!;
    expect([text(next.say), next.drop]).toEqual(["ux is the state that comes next.", "Drop to move"]);
    const over = previewOf(
      answered({ ok: false, dryRun: true, refusal: { code: "fast-forward", message: "…" }, plan: plan({ standsAt: { path: ["build"], stateId: "feature/build" }, move: { direction: "forward", to: "build", path: [], passes: ["ux", "ui"] } }) }),
      mine,
      column("build"),
    )!;
    expect(text(over.say)).toBe("build is 2 states ahead in this task's workflow.");
    expect(over.facts.map(text)).toEqual(["ux → ui lie between"]);
    const skipping = previewOf(answered({ ok: true, dryRun: true, plan: plan({ standsAt: { path: ["build"], stateId: "feature/build" }, forward: "skip", move: { direction: "forward", to: "build", path: [], passes: ["ux"], stepsPast: "product" } }) }), mine, column("build"))!;
    expect(skipping.facts.map(text)).toEqual(["steps over ux, recorded as skipped", "steps past product, where it stopped"]);
    expect(skipping.drop).toBe("Drop to skip ahead");
    // The board's own case (decision 0005 §4): a forward drop RUNS what is between.
    const forward = previewOf(answered({ ok: true, dryRun: true, plan: plan({ standsAt: { path: ["build"], stateId: "feature/build" }, forward: "fast-forward", move: { direction: "forward", to: "build", path: [], passes: ["ux", "ui"] } }) }), mine, column("build"))!;
    expect(forward.facts.map(text)).toEqual(["runs ux → ui on the way, the conversation answering what comes up"]);
    expect(forward.drop).toBe("Drop to fast-forward");
    expect(over.drop).toBeUndefined();
    expect(over.refused).toBe("Nothing here can run the states between.");
  });

  it("NEW TRANSITION: which modification, the split that makes held tasks, and the inputs that would not bind", () => {
    const split = previewOf(
      answered({ ok: true, dryRun: true, plan: plan({ resolution: "modify", modification: "new", adoptedAs: "product", mount: "split", standsAt: { path: ["explore"], stateId: "explore" }, inputs: [{ name: "item", via: "wire", from: "product.items", each: "split" }] }) }),
      mine,
      column("explore"),
    )!;
    expect(split.kind).toBe("New transition");
    expect(text(split.say)).toBe("No workflow holds both product and explore. A new one is made around this task, with a move to it.");
    expect(split.facts.map(text)).toEqual(["this task becomes its first child, product", "one task per element, made held — none starts", "item takes one element of product.items"]);
    expect(split.drop).toBe("Drop to add the move and take it");

    const cloned = previewOf(answered({ ok: true, dryRun: true, plan: plan({ resolution: "modify", modification: "cloned", standsAt: { path: ["explore"], stateId: "explore" } }) }), card({ taskId: "t2", workflow: "feature" }), column("explore"))!;
    expect(cloned.facts.map(text)).toEqual(["the copy stops following feature"]);

    const unbound = previewOf(
      answered({
        ok: false,
        dryRun: true,
        refusal: { code: "inputs-missing", message: "…", missing: [{ state: "explore", name: "question", schema: { type: "string" }, reason: "nothing the task produced fits it" }] },
        plan: plan({ resolution: "modify", modification: "new", standsAt: { path: ["explore"], stateId: "explore" } }),
      }),
      mine,
      column("explore"),
    )!;
    expect(unbound.facts.map(text)).toContain("question is required and unbound — nothing the task produced fits it");
    expect(unbound.refused).toBe("1 required input would not be bound.");
    expect(unbound.drop).toBeUndefined();
  });

  it("names the workflows to choose between when more than one holds both", () => {
    const preview = previewOf(
      answered({ ok: false, dryRun: true, refusal: { code: "ambiguous-workflow", message: "'a' and 'b' each hold both", candidates: [{ workflow: "a", label: "A", childKey: "product" }, { workflow: "b", childKey: "p" }] } }),
      mine,
      column("ux"),
    )!;
    expect(preview.facts.map(text)).toEqual(["could join A as product", "could join b as p"]);
    expect(preview.refused).toBe("'a' and 'b' each hold both");
  });
});

describe("what draws", () => {
  it("the preview has NO controls — the drop is the commit", () => {
    const preview = previewOf(answered({ ok: true, dryRun: true, plan: plan({ resolution: "adopt", adoptedAs: "product", workflowLabel: "Feature" }) }), card({ taskId: "t1" }), column("feature"))!;
    const html = renderToStaticMarkup(createElement(ConnectPop, { preview }));
    expect(html).toContain('class="connect-pop connect-pop-inline"');
    expect(html).toContain('<span class="connect-kind">Adopt into</span>');
    expect(html).toContain('<span class="connect-drop">Drop to adopt</span>');
    expect(html).not.toMatch(/<button|<a |<input|onclick/i);
    // Refused: the same box, without the accent line that names the drop.
    const refused = renderToStaticMarkup(createElement(ConnectPop, { preview: { kind: "Move within", say: ["x"], facts: [], refused: "Not yet." } }));
    expect(refused).toContain("connect-refused");
    expect(refused).toContain('<span class="connect-drop connect-no">Not yet.</span>');
    expect(renderToStaticMarkup(createElement(ConnectPop, { preview: "asking" }))).toContain("Working out what a drop does");
  });

  it("files an adopted task BENEATH the task that adopted it, out of the lane its own status names", () => {
    const parent = card({ taskId: "parent", status: "queued", workflow: "feature" });
    const adopted = card({ taskId: "adopted", status: "completed", under: "parent", endedAt: 1 });
    const other = card({ taskId: "other", status: "completed", endedAt: 2 });
    const elsewhere = card({ taskId: "elsewhere", under: "not-in-this-column" });
    const { top, beneath } = nestUnder([other, parent, adopted, elsewhere]);
    expect(top.map((c) => c.taskId)).toEqual(["other", "parent", "elsewhere"]);
    expect(beneath.get("parent")?.map((c) => c.taskId)).toEqual(["adopted"]);
    // The lanes are made of what is left: the adopted task is not also under "Finished".
    expect(lanesOf(top).map((l) => [l.lane, l.cards.map((c) => c.taskId)])).toEqual([
      ["not-started", ["parent"]],
      ["finished", ["other", "elsewhere"]],
    ]);

    const html = renderToStaticMarkup(
      createElement(Board, {
        board: { level: "", breadcrumb: [], columns: [{ key: "feature", stateId: "feature", cards: [other, parent, adopted] }], atLevel: [], finished: [] },
        selected: null,
        numbered: false,
        onSelectTask: () => undefined,
        onDrill: () => undefined,
        onTaskDrop: () => undefined,
        connect: { ask: async (): Promise<TaskConnectResult> => ({ ok: true, dryRun: true, plan: plan({}) }), onDrop: () => undefined, undoable: new Set(["parent"]), onUndo: () => undefined },
      }),
    );
    // Parent, then its child indented, then the rest — and Undo on the card the drop made.
    const order = [...html.matchAll(/class="card(?: [^"]*)?"/g)].map((m) => m[0]);
    expect(order).toEqual(['class="card card-draggable"', 'class="card card-child"', 'class="card card-draggable"']);
    expect(html.indexOf(">parent<")).toBeLessThan(html.indexOf(">adopted<"));
    expect(html.indexOf(">adopted<")).toBeLessThan(html.indexOf(">other<"));
    expect(html).toContain("adopted · feature/product");
    expect(html.match(/<button type="button" class="link">Undo<\/button>/g)).toHaveLength(1);
  });

  it("offers Undo only on the card it was handed for", () => {
    const html = renderToStaticMarkup(createElement(Card, { card: card({ taskId: "t1" }), selected: false, onSelect: () => undefined }));
    expect(html).not.toContain("Undo");
  });
});
