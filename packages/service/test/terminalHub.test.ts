/**
 * The engine's terminals (decision 0028, `TerminalHub`): what it keeps per task, what it pushes and
 * when, and how a person's typing reaches a command and its screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINALS_KEPT, WAITING_AFTER_MS, YOU_CLOSE, YOU_OPEN, type PushMessage } from "@jaira/shared";
import type { ShellCallIo } from "@jaira/runtime";
import { OUTPUT_EVERY_MS, TerminalHub } from "../src/terminals";

describe("TerminalHub", () => {
  let pushes: PushMessage[];
  let hub: TerminalHub;
  beforeEach(() => {
    vi.useFakeTimers();
    pushes = [];
    hub = new TerminalHub((message) => pushes.push(message), () => 1_000);
  });
  afterEach(() => vi.useRealTimers());

  const open = (callId = "toolu_1") => hub.forTask("t-1", "proj").open({ callId, command: "npm test", cwd: "/w", dialect: "posix" });

  it("says a terminal started, gathers its output, and says from where each push starts", () => {
    const terminal = open();
    expect(pushes[0]).toMatchObject({ type: "terminal:state", project: "proj", terminal: { taskId: "t-1", callId: "toolu_1", by: "agent", length: 0 } });
    terminal.output("one\n");
    terminal.output("two\n");
    expect(pushes).toHaveLength(1);
    vi.advanceTimersByTime(OUTPUT_EVERY_MS);
    expect(pushes[1]).toEqual({ type: "terminal:output", taskId: "t-1", project: "proj", callId: "toolu_1", from: 0, text: "one\ntwo\n" });
    terminal.output("three\n");
    vi.advanceTimersByTime(OUTPUT_EVERY_MS);
    expect(pushes[2]).toMatchObject({ from: 8, text: "three\n" });
    expect(hub.read("t-1", "toolu_1")).toMatchObject({ output: "one\ntwo\nthree\n", summary: { length: 14 } });
  });

  it("sends what is left and the end together when it ends", () => {
    const terminal = open();
    terminal.output("last\n");
    terminal.ended({ exitCode: 1, signal: null, timedOut: false, stopped: false });
    expect(pushes.map((p) => p.type)).toEqual(["terminal:state", "terminal:output", "terminal:state"]);
    expect(hub.list("t-1")[0]).toMatchObject({ exitCode: 1, endedAt: 1_000 });
  });

  it("types into a running command, writes it in as the person's, and keeps the line", () => {
    const terminal = open();
    const typed: string[] = [];
    const io: ShellCallIo = { type: (text) => (typed.push(text), true), interrupt: vi.fn(), stop: vi.fn(), endsAt: () => 5_000 };
    terminal.attach(io);
    expect(hub.input("t-1", "toolu_1", "y\n")).toBe(true);
    expect(typed).toEqual(["y\n"]);
    expect(hub.read("t-1", "toolu_1")?.output).toBe(`${YOU_OPEN}y${YOU_CLOSE}\n`);
    expect(hub.list("t-1")[0]).toMatchObject({ input: ["y"], endsAt: 5_000 });
    expect(hub.signal("t-1", "toolu_1", "interrupt")).toBe(true);
    expect(io.interrupt).toHaveBeenCalled();
    terminal.ended({ exitCode: null, signal: "SIGINT", timedOut: false, stopped: true });
    expect(hub.input("t-1", "toolu_1", "n\n")).toBe(false);
    expect(hub.signal("t-1", "toolu_1", "stop")).toBe(false);
  });

  it("says a command waits for input once its output ends mid-line and goes still, and takes it back on more", () => {
    const terminal = open();
    terminal.output("\u001b[1mProceed? (y/N)\u001b[0m ");
    vi.advanceTimersByTime(WAITING_AFTER_MS - 1);
    expect(hub.list("t-1")[0]?.waiting).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(hub.list("t-1")[0]?.waiting).toBe(true);
    expect(pushes.at(-1)).toMatchObject({ type: "terminal:state", terminal: { waiting: true } });
    terminal.output("y\n");
    expect(hub.list("t-1")[0]?.waiting).toBeUndefined();
    vi.advanceTimersByTime(WAITING_AFTER_MS);
    expect(hub.list("t-1")[0]?.waiting).toBeUndefined();
  });

  it("keeps a tool call's process with its tool and call, and never calls it waiting — nobody can answer it", () => {
    const terminal = hub.forTask("t-1", "proj").open({ callId: "toolu_9~1", command: "git push origin x", cwd: "/w", dialect: "posix", tool: "git_push", call: "toolu_9" });
    expect(hub.list("t-1")[0]).toMatchObject({ callId: "toolu_9~1", tool: "git_push", call: "toolu_9", by: "agent" });
    terminal.output("Username for 'https://github.com': ");
    vi.advanceTimersByTime(WAITING_AFTER_MS * 2);
    expect(hub.list("t-1")[0]?.waiting).toBeUndefined();
  });

  it("keeps the last few per task, letting ended ones go before running ones", () => {
    const running = open("running");
    running.attach({ type: () => true, interrupt: () => undefined, stop: () => undefined, endsAt: () => undefined });
    for (let i = 0; i < TERMINALS_KEPT + 3; i++) open(`c${i}`).ended({ exitCode: 0, signal: null, timedOut: false, stopped: false });
    const ids = hub.list("t-1").map((t) => t.callId);
    expect(ids).toHaveLength(TERMINALS_KEPT);
    expect(ids).toContain("running");
    expect(ids).not.toContain("c0");
  });
});
