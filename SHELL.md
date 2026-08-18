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

Visual reference (rendered specimens, both themes) is listed in §10.

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
| Providers · Executors · Configuration · History | app | |
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

---

## 5. Surfaces

### 5.1 The sidebar

Structure, top to bottom:

```
[toggle]  JAIRA                                  ← app-label; drag handle
▸ declarative-ai                    ▶2 ⏸3 +4     ← data-title when open, data-secondary when not
    ❏ FILES                              ▾       ← app-label, .is-active when current
        workflows/feature/                       ← data-text
        prompts/review.md                        ← data-text .is-active
    ▶ TASKS                         ▶2 ⏸3 +4
    ✎ CHAT                              ⏸1
  notes-api                             ⛔1 ✓4
  atlas-web                             ▶1 ⚠1
  ~/.jaira                                  ▸
─────────────────────────────────────────────    ← border-top --line
  ≡ LOGS   ⌁ DEBUG   ☾ DARK   ⚙ SETTINGS         ← app-label, same rows
```

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
- The trailing pill is the same component as the sidebar's, with a word instead
  of a count. Active filled, status flat — so a column sorts itself visually
  before a title is read.
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

**Required fix:** the comment above `.card::before` reserves the left edge for
"run status down a column of cards" — that reservation is the only reason the
edge survived the last pass. Change the comment with the code, or the stylesheet
argues for an idiom the app no longer uses.

---

## 6. Appearance preferences

Modelled on t3code's `appearanceFonts.ts`, mapped onto two voices.

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

The control is a **multi-select**, not a text field: a stack is an ordered list,
so the chips are numbered 1, 2 (the second family is what renders a glyph the
first lacks), drag to reorder, ✕ to drop. The default stack is the last line of
the menu — stated and un-removable, which makes "prepend, never replace" visible
rather than a rule you have to know. **Size sits on the same line as the family
it applies to.**

One thing from t3code *not* to copy: its marketing CSS sets
`font-feature-settings: "ss01", "ss02"` on DM Sans. The served font's features
are `calt, ccmp, dnom, frac, liga, locl, numr` — there is no `ss01` or `ss02`,
and that declaration does nothing. What DM Sans does have is two axes,
**`opsz 9–40`** and **`wght 100–1000`**; JetBrains Mono has `wght 400–800`.

---

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

## 9. Open questions

1. **`interrupted`: warning or active?** Filed under ⚠ here because the active set
   is defined as exactly working and waiting-on-you. But `laneOf` calls it "a
   pause somebody has to end — not a failure", and a person may well think an
   interrupted run is theirs to resume. If it is active, it takes a third active
   icon and the priority order grows an entry.
2. **Does `+N` carry colour?** Recommended: tint it to the most severe kind it
   hides. Otherwise a folded error reads as a folded success.
3. **Do running tasks belong in the unseen counts at all?** A count that will
   change again on its own is not really something you failed to see. The pill
   set works if status is unseen-scoped and active is live — which is what §4.3
   says — but it means `▶2` and `✓3` on the same row are counting different
   things.
4. **Is the split pane still wanted?** Not specified here. Authoring a state in
   `~/.jaira` while watching it run in a checkout is the one thing this design
   does not do; if it is wanted, keep the shell's view components instanceable
   rather than binding them to the window.

---

## 10. Visual reference

Rendered specimens, both themes, at real width. Each carries the alternatives
that were considered and the reason the chosen one won.

| Subject | Reference |
| --- | --- |
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

These are private links on the author's account. Everything an implementer needs
is in §3–§6; the references are for the judgement calls, not the values.
