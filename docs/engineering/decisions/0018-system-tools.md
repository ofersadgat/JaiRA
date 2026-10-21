---
id: engineering/decisions/0018-system-tools
type: decision
status: built
updated: 2026-10-20
decides_for: [engineering/units/tool-policy, engineering/units/host-tools]
---

# 0018. System tools

Amends decision 0007 (§3 and §4, and its amendment of 2026-10-20). Mockup — the real Settings →
Tools card as shipped, and the same component drawn over the proposed vocabulary:
https://claude.ai/artifact/N1wWRE6eKUz36ybZuKWuZh. Built 2026-10-20 — see Built, at the end, for where it
departs from the text above.

## Context

The person, 2026-10-20: "we should probably have another category for system. that can include tools
that involve things like system use. e.g. tools which would traditionally be done with claude work
would belong in that category." Asked how far it reaches, they chose:

- **Scope:** the machine and its desktop — processes, services, power, settings, installed software,
  the clipboard, opening apps — and driving the desktop: the screen, the mouse and the keyboard.
- **Granularity:** a few subjects, each with its own mode — not one `system` line, not one per action.
- **Look and change apart:** a set can let an agent look at processes and refuse stopping one, as
  `read_file` and `write_file` are apart.
- **Real tools now:** JaiRA implements them and serves them to agents, not only permission subjects
  the shell maps onto.

Today none of this has a place. Of PowerShell's 321 core cmdlets, 139 act on the machine with no
standard tool for it (`powershellCmdlets.test.ts`), and so do `ps`, `kill`, `systemctl`, `shutdown`,
`reg`, `winget`, `pbcopy` and their kind: each is a command of its own name under the `shell` line, so
a set either names every one of them or lets the shell's mode answer for all. Desktop control is
reachable only through an MCP server, whose tools answer to their own lines and to `other`.

## Decision

### 1. A System category of eight areas, each with a look and a change tool

`TOOL_CATEGORIES` gains `system` — "System: this machine and its desktop: processes, services,
software, settings, the clipboard, apps and the screen" — between Execution and Web.

| Area | Look | Change |
| --- | --- | --- |
| Machine | `read_system` — what the machine is: OS, hardware, disks, network, users, logs | `power` — restart, shut down, sleep, sign out, lock |
| Processes | `list_processes` — the programs running, and what each uses | `stop_process` — stop a running program |
| Services | `list_services` — the services, and whether each is running | `control_service` — start, stop, restart, enable, disable |
| Software | `list_software` — programs, packages and modules installed | `install_software` — install, update, remove |
| Settings | `read_settings` — the registry, preferences, environment, time and time zone | `write_settings` — change one |
| Clipboard | `read_clipboard` — what is on it | `write_clipboard` — put text or an image on it |
| Apps & windows | `list_windows` — the apps and windows open | `open_app` — launch an app, open a file or link in its app, focus or close a window |
| Screen & input | `screenshot` — the screen, or one window | `control_input` — move and click the mouse, scroll, type, press keys |

Each is a standard tool: a line in every permission set, offered when present, and the subject the
shell's commands and an agent's own tools are judged as (§3, §4).

### 2. They are JaiRA's tools, served to every agent

Served as JaiRA's other tools are: injected into Claude, over the MCP bridge to codex, gated before
they run. Each runs on the machine the engine runs on, with no native module — PowerShell and the
programs every Windows has, and on macOS and Linux their own commands — so the packaging and the
licence page gain nothing.

- `read_system` — Node's `os`, and the OS's own: the registry and .NET on Windows (not WMI: a hung WMI
  is what hangs `taskkill`), `sw_vers`/`system_profiler` on macOS, `/etc/os-release`, `lsblk`, `ip`
  on Linux. Logs: `Get-WinEvent`, `log show`, `journalctl`, filtered and bounded.
- `list_processes` / `stop_process` — the toolhelp walk `killTree.ts` already has on Windows, `ps`
  elsewhere; stopping is `killTree`. JaiRA's own engine, app and agent processes are refused.
- `list_services` / `control_service` — the Service Control Manager (`Get-Service`, `sc.exe`),
  `systemctl`, `launchctl`. A service that needs an administrator says so instead of failing silently.
- `list_software` / `install_software` — `winget` and PowerShell's modules on Windows, `brew` on macOS,
  the distribution's manager on Linux.
- `read_settings` / `write_settings` — the registry and the user's persistent environment variables,
  time and time zone on Windows; `defaults` and `systemsetup` on macOS; `gsettings` and `timedatectl`
  on Linux.
- `read_clipboard` / `write_clipboard` — text and images: `Get-`/`Set-Clipboard` and .NET's clipboard,
  `pbpaste`/`pbcopy`, `wl-paste`/`wl-copy` or `xclip`.
- `list_windows` / `open_app` — the desktop's windows (`EnumWindows` through `Add-Type`, as the
  toolhelp walk is), `ShellExecute`/`Start-Process`, `open`/`osascript`, `wmctrl`/`xdg-open`.
- `screenshot` — the whole screen, one monitor or one window, kept with the task as a file (as a
  downloaded CI artifact is) and handed back to the model as an image, scaled so its long side is at
  most 1568 px. `screencapture`, `grim`/`gnome-screenshot` elsewhere.
- `control_input` — the action set the computer-use tool defines, which models are trained on:
  `mouse_move`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`,
  `left_click_drag`, `scroll`, `type`, `key`, `hold_key`, `cursor_position`, `wait`, in the
  coordinates of the last `screenshot`. `SendInput` on Windows; on macOS, CoreGraphics events through
  JavaScript for Automation (see Built: nothing to install).

### 3. The shell's commands are the same tools

As `cat` and `Get-Content` are `read_file`, the shell's system commands are the System tools, in every
dialect — so a set's `stop_process` line holds `kill`, `taskkill` and `Stop-Process` alike.

| Tool | POSIX | PowerShell | cmd |
| --- | --- | --- | --- |
| `read_system` | `uname`, `hostname`, `uptime`, `df`, `free`, `lscpu`, `journalctl`, `dmesg`, `sw_vers` | `Get-ComputerInfo`, `Get-HotFix`, `Get-EventLog`, `Get-WinEvent`, `Get-Volume` | `systeminfo`, `ver`, `ipconfig` |
| `power` | `shutdown`, `reboot`, `poweroff`, `systemctl reboot\|poweroff\|suspend` | `Restart-Computer`, `Stop-Computer` | `shutdown`, `logoff` |
| `list_processes` | `ps`, `pgrep`, `top -b` | `Get-Process` | `tasklist` |
| `stop_process` | `kill`, `pkill`, `killall` | `Stop-Process` | `taskkill` |
| `list_services` | `systemctl status\|list-units`, `service --status-all`, `launchctl list` | `Get-Service` | `sc query` |
| `control_service` | `systemctl start\|stop\|restart\|enable\|disable`, `launchctl load\|unload` | `Start-`, `Stop-`, `Restart-`, `Suspend-`, `Resume-`, `Set-`, `New-Service` | `sc start\|stop\|config`, `net start\|stop` |
| `list_software` | `dpkg -l`, `rpm -qa`, `brew list`, `apt list --installed` | `Get-Package`, `Get-InstalledModule`, `Get-InstalledScript` | `winget list`, `choco list` |
| `install_software` | `apt`, `dnf`, `pacman`, `brew install\|uninstall`, `npm install -g` | `Install-`, `Uninstall-`, `Update-`, `Save-Module` and their kind | `winget install\|uninstall\|upgrade`, `choco`, `scoop` |
| `read_settings` | `defaults read`, `gsettings get`, `timedatectl status` | `Get-ItemProperty` on a registry drive, `Get-ExecutionPolicy` | `reg query` |
| `write_settings` | `defaults write`, `gsettings set`, `timedatectl set-*` | `Set-`, `New-`, `Remove-ItemProperty` on a registry drive, `Set-Date`, `Set-TimeZone`, `Set-ExecutionPolicy` | `reg add\|delete`, `setx` |
| `read_clipboard` | `pbpaste`, `wl-paste`, `xclip -o` | `Get-Clipboard` | — |
| `write_clipboard` | `pbcopy`, `wl-copy`, `xclip` | `Set-Clipboard` | `clip` |
| `list_windows` | `wmctrl -l` | — | — |
| `open_app` | `open`, `xdg-open`, `gio open` | `Invoke-Item` | `start`, `explorer` |
| `screenshot` | `screencapture`, `grim`, `gnome-screenshot`, `scrot`, `import` | — | — |
| `control_input` | `xdotool`, `ydotool`, `cliclick` | — | — |

`Invoke-Item` moves from `script` to `open_app`. `Start-Process` stays a runner: it opens the program
it starts, which is judged as itself. A registry path given to a file cmdlet (`HKCU:\…`) is a setting,
not a file. A project's own package manager (`npm install`, `pip install` in a venv) stays the command
it is, under the built-in install ask; a global install is `install_software`. What the 139 cmdlets of
`powershellCmdlets.test.ts` that act on the machine become is pinned there, cmdlet by cmdlet.

### 4. Agents' own system tools

Claude Code and codex have no system tools of their own; nothing is displaced. A connected MCP server
that drives the desktop (a computer-use server) answers to its own lines and `other`, as now — see Open.

### 5. What ships

As ruled (see Rulings, 2): every System tool asks, except that `read-only` allows the eight look
tools and refuses the eight change tools, and `full` allows all sixteen. `chat_control` holds none.
(Proposed was `allow` and `smart` in `auto`, and the clipboard and the screen refused in `read-only`.)

### 6. Built-ins

`power` is a built-in ask, as a push is; `install_software` keeps the install ask the shell's managers
have. `stop_process` refuses JaiRA's own processes whatever a set says.

## Rulings (the person, 2026-10-20)

The seven open questions of the proposal, answered:

1. **The card: B** — one row per area, its look and change modes side by side. The category is the
   existing kind (System is a `TOOL_CATEGORIES` entry like Git or CI); the paired row is new, made of
   the pieces every row already uses (the remove control, the name and hint, the mode picker).
2. **"The clipboard is read only. That said, system should default to ask."** Reading the clipboard
   (and, alike, the screen) is a read: `read-only` allows every look tool, refuses every change tool.
   Everywhere else a System tool ships as `ask` — `auto` asks for all sixteen, not `smart` or `allow`.
   §5 is restated to match.
3. **Windows first, macOS right after.** Linux is not asked for: there, a System tool refuses, saying
   it is not built for Linux yet.
4. **WSL: agreed** — the tools act on the machine the engine runs on.
5. **MCP computer-use servers: yes**, as a follow-up once the tools are in.
6. **The band while an agent drives the desktop: agreed** — with Stop.
7. **Names: as proposed.**

### §5 as ruled

| | `ask-first` | `read-only` | `auto` | `full` |
| --- | --- | --- | --- | --- |
| the eight look tools (`read_system`, `list_processes`, `list_services`, `list_software`, `read_settings`, `read_clipboard`, `list_windows`, `screenshot`) | ask | allow | ask | allow |
| the eight change tools (`power`, `stop_process`, `control_service`, `install_software`, `write_settings`, `write_clipboard`, `open_app`, `control_input`) | ask | deny | ask | allow |

A permission set that holds no System tool offers none: the person's own sets need no migration, and
a shell command that is a System tool answers to that tool's line, then to `other`, as `cat` answers
to `read_file`'s.

## Build order

1. **The vocabulary.** The category, the sixteen specs (`unserved` until step 2 serves them), the
   areas (`SYSTEM_AREAS`, look and change per area), the shipped sets, the shell's commands judged as
   the tools (§3), the paired row on the card, the tools' titles and glyph in the conversation.
2. **The machine on Windows.** Fourteen tools — every one but `screenshot` and `control_input` —
   over PowerShell and .NET, no WMI; `stop_process` refuses JaiRA's own processes.
3. **The screen on Windows.** `screenshot` kept with the task and handed to the model as an image
   (the bridge learns to carry an image result: an upstream change), `control_input` through
   `SendInput`, and the band with Stop while it runs.
4. **macOS.** The same sixteen over macOS's own commands.
5. **The docs**, and this decision `built`.

Follow-ups, not in this build: MCP computer-use servers declared as System tools (ruling 5); Linux.

## Built (2026-10-20)

Uncommitted. Windows run on this machine; macOS written and its readers tested, not yet run on a Mac.

**Where it is.** The vocabulary — the `system` category, the sixteen specs (icon `system`), `SYSTEM_AREAS` —
in `shared/toolVocabulary.ts`; the shipped modes in the four `chat/*.json`. The shell's commands judged as
the tools in `shared/systemCommands.ts` (`systemToolOf`, `openerOf`/`openerTool`), read by
`runtime/commandParts.ts`. The tools in `runtime/systemTools.ts` over a `SystemBackend`
(`runtime/system/types.ts`): `system/windows.ts` with `system/powershell.ts`, `system/macos.ts`. The
always-ask in `runtime/policy.ts` (`ALWAYS_ASKING_TOOLS`, the compiled narrowing both gates read; a shell
`power` command is a built-in ask in `judgePart`). Registered in the run and typed-turn paths of
`service.ts`, the CLI and `registerAllTools`. The card's paired row is `AreaRow` (`universal`'s
`permissions/rows.tsx`); a returned picture is drawn under its call (`pictureOf`, `WorkRows.tsx`); the
band is `app/src/main/drivingBand.ts` with `desktop:driving`/`desktop:stop`. Upstream (declarative-ai,
uncommitted): `$images` — `json`'s `TOOL_IMAGES`/`splitToolImages`, `agents-api`'s `valueResult` (MCP
`image` content), `llm`'s `toModelOutput` (`image-data` parts).

**Where it departs from the text above.**

1. **macOS needs nothing installed** (§2, Open 3). JavaScript for Automation (`osascript -l JavaScript`)
   reaches CoreGraphics and AppKit for the windows, the displays and the mouse and keyboard; `screencapture`
   and `sips` take and scale the picture; `launchctl`, `defaults`, `pbcopy`/`pbpaste`, `pmset`, `ps`,
   `brew` the rest. What macOS asks for is permission — Screen Recording for a picture, Accessibility for
   input — and the tools say where to grant it rather than fail silently. Linux: every call answers that it
   is not built there yet.
2. **Some commands stay commands** (§3). A screenshot program writes its picture to a file the line names,
   which a look must not do. `reg export`/`reg save` and `powercfg /batteryreport` write files. cmd's
   `start`, like `Start-Process`, starts a program that is judged as itself. What changes nothing outside
   the line stays no request: `Get-TimeZone`, `Get-ExecutionPolicy`, `Get-Culture`, cmd's `ver`. A
   subcommand the table does not name leaves the program the command it is (`systemctl frobnicate`).
3. **`Invoke-Item`, `open`, `xdg-open`, `gio open`, `explorer` are openers** (§3): `open_app`, unless
   what they open would run as a program — a script or an executable, and on a POSIX desktop a file with no
   extension — which is `script`, as is `open --args`. A registry path handed to a file cmdlet is
   `read_settings`/`write_settings`.
4. **JaiRA's own windows take no input.** `control_input` refuses, step by step, a click on (or keys into) a
   window of JaiRA's own processes — a click there could answer the agent's own approval — and `open_app`
   will not close one.
5. **Stop keeps the agent off.** The band's Stop ends the input call where it stands, and that task may not
   use the mouse and keyboard again until the person next writes to it.
6. **`open_app` launches apps, not interpreters**: a shell, an interpreter or a script host, and a command
   the shell judges as a System tool, are refused, as is a link to any protocol but http(s), mailto, file and
   ms-settings.

**Tests.** `runtime/test/systemCommands.test.ts` (the shell's commands in three dialects, the shipped sets'
verdicts), `systemTools.test.ts` (a fake machine: protection, refusals, coordinates, Stop, always-ask),
`systemWindows.test.ts` (Windows itself, reads only), `systemMac.test.ts` (macOS's readers; reads on a
Mac), `powershellCmdlets.test.ts` (each system cmdlet's tool), `app/test/toolPictures.test.ts`; upstream
`json`'s `toolImages.test.ts` and the `$images` cases in `mcpTools.test.ts` and `llm`'s `tools.test.ts`.

**Not yet.** Run on a Mac; the band seen with an agent driving; Linux. (Ruling 5 is built — below.)

## Ruling 5, built (2026-10-20): an MCP server's tools mapped to JaiRA's permissions

Proposal (with the real components drawn over it): https://claude.ai/artifact/SgQ8gfoVKZ8aLQECHvS6YQ. The
person's rulings on it widened it beyond the System tools:

1. **Any permission.** A server's tool may count as ANY standard tool — the file tools, `shell`, web,
   Git, CI, the System tools — or `screen`. For one that acts on a place, the mapping names which of the
   tool's arguments holds it (`args`), so the scope tables judge it, and one counted as `shell` is taken
   apart and judged part by part.
2. **From the tool itself, else settings.** A tool may say itself what it counts as, in its `_meta`
   (`jaira/tool`, holding a mapping). That is a CLAIM: Connections shows it to accept, and only an
   accepted one — written into the server's `tools` in settings — counts. Without one, the mapping is the
   server's `tools` in settings, edited in Connections' MCP section.
3. **The stricter of the two.** A mapped call is judged by the tool's own line (or its server's) and by
   what it counts as, the stricter kept; where the set names neither the tool nor its server, what it
   counts as answers alone (and `other` only for that, as for any standard tool).
4. **`screen` splits by action** — `screenshot`, `cursor_position`, `zoom` look; every other action is
   `control_input`.
5. **Mapped tools show under their server only**, in a set's MCP section.
6. **JaiRA's own is preferred.** Where a set holds JaiRA's own implementation of what a tool counts as,
   the server's tool is withheld — refused, saying which of JaiRA's to call — unless that line picks
   `native`. So JaiRA's own `control_input`, with its window guard and band, is what drives the desktop.

As built: `mcp.ts` (shared) — `McpToolMapping`, a server's `tools`, `mcpMappingProblem`, `MCP_TOOL_CLAIM`
and `mcpClaimOf`, `mcpMappingOf`, `mappedCallOf` (the action split and the renamed places),
`McpToolInfo.claim`/`inputs`, `McpServerStatus.mappings`; the probe reads each tool's claim and argument
names; `decideMappedMcpCall` in `runtime/policy.ts`, called from the compiled policy's MCP narrowing (both
routes) and from `allowsCall` (the read-only judge), with the configured servers handed to
`compilePolicy` as `mcp`; the service lays the configured mappings over the probe's report, so editing one
starts no server. Connections: `serverSchemaOf` adds "what its tools count as" to the server's schema form
(the places offered follow the tool picked, from the tool's own arguments) and `unacceptedClaims` the
claims to accept; the card: `mappedMcpToolsOf`. Tests: `runtime/test/mcpMapping.test.ts`,
`app/test/mcpMappingModel.test.ts`, the claim case in `mcpServers.test.ts`.
