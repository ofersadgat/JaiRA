/**
 * A process is a task, in the window (decision 0032, "The view", rulings 3–7): what its card and row say,
 * the parent's count, the `Process` workflow's strip and lanes, the sidebar's Nested | Flat, and the
 * channels a process task's id is never sent on.
 */
import { describe, expect, it } from "vitest";
import { PROCESS_STATES, processTaskIdOf, type BoardCard, type BoardView, type ProcessSummary, type ProcessTaskFacts } from "@jaira/shared";
import {
  countChipOf,
  flatRows,
  fromLabelOf,
  isProcessBoard,
  nestProcessRows,
  originLabelOf,
  processBadgeOf,
  processCardOf,
  processCountsByParent,
  processHeadlineOf,
  processLanesOf,
  processStepsOf,
  processStripOf,
  processWordOf,
  refusedProcessTask,
} from "../src/renderer/processTaskModel";
import { arrangeTasks, standingOf } from "../src/renderer/taskListModel";

const facts = (over: Partial<ProcessTaskFacts> = {}): ProcessTaskFacts => ({ key: "1@1", pid: 1, state: "running", origin: "background", ports: [], machine: "win-desk / topodiff", ...over });

const task = (taskId: string, title: string, status: BoardCard["status"], updatedAt: number, extra: Partial<BoardCard> = {}): BoardCard =>
  ({ taskId, title, status, workflow: "session", activePath: [], hasSubBoard: false, updatedAt, ...extra }) as BoardCard;

let pid = 100;
const proc = (title: string, f: Partial<ProcessTaskFacts>, updatedAt: number, status: BoardCard["status"] = "running"): BoardCard => {
  pid++;
  return task(processTaskIdOf(pid, 1000 + pid), title, status, updatedAt, { workflow: "Process", type: "process", process: facts({ key: `${pid}@${1000 + pid}`, pid, ...f }) });
};

describe("a process task's words", () => {
  it("wears its state as a badge: listening names the port, an end names how it ended", () => {
    expect(processBadgeOf(facts({ state: "listening", ports: [8145] }))).toEqual({ glyph: "◉", text: "listening :8145", tone: "accent" });
    expect(processBadgeOf(facts({ state: "listening", ports: [8145, 24678] })).text).toBe("listening :8145 +1");
    expect(processBadgeOf(facts({ state: "waiting" }))).toEqual({ glyph: "⏸", text: "waiting for input", tone: "warn" });
    expect(processBadgeOf(facts({ state: "failed", exitCode: 1 }))).toEqual({ glyph: "✗", text: "exited 1", tone: "bad" });
    expect(processBadgeOf(facts({ state: "failed", exitCode: null, signal: "SIGKILL" })).text).toBe("SIGKILL");
    expect(processBadgeOf(facts({ state: "stopped" })).text).toBe("stopped");
  });

  it("says its state in a word where a row says a status", () => {
    expect(processWordOf(facts({ state: "waiting" }))).toBe("input");
    expect(processWordOf(facts({ state: "listening" }))).toBe("listening");
    expect(processWordOf(facts({ state: "failed", exitCode: 1 }))).toBe("exited 1");
    expect(processWordOf(facts({ state: "exited", exitCode: 0 }))).toBe("exited 0");
  });

  it("says where it came from as a fact, never a state", () => {
    expect(originLabelOf({ origin: "background" })).toBe("run_in_background");
    expect(originLabelOf({ origin: "this-turn" })).toBe("this turn");
    expect(originLabelOf({ origin: "left" })).toBe("left running");
    expect(originLabelOf({ origin: "escaped", why: "started through WMI by this call; parent WmiPrvSE.exe" })).toBe("escaped · WMI");
    expect(originLabelOf({ origin: "escaped" })).toBe("escaped");
    expect(originLabelOf({ origin: "native" })).toBe("Claude's Bash");
    expect(originLabelOf({ origin: "watched" })).toBe("Mine · watched");
  });

  it("names its parent, or says it has none", () => {
    const titles = new Map([["t-parent0001", "Dev server and the gutter"]]);
    expect(fromLabelOf({ parentTaskId: "t-parent0001" }, (id) => titles.get(id))).toBe("↰ from Dev server and the gutter");
    expect(fromLabelOf({}, () => undefined)).toBe("no parent task");
  });
});

describe("the parent's count", () => {
  it("counts each parent's processes from the rows that carry them, and words it as the chip and the rest", () => {
    const rows = [
      task("t-parent0001", "Dev server and the gutter", "running", 10),
      proc("one dev", { state: "listening", parentTaskId: "t-parent0001" }, 9),
      proc("tsc --noEmit", { state: "running", origin: "this-turn", parentTaskId: "t-parent0001" }, 8),
      proc("node.exe", { state: "listening", origin: "escaped", parentTaskId: "t-parent0001" }, 7),
      proc("drizzle-kit studio", { state: "failed", exitCode: 1, parentTaskId: "t-parent0001" }, 6, "failed"),
      proc("storybook", { state: "listening", origin: "left", parentTaskId: "t-parent0002" }, 5),
      proc("postgres", { state: "listening", origin: "watched" }, 4),
    ];
    const counts = processCountsByParent(rows);
    expect([...counts.keys()].sort()).toEqual(["t-parent0001", "t-parent0002"]);
    expect(counts.get("t-parent0001")).toMatchObject({ total: 4, live: 3, escaped: 1, failed: 1 });
    expect(countChipOf(counts.get("t-parent0001"))).toEqual({ head: "4 processes", rest: "3 running · 1 escaped · 1 failed" });
    expect(countChipOf(counts.get("t-parent0002"))).toEqual({ head: "1 process", rest: "1 running" });
    expect(countChipOf(undefined)).toBeUndefined();
  });
});

describe("the Process workflow, opened", () => {
  const cards = [
    proc("tsc --noEmit", { state: "running" }, 50),
    proc("one dev", { state: "listening", ports: [8145] }, 40),
    proc("serve dist", { state: "listening", origin: "left", ports: [5050] }, 30),
    proc("prisma migrate dev", { state: "waiting" }, 20),
    proc("fixture build", { state: "exited", exitCode: 0 }, 10, "completed"),
    proc("fixture-sync", { state: "failed", exitCode: 1 }, 5, "failed"),
  ];

  it("counts each state in the strip's shape, and says it beside the crumbs", () => {
    const strip = processStripOf(cards);
    expect(strip.flow.map((s) => [s.label, s.count])).toEqual([
      ["starting", 0],
      ["running", 1],
      ["listening", 2],
      ["waiting for input", 1],
    ]);
    expect(strip.ends.map((s) => [s.label, s.count])).toEqual([
      ["exited 0", 1],
      ["exited ≠ 0", 1],
      ["stopped", 0],
    ]);
    expect(processHeadlineOf(strip)).toBe("6 process tasks · 4 running · 1 waiting for input");
  });

  it("puts each card in the lane of its state, one lane per state in the workflow's order, a card once", () => {
    const engine: BoardView = {
      level: "Process",
      label: "Process",
      breadcrumb: [{ stateId: "Process", label: "Process" }],
      columns: [{ key: "listening", stateId: "listening", label: "listening", cards: cards.filter((c) => c.process?.state === "listening") }],
      atLevel: [],
      finished: [],
    } as BoardView;
    const wider = [...cards, processCardOf(summary({ name: "postgres", state: "listening", origin: "watched", ports: [5432] }))];
    const board = processLanesOf(engine, wider);
    expect(isProcessBoard(board)).toBe(true);
    expect(board.columns.map((c) => c.key)).toEqual([...PROCESS_STATES]);
    expect(board.columns.map((c) => c.cards.length)).toEqual([0, 1, 3, 1, 1, 1, 0]);
    expect(board.columns.find((c) => c.key === "listening")!.label).toBe("listening");
    expect(board.columns.find((c) => c.key === "failed")!.label).toBe("exited ≠ 0");
    expect(board.finished?.map((c) => c.title)).toEqual(["fixture build", "fixture-sync"]);
  });

  it("draws a listed process as a process card, its key standing in for a task it does not have", () => {
    const watched = processCardOf(summary({ name: "postgres", processTaskId: "t-p5432-abc", state: "listening", origin: "watched", ports: [5432] }));
    expect(watched).toMatchObject({ taskId: "t-p5432-abc", title: "postgres", type: "process", workflow: "Process", status: "running", process: { state: "listening", origin: "watched", ports: [5432] } });
    const unwatched = processCardOf(summary({ name: "code", key: "77@5", state: "running" }));
    expect(unwatched.taskId).toBe("77@5");
  });
});

describe("the sidebar's Tasks tab", () => {
  const rows = [
    task("t-dev0000001", "Dev server and the gutter", "running", 100),
    proc("one dev", { state: "listening", parentTaskId: "t-dev0000001" }, 90),
    proc("prisma migrate dev", { state: "waiting", parentTaskId: "t-word000001" }, 85),
    task("t-word000001", "Word-level diff spans", "running", 80, { asking: "gate" }),
    proc("drizzle-kit studio", { state: "failed", exitCode: 1, parentTaskId: "t-dev0000001" }, 70, "failed"),
    task("t-hunk000001", "Hunk headers in the gutter", "completed", 60),
    proc("storybook", { state: "listening", origin: "left", parentTaskId: "t-hunk000001" }, 50),
    proc("postgres", { state: "listening", origin: "watched" }, 40),
  ];
  const sections = arrangeTasks(rows, { group: "status", sort: "when-desc" }, { placeOf: () => undefined, home: "" });

  it("puts a process waiting for input with what waits for you", () => {
    expect(standingOf(rows[2]!)).toMatchObject({ word: "Asks you", rank: 0 });
    expect(sections.map((s) => [s.label, s.rows.map((r) => r.title)])).toEqual([
      ["Asks you", ["prisma migrate dev", "Word-level diff spans"]],
      ["Running", ["Dev server and the gutter", "one dev", "storybook", "postgres"]],
      ["Failed", ["drizzle-kit studio"]],
      ["Done", ["Hunk headers in the gutter"]],
    ]);
  });

  it("nests each process under the task that started it, in the parent's group; a done parent keeps its live process", () => {
    const nested = nestProcessRows(sections);
    expect(nested.map((s) => [s.label, s.rows.map((r) => `${"  ".repeat(r.depth)}${r.card.title}`)])).toEqual([
      ["Asks you", ["Word-level diff spans", "  prisma migrate dev"]],
      ["Running", ["Dev server and the gutter", "  one dev", "  drizzle-kit studio", "postgres"]],
      ["Done", ["Hunk headers in the gutter", "  storybook"]],
    ]);
  });

  it("lists them flat as they were grouped", () => {
    const flat = flatRows(sections);
    expect(flat.flatMap((s) => s.rows.map((r) => r.depth))).toEqual(Array(8).fill(0));
    expect(flat.map((s) => s.rows.length)).toEqual([2, 4, 1, 1]);
  });
});

describe("what a process task's id is sent on", () => {
  const id = processTaskIdOf(84456, 1_700_000_000_000);
  it("only its detail, cancel, archive, delete and the process channels", () => {
    for (const channel of ["task:detail", "task:cancel", "task:delete", "task:archive", "task:unarchive", "process:get"]) expect(refusedProcessTask(channel, { taskId: id })).toBeUndefined();
    for (const channel of ["task:conversation", "session:history", "session:view", "run:records", "chat:send", "task:rename", "task:rerun", "task:move", "session:live"]) expect(refusedProcessTask(channel, { taskId: id })).toBe(id);
    expect(refusedProcessTask("task:rerun", { taskIds: ["t-abcdefghij", id] })).toBe(id);
    expect(refusedProcessTask("task:conversation", { taskId: "t-abcdefghij" })).toBeUndefined();
    // Its output is read through the PARENT's terminal, which is a task like any other.
    expect(refusedProcessTask("terminal:read", { taskId: "t-abcdefghij", callId: "toolu_1" })).toBeUndefined();
  });
});

describe("a process task opened", () => {
  it("shows the states it went through, the one it is in with how long", () => {
    const at = new Date(2026, 10, 21, 10, 41, 12).getTime();
    const steps = processStepsOf(
      {
        state: "listening",
        ports: [8145, 24678],
        states: [
          { state: "starting", at },
          { state: "running", at: at + 1000 },
          { state: "listening", at: at + 2000 },
        ],
      },
      at + 2000 + 4 * 60_000,
    );
    expect(steps.map((s) => s.text)).toEqual(["starting 10:41:12", "running 10:41:13", "listening :8145, :24678 since 10:41:14 · 4m"]);
    expect(steps.map((s) => s.current)).toEqual([false, false, true]);
  });
});

function summary(over: Partial<ProcessSummary>): ProcessSummary {
  return {
    key: "1@1",
    machine: "win-desk",
    pid: 1,
    startedAt: 1,
    command: "x",
    name: "x",
    startedBy: "user",
    state: "running",
    states: [{ state: "running", at: 1 }],
    ports: [],
    load: [],
    output: { source: "unreadable" },
    ...over,
  };
}

describe("the crumbs of a process task opened", () => {
  it("read project › Process › its name, and the Process crumb goes back to the workflow", async () => {
    const { taskAddressOf } = await import("../src/renderer/taskBarModel");
    const walked: number[] = [];
    const { crumbs } = taskAddressOf({
      projects: [{ project: "/p/topodiff", label: "topodiff", kind: "project", tasks: 3, running: 1 } as never],
      focus: "/p/topodiff",
      at: null,
      boards: { "/p/topodiff": { level: "Process", label: "Process", breadcrumb: [{ stateId: "Process", label: "Process" }], columns: [], atLevel: [], finished: [] } as BoardView },
      trail: [],
      process: { taskId: "t-p84456-abc", title: "one dev" },
      seen: {},
      onSeen: () => undefined,
      onFocus: () => undefined,
      onDrill: () => undefined,
      onWalkBack: (i) => walked.push(i),
      onOpenProject: () => undefined,
    });
    expect(crumbs.map((c) => c.text)).toEqual(["topodiff", "Process", "one dev"]);
    expect(crumbs[2]!.go).toBeUndefined();
    crumbs[1]!.go!();
    expect(walked).toEqual([-1]);
  });
});
