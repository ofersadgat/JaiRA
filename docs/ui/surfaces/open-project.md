---
id: ui/surfaces/open-project
type: ui-surface
status: shipped
updated: 2026-11-20
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
  studio-mini`, `Add build-01`, and at Go `Hide — it carries on` or `Done`.

## 1 · Project: a place, then what is in it

- **The column.** 232 wide on `--bg` with a `--line` right: `THIS MACHINE` and the paired machines grouped
  `MACS`, `LINUX`, `WINDOWS`, `OTHER` (online first), then `FORGES` — one row per signed-in forge host. An
  offline machine is dimmed with `offline` at its right. Rows are padded 5 8 with radius 6; the chosen one on
  `--tint-accent` at 600.
- **A machine.** Its folders, read by its engine (`files:browse`): roots as ghost buttons, the folder it is
  in, `..`, and each folder with its `JaiRA project` or `git` chip and a `Choose` button (a press on the row
  goes in). A folder chosen is copied **as it is** — everything git does not ignore — or opened where it is.
- **A forge.** Its repositories (`forge:repositories`), most recently changed first, each with `private`
  when it is; a field finds one; the chosen one's branches (`forge:branches`) as buttons under the list, the
  default branch chosen.
- **The project chosen, shown.** Opened with a project already chosen (adding a workspace) or gone back to,
  the step opens where that project is: its forge, the repository and branch chosen; or its machine, at the
  folder that holds it. A forge no connection serves is listed under `FORGES` all the same, `not signed in`,
  its pane the repository chosen and why nothing else is listed. Adding a workspace, the dialog's title names
  the project chosen — another one chosen here, that one.

## 2 · Where it goes: a machine, and a folder on it

- **The column.** For a folder on a machine, `WHERE IT IS` with that machine and `open it there`; then the
  machines (adding a workspace, the folder is one already: its machine is listed with the rest and takes a
  second, copied beside it), each with its status for this project at its right, from its `workspace:plan`: `ready`
  (`--ok`), `installs node` (`--accent`), `password` (`--warn`), `can't` or `offline` (`--dim`), `…` while it
  is asked.
- **The pane.** The machine's name and status; a note when it is ready, needs a password or cannot set the
  project up; its folders at its projects folder with the new folder as a dashed `+ atlas — made here` row;
  `Folder name` (prefilled: the project's name, or `atlas-1` when `atlas` is taken there); `Full path` with
  why it is named so. Opening another folder puts it there instead.

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
| no forge signed in | under `FORGES`: `No forge is signed in. Settings → Connections → Forges.` |
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
