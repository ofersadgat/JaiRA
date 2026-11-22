/**
 * An agent's background processes (decision 0032): `shell` with `run_in_background` answers with a pid
 * and keeps the process as the session's; the process tools read, wait on and stop it; what a
 * foreground command leaves running is kept or stopped as the session's permission says. Real
 * processes throughout — node, through the shell the platform runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NodeExec } from "../src/exec";
import { SessionProcesses } from "../src/sessionProcesses";
import { descendantsByStart, isAlive, mayLeaveRunning } from "../src/leftRunning";

/**
 * Whether a process is gone within `ms`. A stop is a kill and then the system's own time to end it — a
 * second or two on a quiet machine, longer while the whole suite runs beside it — so it is waited for
 * rather than assumed to have happened by a fixed time.
 */
async function diesWithin(pid: number, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}
import { createShellTool, type ShellTerminals } from "../src/tools";
import { createSystemTools, systemBackendFor } from "../src/systemTools";
import type { ExecServices } from "@declarative-ai/exec";

/** A call with no task around it. */
const NO_CTX = undefined as unknown as ExecServices;

const node = JSON.stringify(process.execPath);
const win = process.platform === "win32";
/** A line that runs node with `code`, in the shell `shell` runs (PowerShell needs the call operator). */
const nodeLine = (code: string): string => `${win ? "& " : ""}${node} -e ${JSON.stringify(code)}`;

const started: SessionProcesses[] = [];
const keep = (): SessionProcesses => {
  const p = new SessionProcesses(new NodeExec());
  started.push(p);
  return p;
};
afterEach(() => {
  for (const p of started.splice(0)) p.stopAll();
});

/** Terminals that keep nothing — the leftover check runs only on a watched call. */
const terminals: ShellTerminals = { open: () => ({ output: () => undefined, attach: () => undefined, ended: () => undefined }) };

describe("SessionProcesses", () => {
  it("starts a process, answers with what it printed so far, and keeps it running", async () => {
    const processes = keep();
    const answer = await processes.background(
      { command: "server", argv: [process.execPath, "-e", "console.log('listening'); setInterval(() => {}, 1000)"], execEnv: "windows" },
      1_500,
    );
    expect(answer.process.running).toBe(true);
    expect(answer.output).toContain("listening");
    expect(isAlive(answer.process.pid)).toBe(true);
    expect(processes.list().map((p) => p.pid)).toEqual([answer.process.pid]);
  }, 20_000);

  it("reads what is new since the last read, waits for a pattern, and says its end once", async () => {
    const processes = keep();
    const code = "let n = 0; const t = setInterval(() => { console.log('tick ' + ++n); if (n === 3) { console.log('ready'); clearInterval(t); setTimeout(() => process.exit(4), 300); } }, 200)";
    const { process: p } = await processes.background({ command: "ticks", argv: [process.execPath, "-e", code], execEnv: "windows" }, 0);
    const ready = await processes.wait(p.pid, { pattern: /ready/ }, 10_000);
    expect(ready.matched).toBe(true);
    expect(ready.output).toContain("tick 3");
    const ended = await processes.wait(p.pid, { exit: true }, 10_000);
    expect(ended.process.running).toBe(false);
    expect(ended.process.exitCode).toBe(4);
    expect(processes.read(p.pid).output).toBe("");
    const notes = processes.takeNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/`ticks` \(pid \d+\) exited 4/);
    expect(processes.takeNotes()).toEqual([]);
  }, 20_000);

  it("stops a process with what it started", async () => {
    const processes = keep();
    const { process: p } = await processes.background({ command: "sleeper", argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], execEnv: "windows" }, 300);
    processes.stop(p.pid);
    const ended = await processes.wait(p.pid, { exit: true }, 10_000);
    expect(ended.process.running).toBe(false);
    expect(ended.process.stopped).toBe(true);
  }, 20_000);

  it("refuses past its limit, naming what runs", async () => {
    const processes = new SessionProcesses(new NodeExec(), { limit: () => 1 });
    started.push(processes);
    await processes.background({ command: "one", argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], execEnv: "windows" }, 0);
    await expect(processes.background({ command: "two", argv: [process.execPath, "-e", "0"], execEnv: "windows" }, 0)).rejects.toThrow(/most it may.*`one`/);
  }, 20_000);
});

describe("shell with run_in_background, and the process tools", () => {
  it("answers with the pid; list_processes, read_process, wait_process and stop_process reach it at scope session", async () => {
    const processes = keep();
    const shell = createShellTool({ processes, terminals });
    const tools = createSystemTools({ processes, backend: null });
    const started = (await shell.run({ command: nodeLine("console.log('up'); setInterval(() => console.log('beat'), 200)"), run_in_background: true }, NO_CTX)) as Record<string, unknown>;
    expect(started["running"]).toBe(true);
    const pid = started["pid"] as number;
    expect(typeof pid).toBe("number");

    const listed = (await tools["list_processes"]!.run({}, NO_CTX)) as { processes: Array<{ pid: number; running: boolean }>; scope: string };
    expect(listed.scope).toBe("session");
    expect(listed.processes.map((p) => p.pid)).toEqual([pid]);

    const waited = (await tools["wait_process"]!.run({ pid, until: "output", pattern: "beat" }, NO_CTX)) as Record<string, unknown>;
    expect(waited["matched"]).toBe(true);
    const read = (await tools["read_process"]!.run({ pid, tail: 1 }, NO_CTX)) as Record<string, unknown>;
    expect(String(read["output"])).toMatch(/beat|up/);

    const stopped = (await tools["stop_process"]!.run({ pid }, NO_CTX)) as Record<string, unknown>;
    expect(stopped["stopped"]).toBe(true);
    const ended = (await tools["wait_process"]!.run({ pid, timeout_ms: 10_000 }, NO_CTX)) as Record<string, unknown>;
    expect(ended["running"]).toBe(false);
  }, 30_000);

  it("refuses a pid the session did not start, and another scope where none is built", async () => {
    const tools = createSystemTools({ processes: keep(), backend: null });
    expect(await tools["stop_process"]!.run({ pid: process.pid }, NO_CTX)).toMatchObject({ error: expect.stringMatching(/not a process this session started/) });
    expect(await tools["read_process"]!.run({ pid: process.pid, scope: "user" }, NO_CTX)).toMatchObject({ error: expect.stringMatching(/not built yet/) });
    expect(await tools["list_processes"]!.run({ scope: "user" }, NO_CTX)).toMatchObject({ error: expect.stringMatching(/built for Windows and macOS/) });
  });

  it("is refused without a session to keep it", async () => {
    const shell = createShellTool({});
    expect(await shell.run({ command: "echo hi", run_in_background: true }, NO_CTX)).toEqual({ error: "running a command in the background is not available here" });
  });
});

describe("what a foreground command leaves running", () => {
  /** A line that starts a long-lived node and returns at once. */
  const leaving = win
    ? `Start-Process -FilePath ${node} -ArgumentList '-e','setInterval(()=>{},1000)' -WindowStyle Hidden; 'started'`
    : `${node} -e 'setInterval(()=>{},1000)' > /dev/null 2>&1 & echo started`;
  const lister = win || process.platform === "darwin" ? () => systemBackendFor()!.processes() : undefined;

  it("is kept as the session's when the permission allows it, and said so", async () => {
    const processes = keep();
    const shell = createShellTool({ processes, terminals, leftRunning: { ...(lister !== undefined ? { lister } : {}), decide: () => "allow" } });
    const answer = (await shell.run({ command: leaving }, NO_CTX)) as Record<string, unknown>;
    expect(answer["started"]).toEqual([expect.objectContaining({ program: expect.stringMatching(/node/i) })]);
    expect(String(answer["note"])).toMatch(/now this session's processes/);
    const [kept] = processes.list();
    expect(kept?.how).toBe("left");
    expect(isAlive(kept!.pid)).toBe(true);
  }, 60_000);

  it("is stopped before the call answers when it is not allowed", async () => {
    const processes = keep();
    const shell = createShellTool({ processes, terminals, leftRunning: { ...(lister !== undefined ? { lister } : {}), decide: () => "deny" } });
    const answer = (await shell.run({ command: leaving }, NO_CTX)) as Record<string, unknown>;
    const stopped = answer["stoppedLeft"] as Array<{ pid: number }>;
    expect(stopped).toHaveLength(1);
    expect(String(answer["note"])).toMatch(/shell --run_in_background/);
    expect(await diesWithin(stopped[0]!.pid)).toBe(true);
    expect(processes.list()).toEqual([]);
  }, 60_000);
});

describe.runIf(win || process.platform === "darwin")("the machine's processes, by scope", () => {
  it("reads accounts, places JaiRA's own under jaira, and keeps each scope to its own", async () => {
    const backend = systemBackendFor()!;
    const owners = await backend.owners!();
    const os = await import("node:os");
    expect(owners[String(process.pid)]?.toLowerCase()).toContain(os.userInfo().username.toLowerCase());
    const tools = createSystemTools({ processes: keep(), backend });
    const jaira = (await tools["list_processes"]!.run({ scope: "jaira", limit: 500 }, NO_CTX)) as { processes: Array<{ pid: number; started_by: string }> };
    expect(jaira.processes.some((p) => p.pid === process.pid)).toBe(true);
    const user = (await tools["list_processes"]!.run({ scope: "user", limit: 500 }, NO_CTX)) as { processes: Array<{ pid: number; started_by: string }> };
    expect(user.processes.every((p) => p.started_by === "user")).toBe(true);
    expect(user.processes.some((p) => p.pid === process.pid)).toBe(false);
  }, 60_000);
});

describe.runIf(win)("with the session's containment (Windows)", () => {
  it("lists a process started through WMI as escaped, and stops it", async () => {
    const { Containment } = await import("../src/containment");
    const engine = new Containment();
    try {
      await engine.ready();
      const processes = keep();
      const shell = createShellTool({ processes, terminals, containment: { group: engine.group("t-escape"), engine }, leftRunning: { lister: () => systemBackendFor()!.processes(), decide: () => "allow" } });
      const line = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${process.execPath} -e "setInterval(()=>{},1000)"' }; $r.ProcessId`;
      const answer = (await shell.run({ command: line }, NO_CTX)) as Record<string, unknown>;
      const escaped = answer["escaped"] as Array<{ pid: number; why: string }>;
      expect(escaped).toHaveLength(1);
      expect(escaped[0]!.why).toMatch(/WMI/i);
      const kept = processes.list().find((p) => p.pid === escaped[0]!.pid);
      expect(kept?.how).toBe("escaped");
      processes.stop(escaped[0]!.pid);
      expect(await diesWithin(escaped[0]!.pid)).toBe(true);
    } finally {
      engine.close();
    }
  }, 90_000);
});

describe("reading a line for a background start", () => {
  it("knows PowerShell's and sh's ways", () => {
    expect(mayLeaveRunning("Start-Process node -ArgumentList x", "powershell")).toBe(true);
    expect(mayLeaveRunning("Start-Process notepad -Wait", "powershell")).toBe(false);
    expect(mayLeaveRunning("start /b node x", "powershell")).toBe(true);
    expect(mayLeaveRunning("git status", "powershell")).toBe(false);
    expect(mayLeaveRunning("npm run dev &", "posix")).toBe(true);
    expect(mayLeaveRunning("sleep 5 & echo hi", "posix")).toBe(true);
    expect(mayLeaveRunning("make && make test", "posix")).toBe(false);
    expect(mayLeaveRunning("nohup ./server", "posix")).toBe(true);
  });

  it("finds what a process started by parent and start time, skipping a reused pid", () => {
    const at = (ms: number): string => new Date(ms).toISOString();
    const rows = [
      { pid: 10, name: "cmd", started: at(2_000) },
      { pid: 11, parent_pid: 10, name: "node", started: at(3_000) },
      { pid: 12, parent_pid: 11, name: "esbuild", started: at(3_500) },
      // Its parent pid is the call's, but it started before the call: an older process whose parent's pid was reused.
      { pid: 13, parent_pid: 10, name: "old", started: at(500) },
    ];
    expect(descendantsByStart(rows, 10, 2_000).map((p) => p.pid)).toEqual([11, 12]);
  });
});
