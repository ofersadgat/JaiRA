/**
 * The engine's processes as the window draws them (decision 0032, "The view"; `ProcessHub`): the state
 * each is in, what a sample adds, the pushes and the change log's stamps, "Tell Claude when it prints…",
 * and each process as a task of the built-in `Process` workflow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProcessTaskId, PROCESS_WORKFLOW, processCount, processCountLabel, type PushMessage, type TerminalSummary } from "@jaira/shared";
import { parseLsofListen, parseNetstatListen, parsePsSample, parseSsListen, parseWindowsUsage, type ProcessSample, type SessionProcessSummary } from "@jaira/runtime";
import { deriveProcessState, ProcessHub, processDisplayName, PUSH_EVERY_MS, STARTING_MS, TELL_AFTER_MS, THIS_TURN_AFTER_MS, type SessionProcessesLike } from "../src/processes";

const T0 = 1_000_000;

function fakeSession(): SessionProcessesLike & { stops: Array<{ pid: number; how: string | undefined }>; text: string } {
  const sp = {
    stops: [] as Array<{ pid: number; how: string | undefined }>,
    text: "",
    byKey: () => undefined,
    stopKey: (pid: number, _startedAt: number, how?: "interrupt" | "stop") => {
      sp.stops.push({ pid, how });
      return { pid } as SessionProcessSummary;
    },
    peek: (pid: number, startedAt: number, since = 0) => ({ summary: { pid, startedAt } as SessionProcessSummary, output: sp.text.slice(since), offset: sp.text.length }),
  };
  return sp;
}

const record = (over: Partial<SessionProcessSummary> = {}): SessionProcessSummary => ({
  pid: 84456,
  startedAt: T0,
  command: "npx one dev --port 8145",
  how: "background",
  running: true,
  output: "spawned",
  callId: "toolu_1",
  ...over,
});

const sample = (rows: Array<{ pid: number; parentPid?: number; cpuSeconds?: number; memoryMb?: number; name?: string }>, ports: Record<number, number[]> = {}, at = T0 + 5_000): ProcessSample => ({
  at,
  rows: new Map(rows.map((r) => [r.pid, r])),
  ports: new Map(Object.entries(ports).map(([pid, list]) => [Number(pid), list])),
  complete: true,
});

describe("a process's state", () => {
  it("is derived from its run, its terminal, its ports and its exit", () => {
    const base = { running: true, ports: [] as number[], sampled: false, age: 0 };
    expect(deriveProcessState(base)).toBe("starting");
    expect(deriveProcessState({ ...base, age: STARTING_MS })).toBe("running");
    expect(deriveProcessState({ ...base, sampled: true })).toBe("running");
    expect(deriveProcessState({ ...base, sampled: true, ports: [8145] })).toBe("listening");
    expect(deriveProcessState({ ...base, sampled: true, ports: [8145], waiting: true })).toBe("waiting");
    expect(deriveProcessState({ ...base, running: false, exitCode: 0 })).toBe("exited");
    expect(deriveProcessState({ ...base, running: false, exitCode: 1 })).toBe("failed");
    expect(deriveProcessState({ ...base, running: false, exitCode: null, signal: "SIGSEGV" })).toBe("failed");
    expect(deriveProcessState({ ...base, running: false, exitCode: null, signal: "SIGTERM", stopped: true })).toBe("stopped");
    // An end JaiRA could not read (a process it did not spawn) is an exit.
    expect(deriveProcessState({ ...base, running: false, exitCode: null, signal: null })).toBe("exited");
  });

  it("names a command by what it runs", () => {
    expect(processDisplayName("npx one dev --port 8145")).toBe("one dev");
    expect(processDisplayName("npx tsc --noEmit")).toBe("tsc --noEmit");
    expect(processDisplayName("npm run storybook")).toBe("storybook");
    expect(processDisplayName("npx drizzle-kit studio")).toBe("drizzle-kit studio");
    expect(processDisplayName("cmd /c npx serve dist -l 5050")).toBe("serve dist");
    expect(processDisplayName("node C:/Users/o/AppData/Local/Temp/devserver.cjs")).toBe("node devserver.cjs");
    expect(processDisplayName('"C:\\Program Files\\nodejs\\node.exe" server.js --port 3')).toBe("node server.js");
    expect(processDisplayName("cmd /c \"npx serve dist -l 5050\"")).toBe("serve dist");
  });
});

describe("a sample", () => {
  it("reads ps, lsof, ss, netstat and Get-Process as the platforms write them", () => {
    expect(parsePsSample(" 100   1  20480  00:01:05\n 101 100 1024 1-00:00:01\n")).toEqual([
      { pid: 100, parentPid: 1, memoryMb: 20, cpuSeconds: 65 },
      { pid: 101, parentPid: 100, memoryMb: 1, cpuSeconds: 86_401 },
    ]);
    expect(parseLsofListen("p100\nf20\nn*:8145\nf21\nn[::1]:24678\np200\nn127.0.0.1:5050\n")).toEqual(new Map([[100, [8145, 24678]], [200, [5050]]]));
    expect(parseSsListen('LISTEN 0 511 0.0.0.0:8145 0.0.0.0:* users:(("node",pid=1234,fd=20))\n')).toEqual(new Map([[1234, [8145]]]));
    expect(parseNetstatListen("  TCP    0.0.0.0:8145     0.0.0.0:0      LISTENING       84456\r\n  TCP    [::]:8145   [::]:0   LISTENING   84456\r\n  TCP    10.0.0.2:1 1.1.1.1:443 ESTABLISHED 7\r\n")).toEqual(new Map([[84456, [8145]]]));
    expect(parseWindowsUsage("84456 12.5 190840832\r\n")).toEqual(new Map([[84456, { cpuSeconds: 12.5, memoryMb: 182 }]]));
  });
});

describe("ProcessHub", () => {
  let pushes: PushMessage[];
  let touches: Array<[string, boolean]>;
  let now: number;
  let told: Array<{ taskId: string; text: string }>;
  let terminals: Map<string, TerminalSummary>;
  let hub: ProcessHub;
  const project = { dir: "C:/w/topodiff", key: "c:/w/topodiff" };

  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    pushes = [];
    touches = [];
    told = [];
    terminals = new Map();
    hub = new ProcessHub({
      publish: (message) => pushes.push(message),
      touch: (id, deleted) => touches.push([id, deleted]),
      machine: () => "win-desk",
      now: () => now,
      terminal: (taskId, callId) => terminals.get(`${taskId}/${callId}`),
      tell: async (taskId, _project, text) => {
        told.push({ taskId, text });
      },
    });
  });
  afterEach(() => {
    hub.close();
    vi.useRealTimers();
  });

  const flush = (): void => {
    vi.advanceTimersByTime(PUSH_EVERY_MS);
  };
  const states = (): string[] => pushes.flatMap((p) => (p.type === "process:state" ? [p.process.state] : []));

  it("keeps a task's background process, from starting through listening to its exit, pushing and stamping each move", () => {
    const sp = fakeSession();
    hub.fromSession("t-parent0001", project, record(), sp);
    flush();
    const [p] = hub.list();
    expect(p).toMatchObject({ key: `84456@${T0}`, taskId: "t-parent0001", project: project.dir, machine: "win-desk", name: "one dev", origin: "background", state: "starting", terminal: "toolu_1", output: { source: "spawned" } });
    expect(isProcessTaskId(p!.processTaskId!)).toBe(true);
    expect(touches).toEqual([[p!.processTaskId, false]]);

    // A sample: its tree (cmd → node) listens on 8145; CPU from the second reading on.
    now = T0 + 1_000;
    hub.take(sample([{ pid: 84456, cpuSeconds: 1, memoryMb: 10 }, { pid: 84457, parentPid: 84456, cpuSeconds: 1, memoryMb: 170 }], { 84457: [8145] }, T0 + 1_000));
    hub.take(sample([{ pid: 84456, cpuSeconds: 1.5, memoryMb: 10 }, { pid: 84457, parentPid: 84456, cpuSeconds: 2, memoryMb: 172 }], { 84457: [8145] }, T0 + 3_000));
    flush();
    expect(hub.get({ key: p!.key })).toMatchObject({ state: "listening", ports: [8145], cpu: 75, memoryMb: 182, children: [84457], load: [75] });
    expect(pushes.some((m) => m.type === "process:stats" && m.stats[0]?.ports[0] === 8145)).toBe(true);
    expect(touches).toHaveLength(2);

    // It waits for input while its terminal says so.
    terminals.set("t-parent0001/toolu_1", { waiting: true } as TerminalSummary);
    hub.fromTerminal({ taskId: "t-parent0001", callId: "toolu_1", shell: "background", waiting: true } as TerminalSummary);
    flush();
    expect(hub.get({ key: p!.key })!.state).toBe("waiting");

    // It exits 1: failed, its ports gone.
    hub.fromSession("t-parent0001", project, record({ running: false, exitCode: 1, signal: null, endedAt: T0 + 60_000 }), sp);
    flush();
    expect(hub.get({ key: p!.key })).toMatchObject({ state: "failed", exitCode: 1, ports: [] });
    expect(hub.get({ key: p!.key })!.states.map((s) => s.state)).toEqual(["starting", "listening", "waiting", "failed"]);
    expect(states().at(-1)).toBe("failed");
  });

  it("is a task of the Process workflow, under the task that started it, and the parent's count comes from the list", () => {
    const sp = fakeSession();
    hub.fromSession("t-parent0001", project, record(), sp);
    hub.fromSession("t-parent0001", project, record({ pid: 9, command: "node.exe, started outside JaiRA by `pwsh -File scripts/restart-dev.ps1`", how: "escaped", output: "unreadable" }), sp);
    hub.fromSession("t-parent0001", project, record({ pid: 10, command: "npx drizzle-kit studio" }), sp);
    hub.fromSession("t-parent0001", project, record({ pid: 10, command: "npx drizzle-kit studio", running: false, exitCode: 1 }), sp);
    const tasks = hub.tasks({ projectKey: project.key });
    expect(tasks).toHaveLength(3);
    for (const task of tasks) expect(task).toMatchObject({ type: "process", workflow: PROCESS_WORKFLOW, parentTaskId: "t-parent0001", project: project.dir });
    const escaped = tasks.find((t) => t.process?.origin === "escaped")!;
    expect(escaped).toMatchObject({ title: "node.exe", status: "running", process: { why: "started outside JaiRA by `pwsh -File scripts/restart-dev.ps1`" } });
    expect(tasks.find((t) => t.process?.pid === 10)).toMatchObject({ status: "failed", process: { state: "failed", exitCode: 1 } });
    expect(processCountLabel(processCount(tasks, "t-parent0001"))).toBe("3 processes · 2 running · 1 escaped · 1 failed");
    expect(hub.tasks({ projectKey: "elsewhere" })).toEqual([]);

    const board = hub.board(project.key);
    expect(board.columns.map((c) => c.key)).toEqual(["starting", "running", "listening", "waiting", "exited", "failed", "stopped"]);
    expect(board.columns.find((c) => c.key === "failed")!.cards.map((c) => c.process?.pid)).toEqual([10]);
    expect(board.finished.map((c) => c.process?.pid)).toEqual([10]);
    expect(hub.rootColumn(project.key)).toMatchObject({ key: PROCESS_WORKFLOW, label: PROCESS_WORKFLOW });
    expect(hub.detail(escaped.taskId)).toMatchObject({ taskId: escaped.taskId, workflow: PROCESS_WORKFLOW, type: "process", process: { origin: "escaped" } });
  });

  it("stops a task's process through its record; a stopped one says so", async () => {
    const sp = fakeSession();
    hub.fromSession("t-parent0001", project, record(), sp);
    const key = hub.list()[0]!.key;
    expect(await hub.stop(key, "interrupt")).toEqual({ stopped: true });
    expect(sp.stops).toEqual([{ pid: 84456, how: "interrupt" }]);
    expect(await hub.stop(key)).toEqual({ stopped: true });
    // Asked to stop is not stopped: it is stopped when it ends.
    expect(hub.get({ key })!.state).toBe("starting");
    hub.fromSession("t-parent0001", project, record({ running: false, exitCode: null, signal: "SIGTERM", stopped: true }), sp);
    expect(hub.get({ key })!.state).toBe("stopped");
    expect(await hub.stop(key)).toEqual({ stopped: false, why: "it has already ended" });
  });

  it("lets a task's processes go with it, and takes nothing more from its records", () => {
    const sp = fakeSession();
    hub.fromSession("t-parent0001", project, record(), sp);
    flush();
    const id = hub.list()[0]!.processTaskId!;
    hub.letGoOf("t-parent0001", sp);
    expect(hub.list()).toEqual([]);
    expect(pushes.at(-1)).toMatchObject({ type: "process:gone", processTaskId: id });
    expect(touches.at(-1)).toEqual([id, true]);
    // The stop just sent ends it later: not taken back in.
    hub.fromSession("t-parent0001", project, record({ running: false, exitCode: null, stopped: true }), sp);
    expect(hub.list()).toEqual([]);
  });

  it("makes a command that runs past a second a this-turn process task, kept ended when it ends", () => {
    const t = { taskId: "t-parent0001", project: project.key, callId: "toolu_9", command: "npx tsc --noEmit", dialect: "powershell", by: "agent", pid: 777, startedAt: T0, length: 0, dropped: 0, input: [] } as TerminalSummary;
    terminals.set("t-parent0001/toolu_9", t);
    hub.fromTerminal(t);
    expect(hub.list()).toEqual([]);
    vi.advanceTimersByTime(THIS_TURN_AFTER_MS);
    flush();
    expect(hub.list()[0]).toMatchObject({ origin: "this-turn", by: "agent", name: "tsc --noEmit", terminal: "toolu_9" });
    hub.fromTerminal({ ...t, endedAt: T0 + 12_000, exitCode: 0 });
    flush();
    expect(hub.list()).toHaveLength(1);
    expect(hub.list()[0]).toMatchObject({ state: "exited", exitCode: 0, endedAt: T0 + 12_000 });
    // Stopped, or failing, it stays too, as what it ended as.
    const failing = { ...t, callId: "toolu_11", pid: 779 };
    terminals.set("t-parent0001/toolu_11", failing);
    hub.fromTerminal(failing);
    vi.advanceTimersByTime(THIS_TURN_AFTER_MS);
    hub.fromTerminal({ ...failing, endedAt: T0 + 5_000, exitCode: 2 });
    const stopping = { ...t, callId: "toolu_12", pid: 780 };
    terminals.set("t-parent0001/toolu_12", stopping);
    hub.fromTerminal(stopping);
    vi.advanceTimersByTime(THIS_TURN_AFTER_MS);
    hub.fromTerminal({ ...stopping, endedAt: T0 + 6_000, exitCode: null, signal: "SIGTERM", stopped: true });
    expect(hub.get({ key: "779@" + T0 })?.state).toBe("failed");
    expect(hub.get({ key: "780@" + T0 })?.state).toBe("stopped");
    // Until its task lets it go.
    hub.letGoOf("t-parent0001");
    expect(hub.list()).toEqual([]);
    expect(pushes.at(-1)).toMatchObject({ type: "process:gone" });

    // A quick one never is.
    const quick = { ...t, callId: "toolu_10", pid: 778 };
    terminals.set("t-parent0001/toolu_10", quick);
    hub.fromTerminal(quick);
    hub.fromTerminal({ ...quick, endedAt: T0 + 100 });
    vi.advanceTimersByTime(THIS_TURN_AFTER_MS);
    expect(hub.list()).toEqual([]);
  });

  it("watches a machine process with no parent until it is unwatched, or gone", async () => {
    const stopMachine = vi.fn(async () => ({ stopped: true }));
    hub.close();
    hub = new ProcessHub({ publish: (m) => pushes.push(m), touch: (id, d) => touches.push([id, d]), machine: () => "win-desk", now: () => now, stopMachine });
    const watched = hub.watch({ pid: 5432, name: "postgres", started: new Date(T0 - 60_000).toISOString(), started_by: "user", user: "ofer" }, project);
    expect(watched).toMatchObject({ origin: "watched", startedBy: "user", account: "ofer", name: "postgres" });
    expect(watched.taskId).toBeUndefined();
    expect(hub.tasks()[0]).toMatchObject({ type: "process", process: { origin: "watched" } });
    expect(hub.tasks()[0]!.parentTaskId).toBeUndefined();
    await expect(hub.tellWhen(watched.key, "ready")).rejects.toThrow(/no task's process/);
    expect(await hub.stop(watched.key)).toEqual({ stopped: true });
    expect(stopMachine).toHaveBeenCalledWith(5432, T0 - 60_000, "stop");
    expect(hub.unwatch(watched.key)).toBe(true);
    expect(hub.list()).toEqual([]);

    // One the machine no longer has has exited.
    const again = hub.watch({ pid: 5433, name: "redis", started: new Date(T0).toISOString(), started_by: "user" }, project);
    hub.take(sample([{ pid: 1 }]));
    expect(hub.get({ key: again.key })).toMatchObject({ state: "exited", exitCode: null });
  });

  it("puts an escaped process under the program that started it in the tree", async () => {
    const sp = fakeSession();
    hub.fromSession("t-parent0001", project, record(), sp);
    hub.fromSession("t-parent0001", project, record({ pid: 9, command: "node.exe, started outside JaiRA by `pwsh -File x.ps1`", how: "escaped", output: "unreadable" }), sp);
    hub.take(sample([{ pid: 84456 }, { pid: 84457, parentPid: 84456, name: "node.exe" }, { pid: 9, parentPid: 4000 }, { pid: 4000, name: "WmiPrvSE.exe" }]));
    const tree = await hub.tree({ taskId: "t-parent0001" });
    const wmi = tree.find((n) => n.process.pid === 4000)!;
    expect(wmi.process.name).toBe("WmiPrvSE.exe");
    expect(wmi.children.map((c) => c.process.pid)).toEqual([9]);
    const dev = tree.find((n) => n.process.pid === 84456)!;
    expect(dev.children.map((c) => c.process.name)).toEqual(["node.exe"]);
  });

  describe("Tell Claude when it prints…", () => {
    it("tells the task once, with the line and those around it, then disarms", async () => {
      const sp = fakeSession();
      hub.fromSession("t-parent0001", project, record(), sp);
      const key = hub.list()[0]!.key;
      const armed = await hub.tellWhen(key, "error", "i");
      expect(armed.tellWhen).toMatchObject({ pattern: "error", flags: "i" });
      expect(hub.tasks()[0]!.process?.armed).toBe(true);
      hub.output({ pid: 84456, startedAt: T0 }, "one\ntwo\nthree\n\u001b[31mERROR: port 8145 in use\u001b[0m\nafter one\n");
      expect(told).toEqual([]);
      hub.output({ pid: 84456, startedAt: T0 }, "after two\nafter three\nERROR again\n");
      expect(told).toHaveLength(1);
      expect(told[0]!.taskId).toBe("t-parent0001");
      expect(told[0]!.text).toContain("`npx one dev --port 8145` (pid 84456) printed a line matching /error/i");
      expect(told[0]!.text).toContain("one\ntwo\nthree\nERROR: port 8145 in use\nafter one\nafter two\nafter three");
      expect(hub.get({ key })).toMatchObject({ toldWhen: { pattern: "error", line: "ERROR: port 8145 in use" } });
      expect(hub.get({ key })!.tellWhen).toBeUndefined();
      vi.advanceTimersByTime(TELL_AFTER_MS * 2);
      expect(told).toHaveLength(1);
    });

    it("sends what came after within a moment when no more lines come", async () => {
      hub.fromSession("t-parent0001", project, record(), fakeSession());
      const key = hub.list()[0]!.key;
      await hub.tellWhen(key, "ready on :\\d+");
      hub.output({ pid: 84456, startedAt: T0 }, "booting\nready on :8145\n");
      expect(told).toEqual([]);
      vi.advanceTimersByTime(TELL_AFTER_MS);
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain("booting\nready on :8145");
    });

    it("is cancelled, and refused where nothing can be read", async () => {
      hub.fromSession("t-parent0001", project, record(), fakeSession());
      hub.fromSession("t-parent0001", project, record({ pid: 9, how: "left", output: "unreadable", command: "serve, left running by `npx serve dist`" }), fakeSession());
      const key = hub.list().find((p) => p.pid === 84456)!.key;
      await hub.tellWhen(key, "x");
      expect(hub.tellCancel(key)!.tellWhen).toBeUndefined();
      hub.output({ pid: 84456, startedAt: T0 }, "x\n");
      vi.advanceTimersByTime(TELL_AFTER_MS);
      expect(told).toEqual([]);
      await expect(hub.tellWhen(hub.list().find((p) => p.pid === 9)!.key, "x")).rejects.toThrow(/cannot be followed|cannot be read/);
      await expect(hub.tellWhen(key, "(")).rejects.toThrow(/not a pattern/);
    });
  });
});
