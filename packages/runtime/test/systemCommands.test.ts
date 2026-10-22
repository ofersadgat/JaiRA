/**
 * The shell's commands that are System tools (decision 0019 §3): as `cat` is `read_file`, `kill`,
 * `taskkill` and `Stop-Process` are `stop_process` — in every dialect, by subcommand, flag and operand
 * where the program does both — and judged against the shipped sets as the tools are (§5, as ruled).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePermissionSet, takeApart, type CommandDialect } from "@jaira/shared";
import { noteCallDialect } from "../src/callDialect";
import { classifyRequest } from "../src/commandParts";
import { compilePolicy } from "../src/policy";

/** Each request of a line, as `kind:subject`. */
const partsOf = (line: string, dialect: CommandDialect): string[] =>
  takeApart(line, dialect).requests.flatMap((request) => {
    const part = classifyRequest(request, dialect);
    return part === undefined ? [] : [`${part.kind}:${part.subject}`];
  });

describe("a System command is the System tool", () => {
  it.each<[CommandDialect, string, string[]]>([
    ["posix", "ps aux", ["tool:list_processes"]],
    ["posix", "kill -9 123", ["tool:stop_process"]],
    ["posix", "uname -a", ["tool:read_system"]],
    ["posix", "df -h", ["tool:read_system"]],
    ["posix", "shutdown -h now", ["tool:power"]],
    ["posix", "apt list --installed", ["tool:list_software"]],
    ["posix", "apt install jq", ["tool:install_software"]],
    ["posix", "pacman -Ss foo", ["tool:list_software"]],
    ["posix", "pacman -Syu", ["tool:install_software"]],
    ["posix", "dpkg -l", ["tool:list_software"]],
    ["posix", "defaults read com.apple.dock", ["tool:read_settings"]],
    ["posix", "defaults write com.apple.dock autohide 1", ["tool:write_settings"]],
    ["posix", "pbpaste", ["tool:read_clipboard"]],
    ["posix", "echo hi | pbcopy", ["command:echo", "tool:write_clipboard"]],
    ["posix", "xclip -o", ["tool:read_clipboard"]],
    ["posix", "xclip -selection clipboard", ["tool:write_clipboard"]],
    ["posix", "xdotool search --name Firefox", ["tool:list_windows"]],
    ["posix", "xdotool mousemove 10 10", ["tool:control_input"]],
    ["powershell", "Get-Process", ["tool:list_processes"]],
    ["powershell", "kill 123", ["tool:stop_process"]],
    ["powershell", "Restart-Service spooler", ["tool:control_service"]],
    ["powershell", "Restart-Computer", ["tool:power"]],
    ["powershell", "Get-Clipboard", ["tool:read_clipboard"]],
    ["powershell", "winget install jq", ["tool:install_software"]],
    ["powershell", "taskkill /PID 12 /F", ["tool:stop_process"]],
    ["powershell", "sc.exe query", ["tool:list_services"]],
    ["cmd", "tasklist", ["tool:list_processes"]],
    ["cmd", "sc start spooler", ["tool:control_service"]],
    ["cmd", "setx A 1", ["tool:write_settings"]],
    ["cmd", "echo hi | clip", ["command:echo", "tool:write_clipboard"]],
    ["cmd", "shutdown /r /t 0", ["tool:power"]],
  ])("%s: %s", (dialect, line, parts) => {
    expect(partsOf(line, dialect)).toEqual(parts);
  });

  it("is read by its subcommand where the program both looks and changes", () => {
    expect(partsOf("systemctl status nginx", "posix")).toEqual(["tool:list_services"]);
    expect(partsOf("systemctl --user start x", "posix")).toEqual(["tool:control_service"]);
    expect(partsOf("systemctl reboot", "posix")).toEqual(["tool:power"]);
    expect(partsOf("systemctl", "posix")).toEqual(["tool:list_services"]);
    expect(partsOf("brew services start redis", "posix")).toEqual(["tool:control_service"]);
    expect(partsOf("brew list", "posix")).toEqual(["tool:list_software"]);
    expect(partsOf("pmset -g", "posix")).toEqual(["tool:read_settings"]);
    expect(partsOf("pmset sleepnow", "posix")).toEqual(["tool:power"]);
    expect(partsOf("pmset displaysleep 10", "posix")).toEqual(["tool:write_settings"]);
    expect(partsOf("net start", "cmd")).toEqual(["tool:list_services"]);
    expect(partsOf("net start spooler", "cmd")).toEqual(["tool:control_service"]);
    expect(partsOf("reg query HKCU\\Software", "cmd")).toEqual(["tool:read_settings"]);
    expect(partsOf("reg add HKCU\\Software\\X /v a", "cmd")).toEqual(["tool:write_settings"]);
  });

  it("is read by its operand where handing it one changes the machine", () => {
    expect(partsOf("hostname", "posix")).toEqual(["tool:read_system"]);
    expect(partsOf("hostname box", "posix")).toEqual(["tool:write_settings"]);
    expect(partsOf("sysctl kern.ostype", "posix")).toEqual(["tool:read_settings"]);
    expect(partsOf("sysctl kern.maxfiles=1000", "posix")).toEqual(["tool:write_settings"]);
    expect(partsOf("ipconfig /all", "powershell")).toEqual(["tool:read_system"]);
    expect(partsOf("ipconfig /flushdns", "powershell")).toEqual(["tool:write_settings"]);
  });

  it("stays the command it is where the table does not say what it does", () => {
    // A subcommand nobody named, a file a program writes, what cmd's `start` starts.
    expect(partsOf("systemctl frobnicate", "posix")).toEqual(["command:systemctl frobnicate"]);
    expect(partsOf("gio remove a.pdf", "posix")).toEqual(["command:gio remove"]);
    expect(partsOf("screencapture shot.png", "posix")).toEqual(["command:screencapture"]);
    expect(partsOf("reg export HKCU\\X f.reg", "cmd")).toEqual(["command:reg export"]);
    expect(partsOf("net user", "cmd")).toEqual(["command:net user"]);
    expect(partsOf("start notepad", "cmd")).toEqual(["command:start notepad"]);
    // The project's own install is the command it is; a global one is software.
    expect(partsOf("npm install", "posix")).toEqual(["command:npm install"]);
    expect(partsOf("npm install -g tsx", "posix")).toEqual(["tool:install_software"]);
  });

  it("is `open_app` when it opens a file, a folder, a link or an app — and `script` when what it opens would run", () => {
    expect(partsOf("open .", "posix")).toEqual(["tool:open_app"]);
    expect(partsOf("open -a Safari https://example.com", "posix")).toEqual(["tool:open_app"]);
    expect(partsOf("open notes.txt", "posix")).toEqual(["tool:open_app"]);
    expect(partsOf("xdg-open report.pdf", "posix")).toEqual(["tool:open_app"]);
    expect(partsOf("gio open a.pdf", "posix")).toEqual(["tool:open_app"]);
    // A POSIX file with no extension runs in a terminal when it is executable.
    expect(partsOf("open ./run", "posix")).toEqual(["script:script"]);
    expect(partsOf("xdg-open build.sh", "posix")).toEqual(["script:script"]);
    expect(partsOf("open -a Terminal --args ls", "posix")).toEqual(["script:script"]);
    expect(partsOf("Invoke-Item notes.txt", "powershell")).toEqual(["tool:open_app"]);
    expect(partsOf("ii run.bat", "powershell")).toEqual(["script:script"]);
    expect(partsOf("explorer C:\\Users", "cmd")).toEqual(["tool:open_app"]);
  });

  it("reads the registry through a file cmdlet as the machine's settings", () => {
    expect(partsOf("Get-ItemProperty HKCU:\\Software\\X", "powershell")).toEqual(["tool:read_settings"]);
    expect(partsOf("Get-ChildItem Registry::HKEY_CURRENT_USER", "powershell")).toEqual(["tool:read_settings"]);
    expect(partsOf("Set-ItemProperty -Path HKLM:\\Software\\X -Name a -Value 1", "powershell")).toEqual(["tool:write_settings"]);
    expect(partsOf("Remove-Item HKCU:\\Software\\X", "powershell")).toEqual(["tool:write_settings"]);
    expect(partsOf("Get-ItemProperty notes.txt", "powershell")).toEqual(["tool:read_file"]);
  });
});

describe("a System command, judged by the shipped sets", () => {
  const shipped = (name: string) => parsePermissionSet(JSON.parse(readFileSync(new URL(`../../shared/builtin/permission-sets/chat/${name}.json`, import.meta.url), "utf8"))).permissionSet;
  const judge = (name: string) => {
    const smart = compilePolicy({}, { permissionSet: shipped(name) }).smart!["shell"]!;
    return (command: string, dialect: CommandDialect = "posix") => {
      const input = { command };
      noteCallDialect(input, dialect);
      return smart({ tool: "shell", input, sessionId: "s" } as never);
    };
  };

  it("lets read-only look and refuses every change (ruling 2: the clipboard is a read)", () => {
    const readOnly = judge("read-only");
    expect(readOnly("ps aux")).toBe("allow");
    expect(readOnly("pbpaste")).toBe("allow");
    expect(readOnly("Get-Service", "powershell")).toBe("allow");
    expect(readOnly("kill 123")).toBe("deny");
    expect(readOnly("Set-Clipboard hi", "powershell")).toBe("deny");
    expect(readOnly("sc start spooler", "cmd")).toBe("deny");
  });

  it("asks in auto, for a look as for a change (ruling 2: system defaults to ask)", () => {
    const auto = judge("auto");
    expect(auto("ps aux")).toBe("ask");
    expect(auto("uname -a")).toBe("ask");
    expect(auto("Stop-Process -Name x", "powershell")).toBe("ask");
  });

  it("asks before `power` even in full, as before a push", () => {
    const full = judge("full");
    expect(full("Get-Process", "powershell")).toBe("allow");
    expect(full("shutdown -h now")).toBe("ask");
    expect(full("Restart-Computer", "powershell")).toBe("ask");
  });
});
