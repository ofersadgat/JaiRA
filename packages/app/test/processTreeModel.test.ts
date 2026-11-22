/**
 * The Terminals tab's rows and tree (decision 0032's view, ruling 2): one row anatomy for List and Tree,
 * the tree built from the window's terminals (a tool call's processes under it), and which of a row's
 * parts show at rest, hovered and opened.
 */
import { describe, expect, it } from "vitest";
import type { ProcessSummary, ProcessTreeNode as EngineNode, TerminalSummary } from "@jaira/shared";
import { OTHER_SCOPES, engineTreeOf, pressOf, processNodeOf, rowEndOf, scopeTreeOf, sessionRowsOf, shownNodesOf, stopKeysOf, stopTargetsOf, terminalListOf, terminalNodeOf, terminalTreeOf, toggled } from "../src/renderer/processTreeModel";

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

describe("the engine's processes as rows", () => {
  const proc = (key: string, over: Partial<ProcessSummary> = {}): ProcessSummary => {
    const [pid, start] = key.split("@").map(Number) as [number, number];
    return { key, processTaskId: `t-p${pid}-${start}`, taskId: "t1", machine: "m", pid, startedAt: NOW - 240_000, command: "npx one dev --port 8145", name: "one dev", origin: "background", startedBy: "session", state: "listening", states: [], ports: [8145], load: [], output: { source: "spawned" }, ...over };
  };

  it("draws a process with its pid, origin tag and ports; its terminal is what it opens through", () => {
    const node = processNodeOf(proc("84456@1", { terminal: "call1" }), NOW, term("call1", { command: "npx one dev --port 8145", dialect: "powershell" }));
    expect(node).toMatchObject({ id: "process:84456@1", label: "one dev", pid: 84456, tag: { words: "background", tone: "accent" }, ports: [8145], glyph: "run", time: "4m", running: true });
    expect(node.note).toBeUndefined();
    expect(node.terminal).toEqual({ taskId: "t1", callId: "call1", command: "npx one dev --port 8145", dialect: "powershell" });
    expect(pressOf(node)).toBe("open");
    expect(stopKeysOf(node)).toEqual([]);
  });

  it("tags where it came from, and how it ended", () => {
    expect(processNodeOf(proc("1@1", { origin: "left", name: "serve" }), NOW)).toMatchObject({ tag: { words: "left running", tone: "plain" }, glyph: "left" });
    expect(processNodeOf(proc("2@1", { origin: "escaped", why: "started through WMI by …" }), NOW)).toMatchObject({ tag: { words: "escaped · WMI", tone: "warn" }, glyph: "escaped" });
    expect(processNodeOf(proc("3@1", { origin: "native", why: "Claude's Bash" }), NOW).tag).toEqual({ words: "Claude's Bash", tone: "plain" });
    expect(processNodeOf(proc("4@1", { origin: "watched", taskId: undefined }), NOW)).toMatchObject({ tag: { words: "Mine · watched", tone: "plain" }, glyph: "external" });
    expect(processNodeOf(proc("5@1", { state: "failed", exitCode: 1, told: true, endedAt: NOW }), NOW)).toMatchObject({ tag: { words: "told Claude", tone: "bad" }, time: "exit 1", timeBad: true, glyph: "bad", running: false });
    expect(processNodeOf(proc("6@1", { state: "waiting" }), NOW)).toMatchObject({ tag: { words: "waiting for you", tone: "warn" }, waiting: true, glyph: "wait" });
    // A process with no terminal is stopped through the engine.
    expect(stopKeysOf(processNodeOf(proc("7@1"), NOW))).toEqual(["7@1"]);
  });

  it("says what a machine's process runs past its name", () => {
    const child = proc("84460@2", { processTaskId: undefined, taskId: undefined, origin: undefined, name: "cmd.exe", command: "C:\\Windows\\system32\\cmd.exe /c npx one dev", ports: [] });
    expect(processNodeOf(child, NOW)).toMatchObject({ label: "cmd.exe", note: "/c npx one dev", glyph: "run" });
    expect(processNodeOf({ ...child, command: "conhost.exe", name: "conhost.exe" }, NOW).note).toBeUndefined();
    expect(processNodeOf({ ...child, name: "ApplicationFrameHost", command: "C:/WINDOWS/system32/ApplicationFrameHost.exe" }, NOW).note).toBeUndefined();
    // A parent read only by its pid has no start to age.
    expect(processNodeOf({ ...child, startedAt: 0 }, NOW).time).toBeUndefined();
  });

  it("lists the conversation's processes and its other commands, live first, then ended", () => {
    const procs = [proc("10@1", { terminal: "bg" }), proc("11@1", { origin: "left", name: "serve", startedAt: NOW - 540_000 }), proc("12@1", { state: "failed", exitCode: 1, endedAt: NOW - 1_000 })];
    const list = [term("bg", { command: "npx one dev --port 8145" }), term("quick", { command: "ls", endedAt: NOW - 500, exitCode: 0 }), term("asks", { waiting: true, startedAt: NOW - 5_000 })];
    const { live, ended } = sessionRowsOf(list, procs, NOW);
    expect(live.map((n) => n.id)).toEqual(["terminal:asks", "process:11@1", "process:10@1"]);
    expect(live[0]!.waiting).toBe(true);
    expect(ended.map((n) => n.id)).toEqual(["terminal:quick", "process:12@1"]);
  });

  it("trees the engine's answer: what each started under it, the escaped under the program that started them", () => {
    const dev = proc("100@1", { terminal: "bg" });
    const cmd = proc("101@2", { processTaskId: undefined, taskId: undefined, origin: undefined, name: "cmd.exe", command: "cmd.exe /c npx one dev", ports: [] });
    const wmi = proc("3312@0", { processTaskId: undefined, taskId: undefined, origin: undefined, name: "WmiPrvSE.exe", command: "WmiPrvSE.exe", startedBy: "system", ports: [] });
    const esc = proc("90212@3", { origin: "escaped", name: "node.exe", ports: [8144] });
    const gone = proc("77410@4", { state: "failed", exitCode: 1, endedAt: NOW - 100, name: "drizzle-kit studio" });
    const nodes: EngineNode[] = [
      { process: dev, children: [{ process: cmd, children: [] }] },
      { process: wmi, children: [{ process: esc, children: [] }] },
      { process: gone, children: [] },
    ];
    const tree = engineTreeOf({ id: "t1", label: "This conversation" }, nodes, [term("bg"), term("quick", { command: "ls", endedAt: NOW - 50, exitCode: 0 })], NOW);
    expect(tree).toMatchObject({ kind: "session", note: "2 running · 1 escaped · 2 ended", running: true });
    expect(tree.children.map((n) => n.id)).toEqual(["process:100@1", "escaped:t1", "process:77410@4", "terminal:quick"]);
    expect(tree.children[0]!.children.map((n) => n.label)).toEqual(["cmd.exe"]);
    const escaped = tree.children[1]!;
    expect(escaped).toMatchObject({ label: "escaped", note: "outside this tree", glyph: "escaped" });
    expect(escaped.children[0]!.label).toBe("WmiPrvSE.exe");
    expect(escaped.children[0]!.children[0]).toMatchObject({ label: "node.exe", tag: { words: "escaped", tone: "warn" }, ports: [8144] });
  });

  it("draws another scope folded, counted once read", () => {
    const scope = OTHER_SCOPES[0];
    expect(scopeTreeOf(scope, undefined, NOW)).toMatchObject({ id: "scope:user", label: "Mine", note: "not started by JaiRA", children: [] });
    const pg = proc("6120@1", { processTaskId: undefined, taskId: undefined, origin: undefined, name: "postgres.exe", command: "postgres.exe", startedBy: "user", ports: [5432] });
    const read = scopeTreeOf(scope, [{ process: pg, children: [{ process: { ...pg, key: "6121@1", pid: 6121 }, children: [] }] }], NOW, "9 could not be placed");
    expect(read.note).toBe("not started by JaiRA · 2 · 9 could not be placed");
    expect(read.children[0]).toMatchObject({ label: "postgres.exe", glyph: "external", ports: [5432] });
  });
});
