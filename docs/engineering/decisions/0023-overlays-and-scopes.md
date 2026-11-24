---
id: engineering/decisions/0023-overlays-and-scopes
type: decision
status: built
updated: 2026-11-18
decides_for: [engineering/units/tool-policy, ui/components/permissionSet-card, ui/components/composer-setting-chip, ui/components/command-approval, ui/surfaces/settings-tools]
---

# 0023. Layers and places

The person, 2026-11-02, while the approval dialog's per-line panel was being redesigned: "lets do the
full redesign i have in mind instead of just piece meal. … 1. I want to be able to "overlay" a
permission set on top of another. … 2. I want to add a property to permissions: scope. A file
permission might have directory scope. A web permission might have a domain scope."

Mockups: https://claude.ai/artifact/PbWkvqTYHhA3iHZ3kBNGjQ (today's renderings first).

Built 2026-11-02, uncommitted. Every question is ruled, and §7 holds the last four, accepted as
proposed. It was checked in the real app with a real agent (`packages/app/shots/runner-approval.mts`).

## Rulings (2026-11-02)

On round 1, the person: "I think it makes more sense to have mode as something like:
`type PermissionMode = 'allow'|'ask'|'deny'|{[scope: string]: 'allow'|'ask'|'deny'}` that way it
overlays cleanly. … for the overlay, we can have it so that the most recent wins. that way, if you have
{mode: 'deny'} as a base and then {mode: {'C:': 'allow'}} that will allow only C: and deny anything
else. This essentially allows the user to choose the default per tool."

This replaced round 1's "an overlay fills only the asks". A newer layer can now loosen or tighten
anything. Then, on the questions that followed:

1. **Most specific wins across layers.** "this doesnt take power away from the latest layer as it can
   always override the same specific path to make sure it can get what it wants."
2. **Anything that is not `ask`, `allow` or `deny` is a function.**
3. **A bare folder is a path,** meaning that folder and everything under it. Credentials are protected
   by specificity, with no rule of their own.
4. **A fourth mode, `unavailable`:** the tool is not visible to the model.
5. **The order is agreed** (§2.6). The permission selector should also let a person compose layers.

On the mockups that followed:

6. **Everything is a layer**, including the presets: "everything should be a layer including the base
   "ask first" "read only" etc. in fact that should be more visible and easy to switch in this ui."
   There is no separate base. The bottom layer is usually a preset, and switching it must be quick.
7. **The approval panel is 4D**, with deny added. What, Where and How far are chosen first, then the
   answer is a Deny or an Allow button, and How far applies to either: once, this run, or a layer.
8. **The stack lives in the composer**, as joined segments (round 4, design 5). "We can even add
   'tools' as the last layer in that stack." It needs a way to handle a stack too long to show, and a
   way to see a stack's definition. "A stack is just a permission set. The sets might have various
   scopes (i.e. global, project, runtime, etc) but theyre essentially the same otherwise." A bucket
   belongs to the set that is in it, not to the stack: "the 'chat >' folder path at the top is
   actually scoped just to the ask first stack."
9. **Each chip adjusts its own layer** (round 6): "the bottom individual chips open to let you adjust
   that one chip, and there is a tools chip at the end that lets you adjust tools individually using
   the ui that existed previously. perhaps there is a plus chip at the end that allows you to add a
   layer. that said there should also be a way to open the entire combined list to see the full view
   showing everything."
10. **A set is a file, chosen by browsing** (round 7): "each permission set is a file on a path, each
    one has an icon, therefore, selecting a permission set should follow some of the folder browser
    ui. The "contents" of a permission is the tool mappings. That UI should look like what we already
    have in 2, just with anything unset being filtered out."
11. **Compact, with an expanded mode that stays** (round 8): "starts like 5/7, but has a button that
    causes it to toggle to an expanded mode (and stay that way until toggled back) like 2/8." Of the
    eight pairings, the person picked **design 6**.
12. **The last four items are accepted as proposed** (§7): "Yes, as proposed".

## Amended 2026-11-03, after using it

The person, looking at the built stack: "1. the shield button should bring up the full expanded
permission ui … 3. i dont like how runtime and tools are separate. tools should show the full list, but
have the runtime modified elements visually differentiated. 4. swapping permissions / permission sets /
layers / etc should reevaluate the current permission prompts under the new permission strategy. 5.
when the composer gets smaller, the permission pill ui should collapse and be the shield with a +1, +2".
Asked what the shield and the count should be, they picked the browser with the stack in its tree, and
a count of the layers over the bottom plus one for what the conversation changed.

13. **The shield opens the browser, with this stack at the top of its tree**: each layer oldest first,
    then `tools`, above the scopes. A layer picked shows its contents with its crumbs and actions;
    `tools` is the Tools card; a set from a scope can be laid on top. It opens on `tools`.
14. **No `runtime` segment.** The run's answers are counted on `tools` (`tools · 9 · 3`, the count in
    `--accent`), and the Tools card marks each on the line it is about (`this run · allow in packages`,
    with a `×`). The engine's stack still has a runtime layer: an approval's rows still say `this run
    allows`.
15. **Changing the stack decides what waits again.** A layer swapped, added, moved, removed or pinned, a
    run answer let go of, or another call answered for this run: every call of the task still waiting
    on the person is decided again under the stack as it is now (`ApprovalHub.rejudge`, `rejudgeCall`).
    One it now allows or denies is answered, by `permissions` (the record says so); one still asking
    stays, its rows redrawn. A part a function now decides leaves the question as it is. A run's calls
    are decided again only at its root state, and only once the person has picked a stack for it — a
    state's own block is the engine's.
16. **Collapsed**, a narrow composer's stack is one segment: the shield, the bottom's icon and `+n`,
    where `n` is the layers over the bottom, plus one when the conversation has lines of its own or
    this run has answers. Pressed, it opens the shield's browser.

## Amended 2026-11-04: the agent's own folder, and reads the gate allows

The person, 2026-11-04: "many of the permissions are limiting read scope a little too narrowly … claude
codes own files are unable to be read when they should be able to", and on a conversation where a
`read_file` of the agent's memory was refused and the agent's PowerShell `Get-Content` of the same file
then went through: "powershell Get-Content should be the same as read_file, right?". They named the
place `$AGENT_WORKSPACE`, as `$AGENT` "would seem to mean the agent name".

The shell part WAS judged as `read_file`. What differed was everything around the judgement:

17. **A tool a place can narrow is never pre-approved.** A delegated agent pre-approves every tool whose
    mode, read with no input, is `allow`. §3.10 hands the gate a line at its loosest, so under
    `chat/read-only` (`$PROJECT: allow`) `read_file`, `glob` and `grep` were pre-approved, and the
    narrowing never ran on any read: not outside the project, and not at `**/.env`. The engine hands a
    delegated agent its raw tools and its own gate, so nothing else stood in front of them. Upstream's
    `ScopeNarrowing` gains `narrows(tool, block)`, and `ToolGate.modeOf` reports an `allow` that a
    narrowing may tighten as `smart`, which is not pre-approved. JaiRA's narrowings say a tool narrows
    when its line has places, the executor floor holds a tool that acts somewhere, or the tool is a
    shell, an MCP tool or one that always asks. A narrowing that does not say narrows.
18. **A read goes where the gate let it.** `read_file`, `glob` and `grep` refused every path outside the
    workspace on their own, a rule older than places. So a read the set asks about outside the project
    (§7.1) was asked and then refused, and only the shell could reach there. Where a read may go is the
    set's to say, at its places, and the executor floor is the sandbox: these tools now read and search
    an outside path where it is, by the path the call named. `.jaira/` is refused anywhere, `~/.jaira`
    included (until 2026-11-17, §2.4: now the shipped sets' lines refuse writing it). Writes keep the workspace: `write_file` and `edit` place files through the artifact
    destination, which is the workspace's. **Amended 2026-11-11** (the person, of a conversation whose
    `edit` of Claude's memory was refused as "outside the workspace" under `full`): but for the calling
    agent's OWN folder (`$AGENT_WORKSPACE`, ruling 19), which is the agent's and not the project's. A
    write or edit there goes where it is, by the absolute path the call named, placed by no destination;
    whether the call may is the line's, at that place. A call no agent made has no such folder.
19. **`$AGENT_WORKSPACE` is a named place, and each agent declares it.** The person: "the agents
    themselves should declare what their workspaces are. This way, chatgpt can have a different workspace
    than claude." An agent's declaration says the folder it keeps for itself while it works in a folder
    (`AgentToolDeclaration.workspace`). Claude Code: `~/.claude/projects/<the worktree, else the project,
    as the agent spells it>` (memory, transcripts, saved tool results). Codex: its transcripts,
    `~/.codex/sessions` (its memories are a database, not files). Neither is the folder that holds the
    sign-in. The place is resolved per call, for the agent that made it: the agent's wrapper notes its
    declaration against each call's input, so Claude's folder opens to Claude's calls only, and a call no
    agent made (JaiRA's own) has none. The `chat` sets read there at their project
    mode, and `~/.claude/.credentials.json` and `~/.codex/auth.json` join the credential places that ask
    in every set.

Conversations kept before 0023 held the whole map as their composer setting, some with
`{ function: … }` values, and so showed no `chat/…` layer. They were migrated by hand, 2026-11-03: each
became the chat preset it was (a plain decision that the preset now writes as places, at `**` or at
`$PROJECT`, counts as that preset's line), with a tools layer of whatever still differed. The two task
files in this checkout became `chat/full`, and seven chat records' settings became `chat/full` or
`chat/auto`.

## 0. Where this starts

- A permission set maps a subject to a mode (`allow`, `ask`, `deny`, or `{ "function": … }`), with
  `other` for anything it does not name. A call answers to the most specific line that names it: a
  command entry by its words, then the subject, then `other` ([tool-policy](../units/tool-policy.md)).
- A layer's copy of a set is `{ "$ref": "$SYSTEM/…", "shell": "allow" }`: the lower set with these
  lines replacing its own. Nothing else composes two sets.
- Places exist, but never on a line. An executor's `scopes` and a state's `permissions.scopes` are
  place-first tables (`scopes.ts`), which only the feature workflow writes and nothing on screen shows.
  No set says anything about where, so `read_file: "allow"` reads anywhere on the disk except
  `.jaira/`.
- "For this run" answers live in `CommandGrants`: in memory, per task, by width, and never shown.

## 1. A line's value

```ts
type Decision = "allow" | "ask" | "deny" | "unavailable" | FunctionName; // any other string names a function
type PermissionMode = Decision | { [place: string]: Exclude<Decision, "unavailable"> };
```

- **A string is a decision.** The four words are modes, and any other string names a function:
  `"web_fetch": "smart"`. `{ "function": "smart" }` migrates to `"smart"` in every file. The reader of
  the old form is then deleted. No function may be named `allow`, `ask`, `deny` or `unavailable`.
- **An object is a place map**, from a place to a decision: `"write_file": { "src": "allow", "infra": "deny" }`.
  A map speaks only at its places (§3.4).
- **`unavailable`** means the model is not handed the tool at all. It is written on a tool, an MCP
  server or an MCP tool, and on `shell` (no shell at all). It cannot be written on a command, a
  runner, `script` or a place: the model cannot be shown part of a shell, and visibility is per tool,
  not per place. The linter refuses it there. It is what the composer's Tools card writes when a tool
  is unticked over a layer that offers it.

## 2. Layers: the newest wins, line by line

**2.1 A stack of sets, merged.** A conversation or a state is judged under a stack of permission sets,
oldest first. The stack is merged into one set, line by line, and the result is judged exactly as one
set is judged today:

```ts
function merge(lower: PermissionMode | undefined, upper: PermissionMode): PermissionMode {
  if (typeof upper === "string" || lower === undefined) return upper; // a plain decision covers everywhere and clears the places below it
  if (typeof lower === "string") return { "**": lower, ...upper };    // the lower decision becomes the fallback
  return { ...lower, ...upper };                                      // places combine; the same place takes the newer decision
}
```

So a base `read_file: "deny"` under a newer `read_file: { "C:": "allow" }` comes to
`{ "**": "deny", "C:": "allow" }`. Every tool gets its own default, chosen by whichever layer last
says one.

**2.2 A merge is right because newest wins per line.** A newer layer's `git: allow` does not override
an older `git push: ask`, because it did not name `git push`. The merged set holds both, and
`git push`, being more specific, still asks. A newer layer that means otherwise writes `git push`
itself.

**2.3 What a layer leaves out says nothing.** A line a layer does not write falls through to the layers
under it. At the bottom of the stack, a tool no layer names is not offered, as today, and `other` is
the line for an agent's native tools with no equal and for MCP. A layer that writes `other` replaces
the `other` under it, as with any line. A set meant only to add lines should therefore not write one,
and `declOfPermissionSet` stops writing `other` when the set it describes had none.

**2.4 What no layer can change.** The destructive floor, `.jaira/`, a piece the parser cannot read
(which asks at least), and an executor's floor all stand above every layer. **Amended 2026-11-17**
(the person: "if we want an agent to modify the jaira files, that should be a permission layer… simply
a default in the permission sets to exclude write permission to that directory"): `.jaira/` is no longer
among them. Every set JaiRA ships refuses writing `$PROJECT/.jaira` and `$WORKTREE/.jaira`, and reading
the machine key, with lines a layer can change ([tool-policy](../units/tool-policy.md) invariant 3).

**2.5 A layer's copy is a layer.** `{ "$ref": lower, …lines }` is the stack [lower, these lines]. It is
merged by §2.1, so a copy that names one place no longer replaces the whole map below it, as
upstream's sibling replacement would. `resolvePermissionSetDecl`, which already follows `$ref`
itself, does the merge. A set file may also name a stack: `"layers": [ref, …]`, judged oldest first,
with the file's own lines as the newest layer. This is how a composition is saved.

**2.6 The order (agreed).** Every set is a layer (ruling 6), and "the base" in this decision means
whatever layer is at the bottom, usually a preset. Two presets may be stacked like any other two
layers. A stack with nothing in it offers nothing. Oldest to newest:
1. the bottom layer, usually a preset (`ask-first`, `read-only`, `auto`, `full`)
2. the bucket's standing layers, from layered settings:
   `"permissions": { "layers": { "chat": ["$/permission-sets/project/build-safe"] } }`
3. the layers a state names, or the conversation's own (`ChatSettings.permissionSet` gains `layers`,
   kept on the task like the rest of the composer's settings)
4. **runtime**: the answers the person gave in this task, at their widths and places, still in
   memory and still emptied when a run opens the gate
5. **tools**: the conversation's own lines, meaning what the composer's Tools card ticks and moves
   (ruling 8)

Every layer is a permission set (ruling 8). What differs is where it lives, its *scope*: `built in`
(what ships), `global` (`~/.jaira`), `project` (`.jaira/`), `runtime` (this task's memory) and
`this conversation` (the tools layer, kept on the task). A set's id carries its own bucket
(`chat/ask-first`, `app/build`), and the stack has none. In this decision "scope" means where a set
lives, and "place" means where on a line a decision applies.

**2.7 Who said it.** Every answer can name the layer it came from. The merge keeps a provenance per
line and per place, and the approval rows, the card and the composer show it: `build-safe allows`,
`ask-first asks · no layer above names one build`.

**2.8 Where "Add to" writes.** Any layer in the stack, with this project's standing layer for the
bucket as the default. A newer layer can loosen a base, so "this build is safe in this project" can
now hold even under `read-only`. Writing it into `read-only` itself changes that set for every user of
it, and the menu says so.

## 3. Places

**3.1 What a place is belongs to the tool.** Each tool declares the kind of place its calls are about
(`ToolSpec.scope`, beside `pathArgs` and `urlArgs`), so the matcher, the card and the dialog know how
to read and offer them:

| Place | Tools and lines | Read off the call |
| --- | --- | --- |
| path | `read_file`, `glob`, `grep`, `edit`, `write_file`, `show_artifact`, `write_clipboard` (the files it puts on the clipboard; text alone names none); `script` (the file run); `shell`, every command line and `runner:*` (where it runs, and every path it names as a file tool) | the path arguments; a command's working directory and file arguments |
| site | `web_fetch`; network programs in the shell (`curl`, `wget`, `Invoke-WebRequest`) | the URL's host, then path |
| branch | `git_push`, `git_merge`, `git push` in the shell | the remote and branch pushed to, or the branch merged into |
| repository | merge-request and CI tools | `owner/name` on the forge |
| workflow | `start_task`, `move_task` | the workflow id |
| program | `list_processes`, `stop_process`, `read_process`, `wait_process`, `list_windows`, `open_app`, `screenshot`, `control_input`; the shell's process commands | a process's program, by its name or by what the machine says its pid is; a window's process's; the program that has the keyboard |
| host | `runner:ssh` | the host |
| service | `list_services`, `control_service`; `systemctl`, `service`, `sc`, `net start`, `*-Service`, `launchctl`, `brew services` | the service's name |
| package | `list_programs`, `install_program`; the package managers in the shell | the package, by the manager's id (`Git.Git`, `node`) |
| area | `read_system`, `read_settings`, `write_settings`; `reg`, `setx`, `defaults`, the registry cmdlets, `sysctl`, `timedatectl` | a part of the machine, written as a path: what `read_system` reads (`summary`, `users`, `logs/System`), a setting's area, key and name (`registry/HKCU/Software/Foo/Bar`, `environment/PATH`, `time_zone`) |
| machine | `read_clipboard`; and a kind of every System tool's resource | the machine's name, as Settings → Machines shows it; `wsl:<distro>` or `container` for a shell line run there |
| action | `power`; and a kind of `stop_process`, `control_service`, `install_program`, `write_settings`, `open_app`, `control_input` | what the call does: `lock`, `restart`, `stop`, `force`, `uninstall`, `delete`, `keys`, `pointer` |
| none | `web_search` | — (a query names no place) |

A map on a line whose tool takes no place is refused by the linter. An MCP tool the configuration maps
to a standard tool takes that tool's place.

**3.1a Resources** (amended 2026-11-22 and 2026-11-23). The person: "make sure that they all have the
ability to have correct permission scopes … some of those might be process scopes, machine scopes", "think
about the resource that each of these tool is using/accessing and think about what permissions apply to
that resource", and then "the llm can filter/limit its query by scope if it wants, but the point of this is
for permissions … permissions are combined via intersection. i.e. both apply".

- **A System tool touches resources, and a resource has a place of several kinds.** A process has a
  program, an owner and a machine. A window is its process's. A service has a name and a machine; a
  package an id, a manager and a machine; a setting an area, an owner (the user's or the machine's) and a
  machine. What a call does to it is an `action`. The tool's own kind is its `ToolSpec.scope`, and the
  others are its `dimensions`:

  | Tool | Its kind | Its other kinds |
  | --- | --- | --- |
  | `list_processes` (filtered), `read_process`, `wait_process` | program | owner, machine |
  | `stop_process` | program | owner, machine, action (`stop`, `interrupt`, `force`, `tree`) |
  | `list_windows` (filtered), `screenshot` | program | owner, machine |
  | `open_app` | program | owner, machine, action, path, site |
  | `control_input` | program | owner, machine, action (`keys`, `pointer`) |
  | `list_services` (filtered), `control_service` | service | machine; action for `control_service` |
  | `list_programs` (filtered), `install_program` | package | machine; action and manager for `install_program` |
  | `read_system`, `read_settings` | area | machine; owner for `read_settings` |
  | `write_settings` | area | owner, machine, action (`set`, `delete`) |
  | `power` | action | machine |
  | `read_clipboard` | machine | — |
  | `write_clipboard` | path | machine |

- **A line writes a rule map per kind**, and every kind must allow a resource: its answer is the strictest
  of its kinds' answers. Within a kind, the most specific place that matches answers, as one map always
  did. A kind with no `**` of its own answers what it does not name by the line's `**`, else the next
  line (§3.4), so `"action": { "force": "deny" }` beside `"**": "ask"` asks about a plain stop; write
  `"action": { "force": "deny", "**": "allow" }` for "refuse only a forced stop".

  ```json
  "stop_process": {
    "owner":   { "session": "allow", "**": "ask" },
    "program": { "node": "allow", "**": "ask" },
    "action":  { "force": "deny", "**": "allow" },
    "**": "ask"
  }
  ```

  The tool's own kind is also written flat, as before (`{ "node": "allow" }`). The line keeps the other
  kinds' places as `owner=session` and writes them back as their maps; a kind the tool's resources do not
  have is refused, naming the ones they do.
- **What the agent asked for is no permission.** `list_processes`' `scope` and `name`, `list_windows`'
  `app`, only narrow what the call touches. The old `<process tool> --scope=<scope>` lines are read as
  OWNER rules on their tool's line, with a warning; the shipped sets write `"owner": { "session": … }`.
- **Owner.** `session` (this task's processes, as `list_processes` places them), `jaira` (JaiRA's own and
  its sessions', holding a session's), `user`, `system`, and `account:<name>`. One process's owner has
  several names (`user` and `account:ofer`); a place matches its most specific. A setting's owner is
  `user` for `HKCU`, the user's variables and `defaults`, `system` for the other hives, machine-wide
  variables and the time.
- **Machine.** The machine's name, as Settings → Machines shows it. A shell line run inside WSL or a
  container is on `wsl:<distro>` or `container`, and reads no pid of this machine's.
- **Read off the machine, before the gate asks.** A pid's program and owner, a window's, the window that
  has the keyboard and the windows on the screen are read by the task's `MachineFactsCache` (the System
  backend's listings, placed as `list_processes` places them; `/proc` on Linux), in the narrowing's
  `prepare` — declarative-ai's `ScopeNarrowing.prepare`, awaited by `decideToolCall` — and only where
  the set judging the call decides by places on a line of a tool that reaches them.
- **A resource nobody can name could be anything.** A pid that has ended or cannot be read, a window
  that cannot, a name the line decides as it runs: `(pid 4242)`, which takes the strictest answer of its
  kind, and the line's `**` too. The dialog offers no narrower answer than anywhere for it.
- **A list is filtered** (`ToolSpec.lists`: `list_processes`, `list_windows`, `list_services`,
  `list_programs`). It is not judged by what it asked for: the gate is handed its line's loosest answer,
  and the tool judges each row it would show as a resource. A row the set refuses is left out; the rows it
  asks about are put to the person once, named ("the permission set asks about 2 more processes: python
  (user), …"), and shown on a yes; the answer says how many were left out and why. Where nothing on the
  line allows, the gate asked before the call ran, and the rows that ask are shown with it.
- **What cannot be filtered takes the strictest answer of everything it touches**: a picture of a whole
  display (every window on the screen), a pointer step (every window it could reach), a shell's `ps aux`
  (every process: nothing filters what it prints), `read_settings` of a whole key or of every variable
  (`environment/**`: every place under it, and every one holding it).
- **The shell's System commands are read for the same places** (`processTargets.ts`, `systemTargets.ts`):
  - processes: the programs and pids a command names, what it does to them (`kill -9` is `force`), and
    for a command that names a program but no pid, an owner nobody could read. `pkill node` is about
    `*node*` (it stops `nodemon` too); only `-x` or `^node$` names `node`; `pkill -f` is about no one
    program;
  - services: `systemctl <verb> <unit>`, `service <name> <verb>`, `sc <verb> <name>`, `net start|stop`,
    `Start-/Stop-/Restart-/Suspend-/Resume-/Set-Service`, `launchctl`, `brew services`;
  - software: the package managers' verbs and packages, `npm -g`, `Install-Module` and its kind;
  - settings: `reg add|delete|query`, `setx [/M]`, `defaults write|delete|read`, the registry cmdlets,
    `sysctl`, `timedatectl`, `tzutil`;
  - power: `shutdown -r|-h|/r|/s|/l|/h|/a`, `reboot`, `poweroff`, `halt`, `systemctl reboot|poweroff|suspend`,
    `loginctl lock-session`, `Restart-Computer`, `Stop-Computer`, `pmset sleepnow`;
  - openers (`open`, `xdg-open`, `start`, `Invoke-Item`): the file or the link, as `open_app`'s.

  A kind a reader does not read is a place nobody could read, never one the part is not about.

**3.2 Paths.**
- A bare path is that folder and everything under it: `"C:"`, `"src"`, `"~/.ssh"`. A path containing
  `*`, `?` or `{` is a glob. A path that names a file names that file. Relative paths are relative to
  the project, and `$PROJECT`, `$WORKTREE` (the task's), `$AGENT_WORKSPACE` (the agent's own folder for
  the folder it works in, ruling 19), `$TEMP` and `~` are named places.
- **The most specific place wins, whatever layer it came from (ruling 1).** In order:
  1. A place that pins the file beats a folder that holds it. `**/.env` and `*.pem` beat `C:` and
     `$PROJECT`, which is how credentials stay asked about under a broad allow, with no rule of their
     own (ruling 3).
  2. Among folders, the deeper one wins.
  3. Among file patterns, the one with more literal segments before its wildcard wins:
     `src/generated/**/*.ts` beats `src/**/*.ts`.
  4. `**` is the least specific place of all.
  5. The same place in two layers was already settled by the merge, so the newer one stands. Two
     different places that rank the same take the stricter answer.
- A newer layer that wants a place it does not get writes that place itself. To allow a credential
  file, it writes `**/.env`.

**3.3 Sites and branches.**
- **Sites:** `github.com` is the host. `*.github.com` is its subdomains, not the host itself.
  `github.com/anthropics/**` is a host and a path. A host with a path beats the bare host, which beats
  a wildcard host, which beats `**`. `localhost` and IP addresses match exactly or not at all.
- **Branches:** `main`, `claude/**`, optionally with a remote (`origin:claude/**`). An exact name beats
  a glob, and a longer literal prefix beats a shorter one.

**3.4 The line first, then the place, then less specific lines.** A call picks the most specific line
that names it, as today, and then the most specific of that line's places that matches. Where none of
them matches, the call falls to the next less specific line. `"npm run build": { "packages/app": "allow" }`
answers for `packages/app`, and elsewhere `npm run build` is `script`'s, then `shell`'s, then
`other`'s. A `**` entry is how a line gives itself a default. A part with no line naming its program
answers as the file tool it is (`rm x` as `write_file` on `x`), at that line's places.

**3.5 Several places in one call** (`cp a b`, a command's directory and its file arguments) take the
strictest answer, as today.

**3.6 Package scripts.** A package script is judged in its package's directory already
(`scriptRunsOf`). So "this workspace's build is safe", the written form 2026-11-01 left open, is
`"npm run build": { "packages/app": "allow" }`.

**3.7 State tables move onto lines.** A state's `permissions.scopes` becomes place maps on the lines of
the state's set. The feature workflow's five `docs/` folders become
`"read_file": { "**": "deny", "docs/product": "allow", … }`. Then the key and its reader are deleted.
An executor's `scopes` stay as the floor (§7.2).

**3.8 Answers remember a place.** "For this run" and "Add to" keep an answer at a subject width and a
place width. `CommandGrants` keys become (width, place). The dialog offers the place widths it reads
off the call:
- a path: `this file` · `its folder` · `the package` (where a `package.json` is above) ·
  `this project` · `anywhere`
- a URL: `this page` · `the host` · `*.{parent}` · `anywhere`
- a branch: `this branch` · `{prefix}/**` · `any branch`

**3.9 Agents' own tools.** For Claude Code, place maps compile into permission rules (`Read(src/**)`,
`Edit(…)`, `WebFetch(domain:github.com)`), as scope tables do today (`compileClaudeScopeRules`), and
`unavailable` is a removed native. Codex has only coarse switches: a line with places serves JaiRA's
own tool to codex and displaces its native.

**3.10 Gate modes compile loose and narrow per call.** Upstream's narrowing only tightens. So the mode
lowered into `baseline.tools` for a tool is the loosest answer any of its places can give, and the
narrowing works out each call's answer. Shell parts already work this way through `decideCommand`.
A tool whose answer a narrowing may tighten is therefore never pre-approved (ruling 17).

## 4. On screen

All of this is drawn on the mockups linked at the top.

**4.1 The stack lives in the composer (rulings 8–11; round 8, design 6).** The composer's Permissions
chip becomes the stack. It is one joined segment per layer, oldest to newest:
`chat/ask-first ⌄` · `app/build` · `web/docs-sites` · `runtime · 3` · `tools · 9` · `+`.
- **Every segment is a permission set**, named by its full id with its bucket, since a bucket belongs
  to its set and not to the stack. The set's icon shows on its file. The preset is the first segment,
  usually.
- **A segment opens to adjust its own layer**, compact first:
  - The head is the set's path as **crumbs that are pickers**: `Built in › chat › ask-first.json`. Each
    crumb drops what sits beside it: the scopes, a scope's buckets, or a bucket's sets. So swapping
    `ask-first` for `read-only` is two presses.
  - Under the head are the set's **contents**, drawn as the permission set card with places (§4.2),
    filtered to the lines the file writes.
  - Under those are the layer's actions: move earlier or later, pin to this project, edit a copy,
    remove.
- **⤢ expands it into a browser.** The popover widens into a tree of scopes, buckets and files, each
  file with its set's icon, beside the selected file's contents. The crumbs stay above both panes, in
  step with the tree's selection. **Use as this layer** swaps the segment's set. The mode is
  remembered, so expanded stays expanded on every segment until ⤡ is pressed.
- **`runtime`** opens this run's answers, each removable, with `clear`.
- **`tools`**, the last layer, opens today's Tools card unchanged. These are the conversation's own
  lines.
- **`+`** opens the same browser to pick a set to lay on top.
- **The full view** is the `tools` chip's Tools card switched to **Everything**: the merged stack in
  the same rows, each tagged with the layer that decided it, with "save this stack as a set"
  (`"layers": […]`) in its head (§7.4).
- **A stack too long for the composer** keeps its first segment and its last three (`runtime`,
  `tools`, `+`) and folds the middle into `⋯ {n}`. That segment lists the folded layers, and each one
  opens as its own segment would (§7.4).

**4.2 The card's lines take places.** A line with a place map folds like a command group. Its head
reads `{n} places`, and its mode button is the map's `**` where it has one, else
`elsewhere: as {line}`. Open, there is one row per place, most specific first: a glyph for the kind
(file, folder, site, branch), the place in the data face with a named place's words beside it, a minus
and the place's mode button. The last row is `+ add a place`, whose menu offers places of the line's
kind and `another…`. The mode menu gains `unavailable`: "not offered — the agent never sees it".

**4.3 Settings → Tools shows what a stack comes to.** A set's detail gains `Show it in a stack`, a base
picker that draws what each call comes to: the base's answer, the layer's, the result, and who said
it. The bucket heading in the rail lists its standing layers.

**4.4 The approval panel (ruling 7, design 4D).** A line's `asks ⌄` opens a panel of choices that
answer nothing until a button is pressed:
- **What:** `one build` · `every one command`
- **Where:** `packages/client` · `packages` · `this project` · `anywhere`
- **How far**, as radios: `Once` · `For this run` · `Add to [build-safe ⌄]`. The picker lists the
  stack's layers, newest first, and marks the bottom preset as changing that set for everyone who
  uses it. The line it would write is shown before an answer is chosen.
- The panel ends in **Deny** and **Allow**. Pressing one answers the line at the chosen reach, so a
  refusal can be once, for this run, or written into a layer as `"one build": { "packages": "deny" }`.
  A denied line refuses the whole command, and the answers on the other lines are kept.

Each row says who answered or who asked. The bottom Allow / Deny (Continue / Cancel once a line is
answered by hand) stays as the 2026-11-02 rounds set it.

## 5. Build order

1. Values: the `PermissionMode` union, `unavailable`, and functions as strings. Then migrate
   `{ "function": … }` and delete its reader.
2. Places: `ToolSpec.scope`, per-kind matchers in `scopes.ts` with §3.2's ranking, and line → place →
   less specific line in `decideCommand` and the narrowing. Migrate state `scopes` and delete them.
3. Layers: `merge` with provenance, `$ref` copies and `layers` through it, standing layers in settings,
   the conversation's `layers`, and `this run` as the top layer.
4. Agents: Claude rules from places and `unavailable`, and codex displacement.
5. The card: place rows, the add-a-place menu, and `unavailable` in the mode menu.
6. The composer: the stack's segments; a segment's compact popover (crumb pickers, filtered contents,
   actions); the remembered expanded browser; `runtime`, `tools` and `+`; the Tools card's
   Everything switch with "save this stack as a set"; the `⋯ {n}` fold.
7. The dialog: Where, provenance on rows, and "Add to" over the stack.
8. Settings: `Show it in a stack`, and standing layers in the rail.
9. What ships gains places (§7.1).

## 6. Invariants this adds

- A layer's line decides only what it names, and a less specific newer line never beats a more
  specific older one.
- The most specific place decides, a file-pinning place beats any folder, and a place that matches
  nothing falls to a less specific line, never to a guess.
- `unavailable` is never written on a command, a runner, `script` or a place.
- Nothing in any layer reaches past the destructive floor, an unreadable piece, or an executor's floor
  (`.jaira/` left this list 2026-11-17, §2.4).
- Lowered gate modes are never stricter than a per-call answer can be, and the narrowing never widens.

## 7. Settled last (ruling 12)

1. **What ships gains places.** The four `chat` sets get:
   - `read_file`, `glob` and `grep` at the set's mode in `$PROJECT`, `$WORKTREE` and `$AGENT_WORKSPACE`
     (ruling 19), and `ask`
     elsewhere in `read-only`, `ask-first` and `auto`. `full` keeps `allow`.
   - `**/.env`, `**/.env.*`, `**/*.pem`, `**/id_rsa*`, `~/.ssh`, `~/.aws`, `~/.claude/.credentials.json`
     and `~/.codex/auth.json` at `ask` in every set,
     `full` included.
   - In `auto`, `git_push` at `smart`, with `main`, `master` and `release/**` asking.
2. **Executor `scopes` stay a separate floor,** an operator's sandbox no layer widens. An executor
   does not name a permission set as its floor.
3. **Standing layers live in settings, per bucket (§2.6),** not in each set file's `layers`.
4. **The full combined view, and a stack too long for the composer (ruling 9).** Today's Tools card
   gains a head switch, **This conversation** | **Everything** (round 6, design 7). Everything draws the merged stack in the same rows, each tagged with the layer
   that decided it, and holds "save this stack as a set". A long stack keeps its first segment and its
   last three (`runtime`, `tools`, `+`) and folds the middle into `⋯ {n}`, which lists the folded
   layers (round 6, design 8).

## Amended 2026-11-18: a permission set in each of the settings' layers

Settings names whose settings a page edits by a path, `Settings › [project] › [machine] › [Just you]`, over
six layers (decision 0026, amended 2026-11-17). Permission sets were files in two of them — Shared
(`~/.jaira/permission-sets/`) and the project (`.jaira/permission-sets/`) — so with only a machine or Just
you in the path the Tools page read the nearest of those and asked where to write. They now have all six.

- **Where each is.** Each layer has a root holding a `permission-sets/` of its own (`fileLayers.ts`), named
  by its own reference root for a reference that means exactly that copy:

  | Layer | Root | Named |
  | --- | --- | --- |
  | you in the project | `~/.jaira/projects/<key>/` — beside `personal-settings.json` for it | `$PROJECTYOU` |
  | Just you | `~/.jaira/personal/` | `$YOU` |
  | the project on this machine | `.jaira/local/` — beside `settings.local.json`; the `.gitignore` template, and the back-fill before a file lands there, ignore `local/` | `$PROJECTMACHINE` |
  | this machine | `~/.jaira/machine/` | `$MACHINE` |
  | the project | `.jaira/` | `$JAIRA` |
  | Shared | `~/.jaira/` | `$BASE` |
  | what ships | the built-in layer | `$SYSTEM` |

- **Found in the settings' order.** A bare `$/permission-sets/<id>` is searched along that column top to
  bottom — the person over the machine over the project, a project's own over the layer it is the
  project's in — by a run's lowering, the composer and Settings alike: the four newer roots lead the
  project's `roots` on every `$` reference (`referenceRootPath`). A run therefore holds the copy the most
  specific layer keeps.
- **One file wins, whole.** A layer's copy is the set there (§2.5: a copy that names a lower one by `$ref`
  is the stack [lower, these lines]). A copy in a layer that is no project's — this machine's, Just you's,
  Shared — follows Shared's copy or what ships, never a project's (`layerSees`): it is read by every
  project, and `$JAIRA/…` names a different file, or none, in each. So in a project that keeps its own copy,
  a machine's or the person's stands in for it whole. A project's layers (the project, the project on this
  machine, you in the project) follow whatever is under them.
- **Settings → Tools.** The page's layer is the path's: each of the six lists its own sets and those it
  sees under it, writes its own copy on the first change and resets it (`permissionSetLayersOf`). Another
  machine's are read and written there (`machine` on `permissionSets:read`, `:write`, `:reset`, forwarded
  by `Federation.route`). An engine from before lists only `project`, `base` and `system`; on its machines
  the page reads the nearest of those and asks where to write, as Just you did. The composer's set browser
  shows a newer layer's scope once it holds a set.
- **Not stored with the person.** These are files, and files do not follow the person (decision 0026, Not
  built): Just you's and you-in-the-project's sets are kept on the machine they are written on, though
  their settings travel. A clone with no remote keys its `projects/<key>/` by where it is, as its settings.

**What does not fit, and why.**

- **Automations.** An automation is a workflow state — the events root `system/events` and a state per
  line — found by bare id. A bare id is searched along the project's own `workflows/` FIRST: it is the
  directory a state's id is folded against (`workflowRefs.ts`, `searchPathFor`), so nothing can stand in
  front of it without changing every id in the project, and a machine's or the person's layer must stand
  in front of it to win as the settings do. Put behind it, a machine's automations would lose to the
  project's, which is not the settings' order. And the events task runs one copy per project, spliced from
  Shared's (`$BASE/workflows/system/events.transitions`): a chain through six copies is a different shape
  of the editor (`automationsModel.ts`). So automations keep their two writable layers; on a machine's or
  Just you's path the page reads the nearest and asks whether the change goes to the project or to Shared,
  and says why. A paired machine with no project reads and writes that machine's Shared copies there.
  (The person asked for all six the same day; built below.)
- **"Add to" from an approval, and "save this stack as a set".** Both still write the project or Shared.
  The newer layers are read when an approval lists its targets — a copy in one marks the others as not
  read here — but are not offered: the approval's menu names two layers and its answer carries one of the
  two (`ApprovalPermissionSetTarget.layer`). (Built below.)
- **Workflows, prompts and functions** keep their three roots for bare ids; a `$/…` reference to a prompt
  or a type would find a copy in a newer root, which nothing makes.

Verified: `app/test/permissionSetsService.test.ts` — each layer's copy where its settings are, the
`.gitignore` line, the shared root's three; a run's reading going nearest first through all six; a
machine's copy following what ships under a project's own; reset. `persistence/test/configLayers.test.ts`
(the roots and their tokens, the `.gitignore` back-fill), `persistence/test/workflowRefs.test.ts` (the
search order), `shared/test/permissionSetSettings.test.ts` (`layerSees`, a layer's pane),
`app/test/permissionSets.test.ts` (`permissionSetLayersOf`, old and new engines).

## Amended 2026-11-18, later: automations, "Add to" and "save as a set" in all six

The person, on the four things left undone above: automations should have the same six layers as
everything else, with the same rule — most specific wins — and "Add to" and "save this stack as a set"
should write any of them. Built that way, with nothing to migrate: a project and Shared that keep
automations today load exactly as they did.

- **An automation's state, found along the six.** An automation is still a workflow state found by bare
  id, and every other bare id is still searched along the project's own `workflows/` first. For the events
  workflow's own ids — `system/events` and every state under it (`isAutomationStateId`) — the search is the
  settings' column instead: each newer layer's root keeps a `workflows/` beside its `permission-sets/`, and
  a copy of an id there stands in front of the project's (`nearerAutomationStates`, laid over the project's
  files by `loadWorkflowBundle`, so a run, the browser's version of it and the events supervisor agree; and
  first on `loadState`'s path for those ids). An id is the file's path under the `workflows/` it was found
  in, as in every layer, so nothing a project already names moves. So Just you's
  `~/.jaira/personal/workflows/system/events/push_main.json` beats the project's, the project on this
  machine's beats this machine's, and you in the project's beats them all.
- **The events workflow splices along the chain.** Each layer's copy says its own lines, then the lines
  of the layer directly under it less the ones it turns off by name — the `$ref` a project's copy has
  always had for Shared's. The layer under each is fixed (`EVENTS_FOLLOWS`): you in the project follows
  `$YOU`, Just you `$PROJECTMACHINE`, the project on this machine `$MACHINE`, this machine `$JAIRA`, the
  project `$BASE`, Shared `$SYSTEM`. A named root never searches, and the layers between may hold no copy —
  Just you's copy is read by every project, some with a copy on this machine and some without — so where
  one of the five above Shared has none, the loader reads one that only passes the layer under it through
  (`automationsVfs`). Shared's is not made up: a `$BASE` with nothing there still names nothing, and what
  writes any copy writes Shared's first, as before. With no project (the shared root opened as one),
  `$JAIRA` is Shared and `$PROJECTMACHINE` / `$PROJECTYOU` name the machine's and the person's roots, so a
  copy naming them still reads. A layer overrides a line under it by turning it off and saying its own of
  that name, and changes only its steps by keeping its own `system/events/<name>.json`, as a project
  always could over Shared.
- **Unlike a permission set,** a cross-project layer's copy does follow a project's here: an automation
  list is added to, not replaced, and every project reads the chain as it stands in it — this machine's
  lines, then that project's (or nothing), then Shared's.
- **Settings → Tools → Automations** reads, writes and resets the page's own layer, whichever of the six
  the path makes, and shows the lines under it grouped by the layer each comes from. Its files go through
  `automations:read`, `:write` and `:remove` (only `system/events` and below; `.gitignore`'s `local/`
  line before a file lands in `.jaira/local/`), with the project always named, and with a paired machine in
  the path, that machine's — forwarded by `Federation.route`. The question "write this to the project or to
  Shared?" is gone. (Since: the ordinary workflow channels, below.)
- **Events status** with a paired machine in the path is that machine's (`events:status` carries
  `machine`).
- **"Add to"** offers each of the six layers' files of the set, nearest first, and the menu and the
  answer carry any of them (`ApprovalPermissionSetTarget.layer`, `PartAnswer.addTo`: `WritableSetLayer`).
  A layer that is no project's never follows a project's copy (`layerSees`), so over a set only a project
  holds, Just you and this machine are not offered. It still starts on the project's file, else Shared's.
- **"Save this stack as a set"** takes any of the six; the form still starts on this project (or Shared).
- **The Files view** reaches the newer layers' files: `.jaira/local/` is walked in the checkout's tree
  though git ignores it (its rows marked ignored), and Just you, this machine and you in the project are
  roots of their own beside the project once their folder exists — the shared root's folders, addressed
  as its paths, offering file verbs and no state verbs. (Since: every layer a root of its own with its
  states, below.)

Verified: `persistence/test/automationLayers.test.ts` — Just you's state over the project's, the project
on this machine's over this machine's, you in the project's over all, the pinned version moving with a
newer layer's state; the chain spliced through a layer with no copy, a line overridden by turning it off,
a newer layer's copy over Shared alone in a project and in the shared root, and an older project and
Shared unchanged (and `eventsWorkflow.test.ts` as it was). `app/test/automationsModel.test.ts` (the
splice's root, a page per layer, the writes a newer layer's first line makes),
`app/test/settingsLayerFiles.test.ts` (the channels, save-as-set, the Files view's roots),
`app/test/approvalPermissionSet.test.ts` and `persistence/test/permissionSetWrite.test.ts` (Add to in each
layer), `app/test/approvalModel.test.ts` (its menu and default), `app/test/federation.test.ts` (events
status and automations of a paired machine, read there). Seen in the window: `shots/settings-layers.mts`.

## Amended 2026-11-18, last: every workflow in all six

The person: "make all workflows use the six layers too." Automations were one case; now every workflow
is, and automations are that case again rather than an exception.

- **Lookup.** A bare state id — any, not only `system/events…` — is read from the most specific layer
  that has a file for it: you in the project, Just you, the project on this machine, this machine, the
  project, Shared, what ships. The four newer layers' `workflows/` lead the search path, ahead of the
  project's own (`searchPathFor`), and their states are laid over the project's files when a bundle
  loads (`nearerStates`, `loadWorkflowBundle`) — the one door a run, the browser, a task start, the
  composer's workflow list and the events supervisor all go through, so they agree. An id is still the
  file's path under the `workflows/` it was found in, and a root's id is the longest root that holds
  it, not the first, so putting layers in front changes which copy is read and never what an id is.
  Nothing moves: a project and Shared with nothing in the newer layers load exactly as before.
- **Children and references.** A child's state, a `./` reference and a `children[].state` are ids once
  resolved against the referring state's id, so each is found nearest first wherever its parent came
  from. A parent in Just you finds a child the project holds, and one Shared holds; a project's parent
  whose child Just you overrides runs Just you's child; a newer layer's file under a parent's id is
  one of its children by directory, as a project's is. A named root folds back to the bare id —
  `$YOU/workflows/feature/plan/draft` IS `feature/plan/draft`, found nearest first like any other — and
  a bare `$/…` fragment (a prompt, a type) searches the layer roots most specific first, as it already did.
- **Shadowing.** The browser lists every layer's files and marks each copy a nearer one overrides
  `shadowed`, with `shadowedBy`: the layer whose copy is read. The Files view draws every layer as a
  root of its own — a project's checkout, `{project} on this machine` (`.jaira/local/`, now out of the
  checkout's walk), `You in {project}`, `Just you`, `This machine`, Shared when standing in it, `Built in`
  — and a shadowed row says by whom (`shadowed · just you`). Just you and this machine are listed once
  beside several projects, their marks reduced across them as what ships' are.
- **Writing.** `WorkflowLayer` is the settings' six and `system`, so every workflow verb takes any of
  them: `workflow:read`, `:write`, `:delete`, `:move` (copy, rename, "edit a copy"), `:setDisabled`, and
  the path-addressed `file:*`. A project's three need the project named; the others are this machine's,
  whichever project asks. A write into the project on this machine adds `local/` to `.jaira/.gitignore`
  first. A state switched off in a layer that does not hold it follows the nearest layer under it it can
  see — never a project's copy from a layer that is no project's (`layerSees`), as for permission sets.
  The tree's copy verbs offer every other layer after the one they always offered first (Shared's into
  the project, anything else to Shared); a shipped state's row offers `Edit a copy in Shared` and
  `Override here` first, then the four newer layers. Saving a dynamic document as a workflow takes any
  of the six. Defaults are as they were.
- **Scripts, the watcher, the editor, the digest — as in a project.** A newer layer's `workflows/` is read
  exactly as a project's is (`readWorkflowFiles`): its state files and its workflow scripts (`.ts`),
  compiled through the same compiler and cache, a script and a state file of one id refused. Each newer
  layer's whole root — its workflows, permission sets and prompts — is watched; one not on disk yet is
  waited for at the nearest folder above it and taken up the moment it appears, made by a person or
  brought by the settings sync from a paired machine (whose own `store:invalidate` reaches the same
  re-read). The workflow editor's top bar offers, for what ships, `Edit a copy in Shared` and
  `Override here` as links and the four newer layers behind `Elsewhere…`, by the tree's rules. The
  conformance digest shows each state's source from the file it is read from, in whichever layer.
- **Not in every layer:** a description is synced with its workflows in a project or Shared only
  (`workflow:sync` refuses the newer layers, and says so).
- **Automations** use the ordinary workflow channels now; `automations:*` is gone, and the events
  workflow's splicing along the chain (`EVENTS_FOLLOWS`, `automationsVfs`) is unchanged.

Verified: `persistence/test/workflowLayers.test.ts` (an ordinary workflow read from each layer in turn;
the browser's shadow marks; an old project + Shared + built-in unchanged; children across layers — a
parent in Just you with children in the project and Shared, a child Just you overrides under a project's
parent, children by directory, a named root folding to the bare id, a `$/…` fragment),
`app/test/settingsLayerFiles.test.ts` (writing, reading and deleting in each layer, the `.gitignore`
line, copying into a layer, switching off by following, the Files view's roots and shadow marks from a
project and from Shared), `app/test/federation.test.ts` (a paired machine's workflow read, written and
deleted there), the events tests unchanged. Seen in the window: `shots/settings-layers.mts`.

