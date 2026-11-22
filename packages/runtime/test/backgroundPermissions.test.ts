/**
 * Decision 0032's permissions: a tool's line refined by its arguments (ruling 1a), a line started to keep
 * running judged by `shell --run_in_background` (ruling 1) — Claude's own `Bash` by the same line (the
 * person's ruling 6) — the escapes refused (ruling 7), and what a foreground call left running judged as
 * a background start (ruling 5).
 */
import { describe, expect, it } from "vitest";
import { lowerPermissionSet, parsePermissionSet, type PermissionSetDecl } from "@jaira/shared";
import { shellPermissionSetOf } from "../src/commandParts";
import { CommandGrants, ESCAPE_REASON, allowsCall, commandDecisionOf, compilePolicy, decideCommand, decideLeftRunning, flagLineAnswer, leftRunningVerdict } from "../src/policy";

const setOf = (decl: PermissionSetDecl) => parsePermissionSet(decl).permissionSet;
const shellOf = (decl: PermissionSetDecl) => shellPermissionSetOf(setOf(decl))!;

describe("a direct call is judged by the flag line its arguments match (ruling 1a)", () => {
  const PROCESSES = setOf({
    list_processes: "allow",
    "list_processes --scope=user": "ask",
    stop_process: "ask",
    "stop_process --scope=session": "allow",
    "stop_process --scope=group": "allow",
    "stop_process --scope=group --group=docker": "deny",
    read_process: "deny",
    "read_process --scope=all": "allow",
    other: "deny",
  });

  it("the flag line beats the bare line where it matches, and the bare line covers the rest", () => {
    expect(flagLineAnswer("list_processes", { scope: "user" }, PROCESSES)).toEqual({ mode: "ask", subject: "list_processes --scope=user" });
    // No session line: the bare line covers it — a left-out scope is the default, session.
    expect(flagLineAnswer("list_processes", { scope: "session" }, PROCESSES)).toEqual({ mode: "allow", subject: "list_processes" });
    expect(flagLineAnswer("list_processes", {}, PROCESSES)).toEqual({ mode: "allow", subject: "list_processes" });
    expect(flagLineAnswer("stop_process", { pid: 4 }, PROCESSES)).toEqual({ mode: "allow", subject: "stop_process --scope=session" });
    expect(flagLineAnswer("stop_process", { pid: 4, scope: "system" }, PROCESSES)).toEqual({ mode: "ask", subject: "stop_process" });
  });

  it("the line naming the most flags decides", () => {
    expect(flagLineAnswer("stop_process", { pid: 4, scope: "group", group: "docker" }, PROCESSES)).toEqual({ mode: "deny", subject: "stop_process --scope=group --group=docker" });
    expect(flagLineAnswer("stop_process", { pid: 4, scope: "group", group: "staff" }, PROCESSES)).toEqual({ mode: "allow", subject: "stop_process --scope=group" });
  });

  it("between equally specific lines, the strictest wins", () => {
    const set = setOf({ stop_process: "allow", "stop_process --scope=group": "allow", "stop_process --group=docker": "ask" });
    expect(flagLineAnswer("stop_process", { scope: "group", group: "docker" }, set)).toEqual({ mode: "ask", subject: "stop_process --group=docker" });
  });

  it("a flag line with places and no `**` passes a call none of them matches to the next line", () => {
    // A `stop_process` call names a pid, no program: no place of the line matches it.
    const set = setOf({ stop_process: "ask", "stop_process --scope=user": { node: "allow" } });
    expect(flagLineAnswer("stop_process", { scope: "user", pid: 4 }, set)).toEqual({ mode: "ask", subject: "stop_process" });
  });

  it("is what the compiled policy narrows a call to — from the turn's set and from a state's lowered block", () => {
    for (const [policy, block] of [
      [compilePolicy({}, { permissionSet: PROCESSES }), undefined],
      [compilePolicy({}), lowerPermissionSet(PROCESSES).permissions],
    ] as const) {
      const ask = { scope: "user" };
      expect(policy.scopeOf!({ name: "list_processes" }, ask as never, block as never)).toBe("ask");
      // The person is asked about the flag line, and may keep the answer there.
      expect(commandDecisionOf(ask)?.parts.parts[0]?.widths).toEqual(["list_processes --scope=user", "list_processes"]);
      expect(policy.scopeOf!({ name: "list_processes" }, {} as never, block as never)).toBeUndefined();
      expect(policy.scopeOf!({ name: "stop_process" }, { scope: "group", group: "docker" } as never, block as never)).toBe("deny");
      // The gate is handed the loosest, so a call a flag line allows is never asked about first.
      expect(policy.baseline?.tools?.["read_process"] ?? lowerPermissionSet(PROCESSES).permissions?.tools?.["read_process"]).toBe("allow");
    }
  });

  it("an answer kept for this run at the flag line settles the next call it matches", () => {
    const grants = new CommandGrants();
    grants.remember("list_processes --scope=user", "allow");
    const policy = compilePolicy({}, { permissionSet: PROCESSES, grants });
    expect(policy.scopeOf!({ name: "list_processes" }, { scope: "user" } as never, undefined as never)).toBeUndefined();
    expect(policy.scopeOf!({ name: "list_processes" }, { scope: "all" } as never, undefined as never)).toBeUndefined();
  });

  it("is what allowsCall judges a direct call by", () => {
    expect(allowsCall({}, PROCESSES, "list_processes", { scope: "user" }, "posix")).toBe(false);
    expect(allowsCall({}, PROCESSES, "list_processes", {}, "posix")).toBe(true);
    expect(allowsCall({}, PROCESSES, "stop_process", {}, "posix")).toBe(true);
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
});
