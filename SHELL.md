# JaiRA Shell — Multi-Project, Typography, and Status

Status: Design complete — 2026-08-18
Companion to [DESIGN.md](DESIGN.md) §11.1. Where this document and DESIGN.md
conflict, this one wins for the shell; everything else in DESIGN.md stands.

This is the implementation handoff for one change with four parts: the window
learns to hold several projects, the type system learns to tell app words from
data words, status becomes two kinds of pill, and both become adjustable.

The parts are separable and land in the order given in §8.

---

## 1. Decisions summary

| Decision | Choice | Why |
| --- | --- | --- |
| Multi-project model | The project is the **head of every address** | There is then no "current project" state to be wrong about; `TaskAddressBar` already works this way |
| Sidebar structure | **Projects over views** — projects at the top level, Files/Tasks/Chat nested | The only arrangement that reads in the same order as the address bar |
| Expansion | **Exactly one project open**, derived from the address, never stored | Bounded height; storing it re-invents the mode the address was meant to retire |
| Nav row register | All rows in one register (`app-label`) | They are one control — `sidebar.tsx` renders every row, footer included, through one `rowOf()` |
| Section treatment | Full-bleed **band** on `--panel` plus **hairline nesting rules** | The band says where the section is; the rules say what is inside what |
| Typography | Two voices: **app** (sans) and **data** (mono), ten registers | A string's family tells you what kind of word it is before you read it |
| Status | Two pill kinds: **active** and **status**, one priority order, `+N` overflow | Active is a live fact; status is an unseen count |
| Board cards | **No left stripe**, status as a trailing pill | A filled, outlined, shadowed rectangle is a button; a task is not pressed |
| Appearance | **Two families, two sizes** — one per voice, user-settable | Every register is a multiple of its voice's base, so one control moves a whole voice coherently |

Visual reference (the running app, both themes) is listed in §10.

---

## 2. Multi-project

### 2.1 What is already true

The service can hold several projects open today. `ProjectSession` is per-project
and `this.sessions` is a `Map`; every channel below takes a `project`. The only
thing stopping a second user project from staying open is one line in
`ServiceHost.open`, and its own comment says so:

> Still one USER project at a time. The map can hold several and everything below
> is written for that, but letting a second one STAY open is a UI decision (which
> project do the project-free channels answer for?) and is made separately.
>
> — `packages/app/src/main/service.ts:848`

This document is that decision.

### 2.2 The model

**The project is the first crumb of every address.** There is no
`state.projectDir`. Every project-scoped call reads its project from the address
the surface is standing on.

Consequences, one per channel that has no project on it today:

| Channel | Resolves to |
| --- | --- |
| Files tree | The projects are the tree's top level; `~/.jaira` is listed once beside them, not under each |
| Settings › project layer | The layer switch *becomes* the crumb. At the root, Settings edits `base` only — which is the rule the no-project case already states |
| New task, Chat | Whatever the address stands in. At the root the composer asks once, and the answer is the address it puts you on |
| Window title | Derived from the address, which it already reports |
| Tasks board | Already this shape. `taskFocus: null` is "All projects" and is a real place, not "nothing chosen" |
| Awaiting you | Already spans every open session — see §2.4, which must be fixed regardless |

### 2.3 Service changes

- `ServiceHost.open` stops calling `closeUserSessions()`. Opening a project adds
  a session; it does not evict one.
- `focusedKey` is no longer meaningful as "the" project and should be deleted.
  Callers that used `session(undefined)` must pass a project explicitly.
- `listProjects()` already materializes shared and system sessions and sorts
  user → shared → system. Unchanged.
- Closing a project closes its session (`ProjectSession.close` is correct as
  written — it aborts runs, rejects hub requests, and awaits in-flight work
  before closing the database).

### 2.4 Required fix: approvals carry no project

`PendingApproval` (`packages/shared/src/ipc.ts:132`) has `taskId` but no
`project`, and the approvals strip calls `onSelect(taskId)` with no project
(`packages/app/src/renderer/App.tsx:1462`) while `actions.select` takes
`(taskId, project)`.

The list is *already* cross-project — `pendingApprovals()` flat-maps every open
session. So the moment a second project stays open, that strip resolves task ids
against whichever database happens to be focused.

- Add `project: string` to `PendingApproval`, `PendingQuestion` and
  `PendingInteraction`.
- Pass it through `onSelect`.
- Show it as a project chip on each strip row.

**Do this first.** It is a correctness bug the moment §2.3 lands, and it is a
small change.

### 2.5 The same fault, in the Chat view

Found by running it: `chat:thread`, `artifact:list` and `chat:startPlan` all
threw **`no project is open`** on a window whose address was standing on
`~/.jaira`.

The surface named its project as `state.at === null ? SHARED_SESSION : null`, and
`null` means *let main resolve the focused one*. `sessionOf(undefined)` answers
only when exactly **one user project is open**, so that expression has three
failure modes and only one working case:

| address | main resolves | outcome |
| --- | --- | --- |
| one checkout open | that checkout | works |
| standing on `~/.jaira` | nothing — a shared session is not a *user* one | `no project is open` |
| two checkouts open | ambiguous | `several projects are open, so this call must name one` |
| a root-list thread in project X | whatever is focused | the wrong database, silently |

The last one is the quiet one: `openConversation(taskId, project)` was already
being told which project a root-list row belongs to, and **nothing read it** —
the surface passed the address's answer instead. A thread would come back empty
rather than wrong, which reads as "this conversation has nothing in it".

The rule, now stated once as `chatProjectOf` and tested: **a chat call names its
project** — the open conversation's, else the address's, else the shared root.
`newConversation` and the `@`-mention completion took the same fix; both were one
`undefined` away from failing as soon as a second checkout was open.

The general form is §2.4's, and it is worth stating as a rule: *a cross-project
surface may not let main resolve a project.* Focus resolution is a convenience
for a window with one checkout, and this shell is not that window.

### 2.6 Opening one, and having it still be there tomorrow

Two consequences of §2.2 that the model implies and the app did not do.

**A folder with no `.jaira/` is an offer, not an error.** `project:open` refuses
one — it has to; there is no database to open — and the app used to hand that
message to the toast, so picking a checkout that had never been set up told the
person to go and run `jaira init` in a terminal. The order is now *ask, then
act*: `project:inspect` reports what a directory is (exists / is a project / is
already open) without touching it, and "not a project yet" becomes a dialog
offering `project:init` on the same path. "New project…" is unchanged and does
not ask — it already means *write a layout here*.

**Which projects are open survives the quit.** Opening a project adds a session
and nothing evicts it (§2.3), which makes "these are the projects I work in" a
statement a person makes by opening them — and one the app retracted on every
quit. The list rides in `user-settings.json` as `projects`, beside the theme and
the layout, for the same reason they do: which checkouts one person has open on
one machine is not a property of any of them, and a list of absolute paths must
never arrive through a pull request. `AppService.restore()` re-opens them at
startup, before the window exists, in the order they were opened — so the last
one is where the address stands, and a directory named on the command line is
opened after them and wins.

Restoring is best-effort, and the failures differ. A directory that is gone from
a filesystem that is plainly there — deleted, moved, or its `.jaira/` removed,
with its parent still on disk — is **forgotten**: it went on purpose, and
retrying it every morning would put an error on the screen about a folder nobody
has. Everything else is logged and **kept** — a locked database, or a whole
volume that is not mounted this morning, is a temporary condition, and amnesia is
the wrong punishment for one. Asking the *parent* is what draws that line;
`existsSync` on the project alone answers "no" for an unmounted `Z:` and for a
deleted folder alike.

---

## 3. The two voices

### 3.1 The rule

**App voice** is for words JaiRA chose: names of rooms, actions and states. They
are the same on every machine and in every project. Set in the sans.

**Data voice** is for words something else chose: paths, project names, state
ids, task titles, commands, counts. Different on every machine, and the thing a
person is actually there to read. Set in the mono.

Three laws:

1. **Voice is the face. State is weight, colour and ground.** Selection and
   emphasis may move weight, colour and background as far as they like. Neither
   may touch the family. A row that switches to mono to look more selected is how
   this system dies.
2. **Data never takes `text-transform`.** Uppercasing `review.md` misrepresents
   it — paths and ids are case-sensitive, so changing their case is a lie about
   the value. That is what leaves uppercase free as an app-only signal.
3. **The quietest register is `--tok-hint`,** not an opacity. The palette already
   carries it, described as "dimmer than `--dim`", for a hint sitting on a line of
   code.

### 3.2 The audit

The rule is only worth having if it decides the awkward cases.

| String | Voice | Note |
| --- | --- | --- |
| `JAIRA` | app | |
| Files · Tasks · Chat · Logs · Debug · Settings | app | |
| Connections · Models · Tools · Runs · Data & history | app | |
| `settings.json` in the Settings list | data | The one page named after the file it opens, so it is set as the file |
| Awaiting you | app | The command beside it is data |
| **All projects** | **app** | The one app crumb in an otherwise data-voiced address bar. It names a level, not a directory |
| running · blocked · waiting for user | app | JaiRA's vocabulary for a condition, even though the condition belongs to data |
| `declarative-ai` | data | A directory basename — and the same string the crumb prints |
| `prompts/review.md` | data | Paths, everywhere: tree, crumb, inspector, diff header |
| `feature.plan` | data | State ids and workflow names, authored in the user's own files |
| **`plan` · `build` · `review`** | **data** | Board column headings look like app labels and are not — they are the child states of whatever workflow is open |
| task titles | data | A person typed them; the app did not |
| `rm -rf ./build` | data | The one place exactness is a safety property |
| `2` · `40s` | data | Tabular figures, so a column of them lines up |
| **"open a project…"** | **app, absent** | App text standing where data would be |

That last case already exists in the stylesheet as a one-off: `.side-project.none`
is dim and italic, and `.binding-produced::placeholder` uses the same idiom with
the reason spelled out — a meaningful blank "must not read as an omission."
Naming it is most of the work.

### 3.3 The registers

Ten classes. **No component carries a literal font-size again**; every register
is a multiple of its voice's base, so one preference moves a whole voice with
every ratio intact.

```
--font-app    "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif
--font-data   "JetBrains Mono", "SF Mono", "SFMono-Regular", Menlo, Consolas, monospace
--size-app    12.5px   (default; see §6)
--size-data   12px     (default; see §6)

/* app voice */
.app-title       calc(var(--size-app) * 1.05)  700  sentence          --text
.app-label       calc(var(--size-app) * 0.80)  700  UPPER .1em        --dim
.app-text             var(--size-app)          500  sentence          --text
.app-secondary   calc(var(--size-app) * 0.88)  400  sentence          --dim
.app-absent           var(--size-app)          500  italic            --tok-hint

/* data voice — never text-transform */
.data-title      calc(var(--size-data) * 1.12) 700                    --text
.data-text       calc(var(--size-data) * 0.96) 400                    --text
.data-secondary  calc(var(--size-data) * 0.84) 400                    --dim
.data-faint      calc(var(--size-data) * 0.84) 400                    --tok-hint
.data-num        calc(var(--size-data) * 0.79) 600  tabular-nums      --dim or semantic

/* state — the only three properties it may touch */
.is-active       font-weight +200 · color → --text · background → --tint-accent
```

**Both leading faces are bundled** — `app/src/renderer/fonts/`, one variable
woff2 each, under the OFL. They were named and not shipped at first, on the
grounds that a face is a preference rather than a dependency. That was the wrong
call for one reason: neither is installed on a stock Windows or Linux machine, so
on most of them every ratio above was being applied to Segoe UI and Consolas —
metrics these numbers were not tuned against — and every figure in §10 was
being compared to a screen drawn in different faces. They still lead a stack
rather than being the whole of one, and Appearance still puts a person's own
families in front of them (§6).

`app-label` is for **headings over a group**, not for rows that go somewhere.
That allocation is what keeps the nav consistent.

### 3.4 Required fix: `ui-monospace` at the head of a stack

`.side-project` (`packages/app/src/renderer/styles.css:516`) is
`font-family: ui-monospace, Consolas, monospace`, and 57 declarations in that
file lead the same way. t3code's runtime default deliberately does not:

> Concrete names first: some engines alias `ui-monospace` to the proportional
> system UI font, which would break every code surface.

Put concrete names first in `--font-data` and let `ui-monospace` fall to the
back, or drop it. This lands free with §3.3, since those 57 declarations collapse
into the two tokens.

---

## 4. Status: two kinds of pill

### 4.1 The vocabulary

Icons come from the existing `BADGE` map in `packages/app/src/renderer/board.tsx`.
The set is split, not replaced.

| # | Pill | Kind | Maps from | Means |
| --- | --- | --- | --- | --- |
| 1 | `▶ n` | **active** | `running` | An agent is working. Nothing is asked of you |
| 2 | `⏸ n` | **active** | `waiting_for_user` + `blocked` | Stopped on your answer. A gate and a tool approval are the same thing to a person |
| 3 | `⛔ n` | status | `failed` · `timeout` | The **model** failed — timed out, retries spent, could not produce the output type |
| 4 | `⚠ n` | status | `interrupted` · `canceled` | It stopped without finishing, and nothing is waiting on you |
| 5 | `✓ n` | status | `completed` | Finished, and it worked |
| — | `+N` | overflow | — | Everything that did not fit, summed as **items** |

`queued` is neither: nothing is happening and nothing has happened. It belongs in
the total or nowhere.

**Active pills are filled** (a tint of their colour); **status pills are flat.**
That is the second channel: `⛔` error and a hypothetical red active pill are told
apart by fill, not only by hue.

Merging `blocked` into `⏸` costs nothing structurally — `laneOf` already folds
both into the `paused` lane. But the approvals strip must keep telling them
apart, because an approval blocks a tool loop and a gate does not.

### 4.2 Priority and overflow

```
ORDER = [running, waiting, error, warning, success]

layout(row, counts)
  fit = []
  for kind in ORDER where counts[kind] > 0
    if width(fit + kind + reserve("+N")) <= row.budget → fit.push(kind)
    else break
  rest = sum of counts not in fit
  render fit, then "+" + rest when rest > 0
```

Because `running` heads the order and a single pill always fits any row budget,
**no width can hide the fact that something is working.** A project with nothing
running folds to a bare `+5`; a project with a run in flight keeps `▶1` at any
width.

`+N` counts **items**, not kinds — the number a person wants is how much is
behind the fold, and it is the number that shrinks as they work through it.

**Open:** `+N` is currently colourless, so a folded error looks like a folded
success. Tinting it to the most severe kind it hides is one line and is
recommended.

### 4.3 Unseen counts

Status pills are **unseen counts**: three greens means three finished *since you
last looked*, not three that ever finished. Active pills are live facts and are
always true.

This needs no new persistence. `ui.seen` is already a per-task monotonic
timestamp watermark with `seenOf` / `withSeen` / `forgetSeen`, and `chatPane.tsx`
already derives `unread` as `seen[taskId] < task.updatedAt`.

```
unseenOf(view) = group tasks in that view's subtree
                 where seen[id] < updatedAt
                 bucketed by ORDER kind
```

A **view row** counts its own subtree. A **project row** is the sum of its views.
Clicking a row marks its share seen and the status pills clear; the active pills
remain, because they are not about having looked.

Chat is not exempt: an agent mid-reply is `running`, and a question it asked is
`waiting`.

**A view row counts its own ROOM, and the rooms do not overlap.** This is the
half of "its own subtree" that is easy to skip and expensive to get wrong. Given
the project's whole tally, both root rows read the same number — so **All
conversations** wore a `✓` for a workflow run that had finished, a mark pointing
at a place that did not contain the thing it pointed at, with no row below it
repeating the mark and therefore nothing to follow it to. A project summary
cannot answer this: `ended` carries a status and a clock and no workflow. The
list of conversations can, and it is fetched for every open project whatever view
is showing, so:

```
chat row   = the conversations of that project, counted from their own rows
tasks row  = the project's tally MINUS the chat row's
project    = the whole tally, unchanged
```

`taskCounts` is that second population, and it is honest about the one thing it
cannot see: whether a running task is parked on a person is counted from the
session's own requests and is not on the task row, so a conversation waiting on
an answer reads as `▶` on its view row and is broken out as `⏸` on the project
row above. A view row is a pointer to where to look, and it does point.

**Opening is looking.** A status pill counts what has stopped since you last
looked, so the gesture that clears it is the one that answers it — going and
reading the thing. Selecting a task marks it seen, at the task's OWN clock and
never at `Date.now()`, for the reason a row's mark moves that way: a turn landing
in the same millisecond as the click is news. Clicking the pills stays as the way
to dismiss a row you are *not* going to open.

---

## 5. Surfaces

### 5.1 The sidebar

Structure, top to bottom:

```
[toggle]  JAIRA                                  ← app-label; drag handle
◎ ALL TASKS                         ▶3 ⏸1 +6     ← the root: every project at once
✻ ALL CONVERSATIONS               + ⌕     ⏸1     ← its drawer is every thread, newest first
● declarative-ai        checkouts     ▶2 +4     ← name, then the folder it sits in, then counts
    ❏ FILES                         + ⌕          ← app-label, .is-active when current; no caret
        workflows/                               ← data-text, one guide rule per level
        │ feature/
        │ │ prompts/review.md                    ← data-text .is-active
        ~/.JAIRA                                 ← the OTHER root still introduces itself
        │ workflows/
    ▶ TASKS                         ▶2 ⏸3 +4
    ✎ CHAT                          + ⌕     ⏸1
  notes-api                             ⛔1 ✓4
  atlas-web                             ▶1 ⚠1
  ~/.jaira                                  ▸
─────────────────────────────────────────────    ← border-top --line
  ⚙ SETTINGS                                     ← the only footer row left; see the panel below
```

**What a row carries**, left to right: a hit area that means "go here", then the
row's own **verbs**, then its pills. Three consequences, and each one is a fault
that was in the built column:

- **A row is a place, and nothing folds a drawer.** Clicking a row goes there and
  shows what is in it, *always* — never the reverse. A drawer is open exactly
  while its view is the one selected; the way to put one away is to select
  another, which is the only thing a person is saying when they click a row.
  There is no caret. Two ways to hide one thing is one too many, and because a
  fold is remembered, the second one gave a column that could open with the tree
  of the view you were on already gone.
- **A row's verbs live on the row.** "New conversation" and the search box were
  the first two lines of the drawer under Chat, and the filter and the create
  form were the first and last lines under Files: four permanent controls in a
  250px column, on screen whether or not anybody was searching or creating, and
  all of them one fold away from the row that names them. They are `+` and `⌕` on
  the row now, and what they reveal appears in the drawer only while it is on.
- **`+` on Files asks WHICH, never where.** It drops a menu — new file, new
  folder, new workflow — and the name is then typed into a row in the tree, at
  the place the thing will be: the folder above it is the answer to "where", so
  the form that used to ask it (a name, a layer picker and a Create button, at
  the foot of the column) is gone. Every folder carries the same `+` on hover,
  for itself; a workflow is offered only on `.jaira/` and what is inside it,
  because a root state has one home and pressing it there unfolds
  `.jaira/workflows/` to show the row being named.
- **The row is a container, not a button.** Forced rather than chosen: a
  `<button>` inside a `<button>` is not markup a browser keeps.

**The root has a drawer too.** "All conversations" is a level, and a row that
names a level and opens onto nothing makes the level look empty; its drawer is
the same list the project's Chat row opens, one step up, each thread stamped with
the project it is in.

**Settings is a panel, not an accordion.**

```
[toggle]  JAIRA
┌───────────────────────────────────────────┐    ← full height, over the column
│ ‹  ⚙ SETTINGS                             │    ← the row IS the header
│    JUST YOU                 this machine  │
│    Appearance                             │
│    PROJECT & SHARED              layered  │
│    Connections                            │
│    Models                                 │
│    Tools                                  │    ← the open page's sections,
│       Permission sets                     │      indented under it (§6.6)
│       Functions an agent calls            │
│       Functions a workflow calls          │
│    Runs                                   │
│    Files                                  │
│    Data & history                         │
│    settings.json                          │
│   ─────────────────────────────────────   │
│    ≡ LOGS    ⌁ DEBUG    ☾ DARK            │    ← pinned to the bottom of the panel
└───────────────────────────────────────────┘
```

It is pinned to the foot because it belongs to no project — true, and the reason
it starts there. But the foot is also where the column runs out of room, so
opening it as an accordion put its section list in the two inches between the
last project and the bottom of the window, underneath the whole of the
navigation it had just been left for.

Over rather than taller, because **Settings is not a place in the address**: you
are not in a project while you are in it, so the column has nothing to be showing
underneath. The `‹` and the header row both mean "back to where you were", which
is the view the window was showing when Settings was opened.

**Logs, Debug and the theme are in it.** Belonging to no project is the whole of
what they have in common with Settings, and four rows saying so at the bottom of
the column were four rows the projects had to compete with. The rail keeps them:
there is no panel at 46px to put them in, and losing them there would leave a
mode of the window with no way to reach the log. For the same reason ⚙ in the
rail opens the *column* rather than a view whose navigation cannot be drawn.

**The panel stays open for everything it holds.** It used to be open on
`view === "settings"` alone, so clicking Logs or Debug — rows *inside* the panel
— shut the panel that had just been used to reach them, taking the way back and
the way to the other one with it. It is open on any view the panel contains, and
the section list stays with it: the panel is that row's drawer, and a header over
an empty column is not a smaller version of it. What "back" means follows the same
rule — the view the window was showing before the panel was opened, never Logs or
Debug, or the arrow would lead back into the panel.

- **One project expanded**, derived from the address. Never persisted — see the
  precedent in `uiState.ts`, where `SHUT.folders` is deliberately keyed per
  *layer* and not per checkout, because the alternative "grows without bound as
  projects come and go, to remember something about a folder in a project that is
  not open." The same argument applies here.
- **No group heading over the other projects.** The band's edge separates them;
  a word would add nothing.
- **No parent path** on the project name. The basename only.
- **Logs, Debug, Settings** belong to no project and sit in the footer group.

Treatment:

- The open project's whole section — header, view rows, tree — sits on `--panel`,
  **full bleed**, with a 1px `--line` top and bottom and no radius and no margin.
  The moment it gets a radius it is a card, and the last pass spent a redesign
  getting the settings pane to stop drawing boxes around itself.
- Inside the band, **two nesting rules**: `--rule` under the project (the token
  whose comment reserves it for "the only thing saying what is inside what"), and
  `--line` under the view, at the 12px indent `.side-drawer` already uses.
- **The root the drawer is standing in is not named.** Every root used to be
  introduced by a row carrying its own name — inside a drawer hanging under a row
  that is already that project's name, which printed it twice and spent the first
  line of the column doing it. The others still introduce themselves: a second
  checkout is a different place, and so is `~/.jaira` *while you are standing in
  a checkout*. Matched on the DIRECTORY as well as the project stamp
  (`rootNeedsName`): the shared root carries no project and is also a row in the
  sidebar and a place to stand, so a stamp-only test could never be true there
  and `~/.jaira` went on introducing itself inside itself.
- What that line is worth instead is on the project row: **the folder the project
  sits in**, beside its name, on the open project only. Two checkouts of one
  repository are told apart by where they are, which is exactly the half a
  basename throws away. One segment rather than the whole path — inside 250px the
  whole of `/w/checkouts/acme` renders as `/w/ch…`, which is three characters of
  the half every project on the machine has in common. The whole path is on the
  row's tooltip, where a path belongs, and the open row's pills fold sooner
  (`OPEN_PILL_BUDGET`) to pay for it — its counts are also on the two rows
  directly beneath it, split by room.
- **The tree continues them, one rule per level.** It indented with padding and
  drew nothing, which dropped the column's own convention at exactly the point
  where nesting gets deep: a row four levels down had no line to any of the four,
  so "which folder is this in" was answered by counting pixels. 13px per level —
  the indent it replaces, to the pixel — with the innermost rule in `--rule` and
  its ancestors in `--line`.
- In dark, `--panel` sits only ~6 points of luminance above `--panel-2`; the two
  hairline borders carry the band there. Check dark first.

### 5.2 Collapsed, at 46px

`sidebar.tsx` currently renders `null` in place of the brand and the project name
whenever `collapsed` is set. With the project as the head of the address, that
makes the address's first crumb invisible *and* unreachable.

Collapsed becomes two zones in one rail: **project tiles**, a divider, then the
open project's **view glyphs** — today's rail with one zone added. Exclusivity is
what makes this possible: there is always a project the rail is on.

### 5.3 The task board

Cards lose the box. `.card` (`styles.css:2324`) is `background: var(--panel)` +
1px border + radius + `box-shadow` — a filled, outlined, shadowed rectangle,
which is a button. A task is selected, not pressed.

```
┌ feature.plan                              7 runs ┐   ← data-title / app-secondary
│  tighten the sync lint            ▶ running      │   ← data-text .is-active / active pill
│  40s · 3 turns                                   │   ← data-secondary
│  rate limiter                     ▶ running      │
│  delete stale worktrees           ⏸ waiting      │
│  approve · 2 min                                 │
│  token budget                     ⏸ waiting      │
│  gate · 6 min                                    │
│  FINISHED ───────────────────────────────  3     │   ← app-label lane heading
│  retry policy                     ✓ done         │
│  schema migration                 ⛔ timed out    │
│  18 min ago · 2 retries                          │
└──────────────────────────────────────────────────┘
```

- Ground is `--fill-ghost-hover` at rest and `--tint-accent` when selected. No
  border, no shadow, **no left stripe.**
- **The column keeps the box the card gave up**, and this is the other half of the
  same argument rather than an exception to it. A column is a *place* — the one
  thing on the board a task moves between — so it earns a hairline all the way
  round, a heading band on `--panel-3`, and a rule under that band. Two columns of
  stripe-free cards with nothing between them read as one field of tiles, which is
  what removing the card's box costs if nothing takes the boundary over. The
  border is drawn always, never on hover: an edge that is only there while the
  pointer is over it is not an edge.
- The heading is `data-title` for the state's name and `app-secondary` for the
  count, at the two ends of the band. **Nothing else** — the sequence number is
  loose in `data-num` where there is one, and the count is not a pill: a pill on
  this board is a *status* (§4.1), and spending that shape on a quantity puts a
  sixth kind into a vocabulary of five.
- The trailing pill is the same component as the sidebar's, with a word instead
  of a count. Active filled, status flat — so a column sorts itself visually
  before a title is read. **Nothing trails the pill** — no drill marker: the head
  row is a title and a status, the width a marker takes comes out of the title,
  and a glyph announcing that a double-click exists is a manual printed on the
  machine.
- The second line says which *kind* of waiting (`approve` vs `gate`) and why an
  error failed (`not a SyncEdit`, `3 attempts`). Merged in the count,
  distinguished where there is room.
- **No lane heading over the active runs** — cards each carrying a filled pill say
  what a "Running" heading would, which is the argument `lanesOf` already makes
  about single-lane columns. The heading returns over `finished`, where the pills
  go flat.

Sorting is unchanged and already correct: `LANES` is
`["running", "paused", "not-started", "finished"]` and the finished lane is
re-sorted newest-first by `endedAtOf`.

#### Dragging a card, where a workflow asked for it

A running workflow can park a transition on a gesture (`on_user_event`,
WORKFLOWS.md §7.4). The board's whole response is an **affordance**, and
deliberately nothing else:

- The card gets `cursor: grab` and becomes draggable. No badge, no handle, no
  entry in an inbox — a card already carries a title, a pill and a place, and
  a fourth mark saying "this one can be moved" would be a manual printed on the
  machine again. A `paused` pill is already saying the run is waiting on a
  person; the cursor says what for.
- While a card is in the air, the columns its rules name are outlined with a
  **dashed accent border**, and the one under the pointer takes the ghost fill.
  Two steps of one gesture: which columns will take it, and which is about to.
  Every other column is left exactly as it was, which is the other half of the
  answer.
- Nothing moves on drop. The card moves when the RUN moves, on the next board
  refresh — a workflow decides where a task goes, and a board that slid the card
  across optimistically would be claiming an outcome it does not own.

Which cards these are is read off the waits the running workflows have
published, never off the workflow file: a wait exists only because the engine
reached the call, so a rule's own conditions have already been checked by the
thing that owns checking them. A drag is offered only where both ends are on
screen — the card, and a column whose key the rule names at this board level.

**Required fix:** the comment above `.card::before` reserves the left edge for
"run status down a column of cards" — that reservation is the only reason the
edge survived the last pass. Change the comment with the code, or the stylesheet
argues for an idiom the app no longer uses.

---

## 6. Appearance — a new Settings section

None of §3 is fixed. **Appearance is a setting**: an entry in the `SECTIONS`
array in `packages/app/src/renderer/App.tsx` — beside Providers, Executors,
Configuration and History when it landed; the pages it sits beside now are in
§6.7 — where a person changes the two families and two sizes that the ten
registers derive from.

```ts
{ id: "appearance", label: "Appearance", group: "you", icon: "appearance", layered: false, purpose: "" }
```

**`layered: false`, and no `needsProject`.** Fonts are a per-person display
preference, not a project's — so the layer switch must not appear above this
section, and it must be reachable on an empty window. That is the rule the theme
toggle already follows, and `sidebar.tsx` states the reason:

> Theme sits here rather than inside Settings: it is a per-person display
> preference, and burying it behind a view that needs an open project would make
> it unreachable on an empty window.

The theme toggle stays in the sidebar footer — it is one click and belongs at
hand — but it may also be mirrored inside this section, since that is where
somebody looking for "how this app looks" will go first.

The model, mapped onto two voices from t3code's `appearanceFonts.ts`:

```ts
const DEFAULT_APP_STACK  = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_DATA_STACK = '"SF Mono", "SFMono-Regular", Menlo, Consolas, monospace';

interface Appearance {
  appFamily: string[];   // ordered; [] ⇒ the default stack alone
  dataFamily: string[];
  sizeApp: number;       // 11–17, default 12.5
  sizeData: number;      // 10–16, default 12
  sizeEditor: number;    // 10–20, default 13 — read only when `advanced`
  advanced: boolean;     // false ⇒ the editor follows sizeData
  smoothing: boolean;    // grayscale antialiasing; default off, the platform's own
}

applyAppearance(root, a):
  --font-app    = [...a.appFamily,  DEFAULT_APP_STACK].join(", ")   // unset ⇒ removeProperty
  --font-data   = [...a.dataFamily, DEFAULT_DATA_STACK].join(", ")
  --size-app    = clamp(a.sizeApp)
  --size-data   = clamp(a.sizeData)
  --size-editor = a.advanced ? clamp(a.sizeEditor) : var(--size-data)
```

Three rules borrowed, one added:

- **Prepend, never replace.** A custom family goes in front of the default stack,
  so a face with no `⛔` or no box-drawing glyphs falls through instead of
  showing tofu.
- **Simple / advanced.** Their terminal font follows the code font until Advanced
  is on; ours is the editor — Monaco and the diff panes follow `--size-data`
  until separated.
- **Previews are real surfaces, not lookalikes.** A real sidebar fragment beside
  a real task row, which is also the one place both voices sit adjacent.
- **Ours: the proportional check.** Two voices can be configured into one.
  Measure the candidate data family — if `i` and `W` advance the same it is
  monospace, if not, say so. A note, not a block: it is their app.

**The headings are "app text" and "data text".** *Voice* is what the stylesheet
calls the two scales and what §3 argues about; on the screen where a person picks
a font, the thing being picked is the text of the app and the text of their data.
A label naming an internal distinction makes somebody work out which of two
abstractions their font is about before they can set it.

**The control shows what is rendering, not only what was chosen.** `appFamily:
[]` means unset — the property is removed and the stylesheet's own value stands,
which is what keeps a change to the shipped default reaching everybody who never
touched the control. On screen that produced an EMPTY BOX under a heading, which
states that nothing is chosen and cannot state what the window is set in. The box
now shows the shipped face (`DM Sans`, `JetBrains Mono`), marked `ours` and
without a ✕ — there is no choice there to take back — and the resolved line under
it leads with that face for the same reason. Choosing anything replaces it
outright: `stackOf` prepends the choice to the platform fallback, and ours is not
in that fallback. The stored value is untouched by any of this; it is a display.

The control is a **multi-select**, not a text field: a stack is an ordered list,
so the chips are numbered 1, 2 (the second family is what renders a glyph the
first lacks) and sit in one box, left to right, in the order they are tried; ✕
drops one. The default stack is the last line of the menu — stated,
un-removable, and outside the menu's scrolling list so it cannot be scrolled
away, which makes "prepend, never replace" visible rather than a rule you have to
know. **Size sits on the same line as the family it applies to**, as a number
with a stepper rather than a slider: a person knows whether they want 12 or 12.5,
and a slider is the control for a quantity whose exact value does not matter.

Three consequences of that shape, each decided against the obvious alternative:

- **This section does not use the `Level` / `Field` chrome.** That chrome is a
  statement on the left and a control on the right, which is right for forty
  independent settings whose names are all that distinguish them. This screen has
  six, they are two pairs and two switches, and every one is about type — so the
  labels are one word, the controls are the width of the pane, and what belongs
  beside a control is the preview, not a paragraph.
- **It draws its own head.** A non-layered section gets no `settings-head` from
  the chrome — there is no shared-versus-project switch to put in one — so the
  fact that header would have carried, *whose* settings these are, is stated in
  the pane: "Appearance · every project on this machine".
- **The menu says which offered faces are actually here.** There is no API that
  lists installed fonts, and `document.fonts.check` answers about loaded
  webfonts — it says yes to a name no machine has ever heard of. What can be
  answered is whether a *named* one resolves, by the same canvas measurement the
  proportional check uses (`isInstalled`). A face that is absent is still allowed
  into the stack, marked rather than refused: configuring one machine from
  another is ordinary.

One thing from t3code *not* to copy: its marketing CSS sets
`font-feature-settings: "ss01", "ss02"` on DM Sans. The served font's features
are `calt, ccmp, dnom, frac, liga, locl, numr` — there is no `ss01` or `ss02`,
and that declaration does nothing. What DM Sans does have is two axes,
**`opsz 9–40`** and **`wght 100–1000`**; JetBrains Mono has `wght 400–800`.

### 6.1 The editors, and what opens a file

The section began as typography and is now three subjects, because two more
questions turned out to belong to the same person and the same file. Both were
already answered — hard-coded in a Monaco options object, in a CodeMirror theme,
in two lines of CSS, and in whichever component happened to be registered for a
type. Neither answer was ever anybody's decision but ours.

**File types come first on the screen**, and the two halves of this section are in
that order below: what opens a file, then what that thing looks like.

**Editors.** Four surfaces, because there are four implementations and not
because there are four kinds of file: a `.ts` and a `.yaml` are the same Monaco
pane with a different grammar, and offering to style them apart would be offering
a control that writes to one place twice.

```ts
type EditorKind = "code" | "markdown" | "json" | "diff";

interface EditorLook {
  lineNumbers, wrap, minimap, indentGuides, currentLine, whitespace, brackets: boolean;
  tabSize: number;    // 2 | 4 | 8
  lineHeight: number; // 1.1–2.2, a MULTIPLE of the editor's font size
}
```

They are not equally capable, so `EDITOR_KNOBS` says which questions each surface
can actually answer and the pane draws only those. A minimap is Monaco's; the
JSON editor is a textarea over a coloured `<pre>` and has no gutter to number.
**A switch the surface would ignore is worse than an absent one** — an absence is
a fact about the editor, a dead switch is a bug you cannot see.

Three rules carry it:

- **The defaults are a transcript, not a taste.** Every value in
  `defaultEditorLook` was a literal in a component before it was a setting, so an
  app nobody has configured draws exactly what it drew before. `editorLook.test.ts`
  pins them against the code they came out of. `brackets` is the one exception and
  a deliberate one: Monaco ships bracket-pair colouring ON, painting every bracket
  in its own gold / pink / blue — three colours from no theme this app has, and the
  single most visible way an editor stops looking like the theme it is set to.
  Turning it off is a correction rather than a transcript, and it is stated as one.
- **Two of those knobs belong to the MODEL, not the editor.** `tabSize` and
  bracket colouring are `ITextModelUpdateOptions`, and `IEditorOptions` carries
  look-alikes (`bracketPairColorization`) that are typed, accepted and not what
  decides. Worse, attaching a model to an editor pushes the editor's derived
  options back onto it after `create` returns — `detectIndentation` re-guesses the
  tab width, the bracket options revert — so writing them once does not hold.
  `keepDocumentOptions` writes them and re-writes them on `onDidChangeOptions`,
  guarded so its own write does not bounce.
- **Line spacing is a MULTIPLE, never a pixel count** — the rule the ten registers
  already follow, so moving a font size moves the spacing with it.
- **The looks are pushed, not polled.** Monaco and CodeMirror are each created
  once, inside an effect that deliberately never re-runs, because re-creating
  either throws away the caret and the undo history. So a preference cannot reach
  them as a prop: `editorLook.ts` holds the current answer and notifies, Monaco
  re-reads its options and CodeMirror reconfigures a compartment, and the two
  knobs the STYLESHEET needs (spacing, tab width) are published as
  `--ed-<kind>-lh` and `--ed-<kind>-tab` beside the font tokens.

`wrapJson` is gone, into `editors.json.wrap`. It was one boolean for one editor
on the argument that word wrap is "the same KIND of thing as the theme" — right,
and never only about JSON. A settings file written before the change is read once
into the new field; the toggle above the editor and the switch in this pane are
now the same setting rather than two that disagree the moment either is used.

**File types: three kinds of renderer, not two halves of a panel.** The surface
registry (`fileTypes.ts`) was keyed by `view` and `edit` — which are not kinds of
rendering but PLACES, the panel's upper and lower halves — and that conflation
made both the registry and this screen say untrue things. It presented the JSON
data tree and the JSON editor as alternatives to each other, when they answer
different questions and a person wants both at once; and it had no room at all for
the fact that a `.json` file has a text rendering too, drawn by Monaco exactly like
every other source file.

A renderer now declares what it IS, and where it goes follows:

```ts
type RenderKind = "text" | "data" | "preview";

registerFileSurface("application/json", "text", { id: "schema", label: "Schema-aware", writes: true, surface: JsonEdit });
registerFileSurface("application/json", "text", MONACO);     // an editor
registerFileSurface("application/json", "text", CODEVIEW);   // coloured source, writes: false
registerFileSurface("application/json", "data", { id: "tree", label: "Data", surface: JsonView });
```

- **text** — the characters as they are on disk. Monaco, the code view, the
  live-preview editor, the schema-aware editor: all of them draw the SOURCE and
  differ in what they let you do with it.
- **data** — the value the document denotes, once parsed. The tree, a table of
  rows, the fields a schema declares, a state's authoring form.
- **preview** — what the document means, rendered. Markdown as prose, HTML as a
  page, an SVG as a drawing, a patch as the change it describes, a state as its
  board.

**Each kind is chosen TWICE — once for reading, once for editing** (§6.3). `read`
is the view that cannot be typed into and `write` is the one that can, and only a
renderer whose registration says `writes` may answer the second. Where those two
views GO is not decided here and deliberately cannot be: a surface may show only
the reading, only the editor, one control that toggles between them, or both at
once. The Files panel still derives its own arrangement (`viewerFor`, `editorFor`)
— the upper half takes the preview, or the data reading for types with no preview;
the lower half takes a writing data renderer if there is one, otherwise the text
one — but that is now one surface's layout rather than the vocabulary everything
is described in.

**`writes: false` is a real answer.** The code view is coloured source that cannot
be typed into, which is exactly what some people want a file they are only reading
to be — and it is the same renderer the value viewer has always offered on the `▾`
beside its Code button, reaching the Files panel for the first time. The panel says
so in the row the Save button would have been in, and names the setting holding it
open.

**A `.json` file has three data renderings, and the third is the form.** The tree
always draws something and leads; `Form` draws the fields the document's schema
declares, in the order it declares them, with their descriptions and a widget per
type — the same `SchemaForm` the value viewer offers, and the same read-only
posture. It is a READING, so it sits above the editor rather than replacing it:
writing would mean serialising the whole document back through `JSON.stringify`,
reordering keys to the schema's declaration order and discarding every choice of
formatting in the file, and the schema-aware editor below already validates
against the very same schema. A state file is the exception that proves the rule —
its authoring form writes, so it is registered as a writing data renderer and
takes the lower half instead.

Three things had to change in `SchemaForm` before that form was worth offering,
and each was a defect against this app's own schemas rather than a new feature:

- **`$ref` is followed.** These documents are written for an editor's completion
  and for validation, so a shape used twice is declared once under `definitions` —
  three hundred references in the state schema alone, every one of which drew as a
  heading with nothing under it.
- **…but never twice on one path.** A JSON Schema describing JSON Schema refers to
  itself, and a slot's `schema` member is one, so following references made the
  renderer recurse until the window stopped responding. A hang, not a crash: only a
  test that renders can catch it, and `schemaForm.test.ts` is that test.
- **A map's members are drawn from the VALUE.** `inputs` and `outputs` have no
  `properties` — the keys are the author's — so a state file's entire input and
  output list was invisible in a form built from its own schema.

And one distinction that is not `disabled`: **`reading` draws what a document
says, not what its schema permits.** A settings form must show a field nobody has
set, because setting it is the point; a form that reads a document and shows
twenty-six empty controls has buried the four things the document says. A locked
settings pane is disabled and still has to show the whole shape, which is why the
two are separate flags.

**Monaco and the code view are registered once, at the floor of the chain**
(`text/plain`), so a `.ts`, a `.py` and a `.toml` all have them with nothing
written per type. A type that wants an editor of its own states them again after
it, because a more specific list REPLACES rather than extends — which is what stops
a config file from inheriting the plain JSON editor that would write it unvalidated.

**A choice is looked up separately from the list, along the same chain.** Almost
every type owns no renderers at all, so a preference stored against
`text/x-typescript` and a list found at `text/plain` are at different links; reading
only the key belonging to the link the list came from would ignore every such
choice silently. The most specific choice that names a renderer in the list wins,
and a stale one is stepped over rather than honoured.

Two rules carry over unchanged from the surface registry, and one from the fonts:

- **The screen is derived, never written out twice.** It asks `fileRenderers` for
  every cell — so a renderer added to the table appears in settings with nothing
  else to write, and one removed cannot leave behind a control that sets a
  preference nothing reads.
- **`surface: null` is a renderer, not an absence.** `Nothing` says this type has
  no view of that kind; what a surface does with the space is the surface's
  business. It must stop the walk: skipping it would fall through to the data
  renderer, or to a vaguer type, and draw the very rendering that was just
  declined. It joins the EDITOR's menu only where there is a real writer to
  decline — "the editor for this preview is Nothing" is not a statement anybody
  makes.
- **Choosing the default stores nothing at all**, the rule the font stack already
  follows: what is not chosen stays unwritten, so a change to what this app thinks
  is the best rendering of a file still reaches everybody who never had an opinion.
  A choice naming a renderer this build lacks is ignored rather than repaired — the
  person is left looking at the default, which is a state they can see and correct.

**The value view asks the same question with fewer answers.** It draws source two
ways, an editor or coloured text, so the several editors the Files panel
distinguishes between all mean `monaco` there (`textRendererFor`). That collapse is
why there is ONE preference rather than two: *draw my source as coloured text* is a
single statement about a type, and somebody who makes it in Appearance means it in
a document as much as in the Files panel. It is read through `renderChoice.ts`
rather than through `FileSurfaceContext` — there is one Files panel and it can be
handed things, and there are dozens of value views nested arbitrarily deep. Same
field, same effect in the store, two delivery routes; the module is not a second
source.

JaiRA's own four vendor types are named in `typeNames.ts` (`Workflow (JSON)`,
`Workflow (YAML)`, `Workflow description`, `Project settings`). They used to come
back wearing the name of the syntax underneath them, which is right until a control
lists types for a person to choose against: three rows all called "JSON" is a list
nobody can use. The FAMILY still comes from the syntax, so the glyphs are unchanged.

Two of those four are named without being OFFERED, and the difference is the point.
A workflow description is markdown — the chain says so, and a preference about
markdown already reaches it — so a row for it would be a second row called Markdown
that somebody then has to tell apart from the first. Project settings is a
particular FILE rather than a kind of file, and it is deliberately restricted to the
editor that parses before it writes; offering a preference against it would be
offering to break that. `PANE_TYPES` is the list that is offered, and it is neither
"every type this app names" nor `OFFERED_TYPES`, which answers a different question
(what a person may assert a piece of text IS).


### 6.2 The editors' own palette, and the preview under the controls

**The editors have their own palettes, and the default is one.** `Appearance.editorTheme`
holds a theme id — **Monokai Light** unless somebody says otherwise — with `app`
reserved for "follow the window", which is what every editor did before palettes
existed. It is the palette for anything nobody has said anything about, which is
almost everything; §6.4 is what a person says when they want one type drawn
differently, and it is read first. That default is a product decision worth stating as one: an editor is
where code is read, code has been coloured by its own palettes for forty years,
and an app whose editors are painted in its chrome's two greys has decided a
person's syntax colours for them by not offering any.

| Theme | Where it comes from |
| --- | --- |
| Monokai Light *(default)* | its `.tmTheme`, embedded whole from `anoff/vscode-monokai-light` |
| Monokai | Shiki's copy of the VSCode theme |
| Solarized Light | Shiki's copy of the VSCode theme |
| One Dark | Shiki's `one-dark-pro` |

### The token source, which is the whole of why this was hard

Monaco IS VSCode's editor and renders exactly what VSCode renders. What the npm
package does not ship is VSCode's **token source**: it comes with Monarch
tokenizers — small regex state machines — where VSCode runs `.tmLanguage`
grammars through Oniguruma. Measured, for
`function f(x: boolean): string { const y = true; if (y) return x; }`, Monarch's
answer is:

```
function=keyword  boolean=keyword  string=keyword  const=keyword  true=keyword  if=keyword
f=identifier      x=identifier
```

Seven words, one class. A theme that colours `storage.type`,
`support.type.primitive`, `constant.language` and `keyword.control` four
different ways therefore painted them all one way, and a parameter could not be
told from any other identifier at all. **The palette was right and the
classification was coarse** — which is exactly what "the colours are Monokai but
it does not look like Monokai" means.

`textmate.ts` closes it. Shiki carries the grammars and an **inlined** Oniguruma
WASM build — inlined matters: nothing is fetched, which is what makes it work
under Electron's `file://` origin — and `shikiToMonaco` gives Monaco a tokenizer
that speaks scopes. The themes stop being a mapping and become the theme:
`themes/monokaiLight.ts` is the `.tmTheme` file's own settings array, all 35
scopes, converted from the plist and otherwise untouched.

Three rules keep that from costing anything at rest:

- **Nothing waits for it.** An editor opens on the Monarch tokenizer with the
  hand-mapped palette and re-tokenizes when the grammar lands. What a person sees
  is the same code twice, the second time with more of it told apart — never a
  blank pane while a WASM module loads.
- **The window's CSP has to permit WebAssembly**, and this is where the feature was
  found not working at all. `script-src 'self'` refuses to instantiate a WASM
  module, so the app fell back to Monaco's own tokenizer while the snapshot harness
  — whose page carried *no* policy — showed the real grammars and certified a
  rendering the app could not produce. The renderer now declares
  `'wasm-unsafe-eval'`, which admits WebAssembly and specifically not `eval()` of
  JavaScript, the harness page declares the identical policy, and `csp.test.ts`
  compares the two verbatim so they cannot drift apart again.
- **A failure is a shrug, but a LOUD one.** No grammar, a WASM build that will not
  instantiate, a theme that will not parse: the editor keeps the tokenizer it had,
  because an app that refused to open a file over a syntax colouring would be a far
  worse trade — and the console gets the reason once, naming the CSP directive
  first, because a bare `catch(() => undefined)` is what made the above invisible.
  `monacoTokens.ts` is what that fallback is worth — it widens
  Monaco's own keyword rule into storage / primitive / constant / control, so the
  degraded path is close rather than flat. (Its registration is deliberately a
  macrotask late: Monaco registers its own definition from inside a dynamic
  import, and registering in the same turn silently loses to it.)
- **Grammars load one at a time**, as files are opened, rather than every language
  this app can colour in one chunk for somebody who only opens TypeScript.

### The dozen colours that survive all that

`editorThemes.ts` still holds a small palette per theme, and it is not a second
source of truth so much as the same theme for two consumers that have no TextMate
engine to ask: the DOM editors are CSS (CodeMirror's markdown preview, the JSON
editor's two layers, the plain box — painted from this app's `--tok-*` tokens by
one rule), and Monaco needs *something* for the moment before the grammar arrives.

**One control for all four surfaces**, above the chips rather than inside them,
and that placement is a claim rather than a layout: it is not a per-surface
question. Monaco's `setTheme` is global — even a per-editor `theme` option
repaints the page — so four controls would be four writes to one place, three of
which would appear not to work. It sits in `Appearance` beside `sizeEditor` and
`advanced`, which are the same shape of thing: one answer about every editor.

An id this build does not have falls back to the DEFAULT rather than to "follow
the app": a person is left looking at what a fresh install looks like, which is a
state they can see and correct, rather than at something that looks like the
setting was silently turned off. `shared` keeps the id unread — it has no registry
of palettes, and a parser that refused an unknown id is a parser a future theme
could not be added past.

The containers are the TEXT, not the chrome. A schema picker or a Save button
above an editor belongs to the app and stays in the app's palette — what somebody
means by "a Monokai editor" is the code, not the furniture.

**The preview is the editor itself.** `CodeDocument`, `MarkdownDocument`,
`SchemaJsonEditor` and `MonacoDiffPane` — the same components the Files panel
mounts, in a 210px band under the controls, with a sample you can type into. It is
the typography preview's argument one section down: *previews are real surfaces,
not lookalikes*. A picture of an editor cannot show you that your line spacing has
made a six-line function scroll, and it cannot answer the knobs this pane could
not describe if it tried — what indent guides look like against your font, what
the minimap does to the width. The samples are chosen so every knob does something
visible: a tab-indented block, a line too long for the pane, a nested block. The
code one is self-contained because Monaco runs its real TypeScript worker in
there, and a sample under red squiggles reads as a preview that is broken.

**File types comes before Editors**, which is the order the questions are asked
in: what opens this file, and then what that thing looks like. It is also the
order of consequence — choosing the source reading of a markdown document changes
which editor you are looking at, and no switch in the section below can.

---

### 6.3 File types — family, type, view

The flat table this began as had twenty rows, three columns and one select per
cell, and a third of the cells read `one way` or `—`. It could say exactly one
thing per type and kind, which turned out to be three things short: it could not
say what a file looks like when you are only READING it as against typing in it,
it could not take a renderer off a menu, and it could not set twenty types at
once — so "draw all my source as coloured text" was twelve separate clicks.

What replaced it is a hierarchy and one stage (`fileTypesPane.tsx`):

**Five families, one open at a time.** `PANE_FAMILIES` is coarser than the icon
families in `typeNames.ts`, and deliberately: `plain` and `table` are useful marks
in a tree and useless GROUPS, because text with nothing claimed about it is prose
and a CSV denotes a value like any other data file. Five groups, each with enough
members to be worth opening. It is an accordion — with five families and nineteen
types, a tree that keeps every branch anybody has touched turns back into the flat
list it replaced.

**An All row shows what its types agree on, and nothing where they do not.**
Choosing on it makes them agree. Three outcomes, and the middle one is the one
worth stating:

- every member resolving the same way is the plain answer;
- every member that CAN take the set renderer taking it, the rest left alone
  because there was nothing else they could be, is a PARTIAL answer — shown hollow,
  with the count that makes it true (`Monaco 7/8`);
- anything else is disagreement, and the control is empty rather than picking a
  winner.

**The All menu is the UNION, and every control that cannot reach the whole family
says how far it does reach** — `only Markdown`, `5 of 7 types`. The intersection
was tried first and it is wrong twice over: it hid exactly the settings this screen
exists to reach, and for two families it emptied the menu completely. Hiding a
control is how a setting becomes unreachable from the one screen that exists to
reach it.

**Setting a family writes one line, not seven.** The family's own key, plus the
deletion of every per-type line that disagreed with it — and only for the types the
renderer can reach, because there is no sense in which choosing `Schema-aware` was
an instruction about a CSV. That is what keeps §6's rule intact: what is not chosen
stays unwritten.

```jsonc
"renderers": {
  "application/json:data":   { "read": "tree", "write": "form" },
  "text/markdown:preview":   { "off": ["rendered"] },      // nothing left: the kind is off
  "text/x-typescript:text":  { "theme": { "read": "one-dark" } },
  "family:code:text":        { "read": "codeview" }        // read after the type's own line
}
```

**Resolution reads two axes, per field.** The type's own line, then the MIME chain
(so a preference about markdown reaches a workflow description without anybody
naming a vendor type they have never heard of), then the family — which cannot be a
link in that chain, because `text/x-typescript` and `application/xml` are both code
and share no ancestor but `text/plain`. Per field, so naming your editor does not
disturb your reading. The walk checks each candidate against the renderers that
actually exist before stopping on it, which is what lets a stale specific answer be
stepped over while a vaguer one still applies.

**The old single value migrates to `read`**, which is what it always meant: it was
resolved for the half of the panel that shows the document, and the editor was
picked by a rule nobody could see or change.

**The width cap moved from the pane to the controls.** This section was typography
alone and was capped at 560px for a good reason — a font stack stretched across a
wide window puts a chip at each end of a line with nothing between them — and then
File types arrived as a tree beside a stage beside a live preview and inherited a
width that was never about it, which is why every control in it wrapped. So
`.cfg-pane.ap` is 1040 and the label-and-a-control rows keep 560 for themselves;
File types opts out with `wide`. The figure moved too: it was a crop of the
Appearance pane, so it photographed the screen at a width the app does not draw it
at, and the wrapping in the picture was a property of the CROP rather than of the
screen. It is photographed on its own now.

**The preview is the real surface**, mounted against `EMPTY_CONTEXT` — every
channel present and inert — rather than a picture of one. Its actions are hidden:
the text is local and thrown away, so a Save button would be a button that does
nothing. A renderer that needs a shell the preview has not got (a board wants a
run, a sync panel wants two layers) says so through an error boundary rather than
taking the settings window down with it.


### 6.4 A palette per pick, and what that could actually be made to mean

The theme belongs to the RENDERER, and the renderer is chosen per type and per
view — so the palette is keyed there too (`RendererChoice.theme`), and the control
sits beside the pick rather than in a section of its own. It is absent where the
renderer has none: the data tree, an authoring form, a table of rows and a board
are drawn in the app's own tokens, and a colour-scheme control over them would be
a control that does nothing.

Making that true meant separating two cases that had been one:

**A reading can hold its own palette, and now does.** `CodeText` — every fenced
block in a transcript, and the whole of the code view — is off
`monaco.editor.colorize` and onto Shiki's `codeToHtml`. Monaco emits `.mtkN`
classes whose meaning is a global stylesheet, so every coloured thing in the window
is in one palette by construction and asking for two is asking for something the
mechanism cannot express; Shiki writes the colours INLINE, so ten readings in ten
palettes are ten independent renderings. `textmate.test.ts` is that claim as a
test: the same TypeScript in Monokai Light and One Dark, both at once, checked down
to the hex. It also removes a `setTheme` call — this used to set the window's theme
as a side effect of colouring one fence, which is how a transcript full of them once
repainted every editor on screen.

**An editor cannot, and the honest rule is that the one in front wins.** Monaco has
one theme: `setTheme` repaints the page, a per-editor `theme` option goes through
the same call, and scoping the CSS would not help because the token classes are
indices into a single colour map and a model's cached tokens are computed against
whichever theme was current when it tokenised. So `takeFront` sets the palette when
an editor is created and whenever it takes focus, and two editors of different types
on screen together share whichever was last clicked into. The Editors section's one
value (§6.2) stands behind every type as the palette for anything nobody has said
anything about, which is almost everything.

**"Follows the app" became a real palette rather than an absence.** It had no
TextMate theme, so under Shiki a reading under it would have fallen back to plain
grey — a preference that silently turns colouring off. It resolves to `light-plus` /
`dark-plus`, which are the VSCode defaults Monaco's own `vs` / `vs-dark` are
renditions of, so those users keep the colours they had and gain the real grammars
they never got. `textmateThemeFor(chosen, dark)` is a pure mapping of two words,
which is what makes it answerable in a test suite that has no DOM.

There is a route to per-instance token colours in Monaco and it is written down
here so nobody has to find it twice. The Shiki bridge feeds Monaco **scope strings**
rather than encoded metadata (`setTokensProvider`, `{ startIndex, scopes }`), so
namespacing the scopes per theme (`t1.keyword.control`, `t2.keyword.control`) and
registering ONE merged theme would put both palettes in one colour map with no
`setTheme` involved. The cost is that a tokens provider is registered per LANGUAGE
id, so each theme in use needs a synthetic language — free for most, and expensive
for exactly the five where Monaco's worker binds to the canonical id (TypeScript,
JavaScript, JSON, CSS, HTML) and a synthetic one loses diagnostics and completion.
Worth it only if two editors of different types are routinely on screen together.

### 6.5 The window's theme, and three things about the board

The person's complaint, 2026-09-23: "grey on grey". Measured, it was exact — the
sidebar, the ground, the column, the column's heading band and the card were five
cool greys a few points apart (card : column 1.13:1, column : ground 1.07:1), and a
card was a 6% wash over its column rather than a surface, so nothing on the board
read as an object. From a study of fifteen palettes they picked five and a sixth:
**Ink rail** (the default — a dark sidebar in both themes beside a near-white
workspace), **Classic** (the original, byte for byte), **Hairline**, **High
contrast**, **Blueprint** and **Pastel**; then **Pastel rail** (Pastel beside a dark
aubergine sidebar) and **Zinc** (after t3code's own tokens — its neutrals, one indigo,
borders rather than fills; deliberately not named after it). Each has a light and a
dark, and the mode is light, dark or **system**, which follows the OS and again when it
changes (`resolveTheme`, `useSystemDark`, and `nativeTheme` in main for the frame).

A palette is `Appearance.palette`, written by `applySurface` as `data-palette` on
`:root` (removed for classic, so the stylesheet's own `:root` paints it) and stamped
as `ink` in `index.html` so the first paint is already the default. Each is a token
block per theme plus a few rules; what all but classic share is the fix itself — the
column is a TRACK and the card a TILE with an edge and a shadow of its own, so a
thing is brighter than what holds it. `PALETTE_FRAME` is the copy `main` needs for
the window's background and the OS controls, kept beside the list of palettes.

The three options are about the board, not about a palette, and work over every
one: **lane colours** (each column its own colour, cycling through six),
**columns** as a `box` or a `line`, and **status wash** (a card coloured by its
pill's kind — `data-pill` on the card — and a finished one faded). Each is `null`
for "what the palette says" (`PALETTE_SURFACE`: line for ink, lanes for pastel),
resolved by `surfaceOf` before anything reaches the stylesheet, and written as an
attribute only when it departs from the classic board. Choosing a palette puts all
three back to null, so a palette arrives the way it was designed.
`shots/palettes.mts` photographs every palette in both themes over a real board and
conversation.

### 6.6 Settings pages, after t3code, and the accordion under the tab

The person, shown JaiRA's settings redrawn in t3code's pattern: "i like this much
better … much more readable than jaira patterns". So a Settings page is
`settingsLayout.tsx`: a title and one sentence saying whose settings these are; each
section a quiet sentence-case heading over ONE bordered card; each setting one row —
its name and one sentence on the left, its control at the right edge, a `↺` beside
the name only while the value differs from what it would be untouched, and an `ⓘ` for
whatever did not fit the sentence. The uppercase `app-label` heading over loose rows
is what it replaced. Appearance is the first page built this way (Mode, Theme, Board,
Conversation, Text, File types — the Conversation tab held one setting about how
things look, so it moved in; File types stayed, on the person's call); the other tabs
follow.

While a tab is open, the sidebar lists that page's sections indented under it, lights
the one being read as the page scrolls, and scrolls to one when it is clicked (the
person's design). The list is read off the page, not declared: a section says it is
one with `data-part` (`SettingsSection`, and a top-level `Level`), and
`useSettingsParts` finds them, watches the scroll box, and holds a click's choice while
the smooth scroll it started is still moving.

Then every other tab, on the person's go-ahead ("do the other tabs, and use a switch to
enable/disable a row"). `App.tsx` wraps each in a page (`SettingsFrame`: its name, the
sentence saying whose settings these are — `settingsLeadOf` — and the layer switch at
the head's right edge) and provides `SettingsRowsContext`, under which `Field` draws as
a row: one sentence, the rest and the config key behind an `ⓘ`. A top-level `Level`
and every `cfg-group` became a section. A field a layer may or may not state has a
SWITCH before its name that enables the row (`Field.toggle`, and the schema form's own
switch with `off`): on, the layer states it and the control edits it; off, the row is
disabled and shows what it inherits. Switching on pins the inherited value, so nothing
changes until it is edited — which is also what replaced the Files tab's "Reset to the
defaults" button. The `SET HERE` tag stays only outside Settings. Run inputs, New task
and gates are untouched: the context is only provided around the Settings view.
`shots/settings-tabs.mts` photographs every tab in both themes and drives the
accordion and a row switch.

### 6.7 The Settings pages, reorganised

The person's rulings, 2026-09-23. The tabs had grown one per thing JaiRA was built
out of — Providers, Integrations, Executors, Toolsets, Configuration, Files,
Appearance, History — so a person looking for "the model a project uses" had two
places to set it (Configuration → Default environment and the executor tree's
router), and a person looking for "what an agent may do" had the project `policy`
block on one tab and the toolsets on another. The pages are now one per QUESTION a
person asks, in two groups in the sidebar (`SECTIONS` and `SETTINGS_GROUPS` in
`App.tsx`):

| Group | Page | Icon | What it answers |
| --- | --- | --- | --- |
| **Just you** · `this machine` | Appearance | a half-filled disc | How JaiRA looks on this machine (§6.5, §6.6). No layer switch. |
| **Project & shared** · `layered` | Connections | a plug | What JaiRA can reach, and as whom. |
| | Models | a cube | What answers a state that names nothing, and how. |
| | Tools | a wrench | What an agent may do, and every function a run can call. |
| | Runs | a play mark | How a run behaves while it is going. |
| | Files | a folder | What the Files tree leaves out. |
| | Data & history | stacked disks | Where runs keep what they produce, and how much there is. |
| | `settings.json` | braces | Everything this layer's settings hold, as stored. |

The layered pages run in the order a project is set up: connect a service, pick a
model, decide what the tools may do, then adjust how runs behave. The icons are
`SETTINGS_ICONS`, drawn in the icon set's own hand (24-unit strokes at 1.7);
`settings.json` is drawn as the file it opens, in the data face. Every page's lead is
the page's purpose followed by whose settings these are (`settingsLeadOf`).

**The layer switch is always at the page head's top-right** ("the this
project/shared/built in should always be on the top right"). `SettingsHeader` is
now only the switch, in the head's aside; the lead wraps and the switch keeps the
corner. Tools is the one page with the third, read-only segment `Built in`, because
the permission sets are what JaiRA ships; with no project open it offers `Shared` and
`Built in`, and every other page drops the switch and says in its lead that it edits
`~/.jaira`. When the checks last ran, and `Re-check`, moved off the header to the
head of the section they are about, Connections → Agents.

Where every old tab went:

| Was | Is |
| --- | --- |
| Providers | Connections → Agents, Model APIs, Local models |
| Integrations | Connections → Forges; `review_artifacts`' publish and wait-after-a-comment are its defaults on Tools |
| Executors → the default executor | Models → Routes (the route cards) and Models → Advanced (the tree, in a closed disclosure, no longer repeating the router's defaults, the routes or the function rules); the function rules are Tools → Functions a workflow calls |
| Executors → Presets | Models → Presets |
| Toolsets | Tools → Permission sets ("toolset" is now "permission set" everywhere; the directory is `permission-sets/`) |
| Configuration → Default environment | Models → Defaults — the one way in |
| Configuration → Safety policy | Gone: the project `policy` block is dissolved into the permission sets and `functions` (decision 0007, amended 2026-09-23) |
| Configuration → smart | Tools → the `smart` row's defaults (`functions.smart`) |
| Configuration → Where commands run, Memoization, Workflow lookup | Runs, beside Fast-forward |
| Configuration → Artifacts | Data & history → Artifacts, beside Storage (which no tab drew before) |
| Configuration → the raw document | its own `settings.json` page |
| History | Data & history → Stored history and Pruning |
| Conversation | Appearance → Conversation (§6.6) |

**Connections: one row shape for everything that connects.** What it is and whether
it works on the left (mark, status dot, the check's sentence and fix); who it
connects as on the right, as a horizontal list of boxes ("a horizontal list of boxes
on the right side") — an agent's logins, a forge's OAuth account, a stored key — ending
in a dashed `+` box that adds one (`LoginCards`, `KeyBoxes`, `KeyEntry` in
`providersPane.tsx`; `ForgeRows` in `integrationsPane.tsx`). Local server lists what
the usual ports answered — Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000, Jan
1337 — with `Use` on one that answers and `in use` on the one the route points at
(`LocalServers`); Embedded weights are rows with their file found or missing
(`WeightsRows`). A forge offers `Sign in with GitHub` / `Sign in with GitLab` (the OAuth
device flow, which needs `integrations.oauth.<provider>.clientId`) or `or paste a
token`.

**Tools: the permission sets, then the functions two ways round.** First the
permission sets pane as it was. Then "Functions an agent calls": a function ×
permission-set matrix, the reverse view — one row per tool an agent may call, one
column per set this layer can see, the mode in each cell, a Defaults column — where a
cell opens that set above (the person's ask: "keyed by the function/tool and show you
which permission set has that tool and what it is set to"). Then "Functions a workflow
calls": `smart`, the gates and the agents, each with its defaults and an `available` /
`not reachable` pill read off the default executor's function rules, which are edited
in a disclosure there (`functionsPane.tsx`). A function's defaults are the layered
`functions` block — `functions.smart` (model, prompt; the shipped `DEFAULT_SMART_PROMPT`
is shown in full until a layer writes its own), `functions.review_artifacts` (publish,
settleAfter), `functions.bash` (builtins) — written through the same schema form as
every other setting.

The styles are the stylesheet's "SETTINGS, REORGANISED" section.
`shots/settings-tabs.mts` photographs every page in both themes into
`shots/out/settings/`; the per-page catalog docs are
`docs/ui/surfaces/settings-*.md`.


## 7. Changes to existing code

| File | Change |
| --- | --- |
| `shared/src/ipc.ts` | `project` on `PendingApproval`, `PendingQuestion`, `PendingInteraction` (§2.4) |
| `app/src/main/service.ts` | `open()` stops closing user sessions; delete `focusedKey` (§2.3) |
| `app/src/renderer/store.ts` | Delete `projectDir`; project comes from the address (§2.2) |
| `app/src/renderer/App.tsx` | Approvals strip passes `project` to `onSelect`; project chip per row (§2.4) |
| `app/src/renderer/sidebar.tsx` | Projects over views; one `rowOf` register; collapsed keeps project tiles (§5.1, §5.2) |
| `app/src/renderer/files.tsx` | Tree top level becomes the projects; `~/.jaira` listed once (§2.2) |
| `app/src/renderer/board.tsx` | Card loses its box; trailing pill; lane heading over `finished` only (§5.3) |
| `app/src/renderer/uiState.ts` | Appearance preferences; **no** per-project expansion state (§5.1, §6) |
| `app/src/renderer/App.tsx` | `SECTIONS` gains an `appearance` entry, `layered: false` (§6) |
| `app/src/renderer/store.ts` | `SettingsSection` is a closed union — widen it with `"appearance"` (§6) |
| `app/src/renderer/panes.tsx` | The Appearance pane itself — family multi-select, size steppers, live preview (§6) |
| `app/src/renderer/styles.css` | Two font tokens replace 57 `ui-monospace` declarations; ten register classes; `.card` loses fill/border/shadow/stripe; update the left-edge comment (§3.3, §3.4, §5.3) |
| `docs/ui/direction.md` | §3 belongs here — it is the standing typography vocabulary that doc is waiting for |

---

## 8. Landing order

1. **`project` on the pending types** (§2.4). Correctness, small, independent.
2. **The two voices** (§3). Purely a stylesheet change; no behaviour moves. Ships
   value on its own.
3. **The pill component** (§4.1, §4.2) with live counts only. Replaces the board's
   badge and the sidebar's ad-hoc counts.
4. **Unseen counts** (§4.3) on top of the pill.
5. **The board card** (§5.3).
6. **Multi-project** (§2.2, §2.3, §5.1, §5.2) — the largest step, and the only one
   that touches the service.
7. **Appearance preferences** (§6).

---

## 9. Questions, and their answers

All four were decided on 2026-08-18. Kept as questions because the reasoning is
what a later change has to argue against, and an answer with its reason attached
is harder to reverse by accident than a rule.

1. **`interrupted`: warning or active?** → **Warning.** The active set is exactly
   working and waiting-on-you, and an interrupted run is neither: nothing is
   happening, and nothing is being asked of you until you go and restart it.
   `laneOf` still calls it "a pause somebody has to end", which stays true and is
   a fact about the LANE — where the card sits among its neighbours — rather than
   about whether the row counting it should read as live.
2. **Does `+N` carry colour?** → **Yes**, tinted to the worst kind behind the
   fold. Colourless, a folded error and a folded success were the same grey `+4`,
   so the fold hid the one fact it exists to summarise. Severity is its own order
   (`PILL_SEVERITY`) and deliberately not `PILL_ORDER` or its reverse: that one is
   a claim about SPACE, and the two disagree at both ends — `running` heads the
   priority order because no width may hide a live run, and sits near the bottom
   of severity because a hidden run will say so again by itself. The overflow pill
   stays FLAT: it is a marker, not a sixth status.
3. **Do running tasks belong in the unseen counts?** → **They belong in the
   counts, and they are never unseen-scoped.** The point of the pills is to know
   what is happening without opening the view, and unseen-scoping the active kinds
   would clear `▶2` the moment somebody glanced at the row — two runs still going
   and nothing on screen saying so, which is the one question these rows exist to
   answer. It does mean `▶2` and `✓3` count different populations; that is the
   price, and it is worth it. A live fact is worth stating every time it is true.
4. **Is the split pane still wanted?** → **Yes** — its job is authoring a state
   while watching it run, which is a different function from navigating, and one
   pane cannot be in two places at once.

   The constraint that follows is the one this document already named: **the view
   components stay instanceable.** They are, and it is worth saying why that is
   not an accident to be re-checked but a property to be kept — `Board`,
   `FileTreePanel`, `ChatView`, `ChatListPanel`, `TaskAddressBar` and `Sidebar`
   all take their address as props, and `useApp()` has exactly ONE call site. A
   view that reached for the store directly would bind itself to the window and
   cost a rewrite later; the rule is that it must not.

   What is still window-bound is the STORE's single address (`state.at`,
   `state.view`, `state.doc`). Splitting the pane means making that per-pane, and
   the shape of it — how a second pane is opened, whether it has its own sidebar,
   what the window title says with two addresses on screen — is not designed here
   and needs its own pass.

---

## 10. Visual reference

The mockups these screens were drawn from, with the alternatives that were
considered and the reason the chosen one won. §10.1 is how the running app is
checked against them.

**The composed reference is in the repository**, at
`packages/app/shots/reference/the-shell.html` — the seven figures this
document's §2–§6 are drawn from, with the two faces extracted into
`app/src/renderer/fonts/` and pointed at from there rather than embedded twice.
A link is a reference somebody has to be logged in to open; a file in the tree is
one a comparison can be run against.

| Subject | Reference |
| --- | --- |
| **The shell, composed (seven figures)** | `packages/app/shots/reference/the-shell.html` · https://claude.ai/code/artifact/8657c833-6f01-4090-86e2-baf6e62b2628 |
| Multi-project layouts (five) | https://claude.ai/code/artifact/182b8a00-23b6-4fed-a107-7c9c296d04f0 |
| Sidebar structures (four) | https://claude.ai/code/artifact/c25f5b2e-58d6-494a-b8f4-f2edded48aa3 |
| Projects-over-views variants | https://claude.ai/code/artifact/389ace43-3491-4a63-94aa-4b819d83f8aa |
| Visual treatments (five) | https://claude.ai/code/artifact/2a6f01ce-6774-4b67-b79c-98e7037a326c |
| Composed treatments (six) | https://claude.ai/code/artifact/e5394c72-54ba-4c4e-8bd5-a283c4d51299 |
| Type settings | https://claude.ai/code/artifact/616758af-d1cc-475f-a638-0424bdb07042 |
| The project-name register | https://claude.ai/code/artifact/5c093572-f04b-414e-9968-2bf0c2a9ac06 |
| The two voices | https://claude.ai/code/artifact/088aba86-f650-406a-8944-0497298887a8 |
| Voice and state (ten registers) | https://claude.ai/code/artifact/aa99309e-c041-4660-b1bd-9d8920751032 |
| Nav, cards, appearance | https://claude.ai/code/artifact/838459fa-cabd-4614-817f-9f1469067337 |
| Unseen counts, stripe-free cards | https://claude.ai/code/artifact/64ff4322-d273-43e2-8f92-bd168c0f37c7 |
| The pill vocabulary | https://claude.ai/code/artifact/92296173-c85e-4cff-a80c-f73c2c6c1802 |
| `+N` overflow, final pill set | https://claude.ai/code/artifact/578b0a97-25ce-4bd7-9203-cc8fc28e0510 |

The remaining rows are private links on the author's account. Everything an
implementer needs is in §3–§6; the references are for the judgement calls, not
the values.

### 10.1 Checking the app against them

```
npm --workspace @jaira/app run shots
```

Photographs **the running app**. It builds a scratch project, starts real tasks
in it, waits for each state to arrive, and captures the window — board, an open
task, a parked gate, that gate answered, settings — in both themes. The pictures
land in `packages/app/shots/out/` (git-ignored), to be read beside the figures in
`shots/reference/the-shell.html`.

The runs are scripted (`fake`), so the whole set costs nothing and reaches no
provider. They are otherwise ordinary runs: real snapshot, real journal, real
projection, real panes at the width panes actually have.

**This replaced a harness that photographed specimens** — components handed
fixtures and framed in a box — and the reason is worth keeping. A `BoardCard`
built by hand has never been through the projection, never sat in a pane, and
never had a neighbour, so the pictures were routinely not what the app showed.
They also drifted without a sound: nothing typechecked the props, and by the end
the specimens carried numeric instance ids and a `runId` from before runs
collapsed into tasks. A rig that can disagree with the app eventually does.

Nothing under `shots/` describes a surface. A scene says how to *reach* a state,
and the app draws whatever it draws.

Three things it is deliberately not:

- **Not a pixel-diff gate.** The figures are mockups: they carry hand-written
  strings the app has no field for, and a numeric threshold over that comparison
  measures the mock's prose, not the app's chrome. What the pictures are for is a
  person — or an agent — looking at two of them.
- **Not a second rendering of anything.** There is one page, and it is the app's.
  The harness before this had its own HTML, its own Vite build and its own
  content policy, and that last one let a WebAssembly module run in the figures
  that the app itself refuses (`test/csp.test.ts` remembers).
- **Not committed output.** The PNGs go stale the first time a hairline moves,
  and the scratch project is rebuilt from nothing on every run.

Three differences it surfaces that are *data*, not styling, and are still open:

1. **A card's second line.** The figures say `40s · 3 turns` for a running card
   and `6 min ago · not a SyncEdit` for a failed one. `BoardCard` carries neither
   an elapsed time, a turn count, nor a failure reason, so the app says the
   active state id instead.
2. **`approve` versus `gate`.** §5.3 asks the second line to distinguish a tool
   approval from an authored gate. Both arrive as `waiting_for_user`;
   `waitingKindOf` currently splits `waiting_for_user`/`blocked`, which is a
   different cut.
3. **Where `interrupted` sits.** Figure 06 files a stopped run under `finished`;
   `laneOf` puts it in `paused`, which is what §9.1 decided and this document
   still holds to. The figure is the loose one.
