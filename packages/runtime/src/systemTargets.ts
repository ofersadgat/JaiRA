/**
 * What a shell command that IS a System tool other than the process tools acts on (decision 0023 §3.1,
 * amended 2026-11-23): the service, the package, the setting, what it does and whose it is — the places
 * of every kind its tool's line decides by, read off the command, so `systemctl stop nginx` answers at
 * `control_service`'s places as `control_service { name: "nginx", action: "stop" }` does.
 *
 * What a reader does not read — a subcommand it does not map, a name decided as the line runs, a
 * command that names none (`apt upgrade` upgrades everything) — is a place nobody could read
 * (`unknownProgramPlace`), which takes the strictest answer of its kind. The process commands are
 * `processTargets.ts`'s; the machine every part runs on is added by the policy.
 */
import { programName, unknownProgramPlace, type CommandDialect, type CommandWord, type ParsedCommand, type ResourcePlaces } from "@jaira/shared";
import { walkCmd, walkPosix, walkPowershell } from "./processTargets";

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-" && token !== "--";

/** Words read as values: a word the line decides when it runs is a place nobody could read. */
const valuesOf = (words: readonly CommandWord[]): string[] => words.map((w) => (w.dynamic === true ? unknownProgramPlace(w.value) : w.value));

/** A list, or one place nobody could read where it is empty. */
const orUnread = (values: readonly string[], what: string): string[] => (values.length > 0 ? [...values] : [unknownProgramPlace(what)]);

// --- services -----------------------------------------------------------------------------------------

/** A service as a place names it: `nginx.service` is `nginx`. */
const serviceName = (name: string): string => name.replace(/\.service$/i, "");

/** What a service manager's verb does, as `control_service`'s ACTION. */
const SERVICE_VERBS: Readonly<Record<string, string>> = {
  start: "start",
  stop: "stop",
  kill: "stop",
  restart: "restart",
  reload: "restart",
  "try-restart": "restart",
  "reload-or-restart": "restart",
  "try-reload-or-restart": "restart",
  condrestart: "restart",
  enable: "set_start_type",
  disable: "set_start_type",
  reenable: "set_start_type",
  mask: "set_start_type",
  unmask: "set_start_type",
  preset: "set_start_type",
  config: "set_start_type",
  freeze: "pause",
  thaw: "resume",
  pause: "pause",
  continue: "resume",
  load: "start",
  bootstrap: "start",
  kickstart: "start",
  run: "start",
  unload: "stop",
  bootout: "stop",
  remove: "stop",
};

/** `Start-Service` and its kind, as ACTIONS. */
const SERVICE_CMDLETS: Readonly<Record<string, string>> = {
  "start-service": "start",
  "stop-service": "stop",
  "restart-service": "restart",
  "suspend-service": "pause",
  "resume-service": "resume",
  "set-service": "set_start_type",
};

function serviceResource(tool: string, command: ParsedCommand, dialect: CommandDialect): ResourcePlaces {
  const program = command.program;
  const control = tool === "control_service";
  let services: string[] = [];
  let action: string | undefined;
  if (dialect === "powershell" && /-service$/.test(program)) {
    const walked = walkPowershell(command, ["-name", "-displayname", "-inputobject", "-include", "-exclude", "-computername", "-force", "-passthru", "-startuptype", "-status", "-whatif", "-confirm"], ["-name", "-displayname", "-inputobject", "-include", "-exclude", "-computername", "-startuptype", "-status"]);
    services = [...walked.values.filter((v) => v.flag === "-name").map((v) => v.word), ...(walked.operands[0] ?? [])].map((w) => (w.dynamic === true ? unknownProgramPlace(w.value) : w.value));
    if (walked.values.some((v) => v.flag === "-displayname" || v.flag === "-inputobject")) services.push(unknownProgramPlace("a service"));
    action = SERVICE_CMDLETS[program];
  } else if (program === "systemctl") {
    const walked = walkPosix(command, ["-t", "--type", "-s", "--signal", "-p", "--property", "-n", "--lines", "-o", "--output", "-H", "--host", "-M", "--machine", "--state", "--root", "--kill-whom"]);
    const [verb, ...units] = walked.operands.flat();
    services = valuesOf(units).map(serviceName);
    action = verb !== undefined ? SERVICE_VERBS[verb.value] : undefined;
  } else if (program === "service") {
    const [name, verb] = walkPosix(command, []).operands.flat();
    services = name !== undefined ? valuesOf([name]).map(serviceName) : [];
    action = verb !== undefined ? (SERVICE_VERBS[verb.value] ?? (verb.value === "status" ? undefined : undefined)) : undefined;
  } else if (program === "sc" || program === "sc.exe") {
    const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).filter((w) => !/^\\\\/.test(w.value));
    const [verb, name] = words;
    services = name !== undefined ? valuesOf([name]) : [];
    action = verb !== undefined ? SERVICE_VERBS[verb.value.toLowerCase()] : undefined;
  } else if (program === "net") {
    const words = walkCmd(command, []).operands.flat();
    const [verb, ...name] = words;
    services = name.length > 0 ? [name.map((w) => w.value).join(" ")] : [];
    action = verb !== undefined ? SERVICE_VERBS[verb.value.toLowerCase()] : undefined;
  } else if (program === "launchctl") {
    const operands = walkPosix(command, ["-S", "-D"]).operands.flat();
    const [verb] = operands;
    const last = operands.length > 1 ? operands[operands.length - 1]! : undefined;
    services = last !== undefined ? valuesOf([last]).map((label) => label.replace(/^.*[\\/]/, "").replace(/\.plist$/i, "")) : [];
    action = verb !== undefined ? SERVICE_VERBS[verb.value] : undefined;
  } else if (program === "brew") {
    // `brew services start redis`
    const operands = walkPosix(command, []).operands.flat();
    const [, verb, formula] = operands;
    services = formula !== undefined ? valuesOf([formula]) : [];
    action = verb !== undefined ? SERVICE_VERBS[verb.value] : undefined;
  }
  return {
    service: orUnread(services, "a service"),
    ...(control ? { action: [action ?? unknownProgramPlace("action")] } : {}),
  };
}

// --- software -----------------------------------------------------------------------------------------

/** What a package manager's verb does, as `install_software`'s ACTION. */
const INSTALL_VERBS: Readonly<Record<string, string>> = {
  install: "install",
  add: "install",
  in: "install",
  i: "install",
  reinstall: "install",
  uninstall: "uninstall",
  remove: "uninstall",
  rm: "uninstall",
  un: "uninstall",
  purge: "uninstall",
  erase: "uninstall",
  del: "uninstall",
  autoremove: "uninstall",
  upgrade: "upgrade",
  update: "upgrade",
  up: "upgrade",
  refresh: "upgrade",
  "full-upgrade": "upgrade",
  "dist-upgrade": "upgrade",
  "safe-upgrade": "upgrade",
};

/** PowerShell's module cmdlets, as ACTIONS — their manager is `powershell`. */
const MODULE_CMDLETS: Readonly<Record<string, string>> = {
  "install-module": "install",
  "install-script": "install",
  "install-psresource": "install",
  "install-package": "install",
  "uninstall-module": "uninstall",
  "uninstall-script": "uninstall",
  "uninstall-psresource": "uninstall",
  "uninstall-package": "uninstall",
  "update-module": "upgrade",
  "update-script": "upgrade",
  "update-psresource": "upgrade",
};

/** The flags of the package managers that take a value which names no package. */
const MANAGER_VALUED = ["-v", "--version", "-s", "--source", "--scope", "--location", "--architecture", "-l", "--log", "--override", "--custom", "--accept-source-agreements", "-r", "--repo", "--channel", "-t", "--target-release", "--prefix", "-C", "--dir", "--cask-dir"];

function softwareResource(tool: string, command: ParsedCommand, dialect: CommandDialect): ResourcePlaces {
  const install = tool === "install_software";
  const program = command.program;
  if (dialect === "powershell" && Object.hasOwn(MODULE_CMDLETS, program)) {
    const walked = walkPowershell(command, ["-name", "-requiredversion", "-minimumversion", "-maximumversion", "-repository", "-scope", "-force", "-allowclobber", "-acceptlicense", "-inputobject"], ["-name", "-requiredversion", "-minimumversion", "-maximumversion", "-repository", "-scope", "-inputobject"]);
    const names = [...walked.values.filter((v) => v.flag === "-name").map((v) => v.word), ...(walked.operands[0] ?? [])];
    return { package: orUnread(valuesOf(names), "a package"), ...(install ? { action: [MODULE_CMDLETS[program]!], manager: ["powershell"] } : {}) };
  }
  const walked = walkPosix(command, ["--id", "--name", "-q", "--query", "--moniker", ...MANAGER_VALUED]);
  const operands = walked.operands.flat();
  // The verb: the first operand, past `global` (`yarn global add`) and `services`-free; npm's `-g` keeps it a global install.
  const start = operands[0]?.value === "global" ? 1 : 0;
  const verb = operands[start];
  const named = [...walked.values.filter((v) => v.flag === "--id" || v.flag === "--name" || v.flag === "-q" || v.flag === "--query").map((v) => v.word), ...operands.slice(start + 1)];
  const action = verb !== undefined ? INSTALL_VERBS[verb.value] : undefined;
  return {
    package: orUnread(valuesOf(named), "every package"),
    ...(install ? { action: [action ?? unknownProgramPlace("action")], manager: [programName(program)] } : {}),
  };
}

// --- settings -----------------------------------------------------------------------------------------

/** Whose a registry key is: the user's hive, or the machine's. */
const registryOwner = (key: string): string => (/^(hkcu|hkey_current_user)\b/i.test(key.replace(/^registry::/i, "")) ? "user" : "system");

/** A registry key as an AREA place: `HKEY_CURRENT_USER\\Software\\X` is `registry/HKCU/Software/X`. */
function registryArea(key: string): string {
  const parts = key
    .replace(/^(?:microsoft\.powershell\.core\\)?registry::/i, "")
    .split(/[\\/]+/)
    .filter((p) => p !== "");
  const hive = (parts[0] ?? "").replace(/:$/, "").toLowerCase();
  const short: Record<string, string> = { hkey_current_user: "HKCU", hkcu: "HKCU", hkey_local_machine: "HKLM", hklm: "HKLM", hkey_classes_root: "HKCR", hkcr: "HKCR", hkey_users: "HKU", hku: "HKU", hkey_current_config: "HKCC", hkcc: "HKCC" };
  return ["registry", short[hive] ?? parts[0] ?? "", ...parts.slice(1)].filter((p) => p !== "").join("/");
}

function settingsResource(tool: string, command: ParsedCommand, dialect: CommandDialect): ResourcePlaces {
  const write = tool === "write_settings";
  const program = command.program;
  const unread = (): ResourcePlaces => ({ area: [unknownProgramPlace("a setting")], owner: [unknownProgramPlace("owner")], ...(write ? { action: [unknownProgramPlace("action")] } : {}) });
  if (program === "reg" || program === "reg.exe") {
    const walked = walkCmd(command, ["/v", "/t", "/d", "/s", "/f", "/se", "/reg"]);
    const [verb, key] = walked.operands.flat();
    if (key === undefined || key.dynamic === true) return unread();
    const name = walked.values.find((v) => v.flag === "/v")?.word;
    const whole = walked.flags.includes("/va") || (name === undefined && verb?.value.toLowerCase() === "delete");
    const area = `${registryArea(key.value)}${name !== undefined ? `/${name.value}` : whole || !write ? "/**" : ""}`;
    return { area: [area], owner: [registryOwner(key.value)], ...(write ? { action: [verb?.value.toLowerCase() === "delete" ? "delete" : "set"] } : {}) };
  }
  if (program === "setx") {
    const walked = walkCmd(command, ["/s", "/u", "/p", "/k", "/f", "/a", "/r", "/d"]);
    const [name] = walked.operands.flat();
    if (name === undefined || name.dynamic === true) return unread();
    return { area: [`environment/${name.value}`], owner: [walked.flags.includes("/m") ? "system" : "user"], action: ["set"] };
  }
  if (program === "defaults") {
    const operands = walkPosix(command, ["-host"]).operands.flat();
    const [verb, domain, key] = operands;
    if (domain === undefined || domain.dynamic === true) return unread();
    const area = `defaults/${domain.value}${key !== undefined && key.dynamic !== true ? `/${key.value}` : "/**"}`;
    return { area: [area], owner: ["user"], ...(write ? { action: [verb?.value === "delete" ? "delete" : "set"] } : {}) };
  }
  if (program === "timedatectl" || program === "tzutil") {
    const zone = (command.words ?? []).some((w) => /^(set-timezone|\/s)$/i.test(w.value));
    return zone ? { area: ["time_zone"], owner: ["system"], ...(write ? { action: ["set"] } : {}) } : { area: ["time"], owner: ["system"], ...(write ? { action: ["set"] } : {}) };
  }
  if (program === "sysctl") {
    const named = walkPosix(command, ["-p", "--load"]).operands.flat().map((w) => (w.dynamic === true ? unknownProgramPlace(w.value) : `sysctl/${w.value.split("=")[0]!}`));
    return { area: orUnread(named, "a setting"), owner: ["system"], ...(write ? { action: ["set"] } : {}) };
  }
  // A file cmdlet handed the registry (\`Set-ItemProperty -Path HKCU:\\…\`) — its path and \`-Name\`.
  if (dialect === "powershell" && /-item(property)?$/.test(program)) {
    const walked = walkPowershell(command, ["-path", "-literalpath", "-name", "-value", "-type", "-propertytype", "-force", "-recurse", "-whatif", "-confirm"], ["-path", "-literalpath", "-name", "-value", "-type", "-propertytype"]);
    const path = walked.values.find((v) => v.flag === "-path" || v.flag === "-literalpath")?.word ?? walked.operands[0]?.[0];
    if (path === undefined || path.dynamic === true) return unread();
    const name = walked.values.find((v) => v.flag === "-name")?.word ?? walked.operands[1]?.[0];
    const area = `${registryArea(path.value)}${name !== undefined && name.dynamic !== true ? `/${name.value}` : write ? "" : "/**"}`;
    return { area: [area], owner: [registryOwner(path.value.replace(/:/, ""))], ...(write ? { action: [/^remove-/.test(program) ? "delete" : "set"] } : {}) };
  }
  return unread();
}

// --- power and opening --------------------------------------------------------------------------------

/** What a power command does, as `power`'s ACTION. */
function powerAction(command: ParsedCommand): string {
  const program = command.program;
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value.toLowerCase());
  const has = (...flags: string[]): boolean => words.some((w) => flags.includes(w));
  switch (program) {
    case "reboot":
    case "restart-computer":
      return "restart";
    case "poweroff":
    case "halt":
    case "stop-computer":
      return "shut_down";
    case "logoff":
      return "sign_out";
    case "pmset":
      return "sleep";
    case "systemctl":
      return { reboot: "restart", "soft-reboot": "restart", kexec: "restart", poweroff: "shut_down", halt: "shut_down", suspend: "sleep", "suspend-then-hibernate": "sleep", "hybrid-sleep": "sleep", hibernate: "hibernate" }[words.find((w) => !w.startsWith("-")) ?? ""] ?? unknownProgramPlace("action");
    case "loginctl":
      return words.some((w) => w.startsWith("lock")) ? "lock" : "sign_out";
    case "shutdown":
      if (has("/r", "-r", "/g")) return "restart";
      if (has("/l")) return "sign_out";
      if (has("/h")) return "hibernate";
      if (has("/a", "-c")) return "cancel";
      if (has("/s", "/p", "-h", "-p", "-s", "--poweroff", "-p")) return "shut_down";
      // POSIX `shutdown now` powers off.
      return "shut_down";
    default:
      return unknownProgramPlace("action");
  }
}

/** What an opener opens: a link is a SITE, anything else a PATH — its app a program nobody could read. */
function openResource(command: ParsedCommand): ResourcePlaces {
  const operands = (command.words ?? []).slice((command.programIndex ?? 0) + 1).filter((w) => !isFlag(w.value) && !/^\/[a-z]$/i.test(w.value));
  const target = operands[operands.length - 1];
  const out: ResourcePlaces = { program: [unknownProgramPlace("the app it opens in")], owner: ["session"], action: ["open"] };
  if (target === undefined || target.dynamic === true) return out;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target.value) ? { ...out, site: [target.value] } : { ...out, path: [target.value] };
}

/**
 * The places of every kind a command that is the System tool `tool` acts on, as its reader reads them —
 * or `undefined` for a tool with no reader here (the process tools are `processTargets.ts`'s).
 */
export function systemResourceOf(tool: string, command: ParsedCommand, dialect: CommandDialect): ResourcePlaces | undefined {
  switch (tool) {
    case "list_services":
    case "control_service":
      return serviceResource(tool, command, dialect);
    case "list_software":
    case "install_software":
      return softwareResource(tool, command, dialect);
    case "read_settings":
    case "write_settings":
      return settingsResource(tool, command, dialect);
    case "power":
      return { action: [powerAction(command)] };
    case "open_app":
      return openResource(command);
    default:
      return undefined;
  }
}
