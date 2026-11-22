/**
 * A terminal as the window draws it (decision 0028): the screen parsed from raw output, what the card
 * says about it, and the window's copy kept current by the engine's pushes.
 */
import { describe, expect, it, vi } from "vitest";
import { YOU_CLOSE, YOU_OPEN, type PushMessage, type TerminalSummary } from "@jaira/shared";
import { TERM_COLOURS, TermScreen, endsInText, isWaiting, promptChoicesOf, requestRowsOf, terminalStatusOf, terminalTitleOf } from "../src/renderer/terminalModel";
import { TerminalStore } from "../src/renderer/terminalStore";

const text = (screen: TermScreen): string[] => screen.lines().map((line) => line.map((span) => span.text).join(""));

describe("TermScreen", () => {
  it("keeps colours as spans and drops what it does not draw", () => {
    const screen = new TermScreen();
    screen.write("\u001b[32m✓\u001b[0m upload \u001b[2m38ms\u001b[22m\n\u001b]0;title\u0007\u001b[?25lnext");
    const [first, second] = screen.lines();
    expect(first).toEqual([{ fg: TERM_COLOURS[2], text: "✓" }, { text: " upload " }, { dim: true, text: "38ms" }]);
    expect(second).toEqual([{ text: "next" }]);
  });

  it("overwrites on a carriage return, as a progress bar ends up", () => {
    const screen = new TermScreen();
    screen.write("10%\r50%\r");
    screen.write("100%\n");
    expect(text(screen)).toEqual(["100%", ""]);
    screen.write("a\r\nb");
    expect(text(screen)).toEqual(["100%", "a", "b"]);
  });

  it("finishes an escape cut between two pushes", () => {
    const screen = new TermScreen();
    screen.write("x\u001b[3");
    screen.write("1mred");
    expect(screen.lines()[0]).toEqual([{ text: "x" }, { fg: TERM_COLOURS[1], text: "red" }]);
  });

  it("marks the person's typing", () => {
    const screen = new TermScreen();
    screen.write(`Stage this hunk [y,n]? ${YOU_OPEN}y${YOU_CLOSE}\n`);
    expect(screen.lines()[0]).toEqual([{ text: "Stage this hunk [y,n]? " }, { you: true, text: "y" }]);
    expect(screen.partial()).toBe("");
    expect(screen.lastText()).toBe("Stage this hunk [y,n]? y");
  });

  it("is the plain text for the Text reading", () => {
    const screen = new TermScreen();
    screen.write("\u001b[1mbold\u001b[0m\n\tx\n");
    expect(screen.plain()).toBe("bold\n        x\n");
  });
});

describe("what the card says", () => {
  const base: TerminalSummary = { taskId: "t", callId: "c", command: "x", dialect: "posix", by: "agent", startedAt: 0, length: 0, dropped: 0, input: [] };

  it("titles a command by the program that does the work", () => {
    expect(terminalTitleOf("cd packages/api && npx vitest run src/upload.test.ts", "posix")).toBe("vitest run");
    expect(terminalTitleOf("git add -p src/upload.ts", "posix")).toBe("git add");
    expect(terminalTitleOf("ls -la", "posix")).toBe("ls");
    expect(terminalTitleOf("printf 'checking uploads\\n'; read answer", "posix")).toBe("printf");
    // A package run through a runner is named with its first word, as a subcommand.
    expect(terminalTitleOf("npx one dev --port 8145", "posix")).toBe("one dev");
    expect(terminalTitleOf("npx drizzle-kit studio", "powershell")).toBe("drizzle-kit studio");
    expect(terminalTitleOf("npx tsc --noEmit", "posix")).toBe("tsc");
    // PowerShell's own case is kept.
    expect(terminalTitleOf("Write-Output 'done'", "powershell")).toBe("Write-Output");
    expect(terminalTitleOf("Set-Location C:/x; Get-ChildItem -Recurse", "powershell")).toBe("Get-ChildItem");
  });

  it("lists the line's requests as the approval does", () => {
    const rows = requestRowsOf("cd packages/api && npx vitest run x 2>&1 | tee /tmp/v.log", "posix");
    expect(rows.map((row) => row.words)).toContain("tee /tmp/v.log");
    expect(rows.some((row) => row.what === "one vitest run")).toBe(true);
  });

  it("says running, waiting, and how it ended", () => {
    expect(terminalStatusOf(base, false, 12_400)).toEqual({ text: "running · 12s", tone: "accent" });
    expect(terminalStatusOf(base, true, 4_000).tone).toBe("warn");
    expect(terminalStatusOf({ ...base, endedAt: 800, exitCode: 0 }, false, 9_999)).toEqual({ text: "exit 0 · 0.8s", tone: "ok" });
    expect(terminalStatusOf({ ...base, endedAt: 5_900, exitCode: 1 }, false, 9_999)).toEqual({ text: "exit 1 · 5.9s", tone: "bad" });
    expect(terminalStatusOf({ ...base, endedAt: 3_000, exitCode: null, stopped: true }, false, 9_999).text).toBe("stopped · 3.0s");
  });

  it("waits for input while the engine says so and it runs", () => {
    expect(isWaiting({ ...base, waiting: true })).toBe(true);
    expect(isWaiting(base)).toBe(false);
    expect(isWaiting({ ...base, waiting: true, endedAt: 2_000 })).toBe(false);
    expect(endsInText({ ...base, endsAt: 73_000 }, 1_000)).toBe("ends in 1m 12s unless you answer");
  });

  it("reads the answers a prompt names", () => {
    expect(promptChoicesOf("(2/2) Stage this hunk [y,n,q,a,d,s,e,?]? ").map((c) => c.key)).toEqual(["y", "n", "q", "a", "d", "s", "e", "?"]);
    expect(promptChoicesOf("Proceed? (y/N)")).toEqual([
      { key: "y", label: "yes", send: "y\n" },
      { key: "n", label: "no (default)", send: "n\n" },
    ]);
    expect(promptChoicesOf("Are you sure? (yes/no)").map((c) => c.send)).toEqual(["yes\n", "no\n"]);
    expect(promptChoicesOf("running tests")).toEqual([]);
  });
});

describe("TerminalStore", () => {
  function store(read: (request: { taskId: string; callId: string }) => unknown = () => null) {
    let push!: (message: PushMessage) => void;
    const invoke = vi.fn((channel: string, request: { taskId: string; callId: string }) => Promise.resolve(channel === "terminal:read" ? read(request) : []));
    const s = new TerminalStore({ invoke: invoke as never, subscribe: ((listener: (m: PushMessage) => void) => ((push = listener), () => undefined)) as never });
    s.subscribe(() => undefined);
    return { s, invoke, push: (m: PushMessage) => push(m) };
  }
  const summary: TerminalSummary = { taskId: "t", callId: "c", command: "npm test", dialect: "posix", by: "agent", startedAt: 0, length: 0, dropped: 0, input: [] };

  it("follows a terminal from its start through its output", () => {
    const { s, push, invoke } = store();
    push({ type: "terminal:state", terminal: summary });
    push({ type: "terminal:output", taskId: "t", callId: "c", from: 0, text: "one\n" });
    push({ type: "terminal:output", taskId: "t", callId: "c", from: 4, text: "two\n" });
    expect(text(s.get("t", "c")!.screen)).toEqual(["one", "two", ""]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads the terminal again when a push shows something was missed, and replays what came meanwhile", async () => {
    const { s, push, invoke } = store(() => ({ summary: { ...summary, length: 8 }, output: "one\ntwo\n" }));
    push({ type: "terminal:state", terminal: summary });
    push({ type: "terminal:output", taskId: "t", callId: "c", from: 4, text: "two\n" });
    push({ type: "terminal:output", taskId: "t", callId: "c", from: 8, text: "three\n" });
    expect(invoke).toHaveBeenCalledWith("terminal:read", { taskId: "t", callId: "c" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(text(s.get("t", "c")!.screen)).toEqual(["one", "two", "three", ""]);
    expect(s.listOf("t")).toHaveLength(1);
  });
});
