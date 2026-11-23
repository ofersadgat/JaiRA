/**
 * The process tools' RESOURCES (decision 0023 §3.1, amended 2026-11-22 and 2026-11-23): a process has a
 * program, an owner and a machine, and a line answers it by the strictest of the kinds it decides by.
 * A shell command that lists or stops processes is judged at the same places, read off the command —
 * the programs and pids it names, what it does to them, and, for a command that names no process,
 * every one. A direct call naming a pid answers at what the machine says that process is.
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import { lowerPermissionSet, parseCommand, parsePermissionSet, unknownProgramPlace, type CommandDialect, type MachineFacts, type PermissionSetDecl } from "@jaira/shared";
import { shellPermissionSetOf } from "../src/commandParts";
import { MachineFactsCache, type MachineFactsSource, type MachineReading } from "../src/machineFacts";
import { commandDecisionOf, compilePolicy, decideCommand, pidsNamedBy, readingOf } from "../src/policy";
import { processTargetsOf, stopActionsOf } from "../src/processTargets";
import type { ProcessRow, SystemBackend } from "../src/system/types";

const ROOT = "/work";
/** The machine as these tests see it: 4242 is the session's node, 5151 the user's python, anything else has ended. */
const FACTS: MachineFacts = {
  machine: () => "desk",
  process: (pid) => ({ 4242: { program: "node", owner: ["session"] }, 5151: { program: "python", owner: ["user", "account:ofer"] } })[pid],
};
/** A source that has read everything already, and says what it was asked to read. */
const source = (facts: MachineFacts = FACTS): MachineFactsSource & { asked: MachineReading[] } => {
  const asked: MachineReading[] = [];
  return { facts, asked, read: async (what) => void asked.push(what) };
};
const setOf = (decl: PermissionSetDecl) => parsePermissionSet(decl).permissionSet;
const block = (decl: PermissionSetDecl) => lowerPermissionSet(setOf(decl), "$/permission-sets/x/y").permissions!;
const decide = (decl: PermissionSetDecl, line: string, dialect: CommandDialect = "posix") =>
  decideCommand({ builtins: false }, line, dialect, { permissionSet: shellPermissionSetOf(setOf(decl))!, root: ROOT, places: { root: ROOT, facts: FACTS } });
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
    ["taskkill /F /IM node.exe /PID 5151", "cmd", ["node"], [5151]],
    ['taskkill /FI "PID eq 4242"', "cmd", [], [4242]],
  ] as const)("'%s' (%s) names %j and pids %j", (line, dialect, programs, pids) => {
    expect(targets(line, dialect)).toEqual({ programs, pids });
  });

  it.each([
    ["kill 4242", "posix", ["stop"]],
    ["kill -9 4242", "posix", ["stop", "force"]],
    ["kill -KILL 4242", "posix", ["stop", "force"]],
    ["kill -s KILL 4242", "posix", ["stop", "force"]],
    ["kill -INT 4242", "posix", ["interrupt"]],
    ["pkill -9 node", "posix", ["stop", "force"]],
    ["Stop-Process -Id 4242 -Force", "powershell", ["stop", "force"]],
    ["taskkill /F /T /PID 4242", "cmd", ["stop", "force", "tree"]],
  ] as const)("'%s' (%s) does %j", (line, dialect, actions) => {
    expect(stopActionsOf(parseCommand(line, dialect).commands[0]!, dialect)).toEqual(actions);
  });
});

describe("a shell command that lists processes answers as list_processes' line says", () => {
  const LIST = { list_processes: { owner: { session: "allow", "**": "ask" }, "**": "ask" }, shell: "allow" } as const;

  it("at whose the processes it names are, every one's where it names none", () => {
    expect(decide(LIST, "ps -p 4242").action).toBe("allow");
    expect(decide(LIST, "ps -p 4242").parts.parts[0]!.decidedBy).toMatchObject({ entry: "list_processes", place: "owner=session" });
    expect(decide(LIST, "ps -p 5151").action).toBe("require_approval");
    // A name reaches anyone's; no name reaches every process — and nothing filters a shell's output.
    expect(decide(LIST, "pgrep node").action).toBe("require_approval");
    expect(decide(LIST, "ps aux").action).toBe("require_approval");
    expect(decide({ list_processes: "allow", shell: "allow" }, "ps aux").action).toBe("allow");
  });

  it("at the program it names, and at the machine it runs on, every kind allowing", () => {
    const set = { list_processes: { node: "allow", machine: { desk: "allow", "**": "deny" }, "**": "ask" }, shell: "allow" } as const;
    expect(decide(set, "pgrep node").action).toBe("allow");
    expect(decide(set, "pgrep python").action).toBe("require_approval");
    expect(decide(set, "Get-Process -Name node", "powershell").action).toBe("allow");
    expect(decide(set, 'tasklist /FI "IMAGENAME eq node.exe"', "cmd").action).toBe("allow");
    expect(decide({ list_processes: { machine: { laptop: "allow", "**": "deny" } }, shell: "allow" }, "pgrep node").action).toBe("deny");
  });
});

describe("a shell command that stops processes answers as stop_process' line says", () => {
  const STOP = { stop_process: { node: "allow", python: "deny", "**": "ask" }, shell: "allow" } as const;

  it("at the program each pid it names is", () => {
    expect(decide(STOP, "kill 4242").action).toBe("allow");
    expect(decide(STOP, "kill 4242").parts.parts[0]!.decidedBy).toMatchObject({ entry: "stop_process", place: "node" });
    expect(decide(STOP, "kill 5151").action).toBe("deny");
    expect(decide(STOP, "Stop-Process -Id 4242", "powershell").action).toBe("allow");
    expect(decide(STOP, "taskkill /PID 4242", "cmd").action).toBe("allow");
    // A pid the machine cannot name could be any program: the strictest of the program places answers.
    expect(decide(STOP, "kill 9999").action).toBe("deny");
    expect(decide({ stop_process: { node: "allow", "**": "ask" }, shell: "allow" }, "kill 9999").action).toBe("require_approval");
  });

  it("at the program it names — exactly, never by a pattern that reaches further", () => {
    expect(decide(STOP, "killall node").action).toBe("allow");
    expect(decide(STOP, "pkill -x node").action).toBe("allow");
    expect(decide(STOP, "taskkill /IM node.exe", "cmd").action).toBe("allow");
    expect(decide(STOP, "Stop-Process -Name node", "powershell").action).toBe("allow");
    // `pkill node` stops `nodemon` too, and `-f` reads the whole command line: neither is `node`.
    expect(decide(STOP, "pkill node").action).toBe("require_approval");
    expect(decide(STOP, "pkill -f node").action).toBe("deny");
    expect(decide({ stop_process: { "*node*": "allow", "**": "ask" }, shell: "allow" }, "pkill node").action).toBe("allow");
  });

  it("at whose they are and what it does to them, every kind allowing", () => {
    // A kind with no `**` of its own answers what it does not name by the line's.
    const set = { stop_process: { owner: { session: "allow", "**": "ask" }, action: { force: "deny", "**": "allow" }, "**": "ask" }, shell: "allow" } as const;
    expect(decide(set, "kill 4242").action).toBe("allow");
    expect(decide(set, "kill 5151").action).toBe("require_approval");
    expect(decide(set, "kill -9 4242").action).toBe("deny");
    expect(decide(set, "taskkill /F /PID 4242", "cmd").action).toBe("deny");
  });

  it("reads no pid where the line runs elsewhere than this machine", () => {
    const set = setOf({ stop_process: { node: "allow", "**": "ask" }, shell: "allow" });
    const elsewhere = compilePolicy({}, { permissionSet: set, machine: source(), execEnv: { wsl: "Ubuntu" }, workspaceRoot: ROOT });
    expect(elsewhere.scopeOf!({ name: "shell" }, { command: "kill 4242" } as FunctionInputs, undefined as never)).toBe("ask");
    const here = compilePolicy({}, { permissionSet: set, machine: source(), workspaceRoot: ROOT });
    expect(here.scopeOf!({ name: "shell" }, { command: "kill 4242" } as FunctionInputs, undefined as never)).toBeUndefined();
  });
});

describe("a direct call naming a pid answers at what that process is", () => {
  it.each(["stop_process", "read_process", "wait_process"])("%s, by its program and its owner", (tool) => {
    const policy = compilePolicy({}, { machine: source(), workspaceRoot: ROOT });
    const decl = { [tool]: { node: "allow", python: "deny", "**": "ask" } };
    expect(policy.scopeOf!({ name: tool }, { pid: 4242 } as FunctionInputs, block(decl) as never)).toBe("allow");
    expect(policy.scopeOf!({ name: tool }, { pid: 5151 } as FunctionInputs, block(decl) as never)).toBe("deny");
    const owners = { [tool]: { owner: { session: "allow", user: "ask", "**": "deny" } } };
    expect(policy.scopeOf!({ name: tool }, { pid: 4242 } as FunctionInputs, block(owners) as never)).toBe("allow");
    expect(policy.scopeOf!({ name: tool }, { pid: 5151 } as FunctionInputs, block(owners) as never)).toBe("ask");
    // What the agent asked for is no permission: a call at its own scope is judged by whose the process is.
    expect(policy.scopeOf!({ name: tool }, { pid: 5151, scope: "session" } as FunctionInputs, block(owners) as never)).toBe("ask");
    // A process nobody can name could be anyone's.
    expect(policy.scopeOf!({ name: tool }, { pid: 9999 } as FunctionInputs, block(owners) as never)).toBe("deny");
    expect(policy.scopeOf!({ name: tool }, { pid: 9999 } as FunctionInputs, block({ [tool]: { node: "allow", "**": "ask" } }) as never)).toBe("ask");
  });

  it("asks about a process nobody can name with no narrower answer than anywhere", () => {
    const policy = compilePolicy({}, { machine: source(), workspaceRoot: ROOT });
    const ended = { pid: 9999 };
    expect(policy.scopeOf!({ name: "stop_process" }, ended as FunctionInputs, block({ stop_process: { node: "allow", "**": "ask" } }) as never)).toBe("ask");
    expect(commandDecisionOf(ended)?.parts.parts[0]?.where).toEqual({ kind: "program", at: unknownProgramPlace(9999), widths: [{ width: "anywhere", place: "**" }] });
  });

  it("with `machine: null`, a pid names no program and no owner", () => {
    const policy = compilePolicy({}, { machine: null, workspaceRoot: ROOT });
    expect(policy.scopeOf!({ name: "stop_process" }, { pid: 4242 } as FunctionInputs, block({ stop_process: { node: "allow", "**": "ask" } }) as never)).toBe("ask");
  });
});

describe("reading the machine before the gate asks (ScopeNarrowing.prepare)", () => {
  it("reads what a call names, and only where a line of a tool that reaches the machine has places", async () => {
    const placed = source();
    const policy = compilePolicy({}, { permissionSet: setOf({ stop_process: { owner: { session: "allow" } }, shell: "allow" }), machine: placed, workspaceRoot: ROOT });
    await policy.scopeOf!.prepare!({ name: "stop_process" }, { pid: 4242 } as FunctionInputs, undefined as never);
    await policy.scopeOf!.prepare!({ name: "shell" }, { command: "kill 5151" } as FunctionInputs, undefined as never);
    await policy.scopeOf!.prepare!({ name: "shell" }, { command: "npm test" } as FunctionInputs, undefined as never);
    expect(placed.asked).toEqual([{ pids: [4242] }, { pids: [5151] }]);
    const plain = source();
    const unplaced = compilePolicy({}, { permissionSet: setOf({ stop_process: "ask", shell: "allow" }), machine: plain, workspaceRoot: ROOT });
    await unplaced.scopeOf!.prepare!({ name: "stop_process" }, { pid: 4242 } as FunctionInputs, undefined as never);
    expect(plain.asked).toEqual([]);
  });

  it("names the pids, windows, keys and screen a call reaches", () => {
    expect(pidsNamedBy("shell", { command: "npm test && kill -9 4242 5151" }, "posix")).toEqual([4242, 5151]);
    expect(pidsNamedBy("shell", { command: "kill 4242" }, "posix", false)).toEqual([]);
    expect(pidsNamedBy("stop_process", { pid: "4242" }, "posix")).toEqual([4242]);
    expect(readingOf("wait_process", { pid: 4242 }, "posix")).toEqual({ pids: [4242] });
    expect(readingOf("screenshot", { window_id: 7 }, "posix")).toEqual({ windows: [7] });
    expect(readingOf("screenshot", {}, "posix")).toEqual({ onScreen: true });
    expect(readingOf("control_input", { steps: [{ action: "type", text: "x" }] }, "posix")).toEqual({ focus: true });
    expect(readingOf("control_input", { steps: [{ action: "left_click" }] }, "posix")).toEqual({ onScreen: true });
    expect(readingOf("list_processes", { name: "node" }, "posix")).toBeUndefined();
  });
});

describe("what the machine says, read once and kept a while", () => {
  /** A machine of three processes and two windows, counting its listings. */
  const machine = (): SystemBackend & { listings: number } => {
    const rows: ProcessRow[] = [
      { pid: 100, name: "node" },
      { pid: 200, name: "C:\\Program Files\\Code\\Code.exe" },
      { pid: 300, name: "keepass" },
    ];
    const backend = {
      os: "windows",
      listings: 0,
      processes: async () => {
        backend.listings++;
        return rows;
      },
      windows: async () => [
        { window_id: 7, title: "x", app: "Code", pid: 200, focused: true, minimized: false, bounds: { x: 0, y: 0, width: 1, height: 1 } },
        { window_id: 8, title: "y", app: "KeePass", pid: 300, focused: false, minimized: true, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    };
    return backend as unknown as SystemBackend & { listings: number };
  };

  it("names a process's program and owner, a window's, the keyboard's and the screen's", async () => {
    const backend = machine();
    const cache = new MachineFactsCache({ backend, enginePid: 100, name: "desk" });
    await cache.read({ pids: [200, 999], windows: [7, 8], focus: true, onScreen: true });
    expect(cache.facts.machine?.()).toBe("desk");
    expect(cache.facts.process?.(100)).toMatchObject({ program: "node", owner: ["jaira"] });
    expect(cache.facts.process?.(200)?.program).toBe("code");
    expect(cache.facts.process?.(999)).toEqual({});
    expect(cache.facts.window?.(7)?.program).toBe("code");
    expect(cache.facts.focused?.()).toBe(7);
    expect(cache.facts.onScreen?.()).toEqual([7]);
    // Read again while what was read is fresh: no second listing of the processes.
    await cache.read({ pids: [200] });
    expect(backend.listings).toBe(1);
  });

  it("names nothing it was not asked to read", () => {
    const cache = new MachineFactsCache({ backend: machine(), name: "desk" });
    expect(cache.facts.process?.(200)).toBeUndefined();
    expect(cache.facts.window?.(7)).toBeUndefined();
  });
});
