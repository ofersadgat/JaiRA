/**
 * Claude Code's own background commands (decision 0032, ruling 6): the gate's notice when it allows a
 * native `Bash` with `run_in_background`, and finding what that started under the claude process.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecServices } from "@declarative-ai/exec";
import type { ToolGate } from "@declarative-ai/permissions";
import { NodeExec } from "../src/exec";
import { SessionProcesses } from "../src/sessionProcesses";
import { isAlive, type LeftProcess } from "../src/leftRunning";
import { CLAUDE_TOOLS, servicesUnder, withAgentPermissionSet } from "../src/agentTools";
import { AgentProcesses, attributeNativeBackground, commandLineRuns, nativeCandidates, noticeNativeBackground, pickNative, type NativeBackgroundCall } from "../src/nativeBackground";
import { createSystemTools, systemBackendFor } from "../src/systemTools";
import type { OutputTargets, ProcessRow } from "../src/system/types";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

/** A gate that answers `allow` for everything but what `deny` names, and records what it was asked. */
function fakeGate(deny: (name: string) => boolean = () => false): ToolGate & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    profile: "default",
    modeOf: () => "ask",
    check: (tool) => {
      asked.push(tool.name);
      return Promise.resolve(deny(tool.name) ? { allow: false as const, reason: "no" } : { allow: true as const });
    },
  };
}

describe("the gate's notice", () => {
  it("tells of a native shell's run_in_background only when it is allowed", async () => {
    const heard: NativeBackgroundCall[] = [];
    const allow = noticeNativeBackground(fakeGate(), (call) => heard.push(call));
    await allow.check({ name: "Bash" }, { command: "npm run dev", run_in_background: true, description: "serve" });
    await allow.check({ name: "Bash" }, { command: "ls" });
    await allow.check({ name: "PowerShell" }, { command: "npm start", run_in_background: true });
    // JaiRA's own shell keeps its own processes: never heard here.
    await allow.check({ name: "shell" }, { command: "npm run dev", run_in_background: true });
    expect(heard.map(({ tool, command, description }) => ({ tool, command, description }))).toEqual([
      { tool: "Bash", command: "npm run dev", description: "serve" },
      { tool: "PowerShell", command: "npm start", description: undefined },
    ]);
    expect(heard[0]!.at).toBeGreaterThan(0);

    const refused: NativeBackgroundCall[] = [];
    const deny = noticeNativeBackground(fakeGate((name) => name === "Bash"), (call) => refused.push(call));
    expect(await deny.check({ name: "Bash" }, { command: "npm run dev", run_in_background: true })).toMatchObject({ allow: false });
    expect(refused).toEqual([]);
  });

  it("hears the native by its own name around the translated gate, which asks about it as `shell`", async () => {
    const heard: NativeBackgroundCall[] = [];
    const inner = fakeGate();
    const translated = servicesUnder({ gate: inner } as unknown as ExecServices, CLAUDE_TOOLS, []).gate!;
    const gate = noticeNativeBackground(translated, (call) => heard.push(call));
    await gate.check({ name: "Bash" }, { command: "node server.js", run_in_background: true });
    expect(inner.asked).toEqual(["shell"]);
    expect(heard.map((c) => c.tool)).toEqual(["Bash"]);
  });

  it("reaches the gate a claude executor is handed, from withAgentPermissionSet's option", async () => {
    const heard: NativeBackgroundCall[] = [];
    let handed: ExecServices | undefined;
    const executor = {
      capabilities: {},
      metrics: {},
      start: (_op: unknown, ctx: ExecServices) => {
        handed = ctx;
        return {};
      },
    };
    const wrapped = withAgentPermissionSet(CLAUDE_TOOLS, executor as never, { label: "claude-cli", onNativeBackground: (call) => heard.push(call) });
    (wrapped as unknown as typeof executor).start({ kind: "prompt", config: {} }, { gate: fakeGate() } as unknown as ExecServices);
    await handed!.gate!.check({ name: "Bash" }, { command: "vite", run_in_background: true });
    expect(heard.map((c) => c.command)).toEqual(["vite"]);
  });
});

describe("matching what the call started", () => {
  const claude = { pid: 100, startedAt: T0 - 60_000 };
  const call = T0;
  const rows: ProcessRow[] = [
    { pid: 100, name: "claude", parent_pid: 1, started: at(-60_000) },
    // An MCP server from claude's start: not the call's.
    { pid: 201, name: "node", parent_pid: 100, started: at(-59_000) },
    // The background command, its MSYS bash and its conhost.
    { pid: 202, name: "bash", parent_pid: 100, started: at(20) },
    { pid: 203, name: "bash", parent_pid: 202, started: at(30) },
    { pid: 204, name: "conhost", parent_pid: 203, started: at(31) },
    // Claude's next call, a foreground one, already running.
    { pid: 205, name: "bash", parent_pid: 100, started: at(900) },
    // A process the session already holds, and what it started since.
    { pid: 206, name: "node", parent_pid: 100, started: at(-5_000) },
    { pid: 207, name: "node", parent_pid: 206, started: at(400) },
    // Someone else's.
    { pid: 300, name: "chrome", parent_pid: 1, started: at(100) },
  ];

  it("takes the tops started since the call under the claude process, less what is known", () => {
    expect(nativeCandidates(rows, [claude], call, new Set([206])).map((p) => p.pid)).toEqual([202, 205]);
  });

  it("keeps the one whose command line runs the call's command", () => {
    const candidates = nativeCandidates(rows, [claude], call, new Set([206]));
    const lines = new Map([
      [202, `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/snap.sh 2>/dev/null || true && eval 'npm run dev -- --port 5173' < /dev/null && pwd -P >| /tmp/cwd"`],
      [205, `"C:\\Program Files\\Git\\bin\\bash.exe" -c "eval 'git status' < /dev/null"`],
    ]);
    expect(pickNative(candidates, "npm run dev -- --port 5173", lines).map((p) => p.pid)).toEqual([202]);
    // A later call that names the command too (a grep for it) is not the one: the earliest is.
    const named = new Map([...lines, [205, `bash.exe -c "eval 'ps -ef | grep \\"npm run dev -- --port 5173\\"'"`]]);
    expect(pickNative(candidates, "npm run dev -- --port 5173", named).map((p) => p.pid)).toEqual([202]);
    expect(pickNative([...candidates].reverse(), "npm run dev -- --port 5173", named).map((p) => p.pid)).toEqual([202]);
    // Lines read, none running it: nothing (it may not have started yet).
    expect(pickNative(candidates, "cargo watch", lines)).toEqual([]);
    // No line read: a lone candidate is kept, two are not told apart.
    expect(pickNative(candidates.slice(0, 1), "npm run dev", new Map()).map((p) => p.pid)).toEqual([202]);
    expect(pickNative(candidates, "npm run dev", new Map())).toEqual([]);
  });

  it("reads a command through each side's quoting", () => {
    // bash's '"'"' and a Windows command line's \" around the eval'd line.
    expect(commandLineRuns(`bash.exe -c "eval 'echo '\\"'\\"'hi'\\"'\\"' && grep \\"x y\\" f.txt' < /dev/null"`, `echo 'hi' && grep "x y" f.txt`)).toBe(true);
    expect(commandLineRuns(`bash -c "eval 'npm run dev'"`, "npm  run\n dev")).toBe(true);
    expect(commandLineRuns(`bash -c "eval 'npm test'"`, "npm run dev")).toBe(false);
    const encoded = Buffer.from("npm run dev", "utf16le").toString("base64");
    expect(commandLineRuns(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, "npm run dev")).toBe(true);
  });

  it("adopts it as the session's, with Claude Code's file, and stops what the walk lost with it", async () => {
    const file = "C:\\Temp\\claude\\x\\tasks\\b1.output";
    const withOrphan: ProcessRow[] = [
      ...rows,
      // MSYS exec: the program under a parent that has already exited.
      { pid: 210, name: "node", parent_pid: 999, started: at(60) },
      // Another orphan in the window, writing elsewhere.
      { pid: 211, name: "git", parent_pid: 998, started: at(70) },
    ];
    // Chrome (300) started in the window under a parent not listed too, and writes nowhere of ours.
    const targets = async (pid: number): Promise<OutputTargets> =>
      [202, 203, 210].includes(pid) ? { stdout: { kind: "file", path: file }, stderr: { kind: "file", path: file } } : { stdout: { kind: "pipe" }, stderr: { kind: "pipe" } };
    const processes = new SessionProcesses(new NodeExec());
    const stopped: number[][] = [];
    const claimed = new Set<number>();
    const kept = await attributeNativeBackground(
      { tool: "Bash", command: "npm run dev", at: call },
      {
        agents: () => [claude],
        lister: async () => withOrphan,
        commandLines: async () =>
          new Map([
            [202, `bash.exe -c "eval 'npm run dev'"`],
            [205, `bash.exe -c "eval 'ls'"`],
          ]),
        outputTargets: targets,
        processes,
        claimed,
        settleMs: 0,
        platform: "win32",
        stop: (_top: LeftProcess, all: readonly LeftProcess[]) => stopped.push(all.map((p) => p.pid)),
        alive: () => true,
      },
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ pid: 202, how: "native", command: "npm run dev", output: "file", outputPath: file, running: true });
    expect(processes.get(202)?.how).toBe("native");
    expect([...claimed].sort()).toEqual([202, 203, 204, 210]);
    processes.stop(202);
    expect(stopped).toEqual([[202, 203, 204, 210]]);

    // The same command again claims nothing already claimed.
    const again = await attributeNativeBackground(
      { tool: "Bash", command: "npm run dev", at: call },
      { agents: () => [claude], lister: async () => withOrphan, commandLines: async () => new Map([[202, `eval 'npm run dev'`]]), processes, claimed, settleMs: 0, tries: 1, platform: "win32", alive: () => true },
    );
    expect(again).toEqual([]);
  });

  it("says why when where it writes is not a file, and finds nothing with no claude running", async () => {
    const processes = new SessionProcesses(new NodeExec());
    const [kept] = await attributeNativeBackground(
      { tool: "Bash", command: "npm run dev", at: call },
      {
        agents: () => [claude],
        lister: async () => rows,
        commandLines: async () => new Map([[202, `eval 'npm run dev'`]]),
        outputTargets: async () => ({ stdout: { kind: "pipe" }, stderr: { kind: "pipe" } }),
        processes,
        settleMs: 0,
        platform: "linux",
        stop: () => undefined,
        alive: () => true,
      },
    );
    expect(kept).toMatchObject({ pid: 202, output: "unreadable" });
    expect(kept!.unreadableWhy).toContain("a pipe");
    expect(await attributeNativeBackground({ tool: "Bash", command: "x", at: call }, { agents: () => [], lister: async () => rows, processes, settleMs: 0 })).toEqual([]);
  });

  it("records the agent processes an observer sees spawn, and forgets them at exit", () => {
    const procs = new AgentProcesses();
    const seen: unknown[] = [];
    const observer = procs.observing({ onSpawn: () => "job-1", onExit: (token) => void seen.push(token) });
    const token = observer.onSpawn({ command: "claude", argv: [], pid: 4242 });
    expect(procs.list(() => true).map((p) => p.pid)).toEqual([4242]);
    observer.onExit(token, { code: 0, signal: null });
    expect(seen).toEqual(["job-1"]);
    expect(procs.list(() => true)).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("a stand-in claude on Windows", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it("finds what it started in the background after the call, adopts it with its file, and stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jaira-native-bg-"));
    const file = join(dir, "task.output");
    const marker = `jaira-native-${process.pid}-${Date.now()}`;
    // Like Claude Code: after a moment, a detached child whose stdout and stderr are a file.
    const script = [
      "const fs = require('fs'); const { spawn } = require('child_process');",
      `setTimeout(() => { const fd = fs.openSync(${JSON.stringify(file)}, 'a');`,
      `  const c = spawn(process.execPath, ['-e', 'console.log(\\'ready\\'); setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], { stdio: ['ignore', fd, fd], detached: true, windowsHide: true });`,
      "  c.unref(); }, 300);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const callAt = Date.now();
    const standIn = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true });
    const startedAt = Date.now();
    cleanup.push(() => {
      standIn.kill();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Held a moment longer by the child's exit.
      }
    });

    const backend = systemBackendFor()!;
    const processes = new SessionProcesses(new NodeExec());
    const kept = await attributeNativeBackground(
      { tool: "Bash", command: `node -e "console.log('ready'); setInterval(() => {}, 1000)" ${marker}`, at: callAt },
      {
        agents: () => [{ pid: standIn.pid!, startedAt }],
        lister: () => backend.processes(),
        outputTargets: (pid) => backend.outputTargets!(pid),
        processes,
        settleMs: 1_500,
        retryMs: 1_500,
      },
    );
    expect(kept).toHaveLength(1);
    const pid = kept[0]!.pid;
    cleanup.unshift(() => {
      try {
        process.kill(pid);
      } catch {
        // Stopped already.
      }
    });
    expect(kept[0]).toMatchObject({ how: "native", output: "file", running: true });
    expect(kept[0]!.outputPath?.toLowerCase()).toBe(file.toLowerCase());
    expect(isAlive(pid)).toBe(true);

    // read_process at scope session follows Claude Code's file, as another program's is.
    const tools = createSystemTools({ processes, backend });
    const read = (await tools["read_process"]!.run({ pid }, {} as never)) as Record<string, unknown>;
    expect(read).toMatchObject({ pid, how: "Claude Code's own run_in_background", source: "file", running: true });
    expect(String(read["output"])).toContain("ready");
    const listed = (await tools["list_processes"]!.run({}, {} as never)) as { processes: Array<Record<string, unknown>> };
    expect(listed.processes[0]).toMatchObject({ pid, readable: expect.stringContaining("task.output") });

    processes.stop(pid);
    const deadline = Date.now() + 10_000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(false);
  }, 90_000);
});
