---
id: engineering/decisions/0026-settings-follow-the-person
type: decision
status: built
updated: 2026-11-16
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
| A key | `secret:<NAME>` | the keychain where there is one, and `<base>/.env.local` |
| A forge sign-in's mark | `mark:<NAME>` | `forgeSignIns` in `user-settings.json`, without `source` |
| An agent's sign-in | `login:<agent>` | `claude-cli` and `codex-cli`, where each agent keeps it (`agentLogins.ts`) |

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
  sign in again. Following within a minute makes this rare; it cannot make it impossible.
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
  policy) does not either.
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

## Revisit when

- An agent's sign-in is refused on one machine within minutes of a refresh on another more than rarely:
  then a sign-in should be refreshed by one machine and handed to the rest, not refreshed by each.
- A setting turns out to differ by machine for a reason this list does not name: add it to
  `isMachinePiece`.
