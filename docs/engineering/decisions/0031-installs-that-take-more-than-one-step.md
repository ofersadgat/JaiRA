---
id: engineering/decisions/0031-installs-that-take-more-than-one-step
type: decision
status: built
updated: 2026-11-19
decides_for: [engineering/units/agent-executors, ui/surfaces/settings-connections, ui/components/provider-row]
---

# 0031. Installs that take more than one step: Node.js before npm, Homebrew before a cask

## The person's words

The person, 2026-11-19:

> i want you to investigate some of the install methods for commands / agents. I think the system might
> be missing installing two things to get a command/agent to install. E.g. installing node/fpm/nvm and
> then installing gemini cli. we should offer two step installs as well (only installing node if they
> are missing it (and potentially giving them an option for install method).

Asked how, they answered: fnm as the default way to get Node.js; "we should be able to install
homebrew if the user wants it", with the password asked in the system's own window; Node.js installed
for an agent made the default, so the person's own terminal has it too; and of the menu:

> in the dropdown, each row specifies a step. so a single command to install is a single row. So, for
> gemini you might have node as a row and homebrew as a row. if you click on node you get the default
> node installation path. but you can also hover/click on a right arrow button on it to choose how to
> install node. then if there is another step after installing node, those node installation methods
> will have right arrows which allow you to choose the next step.

Asked whether installing a version manager (fnm itself) is a level of the menu or part of the row that
uses it, they chose part of the row: "fnm — installs fnm, then Node.js".

Then, on what was built:

> 1. please make sure to test for an existing nvm/fnm better. the issue is that the environment
> variables for those might not be set correctly, but they might be installed already. 2. why not use
> fnm on windows? cant we make it have a default on windows too? 3. the ui for the right arrow on the
> row looks terrible, make it better. it should look like a single row with a special option to
> customize

## Context

- **A way was offered only when its installer was already here** (`install/plan.ts`). With no npm, the
  npm way was dropped without a word; with nothing left, the panel said "none of the ways it is
  installed is on this machine". On 2026-11-19 that was Gemini CLI on every machine without Node.js
  (npm is its only current way: Homebrew's formula is deprecated and disabled on 2026-12-18, behind npm,
  and Google ships nothing for WinGet or Scoop); Codex on a Linux without Node.js, or a Mac with
  neither Node.js nor Homebrew.
- **Node.js's own ways mostly needed something too**: Homebrew, or a version manager, or root. The
  catalog already knew Node.js's packages and its managers (nvm, fnm, Volta, mise, asdf), but only to
  install a version where a manager was already here.
- **A Node.js too old for an agent** let `npm i -g` succeed and the agent fail at its first run: Gemini
  CLI wants 20 or newer, Claude Code 22 (each package's `engines.node`, read 2026-11-19).
- **sudo cannot be answered here**: an installer runs with stdin closed, so `sudo -n` fails where a
  password is needed — apt and dnf did, and Homebrew's script would.
- **Where things land.** fnm's and nvm's Node.js, and an agent npm installs under it, are in folders
  a Mac app started from the Finder has no PATH to. An agent there is a script its folder's `node` runs.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. A single command per way, with the prerequisite's install written into the way's script | One run, one log | Every pairing of agent, Node.js way and machine written by hand; the npm the second half runs is not known when the script is written (it is under whatever fnm just made) |
| B. A menu of steps, each planned when it starts (chosen) | The installer's existing ways are the steps; the npm a step uses is the one the step before left; the person chooses at each step | A request is a path, not a way; the menu is a tree to draw |
| C. Tell the person to install Node.js themselves | Nothing to build | The case the person asked about stays a dead end |

## Decision

**B.** A way whose installer is missing, but can itself be installed, is still offered — as a row for
what is missing (`Node.js` for npm, `Homebrew` for a formula or cask), whose ways each install it and
then go on. `install/chain.ts` builds the tree from the catalog and the machine, and runs a path through
it a step at a time, each planned from what is on the machine when it starts.

- **The rows.** Each of the vendor's ways in its order: the way itself where its installer is here; else
  the row for what it needs, grouping that thing's ways — collapsed to the one way where there is one
  (Homebrew's is its own installer). A way to get Node.js that needs its own manager first folds it in:
  `fnm — installs fnm, then Node.js`. A row's `next` is the ways to take the step after, the
  recommended first; pressing a row runs it and the first of each `next` on. A row with a choice after
  it is still one row, its customizing a chevron inside it; in the install panel, `Install` with a
  joined `⌄`, as a shelf tile's.
- **Node.js's ways**, the recommended first: a version manager already here (nvm-windows included);
  then fnm, nvm and mise, each installed from nothing — fnm first on every system, Windows too;
  Homebrew's (installing Homebrew first where there is none); WinGet's, Chocolatey's, Scoop's, apt's
  and dnf's where each is here. Volta is not offered from nothing: it announced on 2025-11-14 that it is
  unmaintained, pointing at mise. A Node.js too old for the agent gets the row too (`Node.js 20 or
  newer`), its first way bringing the one here up to date the way it was installed.
- **The default, in the person's own terminals.** Node.js installed for an agent is made the default
  (`fnm default lts-latest`, `nvm alias default 'lts/*'`, `nvm use lts` on Windows, `mise use -g`,
  `volta install`) and reaches the person's terminals: fnm's env and mise's activation are added to
  their shell's profile once (zsh's `.zshrc`, bash's `.bashrc` or a Mac's `.bash_profile`, fish's
  `conf.d`) unless it already has them — fnm's own script writes its line, Homebrew's fnm and mise's
  script do not — and on Windows fnm's default's folder (a junction fnm repoints) is added to the
  person's PATH in the registry. After a step that installs Node.js its version is looked at, and a
  Node.js still too old (a distribution's) stops the install, saying so.
- **A version manager the person's terminal sets up.** nvm is found by `NVM_DIR`, fnm by the PATH its
  profile line adds, the rest by theirs — all set by the person's shell profile, which a Mac app opened
  from the Finder never reads. So the environment a new terminal would have is asked once per process
  (`install/shellEnv.ts`: the login shell's `env`, `$SHELL -ilc`, after a mark; on Windows the user's
  and the machine's variables in the registry, where an installer writes them after the app started)
  and laid under the app's own: its variables where the app has none, its PATH's folders searched
  before the installers' usual places (a program there is still not reached by the bare command), and
  both handed to every installer run, so a manager works in the person's folders, not its defaults.
  Beyond that, more places are looked in without any variable: Homebrew's `nvm.sh` (whose `NVM_DIR` is
  `~/.nvm`, not the folder nvm.sh is in — set explicitly, or Node.js would land in Homebrew's folder),
  nvm under `~/.config`, fnm in its XDG folder and cargo's, fnm's versions with no default made, and
  nvm-windows (`%NVM_HOME%`, `%APPDATA%\nvm`, `%NVM_SYMLINK%`).
- **The password.** A step that needs root asks in the system's own window, never through JaiRA: on a
  Mac, `osascript … with administrator privileges` (Homebrew's signed package, fetched as the person and
  checked by Gatekeeper first, then only `installer` run as root); on a Linux desktop, polkit's
  `pkexec` — Homebrew's prefix made the person's (its script refuses root, and needs sudo only for a
  prefix it cannot write), and apt and dnf. Without a desktop, `sudo -n` as before. Homebrew is offered
  only on Apple silicon: it no longer installs on an Intel Mac.
- **Finding what a step left.** npm is looked for where the Node.js managers keep their default (fnm's,
  nvm's, Volta's, mise's; Node.js's own folder on Windows), and so is an agent npm installs. On Windows
  an installer found only there is run by its path. An agent found beside its own `node` in a folder
  the PATH does not reach has that folder added to the end of the PATH JaiRA runs programs with — by
  the install, and by every check after — rather than its path saved, which would not find that node.
- **The request** names a path of keys (`["npm", "nvm"]`), never a command; a path the machine no
  longer offers is refused, running nothing. A row that is one of the agent's own ways and all there is
  to it still sends the way, and runs as it always did.

## Consequences

- Gemini CLI installs on a bare machine in one press: fnm, Node.js by it, then npm.
- The person sees every command before it runs (a row's title lists the whole path), and each step's
  output under a line naming it (`── Step 2 of 3: Node.js (fnm)`).
- apt and dnf on a Linux desktop now ask for the password in polkit's window instead of failing — for a
  project's setup too.
- Homebrew's package is checked by Gatekeeper, not against Homebrew's own Team ID, which Homebrew does
  not publish; a package signed and notarized by another developer at that URL would pass.
- Only Node.js and Homebrew are prerequisites. Bun, pnpm, Scoop and Chocolatey as things to install
  first would each be one more entry in `chain.ts`.

## Revisit when

- Homebrew publishes its Team ID: check the package against it as well.
- An agent the catalog installs is offered by none of its vendor's ways on a common machine even so.
- fnm's script stops setting up the person's shell, or its macOS script stops working without Homebrew.
