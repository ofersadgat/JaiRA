/**
 * The shell tool with a terminal (decision 0028): a real process, watched as it runs, typed into and
 * stopped through the terminal it is handed — and a result for the model in the shape it always had,
 * with what the person typed added. POSIX only: the commands are sh.
 */
import { describe, expect, it } from "vitest";
import { createShellTool, type ShellCallIo, type ShellCallTerminal, type ShellTerminals } from "../src/tools";

interface Watched {
  call?: { callId: string | undefined; command: string; cwd: string | undefined; dialect: string };
  output: string;
  io?: ShellCallIo;
  end?: { exitCode: number | null; signal: string | null; timedOut: boolean; stopped: boolean };
  attached: Promise<ShellCallIo>;
  printed: (text: string) => Promise<void>;
}

function watcher(): { terminals: ShellTerminals; watched: Watched } {
  let attach!: (io: ShellCallIo) => void;
  const waits: Array<{ text: string; done: () => void }> = [];
  const watched: Watched = {
    output: "",
    attached: new Promise((resolve) => (attach = resolve)),
    printed: (text) => new Promise((done) => (watched.output.includes(text) ? done() : waits.push({ text, done }))),
  };
  const terminal: ShellCallTerminal = {
    output: (text) => {
      watched.output += text;
      for (const wait of waits.splice(0)) (watched.output.includes(wait.text) ? wait.done() : waits.push(wait));
    },
    attach: (io) => {
      watched.io = io;
      attach(io);
    },
    ended: (end) => (watched.end = end),
  };
  return {
    watched,
    terminals: {
      open: (call) => {
        watched.call = call;
        return terminal;
      },
    },
  };
}

const posix = process.platform !== "win32";
const run = (tool: ReturnType<typeof createShellTool>, command: string, toolCallId = "toolu_1") =>
  (tool as unknown as { run: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }).run({ command }, { workspace: { root: process.cwd() }, toolCallId });

describe.skipIf(!posix)("the shell tool, watched", () => {
  it("opens a terminal for the call, streams its output, and returns what it always returned", async () => {
    const { terminals, watched } = watcher();
    const result = await run(createShellTool({ terminals }), "printf 'one\\n'; printf 'two\\n' >&2");
    expect(watched.call).toMatchObject({ callId: "toolu_1", command: "printf 'one\\n'; printf 'two\\n' >&2", dialect: "posix" });
    expect(watched.output).toContain("one\n");
    expect(watched.output).toContain("two\n");
    expect(watched.end).toEqual({ exitCode: 0, signal: null, timedOut: false, stopped: false });
    expect(result).toEqual({ exitCode: 0, stdout: "one\n", stderr: "two\n" });
  });

  it("writes what a person types to stdin, and hands the model what was typed", async () => {
    const { terminals, watched } = watcher();
    const pending = run(createShellTool({ terminals }), "printf 'name? '; read name; echo \"got:$name\"");
    const io = await watched.attached;
    await watched.printed("name? ");
    expect(io.type("ada\n")).toBe(true);
    const result = await pending;
    expect(result["stdout"]).toBe("name? got:ada\n");
    expect(result["input"]).toEqual(["ada"]);
    expect(watched.end?.exitCode).toBe(0);
  });

  it("interrupts the whole tree on Ctrl-C, and says it was stopped", async () => {
    const { terminals, watched } = watcher();
    const pending = run(createShellTool({ terminals }), "echo start; sleep 30; echo never");
    const io = await watched.attached;
    await watched.printed("start");
    io.interrupt();
    const result = await pending;
    expect(result["stopped"]).toBe(true);
    expect(String(result["stdout"])).not.toContain("never");
    expect(watched.end?.stopped).toBe(true);
  });

  it("ends a command whose shell a Ctrl-C ended while what it started lived on, every time", async () => {
    // Measured 2026-11-18: about one SIGINT in twenty lands as `sh` forks `sleep`; the shell dies and
    // `sleep` holds the output open for its 30 s. Each of these ends within the grace instead.
    for (let i = 0; i < 20; i++) {
      const { terminals, watched } = watcher();
      const started = Date.now();
      const pending = run(createShellTool({ terminals }), "echo start; sleep 30; echo never");
      const io = await watched.attached;
      await watched.printed("start");
      io.interrupt();
      const result = await pending;
      expect(result["stopped"]).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  }, 60_000);

  it("ends a command at its limit, and typing restarts the limit", async () => {
    const { terminals, watched } = watcher();
    const started = Date.now();
    const pending = run(createShellTool({ terminals, timeoutMs: 400 }), "read a; sleep 30");
    const io = await watched.attached;
    const first = io.endsAt()!;
    await new Promise((resolve) => setTimeout(resolve, 250));
    io.type("x\n");
    expect(io.endsAt()!).toBeGreaterThan(first);
    const result = await pending;
    expect(result["timedOut"]).toBe(true);
    // Restarted at ~250 ms, so it ran past the first 400.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(watched.end?.timedOut).toBe(true);
  });

  it("runs with no limit at 0", async () => {
    const { terminals, watched } = watcher();
    const result = await run(createShellTool({ terminals, timeoutMs: 0 }), "echo fine");
    expect(result).toEqual({ exitCode: 0, stdout: "fine\n", stderr: "" });
    expect(watched.io?.endsAt()).toBeUndefined();
  });
});
