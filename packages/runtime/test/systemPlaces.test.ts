/**
 * Every System tool judged by the RESOURCES it touches (decision 0023 §3.1, amended 2026-11-23): each
 * resource's places of every kind — a part of the machine, a program, a service, a package, whose it is,
 * the machine, what is done to it — answered by the strictest of them. A shell command that IS such a
 * tool is read for the same places; what it does not name is a place nobody could read, which takes the
 * strictest answer of its kind. A tool that lists is filtered to the rows its set allows, and asks the
 * person once about the rows the set asks about.
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs, JsonValue } from "@declarative-ai/exec";
import type { ToolGate } from "@declarative-ai/permissions";
import { lowerPermissionSet, parsePermissionSet, type CommandDialect, type MachineFacts, type PermissionSetDecl } from "@jaira/shared";
import { shellPermissionSetOf } from "../src/commandParts";
import type { MachineFactsSource } from "../src/machineFacts";
import { commandDecisionOf, compilePolicy, decideCommand } from "../src/policy";
import { createSystemTools } from "../src/systemTools";
import type { ProcessRow, SystemBackend } from "../src/system/types";

const ROOT = "/work";
/** The desk, as these tests see it: VS Code's window (77, the user's) has the keyboard; KeePass's (88) is on the screen too. */
const FACTS: MachineFacts = {
  machine: () => "desk",
  window: (id) => ({ 77: { program: "code", owner: ["user"] }, 88: { program: "keepass", owner: ["user"] }, 99: { program: "jaira", owner: ["jaira"] } })[id],
  focused: () => 77,
  onScreen: () => [77, 88],
};
const MACHINE: MachineFactsSource = { facts: FACTS, read: async () => undefined };
const setOf = (decl: PermissionSetDecl) => parsePermissionSet(decl).permissionSet;
const block = (decl: PermissionSetDecl) => lowerPermissionSet(setOf(decl), "$/permission-sets/x/y").permissions!;
const policy = compilePolicy({}, { workspaceRoot: ROOT, machine: MACHINE });
const judge = (decl: PermissionSetDecl, tool: string, input: Record<string, unknown>) => policy.scopeOf!({ name: tool }, input as FunctionInputs, block(decl) as never);
const decide = (decl: PermissionSetDecl, line: string, dialect: CommandDialect = "posix") =>
  decideCommand({}, line, dialect, { permissionSet: shellPermissionSetOf(setOf(decl))!, root: ROOT, places: { root: ROOT, facts: FACTS } });

describe("a direct call, by every kind of place its resource has", () => {
  it("read_system: what it reads, and on which machine", () => {
    const decl = { read_system: { summary: "allow", hardware: "allow", logs: "ask", "logs/Security": "deny", machine: { desk: "allow", "**": "deny" }, "**": "ask" } };
    expect(judge(decl, "read_system", {})).toBe("allow");
    expect(judge(decl, "read_system", { about: "users" })).toBe("ask");
    expect(judge(decl, "read_system", { about: "logs", log: "Security" })).toBe("deny");
    expect(judge({ read_system: { machine: { laptop: "allow", "**": "deny" } } }, "read_system", { about: "hardware" })).toBe("deny");
  });

  it("read_settings and write_settings: the area, whose it is, and what is done", () => {
    const decl = { write_settings: { area: { "registry/HKCU/Software/MyApp": "allow", "**": "ask" }, owner: { system: "deny", "**": "allow" }, action: { delete: "ask", "**": "allow" } } };
    expect(judge(decl, "write_settings", { area: "registry", key: "HKEY_CURRENT_USER\\Software\\MyApp", name: "x", value: "1" })).toBe("allow");
    expect(judge(decl, "write_settings", { area: "registry", key: "HKCU:\\Software\\MyApp\\Sub", name: "x", value: "1" })).toBe("allow");
    // HKLM is the machine's: an owner rule refuses it whatever the area says.
    expect(judge(decl, "write_settings", { area: "registry", key: "HKLM\\Software\\MyApp", name: "x", value: "1" })).toBe("deny");
    expect(judge(decl, "write_settings", { area: "registry", key: "HKCU\\Software\\MyApp", name: "x", delete: true })).toBe("ask");
    expect(judge(decl, "write_settings", { area: "environment", name: "PATH", value: "x", scope: "machine" })).toBe("deny");
    // Reading every variable reads the one the set refuses.
    const read = { read_settings: { "environment/PATH": "allow", "environment/API_TOKEN": "deny", "**": "ask" } };
    expect(judge(read, "read_settings", { area: "environment", name: "PATH" })).toBe("allow");
    expect(judge(read, "read_settings", { area: "environment" })).toBe("deny");
  });

  it("control_service and install_program: the service or package, and what is done to it", () => {
    const services = { control_service: { spooler: "allow", action: { stop: "ask", "**": "allow" }, "**": "deny" } };
    expect(judge(services, "control_service", { name: "spooler", action: "restart" })).toBe("allow");
    expect(judge(services, "control_service", { name: "spooler", action: "stop" })).toBe("ask");
    expect(judge(services, "control_service", { name: "wuauserv", action: "restart" })).toBe("deny");
    const software = { install_program: { "Git.Git": "allow", action: { uninstall: "deny", "**": "allow" }, manager: { winget: "allow", "**": "ask" }, "**": "ask" } };
    expect(judge(software, "install_program", { action: "install", id: "Git.Git", manager: "winget" })).toBe("allow");
    expect(judge(software, "install_program", { action: "uninstall", id: "Git.Git", manager: "winget" })).toBe("deny");
    // The manager left out is the default one, which nobody names: the strictest of the managers answers.
    expect(judge(software, "install_program", { action: "install", id: "Git.Git" })).toBe("ask");
  });

  it("power: what it does, on which machine", () => {
    const decl = { power: { lock: "allow", restart: "ask", "**": "deny" } };
    expect(judge(decl, "power", { action: "lock" })).toBe("allow");
    expect(judge(decl, "power", { action: "restart" })).toBe("ask");
    expect(judge(decl, "power", { action: "shut_down" })).toBe("deny");
  });

  it("screenshot: the window's program and owner; a whole display, every window on it", () => {
    const decl = { screenshot: { code: "allow", keepass: "deny", owner: { jaira: "deny", "**": "allow" }, "**": "ask" } };
    expect(judge(decl, "screenshot", { window_id: 77 })).toBe("allow");
    expect(judge(decl, "screenshot", { window_id: 88 })).toBe("deny");
    expect(judge(decl, "screenshot", { window_id: 99 })).toBe("deny");
    // KeePass is on the screen, so a picture of it all is refused.
    expect(judge(decl, "screenshot", {})).toBe("deny");
    expect(judge({ screenshot: { code: "allow", "**": "ask" } }, "screenshot", { display: 0 })).toBe("ask");
  });

  it("control_input: keys at the window that has the keyboard, a pointer at every window it could reach", () => {
    const decl = { control_input: { code: "allow", "**": "ask" } };
    expect(judge(decl, "control_input", { steps: [{ action: "type", text: "hi" }, { action: "key", keys: "ctrl+s" }] })).toBe("allow");
    expect(judge(decl, "control_input", { steps: [{ action: "left_click", x: 1, y: 1 }] })).toBe("ask");
    expect(judge({ control_input: { action: { pointer: "deny", "**": "allow" } } }, "control_input", { steps: [{ action: "scroll", direction: "down" }] })).toBe("deny");
  });

  it("open_app: the app, the window, the file or link, what it does", () => {
    const decl = { open_app: { notepad: "allow", code: "allow", action: { close: "ask", "**": "allow" }, path: { $PROJECT: "allow", "**": "deny" }, "**": "ask" } };
    expect(judge(decl, "open_app", { action: "launch", app: "notepad" })).toBe("allow");
    expect(judge(decl, "open_app", { action: "focus", window_id: 77 })).toBe("allow");
    expect(judge(decl, "open_app", { action: "close", window_id: 77 })).toBe("ask");
    expect(judge(decl, "open_app", { action: "open", target: "/etc/passwd", app: "notepad" })).toBe("deny");
  });

  it("write_clipboard: the files it puts there, and nothing for text", () => {
    const decl = { write_clipboard: { $PROJECT: "allow", "~/.ssh": "deny", "**": "ask" } };
    expect(judge(decl, "write_clipboard", { text: "hello" })).toBe("ask");
    expect(judge(decl, "write_clipboard", { image_path: "/work/shot.png" })).toBe("allow");
  });
});

describe("a shell command that is a System tool, read for the same places", () => {
  it("services: the unit, what is done", () => {
    const decl = { control_service: { nginx: "allow", action: { stop: "deny", "**": "allow" }, "**": "ask" }, list_services: { nginx: "allow", "**": "ask" }, shell: "allow" };
    expect(decide(decl, "systemctl restart nginx.service").action).toBe("allow");
    expect(decide(decl, "systemctl stop nginx").action).toBe("deny");
    expect(decide(decl, "sudo service nginx reload").action).toBe("allow");
    expect(decide(decl, "systemctl restart postgres").action).toBe("require_approval");
    expect(decide(decl, "sc stop nginx", "cmd").action).toBe("deny");
    expect(decide(decl, "net start nginx", "cmd").action).toBe("allow");
    expect(decide(decl, "Restart-Service -Name nginx", "powershell").action).toBe("allow");
    expect(decide(decl, "Stop-Service nginx", "powershell").action).toBe("deny");
    expect(decide(decl, "systemctl status nginx").action).toBe("allow");
    // Every service: nothing filters a shell's output.
    expect(decide(decl, "systemctl list-units").action).toBe("require_approval");
  });

  it("software: the package, what is done, the manager", () => {
    const decl = { install_program: { "Git.Git": "allow", jq: "allow", action: { uninstall: "deny", "**": "allow" }, manager: { winget: "allow", brew: "allow", "**": "ask" }, "**": "ask" }, shell: "allow" };
    expect(decide(decl, "winget install --id Git.Git -e", "powershell").action).toBe("allow");
    expect(decide(decl, "winget uninstall Git.Git", "powershell").action).toBe("deny");
    expect(decide(decl, "brew install jq").action).toBe("allow");
    expect(decide(decl, "brew install wget").action).toBe("require_approval");
    expect(decide(decl, "apt-get install -y jq").action).toBe("require_approval");
    // Upgrading everything names no package.
    expect(decide(decl, "brew upgrade").action).toBe("require_approval");
  });

  it("settings: the key and the name, whose it is, what is done", () => {
    const decl = { write_settings: { area: { "registry/HKCU/Software/MyApp": "allow", "environment/MY_FLAG": "allow", "**": "ask" }, owner: { system: "deny", "**": "allow" }, action: { delete: "ask", "**": "allow" } }, shell: "allow" };
    expect(decide(decl, 'reg add "HKCU\\Software\\MyApp" /v Mode /d 1 /f', "cmd").action).toBe("allow");
    expect(decide(decl, 'reg add "HKLM\\Software\\MyApp" /v Mode /d 1 /f', "cmd").action).toBe("deny");
    expect(decide(decl, 'reg delete "HKCU\\Software\\MyApp" /v Mode /f', "cmd").action).toBe("require_approval");
    expect(decide(decl, "setx MY_FLAG 1", "cmd").action).toBe("allow");
    expect(decide(decl, "setx MY_FLAG 1 /M", "cmd").action).toBe("deny");
    expect(decide(decl, "Set-ItemProperty -Path HKCU:\\Software\\MyApp -Name Mode -Value 1", "powershell").action).toBe("allow");
    expect(decide({ write_settings: { "defaults/com.apple.dock": "allow", "**": "deny" }, shell: "allow" }, "defaults write com.apple.dock autohide -bool true").action).toBe("allow");
  });

  it("power: what it does", () => {
    const decl = { power: { lock: "allow", restart: "deny", "**": "ask" }, shell: "allow" };
    expect(decide(decl, "shutdown -r now").action).toBe("deny");
    expect(decide(decl, "shutdown /r /t 0", "cmd").action).toBe("deny");
    expect(decide(decl, "Restart-Computer", "powershell").action).toBe("deny");
    expect(decide(decl, "loginctl lock-session").action).toBe("allow");
    expect(decide(decl, "shutdown now").action).toBe("require_approval");
  });

  it("openers: the file or the link, as open_app's", () => {
    const decl = { open_app: { path: { $PROJECT: "allow", "**": "deny" }, site: { "github.com": "allow", "**": "ask" }, "**": "allow" }, shell: "allow" };
    expect(decide(decl, "xdg-open /work/report.html").action).toBe("allow");
    expect(decide(decl, "xdg-open /tmp/report.html").action).toBe("deny");
    expect(decide(decl, "open https://github.com/anthropics").action).toBe("allow");
  });
});

describe("a list, filtered to what its set allows", () => {
  const ROWS: ProcessRow[] = [
    { pid: 100, name: "node" },
    { pid: 200, name: "python" },
    { pid: 300, name: "keepass" },
  ];
  const backend = {
    os: "windows",
    processes: async () => ROWS,
    services: async () => [
      { name: "Spooler", status: "running" as const },
      { name: "wuauserv", status: "stopped" as const },
      { name: "WinDefend", status: "running" as const },
    ],
    windows: async () => [
      { window_id: 7, title: "a.ts", app: "Code", pid: 100, focused: true, minimized: false, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { window_id: 8, title: "vault", app: "KeePass", pid: 300, focused: false, minimized: false, bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ],
  } as unknown as SystemBackend;
  const tools = createSystemTools({ backend, enginePid: 1 });
  /** A gate that puts each call to the policy, as the engine's does, answers `allow` or not, and remembers what it was asked. */
  const gate = (allow: boolean, compiled: ReturnType<typeof compilePolicy>): ToolGate & { asked: string[] } => {
    const asked: string[] = [];
    return {
      profile: "default",
      modeOf: () => "ask",
      check: async (tool: { name: string }, input: FunctionInputs) => {
        compiled.scopeOf!(tool, input, undefined as never);
        asked.push(commandDecisionOf(input)?.reason ?? "");
        return allow ? { allow: true } : { allow: false, reason: "no" };
      },
      asked,
    } as unknown as ToolGate & { asked: string[] };
  };
  const run = async (tool: string, input: Record<string, unknown>, decl: PermissionSetDecl, answer = true) => {
    const compiled = compilePolicy({}, { workspaceRoot: ROOT, machine: MACHINE, permissionSet: setOf(decl) });
    const g = gate(answer, compiled);
    const out = (await tools[tool]!.run(input as never, { policy: compiled, gate: g, session: { id: "s" } } as never)) as Record<string, JsonValue>;
    return { out, asked: g.asked };
  };

  it("leaves out what the set refuses, and says how many", async () => {
    const { out, asked } = await run("list_services", {}, { list_services: { "**": "allow", windefend: "deny" } });
    expect((out["services"] as Array<{ name: string }>).map((s) => s.name)).toEqual(["Spooler", "wuauserv"]);
    expect(out["left_out"]).toBe(1);
    expect(asked).toEqual([]);
  });

  it("asks once about what the set asks about, and shows it on a yes", async () => {
    const { out, asked } = await run("list_processes", { scope: "all" }, { list_processes: { node: "allow", "**": "ask" } });
    expect((out["processes"] as Array<{ name: string }>).map((p) => p.name).sort()).toEqual(["keepass", "node", "python"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/the permission set asks about 2 more processes: python \(.+\), keepass|keepass \(.+\), python/);
    const refused = await run("list_processes", { scope: "all" }, { list_processes: { node: "allow", "**": "ask" } }, false);
    expect((refused.out["processes"] as Array<{ name: string }>).map((p) => p.name)).toEqual(["node"]);
    expect(refused.out["left_out"]).toBe(2);
  });

  it("filters windows by their process's program", async () => {
    const { out } = await run("list_windows", {}, { list_windows: { keepass: "deny", "**": "allow" } });
    expect((out["windows"] as Array<{ app: string }>).map((w) => w.app)).toEqual(["Code"]);
  });

  it("shows every row where the line decides by no place", async () => {
    const { out, asked } = await run("list_services", {}, { list_services: "allow" });
    expect((out["services"] as unknown[]).length).toBe(3);
    expect(out["left_out"]).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
