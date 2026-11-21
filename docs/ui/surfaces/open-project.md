---
id: ui/surfaces/open-project
type: ui-surface
status: shipped
updated: 2026-11-21
kind: dialog
realizes: [ux/patterns/button-says-what-will-happen, ux/patterns/refuse-with-the-reason-and-the-fix]
serves: [product/all-projects-in-one-place, product/parallel-work-without-collisions]
components: []
mockups: []
siblings: [ui/surfaces/sidebar, ui/surfaces/settings-view, ui/surfaces/confirm-dialog]
---

# Open dialog

Opening a project from a forge or a folder on any machine, onto any machine, and adding a workspace of
a project the person has ([0027](../../engineering/decisions/0027-open-anywhere-and-project-setup.md)). A
card over a `--scrim`, `min(1000px, 94vw)` wide and 640 tall, from `+ Open → Open project…`, from the
project crumb's machine menu (`Add a workspace…`), and from Add's card (below). The canvas *Open from GitHub or GitLab* holds the
designs it was chosen from.

## Four steps run across the top and keep their answers

- **The steps.** A row padded 12 20 on `--panel-2` with a `--line` under it: for each step a 20px circle
  (done: `--ok` with `✓`; current: `--accent` with its number; to come: a `--rule` ring and its number),
  the step's name above its answer (10.5 `--dim`, `--accent` and 600 when current; the answer 12.5 600,
  `—` before there is one), and a 1px `--rule` line growing between steps. A finished step can be pressed
  to go back to it. The steps are `Project`, `Where it goes`, `How it gets there`, `Go`.
- **The foot.** A row padded 12 20 under a `--line`: the step before (`‹ Project`, `‹ Where it goes`) as a
  ghost button, then `Cancel`, then the step's primary, which says what it will do — `Next: where it goes`,
  `Next: how it gets there`, `Clone atlas to build-01`, `Copy atlas to build-01`, `Open atlas on
  studio-mini`, `Add atlas-2 to atlas`, `Go to atlas`, `Add build-01`, and at Go `Hide — it carries on` or
  `Done`.
- **Where it stands.** Above the foot, padded 0 20 10, a note says where the project chosen stands among the
  person's (`standingOf`, the person, 2026-11-21) — on `--tint-ok` when it joins one, `--tint-warn` when Add
  refuses it, `--panel-2` otherwise; nothing for a project of its own:
  - a folder of a project the person has, opened where it is: `The same repository as atlas: it becomes
    another of its workspaces, where it is. Nothing is copied.` (copied elsewhere, `the copy becomes another
    of its workspaces`; a repository, `atlas's repository: the clone becomes another of its workspaces.`);
  - a folder already open: `Already a workspace of atlas: opening it goes to it.`;
  - adding, a folder with no git remote: `scratch has no git remote, so nothing says it is atlas
    (github.com/acme/atlas). Adding it asks whether to connect it to that remote or to add it without
    git.` on `--panel-2`; pressing `Add scratch to atlas` asks (below);
  - adding, anything else that is not the project: why — `mist is a workspace of mist, not atlas.`, `scratch has
    no git remote, so it isn't atlas (github.com/acme/atlas).`, `fork is github.com/me/atlas, not atlas
    (github.com/acme/atlas).` — and the primary is disabled.
  The same repository is the identity the sidebar groups workspaces by (decision 0013 §4).

## 1 · Project: a place, then what is in it

- **The column** (proposal 6 of [the eight](../assets/add-workspace/index.html), the person, 2026-11-21).
  232 wide on `--bg` with a `--line` right: `THIS MACHINE` and the paired machines grouped `MACS`, `LINUX`,
  `WINDOWS`, `OTHER` (online first), each with its `MachineIcon` (what it is, what it runs, whether it is
  reached); then `FORGES` — one row per signed-in forge host with GitHub's or GitLab's mark (git's for
  another). An offline machine is dimmed with `offline` at its right. Under the machine chosen, its places
  (`machinePlacesOf`), indented 30 with a 14 glyph: the folder its new workspaces go in (`★`, `projects`),
  the folders holding its workspaces, fullest first (`2 workspaces`), the folders lately chosen there
  (`recent`, kept per device in the layout, six a machine), `Home`, and its other roots; a press browses
  there, and the place browsed is the row marked. Rows are padded 5 8 with radius 6; the chosen one on
  `--tint-accent`, a chosen machine at 600.
- **A machine.** Its folders, read by its engine (`files:browse`), in columns as Where it goes has them:
  the path from `~`, then the folder above, the folder browsed, and the folder chosen. Each folder in the
  middle says what it is — the project it is open in (`atlas · open`), else the project of the person's it
  would join (`atlas`), else `JaiRA project` or `git` — with its mark and a `›`. A press chooses it; `›`
  or a second press goes in. The third column is the folder chosen (or, with none chosen there, the folder
  browsed): its glyph, name, that pill, the repository it is a clone of with its forge's mark, where it
  stands among the person's projects, its path, and `Choose <name>` (or `✓ Chosen`) and `Open ›`. A folder
  chosen is copied **as it is** — everything git does not ignore — or opened where it is.
- **Adding, a folder already there.** A folder of the project that is not yet one of its workspaces is added
  where it is, nothing copied: choosing it takes the target to its machine, and the primary reads `Add
  atlas-2 to atlas` at once. One that is already a workspace is copied to make another, as before.
- **Adding, a folder with no git remote** (the person, 2026-11-21: "ask the user what to do"). It is added
  where it is too, and `Add scratch to atlas` asks first, in a card over the dialog, 460 wide: `scratch has
  no git remote`, `Nothing says it is atlas (github.com/acme/atlas). What should Add do with it on
  build-01?`, then two answers, each a bordered row with its glyph, what it is and what it does — `Connect
  it to github.com/acme/atlas` (the remote as `origin`, the one a workspace of it on that machine fetches
  from, else the forge's https address; `git init` first when it is no repository; nothing fetched) and
  `Add it without git` (that machine's engine keeps the folder as a workspace of the project,
  `~/.jaira/system/joined-workspaces.json`) — and `Cancel`. Either way it then opens there and groups with
  the project (`project:join`). Copied elsewhere it would have no remote either, so another machine is
  refused, saying so.
- **A forge.** Its repositories (`forge:repositories`), most recently changed first, each with `private`
  when it is; a field finds one; the chosen one's branches (`forge:branches`) as buttons under the list, the
  default branch chosen.
- **The project chosen, shown.** Opened with a project already chosen (adding a workspace) or gone back to,
  the step opens where that project is: its forge, the repository and branch chosen; or its machine, at the
  folder that holds it. A forge no connection serves is listed under `FORGES` all the same, `not signed in`,
  its pane the repository chosen and why nothing else is listed. Adding a workspace, the dialog's title names
  the project chosen — another one chosen here, that one.

## 2 · Where it goes: a machine, and a folder on it

- **The column.** As Project's — the machines with their icons, the chosen one's places, which browse the
  pane there — for a folder on a machine, `WHERE IT IS` with that machine and `open it there`; then the
  machines (adding a workspace, the folder is one already: its machine is listed with the rest and takes a
  second, copied beside it), each with its status for this project at its right, from its `workspace:plan`: `ready`
  (`--ok`), `installs node` (`--accent`), `password` (`--warn`), `can't` or `offline` (`--dim`), `…` while it
  is asked.
- **The pane** (proposal 3 of [the eight](../assets/add-workspace/index.html), chosen 2026-11-21). A note
  only when the machine needs a password or cannot set the project up (its readiness is already in the
  column). The path to where it goes, from `~` when under the machine's home, else the root, past four
  folders the middle folded to `…`, each folder a button; the folder it goes in bold on `--panel-2`, then the
  new folder's name in `--accent`. Under it, three columns in one bordered box: the folder above (the folder
  it goes in marked; at a root, the machine's roots), the folder it goes in (its folders, each with a git or
  JaiRA project mark and a `›`, and the new folder among them where it sorts, tinted, with a 2px `--accent`
  bar), and the new folder: its glyph, its name (`atlas`, or `atlas-1` when `atlas` is taken there), `made
  here`, why it is named so (or, `--warn`, that the folder it goes in has one of that name), its whole path,
  and `Rename`, which makes the name a field. A click on a folder in either column puts it there; the plan is
  asked again for that folder (after a pause, so typing a name asks once), and Add waits for it. A pane
  narrower than 560 is one column: the folder it goes in, the new folder under it.

## 3 · How it gets there: what is copied, Bring, Then

- A sentence: `build-01 clones main from github.com, brings .env*.local, then sets it up.`
- For a copy, `Copied from studio-mini`: the branch and its commits not pushed, what is not committed,
  and what is left behind (what git ignores).
- `Bring`, when the setup brings files: the patterns, and `from` — the machines it can take them from, the one
  it will chosen: a copy's own machine first (the folder copied), then each machine holding a workspace of the
  project, the target's own first. The one chosen is sent, so what it says is what happens. With none,
  `There is no other workspace of it to bring them from.`
- `Then`: each step of the setup, numbered, with where it came from under it (`.nvmrc`,
  `.github/workflows/ci.yml · Install deps`) and what it takes on the machine at its right (`✓ 22.11.0
  there`, `installs first`, `needs a password there`, `runs`, `can't: …`). Under it, what is wrong with the
  setup file, in `--bad`. `Found in the project — it has no setup file` when the setup was found.

## 4 · Go: the phases, the steps, what it prints

`Making atlas on build-01` with `Stop`; `Clone` (or `Copy`), `Open as a project`, `Set up`, each `✓`, `◌`,
`✕` or `·`; the setup's steps under them as they run; a note when it stopped or its setup did; and what it
printed in a bordered `--panel-2` box. `atlas on build-01 is ready` when it is.

| State | Shown |
| --- | --- |
| no forge signed in | under `FORGES`: `No forge is signed in. Settings → Connections → Forges signs one in, or \`gh auth login\` / \`glab auth login\` on this machine.` A forge `gh` or `glab` is signed in to is listed as one JaiRA holds a token for. |
| a machine is asked | its status `…`; its pane `Asking build-01…` |
| setup cannot run there | the primary is disabled; the note says which step and why |
| stopped | `atlas on build-01 stopped` and the reason; what was made stays |

## Add's card: the four answers, and one button

`Add` on a machine's row in the project crumb's machine menu (`AddWorkspace.tsx`) opens a card where the
menu stood, in the sidebar's tokens: 400 wide (the window less 16 at most), padding 8, radius 10, on
`--panel` with a `--line` border and the `--lift` shadow.

- **The title.** `Add atlas on build-01`, 12.5 700.
- **The lines.** Each a row padded 7 8, radius 7 (`--fill-ghost-hover` under the pointer): its name in a
  56 column (10.5 600 caps, `--dim`), its answer, and at its right `›` or `▾`.
  - `PROJECT` — the forge's mark and host (`--dim`), the git mark, the project at 600 and `/ main` in
    `--dim`; for a copy, the machine's icon and name and the folder. `›` opens the dialog at Project.
  - `WHERE` — the machine's icon and name, the folder mark, the folder's last three parts in data 11.5;
    under it `atlas is taken there, so atlas-1` when it is. `›` opens the dialog at Where it goes.
  - `BRING` — `.env*.local from studio-mini`, the machine How it gets there would choose first (and Add sends),
    `.env*.local: no other workspace of it to bring them from`, or `nothing git ignores` in `--dim`. `▾` opens the patterns under it.
  - `THEN` — the first two steps and `· 2 more`, or `nothing to set up` in `--dim`. `▾` opens every step
    under it, numbered, with what it takes there at its right.
  - `OR` — `use a folder already on build-01` in `--dim`, `›`: the dialog at Project, on build-01's
    folders, where a folder of the project not yet open is added as it is. Shown until Add is pressed,
    whether or not the plan could be read.
- **The foot.** Under a `--line`: `More…` (the dialog at How it gets there), then `Cancel` and `Add
  build-01`, disabled until the plan is read or when the setup cannot run there.
- **Once pressed.** Bring and Then give way to the job: `Clone` (or `Copy`), `Open`, `Set up` in a row,
  each `✓`, `◌`, `✕` or `·`; the step running; the last line it printed (data 11, `--dim`) — or, when it
  ends, `atlas on build-01 is ready.` in `--ok` or why it stopped in `--warn`. The foot has `Details`
  (the dialog at Go, following the job) and `Stop`, then `Done`.

| State | Shown |
| --- | --- |
| the plan is asked | `Reading the project's setup there…` in `--dim` |
| the plan failed | why, in `--bad`; Add stays disabled |

## The folder chooser

`New project on build-01…` and Settings → Machines → Projects folder → `Change…` (`FolderBrowser.tsx`):
a card `min(1000px, 94vw)` wide and 600 tall — its title (`New project`, `Choose a folder`, `Open a
project`; 15 700, padded 14 20, a `--line` under), the column and the folders in columns as Project has
them, and a foot whose primary names the folder chosen, else the folder browsed: `Make a project of notes
on build-01`, `Use notes on studio-mini`, `Open notes on build-01`. Its third column says what the
primary will do with it.
