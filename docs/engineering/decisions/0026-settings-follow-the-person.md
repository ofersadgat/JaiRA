---
id: engineering/decisions/0026-settings-follow-the-person
type: decision
status: built
updated: 2026-11-19
decides_for: [engineering/decisions/0013-machines, engineering/units/user-settings, engineering/units/project-config, engineering/units/secret-chain, engineering/units/forge-integrations]
---

# 0026. Settings follow the person to every paired machine; what belongs to one machine stays on it

The person, 2026-11-16: "Just as how information about projects/tasks/sessions/etc are synced across
devices, I also want the settings to be synced (where appropriate. e.g. local mcp server doesnt make
sense to sync, but github/gitlab connections, agent login state files, etc. do make sense)".

## Context

- **Tasks and conversations already travel** ([0013](0013-machines.md) §6): every machine with a window
  keeps a copy of the fleet's records, pulled by cursor from each record's owner.
- **Of the settings, only the fleet's own did** (0013 ruling 11): the machine list (introductions) and
  placement rules (`fleet:placement`, newest wins per project). Everything a person sets up — forge
  connections, model routes and presets, MCP servers, permission layers, how the app looks, the keys
  those name, the forge sign-ins, the agents' sign-ins — was set up again on each machine.
- **Where those live on a machine:**
  - `<base>/settings.json` (Shared) and `<base>/personal-settings.json` (Just you), the two settings
    layers in the shared root ([settings-json](../contracts/settings-json.md)). A project's own layer is
    committed with its checkout and already travels by git.
  - JaiRA's keychain (`userData/secrets.json`, Electron's `safeStorage`) and the shared root's
    `.env.local` — the two machine-wide targets of `secret:set` ([secret-sources](../contracts/secret-sources.md)).
    The keychain also holds the tokens this machine holds for the other machines (`jaira.machine.*`).
  - The forge sign-in marks, `forgeSignIns` in `<base>/user-settings.json`.
  - The agents' own sign-ins: Claude Code's in the macOS keychain (`Claude Code-credentials`) or
    `~/.claude/.credentials.json`; Codex's in `~/.codex/auth.json`.
- **Some of it is the machine's.** Where agents run (WSL), how the engine is hosted, the update track,
  a server on this machine (the `local` and `embedded` routes, an MCP server started as a command or
  reached at a loopback address), an agent's binary given as a path, a workflow search path naming a
  folder.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Each file whole, newest wins (as placement rules) | One stamp per file; trivially simple | Two machines changing different things lose one change; a machine's own values ride along and must be stripped and re-added on every write |
| B. Put the shared root in git and let the person sync it | No new mechanism | Secrets cannot go in it; sign-ins are not files there; needs a remote and conflict resolution by hand |
| C. A hub (one machine holds the truth) | No ordering questions | 0013 ruling 11: every machine with a window is equal, there is no hub; an offline hub stops every change |
| D. Piece by piece, newest wins per piece, exchanged peer to peer | Changes to different settings on two machines both survive; the machine's own pieces are simply never pieces; catches up by asking, like replication | A stamp per piece and a merge rule per kind |

## Decision

**D.** It is the only option that lets two machines each change something and keep both changes, and
it is the shape replication already has: equal machines, each asking the others for what it lacks.

### 1. What follows

| Kind | Key | Where it is read and written |
| --- | --- | --- |
| A Shared setting | `base:<path>` | `<base>/settings.json` |
| A Just you setting | `you:<path>` | `<base>/personal-settings.json` |
| A setting of the person's for one project | `projectYou:[<key>, …path]` | `<base>/projects/<key>/personal-settings.json` (amended 2026-11-18, below) |
| A key | `secret:<NAME>` | the keychain where there is one, and `<base>/.env.local` |
| A forge sign-in's mark | `mark:<NAME>` | `forgeSignIns` in `user-settings.json`, without `source` |
| An agent's sign-in | `login:<agent>` | `claude-cli` and `codex-cli`, where each agent keeps it (`agentLogins.ts`) |
| A permission set, workflow or prompt file | `file:[<layer>, (<key>,) …path]` | `permission-sets/`, `workflows/` and `prompts/` in `<base>/`, `<base>/personal/` and `<base>/projects/<key>/` (amended 2026-11-18, below) |

A layer is cut into pieces (`settingsPieces`, `@jaira/shared` `settingsSync.ts`): each top-level block,
each key of a block that is an object (`appearance.mode`, `agents.claudeCli`, `autopilot.askBelow`), and
each entry of the maps whose entries are things of their own (`models.routes`, `models.presets`,
`integrations.forges`, `integrations.oauth`, `mcp.servers`, `permissions.layers`). An event named
`git.push` is one path element; a path is a list, not a dotted string.

### 2. What stays (`isMachinePiece`, `shareable`)

- `execEnvironment`, `engine`, `updates`;
- `models.routes.local`, `models.routes.embedded`;
- an MCP server with a `command`, or whose `url` is a loopback address;
- `workflows` when its path names a folder rather than a layer (`$…`);
- an agent's `command` given as a path: `agents.claudeCli` and `agents.codex` travel without it, and a
  built-in CLI in `agents.genericCli` too; a CLI the person added keeps its path, since an entry without
  a command would not load;
- the keychain's `jaira.*` names — the machine tokens.

A piece that is the machine's is never sent, and a piece that is the machine's HERE is never replaced by
another's. An agent that arrives without a path gets this machine's path put back (`layPiece`).

### 3. Stamps and the exchange (`service/src/settingsSync.ts`)

- **Stamps.** Each piece carries `{at, by}`. A change made here is stamped `max(now, clock + 1)`, where
  the clock is the latest stamp made or heard of, so a change made after hearing of another always wins
  over it, whatever the two machines' clocks say. Ties go to the machine whose id sorts last.
- **The file.** `<base>/system/settings-sync.json` keeps the clock, each piece's stamp and a hash of what
  it held (SHA-256 over canonical JSON) — never a value.
- **Noticing a change.** After every write JaiRA makes (`writeConfig` of Shared or Just you, a key
  stored, a mark written, an agent signed in) the pieces are read again 400 ms later, and once a minute
  for hand edits and for an agent refreshing its own sign-in.
- **The first look.** A piece seen before this machine ever looked is stamped with its file's age (a
  key, as old as anything), so joining a fleet takes the fleet's settings where they changed more
  recently and keeps the newcomer's where they did not. After the first look, a new piece is stamped now.
- **Offer and pull.** What changed is offered to every machine online (`settings:offer`); each takes
  what is newer than its own. On each link coming up, and every five minutes, a machine sends its stamps
  (`settings:pull`) and is answered with what the other holds newer. Both are peer channels, like
  `fleet:placement`: an older JaiRA does not answer them, and nothing breaks.
- **Removals.** A setting or a mark gone from a file that was read is a removal, and travels. A key or
  an agent's sign-in is removed everywhere only when JaiRA removes it — `secret:set` with an empty value,
  a forge signed out, `executor:signOut` — never because it could not be read here: a keychain that will
  not open must not sign every machine out.
- **Checked as a save is.** Pieces for a layer are laid in together and checked with the save's own
  check (`checkConfigWrite`: the layer merged with every other, with each open project); when the whole
  will not load, piece by piece, and a piece that would not load is left out, remembered so it is not
  sent again, logged, and listed under "Not taken". What another machine sends is then written through
  `writeConfig`, so every project re-reads it and availability is checked again.
- **What reads back differently** (a `.env.local` doubles a backslash) is hashed as it reads back, so a
  machine never sees its own write as a change and two machines never pass a value back and forth.

### 4. Agents' sign-ins (`service/src/agentLogins.ts`)

- **Claude Code** on a Mac: the keychain item `Claude Code-credentials` under the user's account, through
  `security`, the program Claude Code files it with, so no prompt asks. Written as hex on `security -i`'s
  standard input, never on a command line. Its `mdat` is the first look's age. A keychain that refuses
  (anything but "not found") stops being asked until JaiRA restarts. A `CLAUDE_CONFIG_DIR` on a Mac files
  it under another name, which is not followed. Elsewhere, `~/.claude/.credentials.json`
  (`$CLAUDE_CONFIG_DIR`). Both hold the same JSON, so a Mac's sign-in lands in a Linux machine's file.
- **Codex:** `~/.codex/auth.json` (`$CODEX_HOME`), written 0600.
- **Agents in WSL** (Windows, `execEnvironment: {wsl}`) are Linux programs and keep the same two files in
  the distro's home. They are read and written there through `wsl.exe -d <distro> -e sh -c …`, the path
  worked out by the distro's own shell (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`,
  `${CODEX_HOME:-$HOME/.codex}/auth.json`), a value going in on standard input and landing 0600 by a
  rename. A distro that is not running (`wsl.exe --list --running`) is not started to be looked at:
  nothing in it can have refreshed a sign-in. One is started to be given a sign-in another machine made.
  Settings says the sign-ins are kept "inside Ubuntu (WSL)". (Amended 2026-11-16: the first build did
  not follow WSL sign-ins at all; the person: "why not?")
- **Not followed, after reading their sources (2026-11-16):**
  - **Gemini CLI** keeps its Google sign-in in the OS keychain through a native module (`@github/keytar`,
    service `gemini-cli-oauth`, account `main-account`). On a Mac, another program reading that item is
    asked about by the system each time. Its fallback, `~/.gemini/gemini-credentials.json`, is encrypted
    with a key made from the machine's host name and user, so a copy cannot be read elsewhere.
    `~/.gemini/oauth_creds.json` is only read once, to migrate an old sign-in into the keychain.
  - **OpenCode** v2 keeps credentials in its own database behind its server; `~/.local/share/opencode/auth.json`
    is read once, when it migrates. `opencode auth export`/`import` exist, but import never replaces a
    credential it has, so a refreshed token would not travel.
  - **Antigravity CLI and Muse Code:** where they keep a sign-in is not known here.

### 5. The switch and what Settings says

- **Settings → Machines → Settings on every machine.** "Keep in step", on by default (`machine.json`
  `syncSettings: false` turns it off; `machines:syncSettings`). Off, a machine neither sends nor takes.
  Turned on, it asks every machine online at once.
- The section lists what is kept on each machine, how the agents' sign-ins fare here, and what was not
  taken and why.
- The layer leads say Shared is "shared by every project on this machine and the machines it is paired
  with", and Just you is kept "on this machine and the machines it is paired with, never in a checkout".

## Consequences

- **Set up once.** A forge connection, its token and its sign-in, an MCP server, a model route and its
  key, the look, the agents' sign-ins: made on one machine, present on all, including a `jaira serve`
  with no window, where runs placed on it need them.
- **Rotating sign-ins can race.** An agent that rotates its refresh token on every refresh (Codex's
  ChatGPT sign-in, Claude Code's) can be refreshed on two machines in the same minute: one machine's
  refresh token is then spent, the later stamp wins everywhere, and the losing machine's agent is told to
  sign in again. Following within a minute makes this rare; it cannot make it impossible. (Amended
  2026-11-19, below: it was not rare, and a machine now keeps its own sign-in while it works.)
- **A sign-out travels.** Signing an agent or a forge out on one machine signs it out on all. That is
  what keeping them in step means; a machine that should keep its own turns the switch off.
- **Secrets travel over the fleet's own link**: the tailnet's HTTPS, to machines holding a token this one
  issued. They land in the other machine's keychain (or its `.env.local` where it has none, as a pasted
  key would).
- **Removals by hand do not travel** for keys and sign-ins (by design, above); for settings they do.

## Not built

- Gemini, Antigravity, Muse Code and OpenCode sign-ins (§4 says why). On Linux, Gemini's keychain item is
  readable without a prompt (`secret-tool`), and on Windows through the Credential Manager; a Mac is
  what stands in the way.
- The shared root's authored files (workflows, functions, skills, permission sets) are not settings and
  do not follow; the window's own state (`user-settings.json` layout, read marks, open projects, log
  policy) does not either. (Amended 2026-11-18: permission sets, workflows and prompts do now, below;
  functions and skills still do not.)
- A window that changes a setting does not show which machine last changed it.

## Verified

- `shared/test/settingsSync.test.ts`: cutting, what stays, the agent path rules, loopback, laying a
  piece in, removal pruning, the machine's own never replaced.
- `app/test/settingsSync.test.ts`, two engines paired on loopback: Shared and Just you settings both
  ways with each machine's own kept; two changes to different settings both kept and the later of two to
  one; a key, a forge mark and a cleared key; an agent's sign-in, its refresh and its sign-out, and none
  into a store this machine cannot reach; turned off and back on, catching up; a piece that would not load, refused and
  said; the sync file holding no value.
- `app/test/agentLogins.test.ts`: the files, their mode and variables; the keychain read, its age, the
  hex write on standard input, signed out, refused; inside WSL, through a stand-in `wsl.exe` that runs the
  real `sh` scripts against a home of its own: written 0600 with the value on standard input, read with
  its age, removed, the distro's own `CODEX_HOME`, a stopped distro not started to look, back to this
  machine's files when the agents stop running in WSL, and no WSL off Windows.
- `security -i` with a quoted service name and `-X` hex, `-U` updating, `-w` reading back and exit 44
  for a missing item: tried on a throwaway keychain on macOS 26.
- In the real app (`shots/settings-sync.mts`), the desktop paired with a second base root's `jaira serve`
  on loopback: a forge connection, a remote MCP server and a look saved in the window land in the other
  machine's files; the window's loopback MCP server does not, and the other's command-started server and
  WSL setting are untouched; a hand edit there reaches the window, without its WSL setting; Settings →
  Machines draws the section, last in step just now. 10/10.
- Found on the way: a removal made through JaiRA was offered only when the next look also found a
  change, so a sign-out waited for the five-minute pull; it is now offered with the next look whatever
  that finds (seen once under the full suite's load).
- **Not seen:** two real machines on a tailnet, Claude Code's real keychain item read by JaiRA, and the
  real `wsl.exe` on Windows (how it passes the quoted `sh -c` script is taken on trust).

## Amended 2026-11-17: a machine has a layer of its own

Settings names whose settings a page edits by a path, `Settings › [project] › [machine] › [Just you]`
(`ui/components/settings-header`), and a machine in the path is a layer of its own: `machine-settings.json`
in that machine's shared root, read over the projects' and under the person's, and a project on one
machine, `.jaira/settings.local.json` in that workspace. Neither syncs — they are the machine's by
definition, so no piece of them is cut or sent — and Settings reads and writes them on the machine they
belong to (`config:read` / `config:write` with `machine`, forwarded by `Federation.route`).

- **The machine's own blocks.** `execEnvironment`, `engine` and `updates` stay machine pieces wherever they
  are written (`isMachinePiece` is unchanged), and are still read from Shared and Just you, where earlier
  builds kept them. About now writes the update track and the engine's hosting to this machine's layer,
  taking them out of Just you as it does (a value there would otherwise win, Just you being more specific);
  `execEnvironment` is a row like any other and lands in whatever layer the path names — the machine's or
  the project's on the machine when a machine is in it. `machineSettings` (the frame, the updater, how the
  engine is hosted) reads built in, Shared, the machine's and Just you.
- **The person's settings for one project** (`projects/<key>/personal-settings.json`, keyed by the
  repository identity) stayed on the machine they were written on: syncing them meant a piece keyed by
  project as well as path, which this exchange did not have yet. It does since 2026-11-18 (below).
- **An older peer** reads the new layers as nothing, and would write them into Just you's file; Settings
  does not write them through an engine whose view has no `machineFile`.

## Amended 2026-11-18: the person's settings for one project follow too

`Settings › atlas › Just you` is the person's, like Just you, so it follows them like Just you.

- **A piece keyed by project as well as path.** `projectYou:["github.com_me_atlas","appearance","mode"]`:
  the first element is the project's settings key (`projectSettingsKey`) — its repository identity with
  unsafe characters made `_`, the same in every clone on every machine — and the rest the path, cut as any
  layer is (`settingsPieces`), the machine's own pieces left out (`execEnvironment` in it stays, as in
  Just you). Laid in, checked and written a project at a time, through the same steps as Shared and Just
  you: checked with every workspace of that project open there laid in (`checkConfigWrite`), or over the
  layers every project has when none is open; written through `writeConfig` where a workspace of it is
  open, so it is re-read at once.
- **Which projects.** A machine offers the projects it has a workspace of whose key comes from a
  repository identity (the engine's `projectKeys`), and keeps in step every project another machine has
  sent it. **A clone with no remote keeps its file on its machine:** its key is its folder's name and a hash
  of where it is on that machine, which names nothing on another — and the same path on two machines
  would name two different projects by one key.
- **Not cloned here.** A project another machine sends that has no workspace here is written to its key's
  file anyway, and kept in step from then on: a clone made later reads it at once, and a hand edit to that
  file still travels.
- **What arrives is checked.** A key that is not one folder name (`isProjectSettingsKey`: only
  `A–Z a–z 0–9 . _ -`, no leading dot) is passed over and said, so nothing is written outside `projects/`.
- **Older machines.** A kind of piece a machine does not know is passed over (`kindOf` answers nothing for
  it), so an older JaiRA ignores these, offered or answered, and keeps working; a newer one passes over a
  kind added after it the same way.
- **Settings says** the person's settings for a project are kept "on this machine and the machines it is
  paired with (a clone with no remote keeps them on its machine)"; Settings → Machines lists the
  no-remote case among what stays.

Verified: `app/test/settingsSync.test.ts` — two clones of one repository on two engines paired on
loopback (one by an ssh remote, one by https), a setting each way, the machine's own kept, a run there
reading it, a clone with no remote not sent; a project not cloned on the other machine, kept and read once
cloned, a hand edit there travelling back; a piece of an unknown kind and a key reaching out of
`projects/` passed over. `shared/test/settingsSync.test.ts`: which keys are taken.

## Amended 2026-11-18: permission sets and workflows follow too

A permission set made or changed on one machine under Shared, Just you or you in a project is the
person's, like the settings beside it, so it follows them like those settings. So do workflows — the
automations Settings gives the person's layers, and the states they are made of — and the prompts a
workflow names.

- **What follows: whole folders, by an allow-list** (`SYNCED_FILE_FOLDERS`, `@jaira/shared`
  `settingsSync.ts`): `permission-sets/`, `workflows/` and `prompts/` in the roots of the three layers
  that follow — Shared (`<base>/`), Just you (`<base>/personal/`) and you in a project
  (`<base>/projects/<key>/`, `fileLayers.ts`) — every file in them at any depth, whatever its name, so a
  workflow added to a layer later travels without a change here. `prompts/` is in because a workflow's
  `$/prompts/…` is searched along the same roots: a workflow that came without its prompt would not load.
- **What never does.** Nothing else under a root is read to be sent. `<base>/` is also where the machine
  keeps its database, logs, sessions, keys and run state (`system/`), its own layer (`machine/`), its
  secrets (`.env`, `.env.local`), the window's state (`user-settings.json`) and its own settings
  (`machine-settings.json`): none of it is in a synced folder. The machine's two layers keep their
  files — `<base>/machine/` and `<project>/.jaira/local/` — and a project's own `.jaira/` travels by
  git. `functions/` and `skills/` stay too: they hold code and what it depends on, and a module must be
  approved on each machine it runs on anyway (`machine.key`). Inside a synced folder these stay: a
  hidden file (`.env`, `.DS_Store`, an editor's swap file), an editor's backup (`~`), a name a machine
  might not hold (`<>:"|?*`, a control character, a trailing dot or space, `CON`, `NUL`, …), a file more
  than twelve folders deep, `node_modules`, a link (never followed, to a file or a folder, inside the
  folder or on the way to it), and a file over 1 MB. A file left out for its size or as a link is said
  once in the log (`machines`), and is not a removal: the other machines keep what they had.
- **A piece per file.** `file:["you","permission-sets","work","careful.json"]`, and for a project
  `file:["projectYou","github.com_me_atlas","workflows","release","start.json"]` — the layer, the
  project's settings key for the person's own in one, and the path under the layer's root. Its value is
  the file's bytes (`{base64}`); the sync file keeps only a hash, as for a setting. The same stamps, the
  same offer and pull, the same peers and pairing, the same rule: the latest change to a file wins, a file
  gone from a folder that was read whole is a removal and travels, and a file this machine wrote is hashed
  as it wrote it, so it is never news here and never sent back.
- **The first look** at a machine's files is stamped by each file's age, also on a machine that had
  looked at its settings long before files followed (`lookedFiles` in the sync file), so the newer of two
  machines' copies wins rather than the one looked at last. A project's files first kept in step since
  then are stamped by their age too, as its settings are.
- **Noticing a change.** Every local write that says workflows changed (`store:invalidate` of
  `workflows`: a set saved, a file written, deleted or moved in Files, a workflow written) asks for a look
  400 ms later; a hand edit is noticed by the minute's look. Another machine's news relayed here does not
  ask: nothing on this disk changed.
- **Written whole, as they are.** A file is not a setting and is not checked: what is broken on one
  machine is broken on the other, as a copy would be. It is written beside itself under a hidden name and
  renamed into place. A project's files are written under its key whether or not it is cloned there,
  and kept in step from then on.
- **What arrives is checked** as a path. A key is taken only when its layer is one of the three, its
  project key is one folder name (`isProjectSettingsKey`), and every name on its path is one a synced
  folder holds (`isSyncedFilePath`) — so no `..`, no separator, no absolute path. Then every folder on
  the way down from the shared root is looked at: a link there, a file where a folder should be, a folder
  where the file should be, a name already there in another case (the same file on a disk that ignores
  case) or a file here over 1 MB, and it is not written. Each is passed over, logged and listed under
  "Not taken".
- **Older machines** pass over a `file` piece (`kindOf`), offered or answered, and keep exchanging
  settings; they never hold one, so they never send a file's removal. A newer machine answers an older
  one's pull with its files every time, and the older one drops them.
- **Settings → Machines** says the settings "with their permission sets and workflows" follow, and lists
  among what stays the machine's own layers' files, functions and skills, and a file over 1 MB.

Found on the way: a `store:invalidate` with no `project`, published on one machine, is relayed by every
paired machine back to the one it came from (`Federation.relay` drops only news about another machine's
projects), so it goes back and forth for as long as both are up — one Shared settings save on two
engines paired on loopback was 2,200 workflow invalidations on each in two seconds. Not fixed here; it is
why the look above is asked for only by local news (`publish(message, relayed)`): asked for by every
relayed one, its 400 ms wait never ended.

Verified: `app/test/settingsSync.test.ts`, two engines paired on loopback — a set made through JaiRA in
Shared, a set, a workflow and a prompt made by hand in Just you, a set and a workflow in you in atlas,
each reaching the other machine and listed there under its layer; each edited by hand on the machine that
had only received it and travelling back; deleted by hand and through Files, and gone on the other; then
neither machine finding news in its own writes. A project's files written on a machine without a clone,
listed once it is cloned, and a hand edit there travelling back. Two copies of one set from before files
followed, the newer kept on both. Nothing sent from `system/`, `machine/`, `functions/`, `skills/`, a
folder no layer syncs, a hidden file, a file over 1 MB or a link (a file, and a whole `prompts/`), each
said once; a set grown past the cap neither sent nor removed. Refused: `..`, a folder that is not synced,
an absolute name, a project key reaching out of `projects/`, a layer that does not follow, a value that is
not a file's bytes, and a write through a link out of the folder. A stand-in older machine that passes
over files: settings still travel both ways and the newer machine's set stays.
`shared/test/settingsSync.test.ts`: which paths are taken. **Not seen:** two real machines, a disk that
ignores case, Windows.

## Amended 2026-11-18, later: automations in all six layers, and what follows of them

Automations now have the settings' six layers, most specific wins (decision 0023, amended 2026-11-18,
later): each layer's root keeps them under its `workflows/system/events…`. What that means here:

- **Shared's, Just you's and you-in-a-project's automations follow the person**, because they are files
  in a `workflows/` folder those three layers already send (above). An automation kept for Just you runs
  on every machine of the person's, spliced into each project's events task there.
- **This machine's and the project on this machine's stay on the machine** (`<base>/machine/workflows/`,
  `<project>/.jaira/local/workflows/`), as their settings and permission sets do. A copy in a layer that
  follows may name one of them as the layer under it (Just you's names `$PROJECTMACHINE`); on a machine
  where that layer holds nothing, it reads as passing the layer under it through, so the copy still loads.
- **A paired machine in the path** is that machine's, for automations as for settings: Settings → Tools
  reads and writes its layers there, and its events status is its own watcher's (`automations:*` and
  `events:status` carry `machine`, forwarded by `Federation.route`). An engine from before has no
  `automations:*`; its page reads as having none.
- **"Add to" and "save this stack as a set"** may now write Just you's or you-in-a-project's file, and so
  a line or a set that follows the person; written into this machine's or the project on this machine's,
  it stays.

Verified: `app/test/federation.test.ts` — a paired machine's events status (its root's remote, which this
machine's root has not) and its automations, read and written there and not here.

## Amended 2026-11-18, last: every workflow in the person's layers follows

Every workflow is found along the settings' six layers now, not only automations (decision 0023,
amended 2026-11-18, last). So any workflow a person keeps in Just you (`~/.jaira/personal/workflows/`)
or for one project (`~/.jaira/projects/<key>/workflows/`) — not only an automation — runs on every
machine of theirs: those folders already follow (above). A workflow kept on this machine
(`~/.jaira/machine/workflows/`) or in the project on this machine (`.jaira/local/workflows/`) stays on
it. With a paired machine in Settings' path, a workflow read or written from Settings is that machine's
(`workflow:read`, `:write`, `:delete` carry `machine`, forwarded by `Federation.route`).

Verified: `app/test/federation.test.ts` — a paired machine's workflow, read, written and deleted there
and not here.

## Amended 2026-11-19: a sign-in that works is kept; one that does not is neither sent nor taken

What happened. On 2026-11-18 at 14:22 the Mac offered its Claude Code sign-in, and the Windows machine
laid it over its own `.credentials.json`; the two then held one refresh token. The Mac's JaiRA closed at
14:31, and Claude Code on the Mac (run outside JaiRA) went on refreshing, spending that token. At 23:07
Claude Code on Windows tried it, was refused, and emptied both tokens in its file, keeping the account
(`"accessToken":"","refreshToken":"","expiresAt":0`, `accountUuid` and the plan kept). Windows' JaiRA
read that as a changed sign-in, stamped it, and would have handed it to the Mac — signing the Mac out —
the next time the Mac's JaiRA came up. Settings said "not signed in — 'claude' responded".

The person's rules, 2026-11-19:

1. **A sign-in that is signed out or not working is never sent, nor taken.** `loginStateOf`
   (`agentLogins.ts`) reads what an agent keeps without saying a token: Claude Code's is usable with a
   refresh token not past `refreshTokenExpiresAt`, or an access token not past `expiresAt`; Codex's with
   a key, a refresh token or an access token. The sync reads a sign-in that is not usable, or that this
   machine's check or a run found not working (`loginWorks`: the last check said `needs-sign-in`, or a
   run's call was refused), as not there — which for a sign-in is never a removal, so nothing is sent
   until it works again. One arriving from an older JaiRA is passed over and listed under "Not taken"
   ("it is signed out or expired").
2. **A sign-in that works here is not overwritten.** Another machine's newer one is passed over, quietly,
   while this machine's is usable and not known to be broken. Each machine refreshes its own copy, so
   neither spends the other's.
3. **One that stops working takes another machine's.** When the check finds the agent's sign-in lapsed
   (below) or a run's call is refused, the engine (`recoverSignIn`, at most once a minute per agent)
   asks every machine online for its sign-in — `settings:pull` with that one stamp left out and
   `keys: [<key>]`, which an older JaiRA ignores and answers whole — and lays in the newest that is
   usable and differs from the one here, even one passed over earlier; then checks again. Nothing
   different anywhere is nothing taken, so a sign-in that fails everywhere is not passed back and forth.
4. **"Sign in again", not "Sign in".** A `needs-sign-in` check whose sign-in on file still names its
   account (Claude Code's `accountUuid`, Codex's `account_id`) is `lapsed`: the row says "sign-in
   expired" with Sign in again, its detail that the sign-in "no longer works: it expired or was
   revoked", and the conversation's error and the composer's button say to sign in again. One with
   nothing on file is "not signed in", as before. The check's own detail now says what it asked
   (`'claude auth status --json' says it is not signed in`), not "'claude' responded".

Unchanged: a sign-out made through JaiRA still travels (Consequences, above) — it is a removal, not a
sign-in. A machine whose agent was signed out in a terminal has nothing usable, so it takes the next
sign-in another machine sends, as before.

Verified: `app/test/settingsSync.test.ts` (a working sign-in kept and another's passed over; taken once
it stops working; asked again with nothing different, nothing taken; a wiped, expired or refused sign-in
neither sent nor taken), `app/test/agentLogins.test.ts` (`loginStateOf`, with the file seen on Windows),
`app/test/lapsedSignIn.test.ts` (the row, its button, the + box and the conversation's error). Not run:
two real machines, or a real refused refresh.

## Revisit when

- An agent's sign-in is refused on one machine within minutes of a refresh on another more than rarely:
  then a sign-in should be refreshed by one machine and handed to the rest, not refreshed by each.
- A setting turns out to differ by machine for a reason this list does not name: add it to
  `isMachinePiece`.
