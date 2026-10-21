/**
 * The shell's commands that ARE System tools (decision 0018 §3) — as `cat` and `Get-Content` are
 * `read_file`, `kill`, `taskkill` and `Stop-Process` are `stop_process`, so a permission set's
 * `stop_process` line holds all three and the agent's own call to the tool alike.
 *
 * What a program is can turn on its subcommand (`systemctl start` changes a service, `systemctl
 * status` looks at one), on a flag (`xclip -o` reads the clipboard, `xclip` writes it), or on
 * whether it is handed an operand at all (`hostname` names the machine, `hostname box` renames it).
 * A subcommand the table is not told of leaves the program the command it is, answering to its own
 * line or the shell's: only what is surely a look, or surely the change, is moved.
 *
 * Left out on purpose:
 *  - a screenshot program (`screencapture`, `scrot`, `grim`): it writes its picture to a file the
 *    line names, which a look must not do — it stays a command;
 *  - cmd's `start` and `Start-Process`: what they start is a program, judged as itself;
 *  - `reg export`, `reg save`, `powercfg /batteryreport`: they write a file;
 *  - what changes nothing outside the line (`Get-TimeZone`, `Get-ExecutionPolicy`, cmd's `ver`):
 *    it stays no request (`NO_REQUEST`), as it was.
 *
 * Pure, in `shared`, beside the other shell tables.
 */
import type { CommandDialect } from "./shellCommand";

/** What a program is, as a System tool. See the module header. */
export interface SystemCommandSpec {
  /**
   * The tool it is, unless a flag, a subcommand or an operand below says otherwise. For a program with
   * `subcommands`, the tool it is with NONE (`systemctl` alone lists the units): a subcommand the
   * table does not name leaves it the command it is.
   */
  tool?: string;
  /** By its first operand; a nested spec reads the operand after that (`brew services start`). */
  subcommands?: Readonly<Record<string, string | SystemCommandSpec>>;
  /** By a flag — a regular expression over each flag — the first that matches, before anything else. */
  when?: ReadonlyArray<{ flag: string; tool: string }>;
  /** The tool when it is handed an operand the table does not name (`hostname box`, `net start spooler`). */
  withOperand?: string;
  /** The tool when an operand sets something (`sysctl kern.x=1`). */
  assigning?: string;
}

const READ_SYSTEM: SystemCommandSpec = { tool: "read_system" };
const POWER: SystemCommandSpec = { tool: "power" };
const LIST_PROCESSES: SystemCommandSpec = { tool: "list_processes" };
const STOP_PROCESS: SystemCommandSpec = { tool: "stop_process" };
const LIST_SERVICES: SystemCommandSpec = { tool: "list_services" };
const CONTROL_SERVICE: SystemCommandSpec = { tool: "control_service" };
const LIST_SOFTWARE: SystemCommandSpec = { tool: "list_software" };
const INSTALL_SOFTWARE: SystemCommandSpec = { tool: "install_software" };
const WRITE_SETTINGS: SystemCommandSpec = { tool: "write_settings" };
const READ_CLIPBOARD: SystemCommandSpec = { tool: "read_clipboard" };
const WRITE_CLIPBOARD: SystemCommandSpec = { tool: "write_clipboard" };
const CONTROL_INPUT: SystemCommandSpec = { tool: "control_input" };

/** Subcommands, each read as `tool`. */
const each = (tool: string, names: string): Record<string, string> => Object.fromEntries(names.trim().split(/\s+/).map((name) => [name, tool]));

/** A package manager: what it lists, then what installs, removes or updates. */
const manager = (lists: string, installs: string): SystemCommandSpec => ({ subcommands: { ...each("list_software", lists), ...each("install_software", installs) } });

/** A settings tool: what it reads, then what it changes. */
const settings = (reads: string, writes: string, tool?: string): SystemCommandSpec => ({
  ...(tool !== undefined ? { tool } : {}),
  subcommands: { ...each("read_settings", reads), ...each("write_settings", writes) },
});

/** `npm install -g`: the project's own install stays the command it is; a global one is software. */
const GLOBAL_FLAG = "^(-g|--global|--location=global)$";
const globalInstalls = (names: string): SystemCommandSpec => ({
  subcommands: Object.fromEntries(names.trim().split(/\s+/).map((name) => [name, { when: [{ flag: GLOBAL_FLAG, tool: "install_software" }] }])),
});

/** systemctl's verbs: looking at units, changing them, and the machine's own power. */
const SYSTEMCTL: SystemCommandSpec = {
  tool: "list_services",
  subcommands: {
    ...each("list_services", "status list-units list-unit-files list-sockets list-timers list-dependencies list-jobs is-active is-enabled is-failed is-system-running show cat help"),
    ...each("control_service", "start stop restart reload try-restart reload-or-restart try-reload-or-restart condrestart enable disable reenable mask unmask preset preset-all revert kill clean freeze thaw isolate daemon-reload daemon-reexec edit set-property set-environment unset-environment import-environment link add-wants add-requires set-default reset-failed"),
    ...each("power", "reboot poweroff halt suspend hibernate hybrid-sleep suspend-then-hibernate kexec soft-reboot emergency rescue default exit"),
  },
};

/** POSIX programs that are System tools — Linux's and macOS's alike. */
export const POSIX_SYSTEM_COMMANDS: Readonly<Record<string, SystemCommandSpec>> = {
  // Machine
  uname: READ_SYSTEM,
  hostname: { tool: "read_system", withOperand: "write_settings", when: [{ flag: "^(-F|--file|-b|--boot)$", tool: "write_settings" }] },
  uptime: READ_SYSTEM,
  df: READ_SYSTEM,
  free: READ_SYSTEM,
  lscpu: READ_SYSTEM,
  lsblk: READ_SYSTEM,
  lsusb: READ_SYSTEM,
  lspci: READ_SYSTEM,
  lsmem: READ_SYSTEM,
  vmstat: READ_SYSTEM,
  vm_stat: READ_SYSTEM,
  iostat: READ_SYSTEM,
  who: READ_SYSTEM,
  w: READ_SYSTEM,
  last: READ_SYSTEM,
  whoami: READ_SYSTEM,
  id: READ_SYSTEM,
  groups: READ_SYSTEM,
  users: READ_SYSTEM,
  nproc: READ_SYSTEM,
  arch: READ_SYSTEM,
  lsb_release: READ_SYSTEM,
  sw_vers: READ_SYSTEM,
  system_profiler: READ_SYSTEM,
  ioreg: READ_SYSTEM,
  dmesg: { tool: "read_system", when: [{ flag: "^(-c|-C|--clear|--read-clear|-D|-E|--console-off|--console-on|-n|--console-level)$", tool: "write_settings" }] },
  journalctl: { tool: "read_system", when: [{ flag: "^--(vacuum-size|vacuum-time|vacuum-files|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)", tool: "write_settings" }] },
  sysctl: { tool: "read_settings", assigning: "write_settings", when: [{ flag: "^(-w|--write|-p|--load|--system)$", tool: "write_settings" }] },
  diskutil: { subcommands: each("read_system", "list info activity listFilesystems") },
  // Power
  shutdown: POWER,
  reboot: POWER,
  poweroff: POWER,
  halt: POWER,
  pmset: { withOperand: "write_settings", when: [{ flag: "^-g$", tool: "read_settings" }], subcommands: each("power", "sleepnow displaysleepnow restoredefaults") },
  loginctl: { subcommands: { ...each("power", "lock-session lock-sessions terminate-session terminate-user kill-session kill-user"), ...each("read_system", "list-sessions session-status show-session list-users user-status show-user list-seats seat-status show-seat") } },
  // Processes
  ps: LIST_PROCESSES,
  pgrep: LIST_PROCESSES,
  pstree: LIST_PROCESSES,
  top: LIST_PROCESSES,
  htop: LIST_PROCESSES,
  btop: LIST_PROCESSES,
  lsof: LIST_PROCESSES,
  pidof: LIST_PROCESSES,
  kill: STOP_PROCESS,
  pkill: STOP_PROCESS,
  killall: STOP_PROCESS,
  xkill: STOP_PROCESS,
  // Services
  systemctl: SYSTEMCTL,
  service: { tool: "control_service", when: [{ flag: "^--status-all$", tool: "list_services" }] },
  launchctl: {
    subcommands: {
      ...each("list_services", "list print print-cache print-disabled blame procinfo hostinfo dumpstate dumpjpcategory resolveport examine error variant version help managerpid manageruid managername"),
      ...each("control_service", "load unload bootstrap bootout enable disable kickstart kill start stop submit remove attach debug config setenv unsetenv limit"),
      ...each("power", "reboot"),
    },
  },
  // Software
  dpkg: {
    when: [
      { flag: "^(-l|--list|-s|--status|-L|--listfiles|-S|--search|-p|--print-avail|--get-selections|--print-architecture|--print-foreign-architectures|--audit|-C|--compare-versions|--verify|-V)$", tool: "list_software" },
      { flag: "^(-i|--install|-r|--remove|-P|--purge|--configure|--unpack|-a|--pending|--set-selections|--clear-selections|--add-architecture|--remove-architecture|--update-avail|--merge-avail|--clear-avail|--forget-old-unavail)$", tool: "install_software" },
    ],
  },
  "dpkg-query": LIST_SOFTWARE,
  rpm: {
    when: [
      { flag: "^(-q[a-zA-Z]*|--query|--querytags|-V[a-zA-Z]*|--verify)$", tool: "list_software" },
      { flag: "^(-[iUFe][a-zA-Z]*|--install|--upgrade|--freshen|--erase|--import|--rebuilddb|--initdb)$", tool: "install_software" },
    ],
  },
  apt: manager("list show search policy depends rdepends showsrc changelog", "install reinstall remove purge autoremove autopurge upgrade full-upgrade dist-upgrade update satisfy build-dep edit-sources"),
  "apt-get": manager("", "install reinstall remove purge autoremove autoclean clean upgrade dist-upgrade full-upgrade update build-dep satisfy dselect-upgrade"),
  "apt-cache": LIST_SOFTWARE,
  aptitude: manager("search show versions why why-not", "install reinstall remove purge hold unhold markauto unmarkauto forbid-version update safe-upgrade full-upgrade"),
  dnf: manager("list info search repolist repoquery provides deplist check-update history", "install reinstall remove erase upgrade update downgrade distro-sync autoremove groupinstall groupremove makecache swap"),
  yum: manager("list info search repolist provides deplist check-update history", "install reinstall remove erase upgrade update downgrade distro-sync autoremove groupinstall groupremove makecache swap"),
  zypper: manager("search se info if list-updates lu packages pa patterns pt products pd repos lr", "install in remove rm update up dist-upgrade dup patch refresh ref addrepo ar removerepo rr"),
  pacman: {
    when: [
      { flag: "^-Q", tool: "list_software" },
      { flag: "^--query$", tool: "list_software" },
      { flag: "^-S[a-zA-Z]*[sigl]", tool: "list_software" },
      { flag: "^-[SRUD]", tool: "install_software" },
      { flag: "^--(sync|remove|upgrade|database)$", tool: "install_software" },
    ],
  },
  apk: manager("info list search policy dot stats", "add del fix update upgrade cache"),
  snap: manager("list info find connections services version", "install remove refresh revert enable disable connect disconnect set unset"),
  flatpak: manager("list info search remotes remote-ls history", "install uninstall update repair remote-add remote-delete remote-modify mask pin"),
  brew: {
    subcommands: {
      ...each("list_software", "list ls info abv outdated deps uses leaves desc config doctor search tap-info"),
      ...each("install_software", "install reinstall uninstall remove rm upgrade update tap untap link unlink pin unpin cleanup autoremove"),
      services: { subcommands: { ...each("list_services", "list info"), ...each("control_service", "start stop restart run kill cleanup") } },
    },
  },
  port: manager("installed list info search outdated contents deps", "install uninstall upgrade selfupdate sync activate deactivate clean"),
  mas: manager("list info search outdated", "install uninstall upgrade purchase lucky"),
  npm: globalInstalls("install i add uninstall remove rm un update up upgrade link ln"),
  pnpm: globalInstalls("add install i remove rm uninstall update up upgrade link ln"),
  yarn: { subcommands: { global: { subcommands: { ...each("install_software", "add remove upgrade"), ...each("list_software", "list bin dir") } } } },
  // Settings
  defaults: settings("read read-type domains find export help", "write delete import rename"),
  gsettings: settings("get list-schemas list-relocatable-schemas list-keys list-children list-recursively range describe writable monitor help", "set reset reset-recursively"),
  dconf: settings("read list dump watch help", "write reset load compile update"),
  timedatectl: settings("status show list-timezones timesync-status show-timesync help", "set-time set-timezone set-local-rtc set-ntp ntp-servers revert", "read_settings"),
  localectl: settings("status list-locales list-keymaps list-x11-keymap-models list-x11-keymap-layouts list-x11-keymap-variants list-x11-keymap-options help", "set-locale set-keymap set-x11-keymap", "read_settings"),
  hostnamectl: settings("status hostname icon-name chassis deployment location help", "set-hostname set-icon-name set-chassis set-deployment set-location", "read_settings"),
  scutil: { when: [{ flag: "^(--get|--dns|--proxy|--nwi|-r)$", tool: "read_settings" }, { flag: "^--set$", tool: "write_settings" }] },
  systemsetup: { when: [{ flag: "^-get", tool: "read_settings" }, { flag: "^-(set|setremote)", tool: "write_settings" }] },
  crontab: { tool: "write_settings", when: [{ flag: "^-l$", tool: "read_settings" }] },
  // Clipboard
  pbpaste: READ_CLIPBOARD,
  pbcopy: WRITE_CLIPBOARD,
  "wl-paste": READ_CLIPBOARD,
  "wl-copy": WRITE_CLIPBOARD,
  xclip: { tool: "write_clipboard", when: [{ flag: "^-o(ut)?$", tool: "read_clipboard" }] },
  // With neither, xsel reads or writes by whether its input is a terminal — in a pipe, it writes.
  xsel: { tool: "write_clipboard", when: [{ flag: "^(-o|--output)$", tool: "read_clipboard" }] },
  // Apps & windows — `open`, `xdg-open` and `gio open` are openers: see `OPENERS`.
  wmctrl: { when: [{ flag: "^-(l|d|m)$", tool: "list_windows" }, { flag: "^-(a|c|r|s|k|n|o|R|g|e|b|N|I|T)$", tool: "open_app" }] },
  // Screen & input
  xdotool: {
    tool: "control_input",
    withOperand: "control_input",
    subcommands: {
      ...each("list_windows", "search getactivewindow getwindowfocus getwindowname getwindowpid getwindowgeometry getdisplaygeometry getmouselocation get_desktop get_num_desktops get_desktop_for_window get_desktop_viewport version help"),
      ...each("open_app", "windowactivate windowfocus windowraise windowminimize windowclose windowkill windowmap windowunmap windowmove windowsize windowreparent set_desktop set_desktop_for_window set_num_desktops set_desktop_viewport set_window"),
    },
  },
  ydotool: CONTROL_INPUT,
  cliclick: CONTROL_INPUT,
};

/** Programs every Windows has, as cmd and PowerShell both run them. */
export const WINDOWS_SYSTEM_COMMANDS: Readonly<Record<string, SystemCommandSpec>> = {
  systeminfo: READ_SYSTEM,
  hostname: READ_SYSTEM,
  whoami: READ_SYSTEM,
  driverquery: READ_SYSTEM,
  getmac: READ_SYSTEM,
  ipconfig: { tool: "read_system", when: [{ flag: "^/(release|release6|renew|renew6|flushdns|registerdns|setclassid|setclassid6)$", tool: "write_settings" }] },
  shutdown: POWER,
  logoff: POWER,
  tasklist: LIST_PROCESSES,
  taskkill: STOP_PROCESS,
  sc: {
    subcommands: {
      ...each("list_services", "query queryex qc qdescription qfailure qfailureflag qsidtype qprivs qtriggerinfo qpreferrednode qmanagedaccount qprotection quserservice getdisplayname getkeyname enumdepend sdshow showsid"),
      ...each("control_service", "start stop pause continue interrogate config description failure failureflag sidtype privs managedaccount triggerinfo preferrednode create delete control sdset"),
    },
  },
  net: { subcommands: { start: { tool: "list_services", withOperand: "control_service" }, ...each("control_service", "stop pause continue") } },
  reg: settings("query compare", "add delete import copy restore load unload flags"),
  setx: WRITE_SETTINGS,
  tzutil: { when: [{ flag: "^/(g|l)$", tool: "read_settings" }, { flag: "^/s$", tool: "write_settings" }] },
  w32tm: { when: [{ flag: "^/(query|stripchart|monitor|tz)$", tool: "read_settings" }, { flag: "^/(config|resync|register|unregister)$", tool: "write_settings" }] },
  bcdedit: { tool: "write_settings", when: [{ flag: "^/(enum|v)$", tool: "read_settings" }] },
  clip: WRITE_CLIPBOARD,
  winget: manager("list ls show view search find source hash validate features", "install add uninstall remove rm upgrade update import repair pin configure settings"),
  choco: manager("list search find info outdated", "install uninstall upgrade pin feature config source sync"),
  scoop: manager("list info status search cat depends which prefix home", "install uninstall update reset hold unhold cleanup bucket"),
};

/** PowerShell's cmdlets that are System tools, by the cmdlet's own name. */
export const POWERSHELL_SYSTEM_COMMANDS: Readonly<Record<string, SystemCommandSpec>> = {
  // Machine
  "get-computerinfo": READ_SYSTEM,
  "get-hotfix": READ_SYSTEM,
  "get-eventlog": READ_SYSTEM,
  "get-winevent": READ_SYSTEM,
  "get-volume": READ_SYSTEM,
  "get-disk": READ_SYSTEM,
  "get-partition": READ_SYSTEM,
  "get-physicaldisk": READ_SYSTEM,
  "get-netadapter": READ_SYSTEM,
  "get-netipaddress": READ_SYSTEM,
  "get-netipconfiguration": READ_SYSTEM,
  "get-netroute": READ_SYSTEM,
  "get-nettcpconnection": READ_SYSTEM,
  "get-netudpendpoint": READ_SYSTEM,
  "get-dnsclientserveraddress": READ_SYSTEM,
  "get-localuser": READ_SYSTEM,
  "get-localgroup": READ_SYSTEM,
  "get-localgroupmember": READ_SYSTEM,
  "get-uptime": READ_SYSTEM,
  "get-counter": READ_SYSTEM,
  "get-pnpdevice": READ_SYSTEM,
  "get-printer": READ_SYSTEM,
  "get-ciminstance": READ_SYSTEM,
  "get-wmiobject": READ_SYSTEM,
  "get-computerrestorepoint": READ_SYSTEM,
  "get-mpcomputerstatus": READ_SYSTEM,
  "get-bitlockervolume": READ_SYSTEM,
  "get-tpm": READ_SYSTEM,
  "get-controlpanelitem": READ_SYSTEM,
  "clear-eventlog": WRITE_SETTINGS,
  "limit-eventlog": WRITE_SETTINGS,
  "new-eventlog": WRITE_SETTINGS,
  "remove-eventlog": WRITE_SETTINGS,
  "write-eventlog": WRITE_SETTINGS,
  "rename-computer": WRITE_SETTINGS,
  "add-computer": WRITE_SETTINGS,
  "remove-computer": WRITE_SETTINGS,
  "checkpoint-computer": WRITE_SETTINGS,
  "restore-computer": WRITE_SETTINGS,
  "enable-computerrestore": WRITE_SETTINGS,
  "disable-computerrestore": WRITE_SETTINGS,
  "reset-computermachinepassword": WRITE_SETTINGS,
  // Power
  "restart-computer": POWER,
  "stop-computer": POWER,
  // Processes
  "get-process": LIST_PROCESSES,
  "stop-process": STOP_PROCESS,
  // Services
  "get-service": LIST_SERVICES,
  "start-service": CONTROL_SERVICE,
  "stop-service": CONTROL_SERVICE,
  "restart-service": CONTROL_SERVICE,
  "suspend-service": CONTROL_SERVICE,
  "resume-service": CONTROL_SERVICE,
  "set-service": CONTROL_SERVICE,
  "new-service": CONTROL_SERVICE,
  "remove-service": CONTROL_SERVICE,
  // Software
  "get-package": LIST_SOFTWARE,
  "get-installedmodule": LIST_SOFTWARE,
  "get-installedscript": LIST_SOFTWARE,
  "get-installedpsresource": LIST_SOFTWARE,
  "get-packageprovider": LIST_SOFTWARE,
  "get-packagesource": LIST_SOFTWARE,
  "get-psrepository": LIST_SOFTWARE,
  "get-psresourcerepository": LIST_SOFTWARE,
  "get-appxpackage": LIST_SOFTWARE,
  "get-windowsoptionalfeature": LIST_SOFTWARE,
  "get-windowsfeature": LIST_SOFTWARE,
  "get-windowscapability": LIST_SOFTWARE,
  "install-module": INSTALL_SOFTWARE,
  "install-package": INSTALL_SOFTWARE,
  "install-script": INSTALL_SOFTWARE,
  "install-psresource": INSTALL_SOFTWARE,
  "install-packageprovider": INSTALL_SOFTWARE,
  "import-packageprovider": INSTALL_SOFTWARE,
  "uninstall-module": INSTALL_SOFTWARE,
  "uninstall-package": INSTALL_SOFTWARE,
  "uninstall-script": INSTALL_SOFTWARE,
  "uninstall-psresource": INSTALL_SOFTWARE,
  "update-module": INSTALL_SOFTWARE,
  "update-script": INSTALL_SOFTWARE,
  "update-psresource": INSTALL_SOFTWARE,
  "update-help": INSTALL_SOFTWARE,
  "save-module": INSTALL_SOFTWARE,
  "save-package": INSTALL_SOFTWARE,
  "save-script": INSTALL_SOFTWARE,
  "save-psresource": INSTALL_SOFTWARE,
  "register-psrepository": INSTALL_SOFTWARE,
  "set-psrepository": INSTALL_SOFTWARE,
  "unregister-psrepository": INSTALL_SOFTWARE,
  "register-packagesource": INSTALL_SOFTWARE,
  "set-packagesource": INSTALL_SOFTWARE,
  "unregister-packagesource": INSTALL_SOFTWARE,
  "register-psresourcerepository": INSTALL_SOFTWARE,
  "set-psresourcerepository": INSTALL_SOFTWARE,
  "unregister-psresourcerepository": INSTALL_SOFTWARE,
  "add-appxpackage": INSTALL_SOFTWARE,
  "remove-appxpackage": INSTALL_SOFTWARE,
  "enable-windowsoptionalfeature": INSTALL_SOFTWARE,
  "disable-windowsoptionalfeature": INSTALL_SOFTWARE,
  "install-windowsfeature": INSTALL_SOFTWARE,
  "uninstall-windowsfeature": INSTALL_SOFTWARE,
  "add-windowscapability": INSTALL_SOFTWARE,
  "remove-windowscapability": INSTALL_SOFTWARE,
  // Settings
  "get-netfirewallrule": { tool: "read_settings" },
  "get-netfirewallprofile": { tool: "read_settings" },
  "get-mppreference": { tool: "read_settings" },
  "get-winsystemlocale": { tool: "read_settings" },
  "get-winuserlanguagelist": { tool: "read_settings" },
  "get-winhomelocation": { tool: "read_settings" },
  "set-date": WRITE_SETTINGS,
  "set-timezone": WRITE_SETTINGS,
  "set-executionpolicy": WRITE_SETTINGS,
  "set-culture": WRITE_SETTINGS,
  "set-winsystemlocale": WRITE_SETTINGS,
  "set-winuserlanguagelist": WRITE_SETTINGS,
  "set-winhomelocation": WRITE_SETTINGS,
  "new-netfirewallrule": WRITE_SETTINGS,
  "set-netfirewallrule": WRITE_SETTINGS,
  "remove-netfirewallrule": WRITE_SETTINGS,
  "enable-netfirewallrule": WRITE_SETTINGS,
  "disable-netfirewallrule": WRITE_SETTINGS,
  "set-netfirewallprofile": WRITE_SETTINGS,
  "set-mppreference": WRITE_SETTINGS,
  "add-mppreference": WRITE_SETTINGS,
  "remove-mppreference": WRITE_SETTINGS,
  "new-netipaddress": WRITE_SETTINGS,
  "set-netipaddress": WRITE_SETTINGS,
  "remove-netipaddress": WRITE_SETTINGS,
  "set-dnsclientserveraddress": WRITE_SETTINGS,
  "set-netadapter": WRITE_SETTINGS,
  "enable-netadapter": WRITE_SETTINGS,
  "disable-netadapter": WRITE_SETTINGS,
  "new-localuser": WRITE_SETTINGS,
  "set-localuser": WRITE_SETTINGS,
  "remove-localuser": WRITE_SETTINGS,
  "enable-localuser": WRITE_SETTINGS,
  "disable-localuser": WRITE_SETTINGS,
  "add-localgroupmember": WRITE_SETTINGS,
  "remove-localgroupmember": WRITE_SETTINGS,
  // Clipboard
  "get-clipboard": READ_CLIPBOARD,
  "set-clipboard": WRITE_CLIPBOARD,
};

/**
 * The programs that OPEN something in its app — a file, a folder, a link, an app by name — which is
 * `open_app`. Opening a file that would run as a program instead (a script, an executable) is
 * running it, and is `script` (see {@link openerTool}).
 */
export interface OpenerSpec {
  /** Only under this subcommand (`gio open`; gio's others copy, move and delete files). */
  sub?: string;
  /** Flags whose next word is a value, not a thing to open (`open -a Safari`). */
  valueFlags?: readonly string[];
  /** Flags that hand what follows to the app as its own words: what runs then is not read. */
  passesArgs?: readonly string[];
}

export const OPENERS: Readonly<Record<CommandDialect, Readonly<Record<string, OpenerSpec>>>> = {
  posix: {
    open: { valueFlags: ["-a", "-b", "-s", "-u", "--env", "--stdin", "--stdout", "--stderr"], passesArgs: ["--args"] },
    "xdg-open": {},
    gio: { sub: "open" },
    "gnome-open": {},
    "kde-open": {},
  },
  powershell: { "invoke-item": {}, explorer: {} },
  cmd: { explorer: {} },
};

/** What a file runs as when it is opened: these run, and opening one is running it. */
const RUNS_WHEN_OPENED = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|msc|scr|cpl|hta|lnk|pif|reg|jar|sh|bash|zsh|command|tool|app|desktop|appimage|py|pl|rb|run|bin)$/i;

/**
 * What one opener's operands make it: `open_app`, or `script` when any of them would run as a program
 * — and, on a POSIX desktop, any file without an extension, which `open` runs in a terminal when it
 * is executable (a folder — `.`, `..`, a path ending in `/` — opens as a folder). A link opens in
 * its app.
 */
export function openerTool(operands: readonly string[], dialect: CommandDialect): "open_app" | "script" {
  for (const operand of operands) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(operand) || /^mailto:/i.test(operand)) continue;
    if (RUNS_WHEN_OPENED.test(operand)) return "script";
    if (dialect === "posix" && !/^\.\.?$/.test(operand) && !/[\\/]$/.test(operand) && !/\.[A-Za-z0-9]+$/.test(operand.split(/[\\/]/).pop() ?? operand)) return "script";
  }
  return "open_app";
}

/** The opener a program is in a dialect, if it is one. */
export function openerOf(program: string, dialect: CommandDialect): OpenerSpec | undefined {
  const table = OPENERS[dialect];
  return Object.hasOwn(table, program) ? table[program] : undefined;
}

/** The table a dialect reads a program in: its own first, then what every Windows has, then POSIX. */
function systemSpecOf(program: string, dialect: CommandDialect): SystemCommandSpec | undefined {
  const own = (table: Readonly<Record<string, SystemCommandSpec>>): SystemCommandSpec | undefined => (Object.hasOwn(table, program) ? table[program] : undefined);
  if (dialect === "powershell") return own(POWERSHELL_SYSTEM_COMMANDS) ?? own(WINDOWS_SYSTEM_COMMANDS) ?? own(POSIX_SYSTEM_COMMANDS);
  if (dialect === "cmd") return own(WINDOWS_SYSTEM_COMMANDS) ?? own(POSIX_SYSTEM_COMMANDS);
  return own(POSIX_SYSTEM_COMMANDS);
}

/** Is this a program the System table could make a tool, in some dialect? */
export function isSystemProgram(program: string): boolean {
  return Object.hasOwn(POSIX_SYSTEM_COMMANDS, program) || Object.hasOwn(WINDOWS_SYSTEM_COMMANDS, program) || Object.hasOwn(POWERSHELL_SYSTEM_COMMANDS, program);
}

function resolve(spec: SystemCommandSpec, flags: readonly string[], operands: readonly string[]): string | undefined {
  for (const rule of spec.when ?? []) {
    const pattern = new RegExp(rule.flag);
    if (flags.some((flag) => pattern.test(flag))) return rule.tool;
  }
  if (spec.assigning !== undefined && operands.some((operand) => /^[^=\s]+=/.test(operand))) return spec.assigning;
  const sub = operands[0];
  if (sub === undefined) return spec.tool;
  if (spec.subcommands !== undefined && Object.hasOwn(spec.subcommands, sub)) {
    const next = spec.subcommands[sub]!;
    return typeof next === "string" ? next : resolve(next, flags, operands.slice(1));
  }
  if (spec.withOperand !== undefined) return spec.withOperand;
  // A subcommand the table does not name: the command it is.
  return spec.subcommands !== undefined ? undefined : spec.tool;
}

/**
 * The System tool a command is, or `undefined` when it is none — the program is not in the table, or
 * the table does not say what this subcommand of it does.
 *
 * `flags` are the command's flags as written; `operands` its other words in order, the subcommand
 * first. cmd's switches (`/release`) are flags here too: the caller hands them in `flags`.
 */
export function systemToolOf(program: string, flags: readonly string[], operands: readonly string[], dialect: CommandDialect): string | undefined {
  const spec = systemSpecOf(program, dialect);
  return spec === undefined ? undefined : resolve(spec, flags, operands);
}
