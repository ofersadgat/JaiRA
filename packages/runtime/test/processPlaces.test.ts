/**
 * The process tools' PROGRAM places (decision 0023 §3.1, amended 2026-11-22 and 2026-11-23): a shell
 * command that lists or stops processes answers to `list_processes`' and `stop_process`'s lines as a
 * direct call does — at the programs it names, the programs its pids are, and the `--scope=all` flag
 * line before the bare one — and a direct call naming a pid answers at the program that process is.
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import { lowerPermissionSet, parseCommand, parsePermissionSet, unknownProgramPlace, type CommandDialect, type PermissionSetDecl } from "@jaira/shared";
import { shellPermissionSetOf } from "../src/commandParts";
import { commandDecisionOf, compilePolicy, decideCommand, flagLineAnswer, pidsNamedBy } from "../src/policy";
import { processTargetsOf } from "../src/processTargets";
import { programOfPidOnMachine, warmProgramsOfPids } from "../src/programOfPid";

const ROOT = "/work";
/** The machine, as these tests see it: 4242 is node, 5151 is python, anything else has ended. */
const PROGRAMS: Record<number, string> = { 4242: "node", 5151: "python" };
const programOfPid = (pid: number): string | undefined => PROGRAMS[pid];
const setOf = (decl: PermissionSetDecl) => parsePermissionSet(decl).permissionSet;
const decide = (decl: PermissionSetDecl, line: string, dialect: CommandDialect = "posix") =>
  decideCommand({}, line, dialect, { permissionSet: shellPermissionSetOf(setOf(decl))!, root: ROOT, places: { root: ROOT, programOfPid } });
const targets = (line: string, dialect: CommandDialect = "posix") => processTargetsOf(parseCommand(line, dialect).commands[0]!, dialect);

describe("what a process command is about", () => {
  it.each([
    ["ps aux", "posix", [], []],
    ["ps -C node,python -o pid", "posix", ["node", "python"], []],
    ["ps -p 4242,5151", "posix", [], [4242, 5151]],
    ["top -p 4242", "posix", [], [4242]],
    ["pgrep node", "posix", ["node"], []],
    ["pgrep -u root -l '^node$'", "posix", ["node"], []],
    ["pgrep 'no.e'", "posix", [unknownProgramPlace("no.e")], []],
    ["pidof node python3", "posix", ["node", "python3"], []],
    ["lsof -c node -i", "posix", ["node"], []],
    // pkill finds its pattern anywhere in a name: `node` stops `nodemon` too.
    ["pkill node", "posix", ["*node*"], []],
    ["pkill -x node", "posix", ["node"], []],
    ["pkill -9 '^node$'", "posix", ["node"], []],
    ["pkill -f node", "posix", [unknownProgramPlace("node")], []],
    ["killall node Python", "posix", ["node", "python"], []],
    ["killall -r 'nod.*'", "posix", [unknownProgramPlace("nod.*")], []],
    ["kill -9 4242 5151", "posix", [], [4242, 5151]],
    ["kill -s TERM 4242", "posix", [], [4242]],
    ["kill %1", "posix", [unknownProgramPlace("%1")], []],
    ["kill $PID", "posix", [unknownProgramPlace("$PID")], []],
    ["kill -l", "posix", [], []],
    ["Get-Process", "powershell", [], []],
    ["Get-Process node, python", "powershell", ["node", "python"], []],
    ["Get-Process -Name node -Id 5151", "powershell", ["node"], [5151]],
    ["gps -n node*", "powershell", ["node*"], []],
    ["Stop-Process 4242 -Force", "powershell", [], [4242]],
    ["Stop-Process -Name:chrome -Id 5151", "powershell", ["chrome"], [5151]],
    ["Stop-Process -Id $pid", "powershell", [unknownProgramPlace("$pid")], []],
    ["tasklist", "cmd", [], []],
    ['tasklist /FI "IMAGENAME eq node.exe" /FO CSV', "cmd", ["node"], []],
    ['tasklist /FI "STATUS eq running"', "cmd", [], []],
    ['taskkill /F /IM node.exe /PID 5151', "cmd", ["node"], [5151]],
    ['taskkill /FI "PID eq 4242"', "cmd", [], [4242]],
  ] as const)("'%s' (%s) names %j and pids %j", (line, dialect, programs, pids) => {
    expect(targets(line, dialect)).toEqual({ programs, pids });
  });
});

describe("a shell command that lists processes answers as list_processes does", () => {
  const LIST = { list_processes: { node: "allow", "**": "ask" }, shell: "allow" } as const;

  it("at the program it names, and at `**` where it names none", () => {
    expect(decide(LIST, "pgrep node").action).toBe("allow");
    expect(decide(LIST, "pgrep node").parts.parts[0]!.decidedBy).toMatchObject({ entry: "list_processes", place: "node" });
    expect(decide(LIST, "Get-Process -Name node", "powershell").action).toBe("allow");
    expect(decide(LIST, 'tasklist /FI "IMAGENAME eq node.exe"', "cmd").action).toBe("allow");
    expect(decide(LIST, "ps -p 4242").action).toBe("allow");
    // Every program, or one the line does not name exactly: the line's `**`.
    for (const line of ["ps aux", "pgrep python", "pgrep 'no.e'", "ps -p 9999"]) expect(decide(LIST, line).action, line).toBe("require_approval");
    expect(decide(LIST, "Get-Process", "powershell").action).toBe("require_approval");
    expect(decide(LIST, "tasklist", "cmd").action).toBe("require_approval");
  });

  it("at the `--scope=all` flag line before the bare line, and never at the session's", () => {
    const set = {
      "list_processes --scope=session": "allow",
      "list_processes --scope=all": { node: "allow", "**": "deny" },
      list_processes: "ask",
      shell: "allow",
    } as const;
    expect(decide(set, "pgrep node").action).toBe("allow");
    expect(decide(set, "pgrep node").parts.parts[0]!.decidedBy).toMatchObject({ entry: "list_processes --scope=all", place: "node" });
    expect(decide(set, "ps aux").action).toBe("deny");
    // With no `--scope=all` line, the bare line answers, as it did — the session's line is never a command's.
    const shipped = { "list_processes --scope=session": "allow", list_processes: "ask", shell: "allow" } as const;
    expect(decide(shipped, "ps aux").action).toBe("require_approval");
    expect(decide(shipped, "ps aux").parts.parts[0]!.decidedBy.entry).toBe("list_processes");
    // A flag line with no `**` passes what none of its places matches down to the bare line.
    const placed = { "list_processes --scope=all": { node: "allow" }, list_processes: "deny", shell: "allow" } as const;
    expect(decide(placed, "pgrep node").action).toBe("allow");
    expect(decide(placed, "pgrep python").action).toBe("deny");
  });

  it("is judged the same through a direct call and through the shell", () => {
    const set = setOf({ "list_processes --scope=all": { node: "allow", "**": "ask" }, list_processes: "deny" });
    expect(flagLineAnswer("list_processes", { scope: "all", name: "node" }, set)).toMatchObject({ mode: "allow", place: "node" });
    expect(decide({ "list_processes --scope=all": { node: "allow", "**": "ask" }, list_processes: "deny", shell: "allow" }, "pgrep node").action).toBe("allow");
  });
});

describe("a shell command that stops processes answers as stop_process does", () => {
  const STOP = { stop_process: { node: "allow", "**": "ask", python: "deny" }, shell: "allow" } as const;

  it("at the program each pid it names is", () => {
    expect(decide(STOP, "kill 4242").action).toBe("allow");
    expect(decide(STOP, "kill 4242").parts.parts[0]!.decidedBy).toMatchObject({ entry: "stop_process", place: "node" });
    expect(decide(STOP, "kill 5151").action).toBe("deny");
    expect(decide(STOP, "Stop-Process -Id 4242", "powershell").action).toBe("allow");
    expect(decide(STOP, "taskkill /PID 4242 /F", "cmd").action).toBe("allow");
    // A pid the machine cannot name is no program's: only `**` answers it, and with a named one the stricter does.
    expect(decide(STOP, "kill 9999").action).toBe("require_approval");
    expect(decide(STOP, "kill 4242 9999").action).toBe("require_approval");
    expect(decide(STOP, "kill 4242 5151").action).toBe("deny");
  });

  it("at the program it names — exactly, never by a pattern that reaches further", () => {
    expect(decide(STOP, "killall node").action).toBe("allow");
    expect(decide(STOP, "pkill -x node").action).toBe("allow");
    expect(decide(STOP, "taskkill /IM node.exe", "cmd").action).toBe("allow");
    expect(decide(STOP, "Stop-Process -Name node", "powershell").action).toBe("allow");
    // `pkill node` stops `nodemon` too, and `-f` reads the whole command line: neither is `node`.
    expect(decide(STOP, "pkill node").action).toBe("require_approval");
    expect(decide(STOP, "pkill -f node").action).toBe("require_approval");
    expect(decide({ stop_process: { "*node*": "allow", "**": "ask" }, shell: "allow" }, "pkill node").action).toBe("allow");
    // What the line decides as it runs is no program's.
    expect(decide(STOP, "kill $PID").action).toBe("require_approval");
  });

  it("at the `--scope=all` flag line first", () => {
    const set = { "stop_process --scope=session": "allow", "stop_process --scope=all": { node: "allow", "**": "deny" }, stop_process: "ask", shell: "allow" } as const;
    expect(decide(set, "kill 4242").action).toBe("allow");
    expect(decide(set, "kill 5151").action).toBe("deny");
  });

  it("reads no pid where the line runs elsewhere than this machine", () => {
    const set = setOf({ stop_process: { node: "allow", "**": "ask" }, shell: "allow" });
    const policy = compilePolicy({}, { permissionSet: set, programOfPid, execEnv: { wsl: "Ubuntu" }, workspaceRoot: ROOT });
    expect(policy.scopeOf!({ name: "shell" }, { command: "kill 4242" } as FunctionInputs, undefined as never)).toBe("ask");
    const native = compilePolicy({}, { permissionSet: set, programOfPid, workspaceRoot: ROOT });
    expect(native.scopeOf!({ name: "shell" }, { command: "kill 4242" } as FunctionInputs, undefined as never)).toBeUndefined();
  });
});

describe("a direct call naming a pid answers at the program that process is", () => {
  const block = (decl: PermissionSetDecl) => lowerPermissionSet(setOf(decl), "$/permission-sets/x/y").permissions!;

  it.each(["stop_process", "read_process", "wait_process"])("%s", (tool) => {
    const policy = compilePolicy({}, { programOfPid, workspaceRoot: ROOT });
    const decl = { [tool]: { node: "allow", python: "deny", "**": "ask" } };
    expect(policy.scopeOf!({ name: tool }, { pid: 4242 } as FunctionInputs, block(decl) as never)).toBe("allow");
    expect(policy.scopeOf!({ name: tool }, { pid: 5151 } as FunctionInputs, block(decl) as never)).toBe("deny");
    const ended = { pid: 9999 };
    expect(policy.scopeOf!({ name: tool }, ended as FunctionInputs, block(decl) as never)).toBe("ask");
    // Asked about a process nobody can name, the person is offered no narrower answer than anywhere.
    expect(commandDecisionOf(ended)?.parts.parts[0]?.where).toEqual({ kind: "program", at: unknownProgramPlace(9999), widths: [{ width: "anywhere", place: "**" }] });
  });

  it("and at the program through a flag line's places, the shipped session line deciding first", () => {
    const set = setOf({ "stop_process --scope=session": "allow", "stop_process --scope=user": { node: "allow", "**": "deny" }, stop_process: "ask" });
    expect(flagLineAnswer("stop_process", { pid: 5151 }, set, { programOfPid })).toEqual({ mode: "allow", subject: "stop_process --scope=session" });
    expect(flagLineAnswer("stop_process", { pid: 4242, scope: "user" }, set, { programOfPid })).toEqual({ mode: "allow", subject: "stop_process --scope=user", place: "node" });
    expect(flagLineAnswer("stop_process", { pid: 5151, scope: "user" }, set, { programOfPid })).toEqual({ mode: "deny", subject: "stop_process --scope=user" });
  });

  it("with `programOfPid: null`, a pid names no program", () => {
    const policy = compilePolicy({}, { programOfPid: null, workspaceRoot: ROOT });
    expect(policy.scopeOf!({ name: "stop_process" }, { pid: 4242 } as FunctionInputs, block({ stop_process: { node: "allow", "**": "ask" } }) as never)).toBe("ask");
  });
});

describe("reading a pid's program before the gate asks (ScopeNarrowing.prepare)", () => {
  /** A machine whose programs can only be read ahead, as Windows' are. */
  const slowMachine = () => {
    const read = new Map<number, string>();
    const warmed: number[][] = [];
    return {
      warmed,
      programOfPid: (pid: number) => read.get(pid),
      warmProgramsOfPids: async (pids: readonly number[]) => {
        warmed.push([...pids]);
        for (const pid of pids) if (PROGRAMS[pid] !== undefined) read.set(pid, PROGRAMS[pid]!);
      },
    };
  };

  it("reads the pids a call names, then judges it at their programs", async () => {
    const machine = slowMachine();
    const set = setOf({ stop_process: { node: "allow", "**": "ask" }, shell: "allow" });
    const policy = compilePolicy({}, { permissionSet: set, programOfPid: machine.programOfPid, warmProgramsOfPids: machine.warmProgramsOfPids, workspaceRoot: ROOT });
    const direct = { pid: 4242 };
    await policy.scopeOf!.prepare!({ name: "stop_process" }, direct as FunctionInputs, undefined as never);
    expect(policy.scopeOf!({ name: "stop_process" }, direct as FunctionInputs, undefined as never)).toBe("allow");
    // `kill` is a POSIX program and PowerShell's `Stop-Process`: the line reads the same on every machine.
    const line = { command: "kill 5151" };
    await policy.scopeOf!.prepare!({ name: "shell" }, line as FunctionInputs, undefined as never);
    expect(policy.scopeOf!({ name: "shell" }, line as FunctionInputs, undefined as never)).toBe("ask");
    expect(machine.warmed).toEqual([[4242], [5151]]);
  });

  it("reads nothing where no process tool's line has program places, or the call names no pid", async () => {
    const machine = slowMachine();
    const plain = compilePolicy({}, { permissionSet: setOf({ stop_process: "ask", "stop_process --scope=session": "allow", shell: "allow" }), ...machine, workspaceRoot: ROOT });
    await plain.scopeOf!.prepare!({ name: "stop_process" }, { pid: 4242 } as FunctionInputs, undefined as never);
    await plain.scopeOf!.prepare!({ name: "shell" }, { command: "kill 4242" } as FunctionInputs, undefined as never);
    const placed = compilePolicy({}, { permissionSet: setOf({ "list_processes --scope=all": { node: "allow" }, shell: "allow" }), ...machine, workspaceRoot: ROOT });
    await placed.scopeOf!.prepare!({ name: "list_processes" }, { name: "node" } as FunctionInputs, undefined as never);
    await placed.scopeOf!.prepare!({ name: "shell" }, { command: "ps aux" } as FunctionInputs, undefined as never);
    expect(machine.warmed).toEqual([]);
    // A state's own lowered block is read for its places as the narrowing reads it.
    const block = lowerPermissionSet(setOf({ read_process: { node: "allow", "**": "ask" } }), "$/permission-sets/x/y").permissions!;
    await placed.scopeOf!.prepare!({ name: "read_process" }, { pid: 5151 } as FunctionInputs, block as never);
    expect(machine.warmed).toEqual([[5151]]);
  });

  it("names the pids of the process commands of a line, in its language, and of a pid-naming tool", () => {
    expect(pidsNamedBy("shell", { command: "npm test && kill -9 4242 5151" }, "posix")).toEqual([4242, 5151]);
    expect(pidsNamedBy("shell", { command: "Stop-Process -Id 4242" }, "powershell")).toEqual([4242]);
    expect(pidsNamedBy("shell", { command: "echo 4242" }, "posix")).toEqual([]);
    expect(pidsNamedBy("shell", { command: "kill 4242" }, "posix", false)).toEqual([]);
    expect(pidsNamedBy("wait_process", { pid: 4242, until: "exit" }, "posix")).toEqual([4242]);
    expect(pidsNamedBy("list_processes", { name: "node" }, "posix")).toEqual([]);
  });
});

describe("the machine names a running process", () => {
  // The machine is asked for real; on a loaded one `tasklist` can run past its time, which names nothing.
  it("names this test's own process once read, and nothing for a pid no process has", { retry: 2 }, async () => {
    await warmProgramsOfPids([process.pid, 2_147_483_000]);
    expect(programOfPidOnMachine(process.pid)).toBe("node");
    expect(programOfPidOnMachine(0)).toBeUndefined();
    expect(programOfPidOnMachine(2_147_483_000)).toBeUndefined();
  });
});
