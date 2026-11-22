/**
 * The Terminals tab's rows and tree (decision 0032's view, ruling 2): one row anatomy for List and Tree,
 * the tree built from the window's terminals (a tool call's processes under it), and which of a row's
 * parts show at rest, hovered and opened.
 */
import { describe, expect, it } from "vitest";
import type { TerminalSummary } from "@jaira/shared";
import { pressOf, rowEndOf, shownNodesOf, stopTargetsOf, terminalListOf, terminalNodeOf, terminalTreeOf, toggled } from "../src/renderer/processTreeModel";

const NOW = 1_000_000;

function term(callId: string, over: Partial<TerminalSummary> = {}): TerminalSummary {
  return { taskId: "t1", callId, command: "npm test", dialect: "posix", by: "agent", startedAt: NOW - 10_000, length: 0, dropped: 0, input: [], ...over };
}

describe("terminalNodeOf", () => {
  it("labels a terminal by its title, the rest of its line after it, and its time", () => {
    const node = terminalNodeOf(term("a", { command: "git log --oneline -5" }), NOW);
    expect(node).toMatchObject({ id: "terminal:a", kind: "process", label: "git log", note: "--oneline -5", glyph: "run", time: "10s", running: true, children: [] });
    expect(node.terminal).toEqual({ taskId: "t1", callId: "a", command: "git log --oneline -5", dialect: "posix" });
  });

  it("says how it ended: its duration when it went well, its exit in the bad tone when not", () => {
    expect(terminalNodeOf(term("a", { endedAt: NOW - 2_000, exitCode: 0 }), NOW)).toMatchObject({ glyph: "end", time: "8.0s", running: false });
    expect(terminalNodeOf(term("b", { endedAt: NOW, exitCode: 2 }), NOW)).toMatchObject({ glyph: "bad", time: "exit 2", timeBad: true });
    expect(terminalNodeOf(term("c", { endedAt: NOW, exitCode: null, stopped: true }), NOW)).toMatchObject({ glyph: "end", time: "stopped" });
    expect(terminalNodeOf(term("d", { endedAt: NOW, exitCode: null, timedOut: true }), NOW)).toMatchObject({ glyph: "bad", time: "timed out" });
  });

  it("tags one waiting for the person, the person's own, and a tool's", () => {
    expect(terminalNodeOf(term("a", { waiting: true }), NOW)).toMatchObject({ glyph: "wait", tag: { words: "waiting for you", tone: "warn" } });
    expect(terminalNodeOf(term("b", { by: "you" }), NOW).tag).toEqual({ words: "you", tone: "accent" });
    expect(terminalNodeOf(term("c"), NOW).tag).toBeUndefined();
  });
});

describe("terminalListOf", () => {
  it("puts the running first, those waiting at the top, then the ended newest first", () => {
    const list = [term("old", { startedAt: NOW - 50_000 }), term("ended1", { endedAt: NOW - 5_000, exitCode: 0 }), term("waits", { waiting: true }), term("ended2", { endedAt: NOW - 1_000, exitCode: 1 })];
    const { running, ended } = terminalListOf(list, NOW);
    expect(running.map((n) => n.id)).toEqual(["terminal:waits", "terminal:old"]);
    expect(ended.map((n) => n.id)).toEqual(["terminal:ended2", "terminal:ended1"]);
  });
});

describe("terminalTreeOf", () => {
  const list = [
    term("shell1", { command: "npx vitest run", startedAt: NOW - 3_000 }),
    term("p1", { command: "git push origin main", tool: "git_push", call: "c1", startedAt: NOW - 4_000 }),
    term("p2", { command: "git fetch", tool: "git_push", call: "c1", startedAt: NOW - 6_000, endedAt: NOW - 5_000, exitCode: 0 }),
    term("done", { command: "ls", endedAt: NOW - 1_000, exitCode: 0 }),
  ];

  it("goes from the session to its terminals, a tool call's processes under that call", () => {
    const tree = terminalTreeOf({ id: "t1", label: "This conversation" }, list, NOW);
    expect(tree).toMatchObject({ id: "session:t1", kind: "session", label: "This conversation", note: "2 running · 2 ended", running: true });
    expect(tree.children.map((n) => n.id)).toEqual(["call:c1", "terminal:shell1", "terminal:done"]);
    const call = tree.children[0]!;
    expect(call).toMatchObject({ kind: "call", label: "git_push", note: "2 processes", glyph: "run", running: true, time: "6.0s" });
    expect(call.terminal).toBeUndefined();
    expect(call.children.map((n) => n.id)).toEqual(["terminal:p1", "terminal:p2"]);
  });

  it("does not tag a call's process with the tool its call already names", () => {
    const tree = terminalTreeOf({ id: "t1", label: "x" }, list, NOW);
    expect(tree.children[0]!.children[0]!.tag).toBeUndefined();
  });

  it("says so when nothing has run", () => {
    expect(terminalTreeOf({ id: "t1", label: "x" }, [], NOW)).toMatchObject({ note: "nothing run yet", running: false, children: [] });
  });

  it("stops everything still running under a node, and only that", () => {
    const tree = terminalTreeOf({ id: "t1", label: "x" }, list, NOW);
    expect(stopTargetsOf(tree.children[0]!).map((r) => r.callId)).toEqual(["p1"]);
    expect(stopTargetsOf(tree).map((r) => r.callId)).toEqual(["p1", "shell1"]);
    expect(stopTargetsOf(tree.children[2]!)).toEqual([]);
  });
});

describe("the tab's rows: open, folded, hovered", () => {
  const tree = terminalTreeOf(
    { id: "t1", label: "x" },
    [term("a"), term("p1", { tool: "git_push", call: "c1", startedAt: NOW - 20_000 })],
    NOW,
  );

  it("draws every node under unfolded parents, with its depth; an opened one as its card", () => {
    const all = shownNodesOf(tree, new Set(), new Set(["terminal:a"]));
    expect(all.map((s) => [s.node.id, s.depth, s.open])).toEqual([
      ["session:t1", 0, false],
      ["call:c1", 1, false],
      ["terminal:p1", 2, false],
      ["terminal:a", 1, true],
    ]);
    const shut = shownNodesOf(tree, new Set(["call:c1"]), new Set());
    expect(shut.map((s) => s.node.id)).toEqual(["session:t1", "call:c1", "terminal:a"]);
    expect(shut[1]!.folded).toBe(true);
  });

  it("a press opens a terminal in place and folds it back; a node without one folds", () => {
    const a = tree.children.find((n) => n.id === "terminal:a")!;
    expect(pressOf(a)).toBe("open");
    expect(pressOf(tree.children[0]!)).toBe("fold");
    expect(pressOf({ ...a, terminal: undefined } as never)).toBe("none");
    let open = toggled(new Set(), a.id);
    open = toggled(open, "terminal:p1");
    expect([...open]).toEqual(["terminal:a", "terminal:p1"]);
    expect([...toggled(open, a.id)]).toEqual(["terminal:p1"]);
  });

  it("at rest shows the places it is in and its time; hovered, the places, … and Stop", () => {
    const a = tree.children.find((n) => n.id === "terminal:a")!;
    expect(rowEndOf(a, false, ["split"])).toEqual({ chips: ["split"], time: true, places: false, more: false, stop: false });
    expect(rowEndOf(a, true, ["split"])).toEqual({ chips: [], time: false, places: true, more: true, stop: true });
    const ended = terminalNodeOf(term("e", { endedAt: NOW, exitCode: 0 }), NOW);
    expect(rowEndOf(ended, true, [])).toMatchObject({ places: true, more: true, stop: false });
    expect(rowEndOf(tree.children[0]!, true, [])).toMatchObject({ places: false, more: false, stop: true });
    expect(rowEndOf(tree, false, [])).toMatchObject({ time: false });
  });
});
