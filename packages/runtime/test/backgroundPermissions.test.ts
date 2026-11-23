/**
 * Decision 0032's permissions: a tool's line refined by its arguments (ruling 1a), a line started to keep
 * running judged by `shell --run_in_background` (ruling 1) — Claude's own `Bash` by the same line (the
 * person's ruling 6) — the escapes refused (ruling 7), and what a foreground call left running judged as
 * a background start (ruling 5).
 */
import { describe, expect, it } from "vitest";
import { lowerPermissionSet, parsePermissionSet, type PermissionSetDecl } from "@jaira/shared";
import { shellPermissionSetOf } from "../src/commandParts";
import { CommandGrants, ESCAPE_REASON, allowsCall, commandDecisionOf, compilePolicy, decideCommand, decideLeftRunning, leftRunningVerdict } from "../src/policy";

const setOf = (decl: PermissionSetDecl) => parsePermissionSet(decl).permissionSet;
const shellOf = (decl: PermissionSetDecl) => shellPermissionSetOf(setOf(decl))!;

describe("what a session started is judged by whose the process is, not by what the agent asked (ruling 4, amended 2026-11-23)", () => {
  // An old set's `--scope=` lines, read as OWNER rules (decision 0023 §3.1).
  const PROCESSES = setOf({
    list_processes: "allow",
    "list_processes --scope=user": "ask",
    stop_process: "ask",
    "stop_process --scope=session": "allow",
    read_process: "deny",
    "read_process --scope=all": "allow",
    other: "deny",
  });
  /** The machine: 4 is this session's, 5 the user's. */
  const machine = { facts: { machine: () => "desk", process: (pid: number) => ({ 4: { program: "node", owner: ["session"] }, 5: { program: "python", owner: ["user"] } })[pid] }, read: async () => undefined };

  it("reads the old lines as owner rules on their tools' lines", () => {
    expect(PROCESSES.entries["stop_process"]).toEqual({ kind: "tool", mode: "ask", places: { "owner=session": "allow" } });
    expect(PROCESSES.entries["list_processes"]).toEqual({ kind: "tool", mode: "allow", places: { "owner=user": "ask" } });
    expect(PROCESSES.entries["read_process"]).toEqual({ kind: "tool", mode: "deny", places: { "owner=**": "allow" } });
  });

  it("judges a direct call by whose the process is, whatever scope it asked for", () => {
    for (const [policy, block] of [
      [compilePolicy({}, { permissionSet: PROCESSES, machine }), undefined],
      [compilePolicy({}, { machine }), lowerPermissionSet(PROCESSES).permissions],
    ] as const) {
      expect(policy.scopeOf!({ name: "stop_process" }, { pid: 4 } as never, block as never)).toBe("allow");
      expect(policy.scopeOf!({ name: "stop_process" }, { pid: 4, scope: "user" } as never, block as never)).toBe("allow");
      const theirs = { pid: 5, scope: "session" };
      expect(policy.scopeOf!({ name: "stop_process" }, theirs as never, block as never)).toBe("ask");
      expect(commandDecisionOf(theirs)?.parts.parts[0]?.decidedBy).toMatchObject({ entry: "stop_process" });
      expect(policy.scopeOf!({ name: "read_process" }, { pid: 5 } as never, block as never)).toBe("allow");
    }
  });

  it("is what allowsCall judges a direct call by", () => {
    expect(allowsCall({}, PROCESSES, "stop_process", { pid: 4 }, "posix")).toBe(false);
    // It reads no machine: whose a recorded pid was is nobody's to say, so an owner rule takes its strictest.
    expect(allowsCall({}, PROCESSES, "read_process", { pid: 4 }, "posix")).toBe(false);
    // A list is filtered as it runs; recorded, the line's own mode answers it.
    expect(allowsCall({}, PROCESSES, "list_processes", {}, "posix")).toBe(true);
  });
});

describe("a line started to keep running (ruling 1)", () => {
  const SET = shellOf({
    shell: "allow",
    "shell --run_in_background": "ask",
    "shell --run_in_background npm": "deny",
    "shell --run_in_background npm run dev": "allow",
  });
  const decide = (line: string, background = true) => decideCommand({}, line, "posix", { permissionSet: SET, ...(background ? { background } : {}) });

  it("is judged by the most specific background line naming what it runs", () => {
    expect(decide("npm run dev").action).toBe("allow");
    expect(decide("npm test").action).toBe("deny");
    expect(decide("node server.js").action).toBe("require_approval");
    // In the foreground, the background lines say nothing.
    expect(decide("node server.js", false).action).toBe("allow");
  });

  it("is one part more, the whole line, with the background lines as its widths", () => {
    const parts = decide("node server.js").parts.parts;
    const kept = parts.at(-1)!;
    expect(kept).toMatchObject({ text: "node server.js", verdict: "asks", decidedBy: { source: "permissionSet", entry: "shell --run_in_background" } });
    expect(kept.widths).toEqual(["shell --run_in_background node server.js", "shell --run_in_background node", "shell --run_in_background"]);
    expect(decide("npm run dev").parts.parts.at(-1)!.widths).toEqual(["shell --run_in_background npm run dev", "shell --run_in_background npm run", "shell --run_in_background npm", "shell --run_in_background"]);
  });

  it("must run AND keep running: the strictest part wins", () => {
    const set = shellOf({ shell: "allow", "git push": "deny", "shell --run_in_background": "allow" });
    expect(decideCommand({}, "git push", "posix", { permissionSet: set, background: true }).action).toBe("deny");
    expect(decideCommand({}, "npm run build && npm run dev", "posix", { permissionSet: SET, background: true }).action).toBe("deny");
  });

  it("asks where the set has no background line at all, and where no set judges it", () => {
    expect(decideCommand({}, "npm run dev", "posix", { permissionSet: shellOf({ shell: "allow", other: "allow" }), background: true }).action).toBe("require_approval");
    expect(decideCommand({}, "npm run dev", "posix", { background: true }).action).toBe("require_approval");
  });

  it("is settled by an answer kept at one of its widths", () => {
    const grants = new CommandGrants();
    grants.remember("shell --run_in_background node", "allow");
    expect(decideCommand({}, "node server.js", "posix", { permissionSet: SET, background: true, grants }).action).toBe("allow");
  });

  it("is read off the call: our shell's run_in_background, and Claude's own Bash with it", () => {
    const block = lowerPermissionSet(setOf({ shell: "allow", "shell --run_in_background": "deny", "shell --run_in_background npm run dev": "allow" }), "inline").permissions;
    const policy = compilePolicy({});
    expect(policy.scopeOf!({ name: "shell" }, { command: "node server.js", run_in_background: true } as never, block as never)).toBe("deny");
    expect(policy.scopeOf!({ name: "shell" }, { command: "node server.js" } as never, block as never)).toBeUndefined();
    expect(policy.scopeOf!({ name: "shell" }, { command: "npm run dev", run_in_background: true } as never, block as never)).toBeUndefined();
    // Claude's `Bash` is asked about as `shell`, its input as the agent wrote it.
    expect(policy.scopeOf!({ name: "Bash" }, { command: "node server.js", run_in_background: true, description: "serve" } as never, block as never)).toBe("deny");
    expect(allowsCall({}, setOf({ shell: "allow", "shell --run_in_background": "deny" }), "Bash", { command: "node x.js", run_in_background: true }, "posix")).toBe(false);
    expect(allowsCall({}, setOf({ shell: "allow", "shell --run_in_background": "deny" }), "Bash", { command: "node x.js" }, "posix")).toBe(true);
  });
});

describe("the escapes are refused (ruling 7)", () => {
  const OPEN = shellOf({ shell: "allow", "shell --run_in_background": "allow" });
  it.each([
    ["Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='npx one dev'}", "powershell"],
    ["Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList notepad", "powershell"],
    ["Get-CimClass Win32_Process | Invoke-CimMethod -MethodName Create -Arguments @{CommandLine='x'}", "powershell"],
    ['wmic process call create "cmd /c x"', "cmd"],
    ["schtasks /create /tn x /tr y /sc once", "cmd"],
    ["Register-ScheduledTask -TaskName x -Action $a", "powershell"],
    ["at 10:00 cmd", "posix"],
    ["crontab mycron", "posix"],
    ["crontab -e", "posix"],
    ["setsid npm run dev", "posix"],
    ["npm run dev & disown", "posix"],
    ["launchctl submit -l x -- /bin/x", "posix"],
    ["systemd-run --user npm start", "posix"],
  ] as const)("%s", (line, dialect) => {
    const decision = decideCommand({}, line, dialect, { permissionSet: OPEN });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe(ESCAPE_REASON);
    // The built-ins switch does not lift it: it is about what JaiRA can track, not a workspace's floor.
    expect(decideCommand({ builtins: false }, line, dialect, { permissionSet: OPEN }).action).toBe("deny");
  });

  it.each([["crontab -l"], ["crontab -r"], ["at -l"], ["Invoke-CimMethod -ClassName Win32_Share -MethodName Create"], ["launchctl list"]])("lets %s be", (line) => {
    expect(decideCommand({}, line, line.startsWith("Invoke") ? "powershell" : "posix", { permissionSet: OPEN }).reason).not.toBe(ESCAPE_REASON);
  });

  it("is lifted only by a background line NAMING the program, which then answers for it", () => {
    const named = shellOf({ shell: "allow", "shell --run_in_background": "allow", "shell --run_in_background schtasks": "ask" });
    const decision = decideCommand({}, "schtasks /create /tn x /tr y", "cmd", { permissionSet: named });
    expect(decision.action).toBe("require_approval");
    expect(decision.parts.parts[0]?.decidedBy).toMatchObject({ source: "permissionSet", entry: "shell --run_in_background schtasks" });
    expect(decideCommand({}, "systemd-run --user npm start", "posix", { permissionSet: shellOf({ shell: "allow", "shell --run_in_background systemd-run": "allow" }) }).action).toBe("allow");
    // The bare background line does not lift it.
    expect(decideCommand({}, "schtasks /create /tn x /tr y", "cmd", { permissionSet: OPEN }).action).toBe("deny");
  });
});

describe("what a foreground call left running (ruling 5)", () => {
  const SET = shellOf({ shell: "allow", "shell --run_in_background": "ask", "shell --run_in_background npm run dev": "allow", "shell --run_in_background esbuild": "deny" });

  it("is judged by a line naming the program, else by the line the call ran, as if started in the background", () => {
    expect(leftRunningVerdict(SET, { command: "npm run dev", programs: ["node"] })).toBe("allow");
    expect(leftRunningVerdict(SET, { command: "npm run dev", programs: ["node", "esbuild"] })).toBe("deny");
    expect(leftRunningVerdict(SET, { command: "python serve.py", programs: ["python"] })).toBe("ask");
    expect(leftRunningVerdict(undefined, { command: "npm run dev", programs: ["node"] })).toBe("ask");
    expect(leftRunningVerdict(shellOf({ shell: "allow" }), { command: "npm run dev", programs: ["node"] })).toBe("ask");
  });

  it("is what the engine asks the call's policy, by the call's own block or the set the policy was compiled for", () => {
    const set = setOf({ shell: "allow", "shell --run_in_background": "deny", "shell --run_in_background npm run dev": "allow" });
    const compiled = compilePolicy({}, { permissionSet: set });
    expect(decideLeftRunning(compiled, undefined, { command: "npm run dev", programs: ["node"] })).toBe("allow");
    expect(decideLeftRunning(compiled, undefined, { command: "node x.js", programs: ["node"] })).toBe("deny");
    // A copy of the policy (an agent's, with its own baseline) is the same judge.
    expect(decideLeftRunning({ ...compiled, baseline: { tools: {} } }, undefined, { command: "node x.js", programs: ["node"] })).toBe("deny");
    // A state's own block, read by a policy compiled with none.
    const block = lowerPermissionSet(setOf({ shell: "allow", "shell --run_in_background": "allow" }), "inline").permissions;
    expect(decideLeftRunning(compilePolicy({}), block, { command: "node x.js", programs: ["node"] })).toBe("allow");
    expect(decideLeftRunning(undefined, block, { command: "node x.js", programs: ["node"] })).toBe("allow");
    expect(decideLeftRunning(undefined, undefined, { command: "node x.js", programs: ["node"] })).toBe("ask");
  });

  it("is judged under the block the gate decides the call under: a conversation's later pick, not the set it opened with", () => {
    // The topodiff chat: opened under a set with no background line, moved to one that allows it. The gate
    // allowed `run_in_background`, and the `Start-Process` server was stopped as `ask`.
    const opened = lowerPermissionSet(setOf({ shell: "allow" }), "inline").permissions;
    const picked = lowerPermissionSet(setOf({ shell: "allow", "shell --run_in_background": "allow" }), "inline").permissions;
    const root = "i-root";
    const policy = { ...compilePolicy({}), permissionsOf: (call: { instanceId: string }, stated: unknown) => (call.instanceId === root ? picked : stated) } as never;
    const left = { command: "Start-Process cmd -ArgumentList '/c','npx one dev --port 8146'", programs: ["cmd"] };
    expect(decideLeftRunning(policy, opened, left, { instanceId: root })).toBe("allow");
    // A state the pick does not govern keeps its own block.
    expect(decideLeftRunning(policy, opened, left, { instanceId: "i-child" })).toBe("ask");
    // Without the call's site there is nothing to ask the host about: the state's block, as before.
    expect(decideLeftRunning(policy, opened, left)).toBe("ask");
  });
});
