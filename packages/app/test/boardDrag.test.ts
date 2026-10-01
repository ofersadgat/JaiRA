/**
 * What a card in the air means (`boardDrag.ts`), for a pointer's drag and a phone's long press alike:
 * which cards lift, which columns a connect asks about, and what a drop on a column does.
 */
import { describe, expect, it, vi } from "vitest";
import type { BoardCard, BoardColumn, BoardView, ConnectPlan, TaskConnectResult } from "@jaira/shared/browser";
import { canPickUp, columnDropOf, connectDragOf } from "../src/renderer/boardDrag";
import { lineDropOf } from "../src/renderer/automationsModel";

const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId">): BoardCard => ({
  title: patch.taskId,
  status: "completed",
  workflow: "feature",
  activePath: [{ instanceId: "i", stateId: "feature/product" }],
  hasSubBoard: false,
  updatedAt: 0,
  ...patch,
});
const column = (key: string, cards: BoardCard[] = []): BoardColumn => ({ key, stateId: `feature/${key}`, cards });
const plan = (patch: Partial<ConnectPlan> = {}): ConnectPlan => ({ resolution: "move", workflow: "feature", standsAt: { path: ["ux"], stateId: "feature/ux" }, inputs: [], asks: [], ...patch });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const lifted = card({ taskId: "t1" });
const board = { level: "feature", columns: [column("product", [lifted]), column("ux"), column("build")], atLevel: [], finished: [] } as unknown as BoardView;

describe("boardDrag", () => {
  it("lifts a card only where a drop would mean something", () => {
    const offers = new Map([["t1", new Map([["build", "r-1"]])]]);
    expect(canPickUp(lifted, offers, () => undefined, undefined)).toBe(true);
    expect(canPickUp(lifted, new Map(), () => undefined, {})).toBe(true);
    expect(canPickUp(lifted, new Map(), () => undefined, undefined)).toBe(false);
    expect(canPickUp(lifted, offers, undefined, {})).toBe(false);
    expect(canPickUp(card({ taskId: "q", status: "queued", activePath: [] }), new Map(), () => undefined, {})).toBe(false);
  });

  it("asks about every column but the card's own and the ones a waiting rule offers", () => {
    const ask = vi.fn(async (): Promise<TaskConnectResult> => ({ ok: true, dryRun: true, plan: plan() }));
    const drag = connectDragOf(board, lifted, new Map([["t1", new Map([["build", "r-1"]])]]), { ask }, () => undefined);
    expect(ask.mock.calls.map((call) => (call as unknown[])[1] as BoardColumn).map((c) => c.key)).toEqual(["ux"]);
    expect(connectDragOf(board, lifted, new Map(), undefined, () => undefined)).toBeNull();
    drag?.end();
  });

  it("answers a wait, commits a connect, and puts an ASK cell's question in front of the commit", async () => {
    const onTaskDrop = vi.fn();
    const putDown = vi.fn();
    const confirm = vi.fn();
    const onDrop = vi.fn();
    const answers: Record<string, TaskConnectResult> = {
      ux: { ok: true, dryRun: true, plan: plan() },
      build: { ok: true, dryRun: true, plan: plan({ judgement: { where: "behind", activity: "working", way: "back", confirm: "stop-and-rewind", sentence: "Stop it?" } as never }) },
    };
    const connect = { ask: async (_c: BoardCard, col: Pick<BoardColumn, "key">) => answers[col.key]!, onDrop };
    const offers = new Map([["t1", new Map([["product", "r-1"]])]]);
    const drag = connectDragOf(board, lifted, new Map(), connect, () => undefined);
    await flush();
    const common = { card: lifted, dragOffers: offers, drag, connect, onTaskDrop, putDown, confirm };

    expect(columnDropOf({ ...common, card: null, column: board.columns[1]! })).toBeUndefined();
    const offered = columnDropOf({ ...common, column: board.columns[0]! })!;
    expect(offered.accepts).toBe(true);
    offered.onDrop();
    expect(onTaskDrop).toHaveBeenCalledWith("r-1", lifted, "product");

    const move = columnDropOf({ ...common, column: board.columns[1]! })!;
    expect(move.accepts).toBe(true);
    expect(move.preview?.()).toMatchObject({ kind: "Move within" });
    move.onDrop();
    expect(onDrop).toHaveBeenCalledWith(lifted, board.columns[1]);

    columnDropOf({ ...common, column: board.columns[2]! })!.onDrop();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ column: "build", sentence: "Stop it?", yes: "Stop and go back" }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    (confirm.mock.calls[0]![0] as { go: () => void }).go();
    expect(onDrop).toHaveBeenLastCalledWith(lifted, board.columns[2], true);
    expect(putDown).toHaveBeenCalledTimes(3);
  });

  it("reorders automation lines as the grip's drop says", () => {
    expect(lineDropOf(["a", "b", "c"], "2", 0)).toEqual(["c", "a", "b"]);
    expect(lineDropOf(["a", "b", "c"], "1", 1)).toBeUndefined();
    expect(lineDropOf(["a", "b", "c"], "x", 1)).toBeUndefined();
  });
});
