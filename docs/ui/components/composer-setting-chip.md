---
id: ui/components/composer-setting-chip
type: ui-component
status: shipped
updated: 2026-11-02
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists]
serves: [product/chat-with-agents, product/steer-agents-mid-task, product/risky-actions-wait-for-approval, product/agents-act-only-where-allowed, product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/model-cascade, ui/components/icon]
implemented_by: [packages/universal/src/components/chat/Composer.tsx, packages/universal/src/components/chat/ComposerCards.tsx, packages/universal/src/components/chat/ComposerStack.tsx, packages/universal/src/components/chat/ComposerTools.tsx, packages/app/src/renderer/composerCards.ts, packages/app/src/renderer/composerStack.ts, packages/app/src/renderer/composerStackHost.ts, packages/app/src/renderer/composerPermissionSet.ts, packages/shared/src/permissionSetBuckets.ts, packages/shared/src/permissionLayers.ts, packages/shared/src/permissionSetTree.ts]
verified_by: [packages/app/test/composer.test.ts, packages/app/test/composerStack.test.ts, packages/app/test/livePermissions.test.ts, packages/app/test/permissionSetsService.test.ts, packages/app/shots/permission-switch.mts, packages/app/shots/sticky-composer.mts, packages/app/test/runnerGroup.test.ts, packages/shared/test/permissionSetBuckets.test.ts, packages/app/shots/parityWorld.mts#composer-model, packages/app/shots/parityWorld.mts#composer-thinking, packages/app/shots/parityWorld.mts#composer-permissions, packages/app/shots/parityWorld.mts#composer-tools]
mockups: [ui/assets/composer-setting-chip/resting.html, ui/assets/composer-setting-chip/inherited.html, ui/assets/composer-setting-chip/overridden.html, ui/assets/composer-setting-chip/buckets.html, ui/assets/composer-setting-chip/custom.html, ui/assets/composer-setting-chip/tools.html]
siblings: [ui/components/composer, ui/components/model-cascade, ui/components/context-menu, ui/components/preset-chips]
---

# Composer setting chip

A borderless rounded chip in the composer's footer, a small grey glyph and a dim word naming what the next message will run under, such as `claude-cli/claude-sonnet-5` or `high`, that opens a card upward headed by the setting's name and where its value comes from — and, after them, the permission STACK: one joined segment per layer, `ask-first ⌄` · `app/build` · `tools · 9 · 3` · `+`, each opening onto its own layer (decision 0023 §4.1, rulings 8–11; the runtime layer folded into `tools` 2026-11-03).

## A setting chip changes one setting for one message

**Use when.** A message is about to be sent and the person checks or changes what it runs under: its model, how hard it thinks, and the stack of permission sets it is judged under — which sets, in which order, and the conversation's own lines (which tools it is offered and what each may do). Model, Thinking, then the stack, always in that order.

**Do not use when.** The setting belongs to a process, a project or every project: the settings screens and the state's own form edit it. The choice is one of a few verbs on an item: use a [context-menu](context-menu.md). The words pick a preset in a settings row: use [preset-chips](preset-chips.md).

## The value reads first, and the card says where it came from before offering the choices

- **Chip.** A glyph at 13px in `--tok-hint`, 5px, then the value in the app face at 11.5/12.5 in `--dim`, padded 3px by 9px, fully rounded, at most 210px wide with the value ending in an ellipsis. The model chip's glyph is the route's brand mark in its own colour; Thinking's a spark.
- **Chosen for this conversation.** Word and glyph in `--accent`.
- **Open.** `--fill-ghost-selected` ground, a 1px `--line` edge and `--text`.
- **Card.** 7px above the chip, left-aligned to it, on `--panel` with a 1px `--line` edge, 12px corners and the lifted shadow, padded 10px by 12px, between 250px and 560px wide as its content needs.
- **Card head.** The setting's name at 11/12.5 and weight 600 in `--text`, then its origin at 10.5/12.5 in `--tok-hint`, and a `reset` pill in `--panel-2` at the far end when the value was chosen here. The head keeps 132px clear at its right.
- **Thinking.** A list of full-width rows 1px apart: a 14px glyph, the name at 12/12.5 weight 500 over a hint at 10.5/12.5 in `--tok-hint`, and a `✓` in `--accent` at the far end of the row in force, which sits on a 13% `--accent` wash. A hint sentence closes the card in `--tok-hint`, at most 320px wide.
- **Model.** The card holds the [model-cascade](model-cascade.md).
- **The stack** (`ComposerStack.tsx`). Joined segments 1px apart, each padded 3px by 9px on `--panel-2` in `--dim` at 11.5/12.5 (hovered `--panel-3` and `--text`; open a 13% `--accent` wash and `--accent`), the first rounded on its left and the last on its right. First a shield cap (the stack's glyph, 13px `--tok-hint`); then one segment per layer, oldest to newest, each named by its set's full id with its bucket (`ask-first`, `app/build` — a bucket belongs to its set, not to the stack); the bottom layer carries its set's icon and a `⌄`; a file built of layers is one segment, and a standing layer of the bucket (pinned to the project in settings) is a segment among them; then `tools · {n}` (a wrench; the tools offered), with `· {n}` after it in `--accent` weight 600 when this run has answers, and `+`.
- **Collapsed.** A composer too narrow for the segments draws the stack as ONE segment rounded at both ends: the shield, the bottom layer's icon (12px), and `+{n}` — the layers over the bottom, and one more when the conversation has lines of its own or this run has answers. Pressed, it opens the shield's browser.
- **A layer's card, compact.** 480px wide. Its head is the set's file glyph (17.6 × 22, corners 3 8 3 3, `--accent` and its 10% wash) and the set's path as crumbs that are pickers — `Built in › ask-first.json`, each in the data face 500 12/12 with a `⌄`, open on a 13% `--accent` wash — and `⤢` at the far end. Under it, `{scope} · {n} lines — only what it writes is shown`, then the set's contents: the [permission set card](permissionSet-card.md), read-only, drawn from the lines the file writes. Last, behind a `--panel-2` rule, the layer's actions in `--accent` at 10.5/12.5: `‹ earlier`, `later ›`, `pin to this project` (or `unpin from this project`), `edit a copy`, and `remove` in `--bad`, pushed right.
- **A crumb's menu.** Under the crumb, at least 240px: what sits beside it — the scopes, a scope's buckets, or a bucket's sets, each a row with a folder (a scope its own glyph) or the set's file glyph, the name over `{n} sets` / `{n} lines · in the stack`, and a `›` on a folder. A folder picked drills into what is in it, in the same menu, under its name in small capitals.
- **The browser** (`⤢`). The card widens to 860px (at most the window less 32): the crumbs over both panes behind a `--panel-2` rule, `⤡` at their end on an `--accent` wash; a tree 300px wide — scopes, buckets nested 14px a level, files with their set's icon, `{n} lines` and an `in the stack` tag, the selected one washed — beside the selected file's contents; and a foot: `open in Settings` in `--tok-hint` at the left, `Cancel` bordered, `Use as this layer` on `--accent`. The look is remembered: expanded stays expanded on every segment until `⤡`. On a phone the tree stands over the contents.
- **The shield's browser.** The browser, 900px wide, its tree starting with THIS stack: `This conversation` (the shield, `oldest first`), each layer as a file row (its id over `{scope} · pinned · {n} lines`), then `tools` (a wrench, `{n} offered · {n} from this run`); a `--panel-2` rule; then the scopes. It opens on `tools`. A layer picked: its crumbs head the card and swap it, its contents fill the right, and its actions — `‹ earlier`, `later ›`, the pin, `remove` — stand in the foot beside `Done`. `tools` picked: the Tools card's switch and rows. A set picked from a scope: its contents, and `Lay it on top`.
- **`tools`.** Today's Tools card over what the whole stack comes to; what it writes is the conversation's own lines, the stack's top layer. What this run answered is marked on the line it is about — a tool's, a command line's — as an `--accent` pill before the mode, `this run · allow` (`in {place}` when kept at one), 600 10/12.5 on a 13% `--accent` wash, with a `×` that lets it go; an answer with no line of its own is a line inside its program's group (or at Execution's end): the terminal glyph, the width in the data face, the pill and the decision's chip. A section or group holding one starts open. Its head gains a switch, `This conversation` | `Everything`, two buttons in a 1px `--line` box, the one on washed 13% `--accent`. On Everything the same rows are read-only, each line tagged with the layer that decided it (a `--panel-2` pill at 500 10/12.5 in `--dim` before its mode), and the head holds `save this stack as a set` on a 13% `--accent` wash.
- **`⋯ {n}`.** `Folded — oldest first` in small capitals, a row per folded layer (its glyph, its id in the data face over its scope and lines, a `›`), and `Press one to adjust it, as its own segment would.`
- **`+`.** The browser, opened on the bottom layer's bucket with nothing picked, its verb `Lay it on top`.
- **Tools card.** Six sections under 1px `--line` rules: File permissions, Execution, Web, Tasks & workflows, MCP, then Other. A section with tools is a fold, a `›` turning down when open, the name over its hint, a round `--accent` count of the lines held, and a mode button. Open, its tools hang under it behind a 1px `--line` rule 9px in. Each tool is a standard grey bordered button with its tick, glyph, name and hint centred, tinted `--accent` when offered, then an outlined implementation button in `--tok-hint` when an agent answers and has its own version, then a mode button with a glyph and a word. `allow` is `--ok`, `deny` is `--bad`, and `custom` is `--tok-hint` with a dashed edge. A section with no tools shows its name in `--tok-hint` over `nothing here`. A mode button opens a small list of the four modes below it, right-aligned, on `--panel` with 9px corners and a deep shadow.
- **Execution.** After the shell's line, one fold per program the permission set names, drawn as a section is without the rule above it: `›`, a terminal glyph, the program, a hint, a count of its named subcommands, and a mode button. Open, its subcommands hang 18px further in, each a tool's line with no implementation button, then a line that adds one: a 17px dashed circle holding `+` and the words in `--tok-hint`. `script` follows the programs as one more line, with a page glyph, and the section ends with the line that adds a command. An adding line opens in place into one box over `Cancel` and an `--accent` `Add`.

## Every chip shows the value that will run, and the card shows who decided it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a chip always names a value. Where nothing sets one it names what decides instead: `the model's default`, or `no model configured` beside a faint grey square. A stack that names no set is `tools` and `+` alone. | |
| loading | Until the settings are read, Thinking reads `…` and the model reads `no model configured`. Until the engine has composed the stack its segments are read off the settings alone (each layer by its id, no icon), and a card's contents read `…`. | [resting.html](../assets/composer-setting-chip/resting.html) |
| resting | Two dim chips and the stack. With nothing chosen here the stack is the state's: its bottom is the set the state names (`ask-first` for `chat/session`), with the bucket's standing layers over it. A choice made here turns Model's or Thinking's chip `--accent`; the stack's origin is said on the Tools card. | [resting.html](../assets/composer-setting-chip/resting.html) |
| inherited | A chip open over its card: `inherited from {state}` or `inherited`, and the value in force ticked. With nothing setting it the origin reads `nothing here sets it` in italic and no row is ticked. | [inherited.html](../assets/composer-setting-chip/inherited.html) |
| overridden | A row picked here: the chip `--accent`, the origin `your choice for this conversation` in `--accent`, the picked row washed and ticked, and `reset` in the head. | [overridden.html](../assets/composer-setting-chip/overridden.html) |
| a layer open | The segment washed `--accent`; its card compact with a crumb's menu open over the contents (Expand 6, compact) — or, expanded, the tree with its file selected and the crumbs in step (Expand 6, expanded). A standing layer's crumbs are words, not pickers, and its actions are its pin and `edit a copy`. | decision 0023's mockups, round 8, design 6 |
| folded | A stack too long for the composer keeps its first segment and `tools`, `+`, and folds the middle — two layers or more — into `⋯ {n}`; it folds before any chip's words drop. Narrower still it collapses to the shield, the bottom's icon and `+{n}`. | round 6, design 8 |
| tools | The Tools card with Execution open: the shell, `git` open onto its subcommands and the line that adds one, `npm` shut, `script`, and the line that adds a command; a section whose lines disagree reads `custom`, and MCP has nothing in it. On Everything the same rows, read-only, tagged by layer. | [tools.html](../assets/composer-setting-chip/tools.html); round 6, design 7 |
| error | Cannot occur on the chip: a setting that is an expression is named by the composer's amber note, and a send that fails is reported above the composer. A set a card cannot read says why where its contents would be. | |

## Picking changes the conversation, and the answer in progress from its next call; reset gives it back

What the chips and the stack say is the conversation's: kept on it as they change (`ChatSettings.permissionSet` in its stack shape — `layers` oldest first, the bottom first, and the tools layer's own lines beside them), sent or not, and what it opens with again — after another conversation, in another window, after a restart (the person, 2026-10-05 and 2026-10-24). Its next message is sent with them. While it answers, its next call is decided under the new stack, and the rows of that call name the layers of the new stack.

| On | Does | Feedback |
| --- | --- | --- |
| Click a chip or a segment | Opens its card, or closes it | Chip ground and edge, or the segment washed; card above |
| Click outside the card, or Escape | Closes the card | The card is gone |
| A Thinking row | Sets the effort for the conversation's messages | The row washed and ticked, the chip `--accent` |
| A crumb | Opens what sits beside it; a folder picked drills into it | The menu under the crumb |
| A set in a crumb's menu (compact) | Swaps the layer for that set — `ask-first` for `read-only` is the set's crumb, then its sibling | The segment reads the new id; the card's contents are the new set's |
| `⤢` / `⤡` | Widens the card into the browser, or back; remembered for every segment | The tree beside the contents, or the compact card |
| A row of the tree | Opens a scope or a bucket, or selects a set | The crumbs follow the selection; the contents are the set's |
| `Use as this layer` | Swaps the segment's set for the one selected | The card closes; the segment reads it |
| `‹ earlier` · `later ›` | Moves the layer one earlier or later among the conversation's layers; moving the bottom later makes the next the bottom | The segments reorder |
| `pin to this project` | Writes the set into this project's standing layers for the bottom's bucket (`permissions.layers.<bucket>`, the project's settings), and takes it out of the conversation's own | The segment stands where standing layers stand, for every conversation of the bucket |
| `unpin from this project` | Takes it off the project's standing layers | The segment goes |
| `edit a copy`, `open in Settings` | Opens Settings → Tools, on this project's layer | Settings |
| `remove` | Takes the layer out of the stack | The segment goes |
| A run answer's `×` (Tools card) | Lets go of that answer for this task; a call waiting on the person is decided again | The pill goes; the tools segment's count drops |
| `tools` | Opens today's Tools card; every edit writes the conversation's own lines — what differs from the layers under it, and `unavailable` for a tool unticked over a layer that offers it | As before |
| `This conversation` · `Everything` | Switches the Tools card between its lines and the whole stack, read-only and tagged | The rows and their tags |
| `save this stack as a set` | Opens a name and where it goes; `Save` writes a set file of the bottom's bucket: `{ "layers": [ … ], …the conversation's lines }` | `saved as {bucket}/{name}`; a name the layer already holds, or one that cannot be a file, is said under the form |
| `⋯ {n}` | Lists the folded layers; one pressed opens as its own segment would | That layer's card |
| `+` | Opens the browser; `Lay it on top` adds the set as the newest of the conversation's layers | A new segment before `tools` |
| The shield cap, or the collapsed stack | Opens the shield's browser: this stack's layers and `tools` above the scopes | The browser, on `tools` |
| Any change to the stack | Every call waiting on the person in this conversation is decided again under the new stack: one it now allows or denies is answered, by the permissions; one still asking redraws its rows | The approval goes, or its rows change |
| `reset` (Tools card) | Drops the conversation's stack: the state's stands again | The segments read the state's |
| A section's fold, or a program's | Opens or closes what is under it | `›` turns a quarter |
| A section's mode | Writes that mode onto every line in the section | Each line's mode button changes |
| A program's mode | Sets the mode for any command of that program its lines do not name | The button changes; the subcommands keep theirs |
| A tool's button | Offers the tool, or stops offering it | Tick and wash appear or go; the section's count changes |
| A command's button | Takes the command out of the permission set | The line goes; the program's count drops |
| `script`'s button | Names running a file in the permission set, or stops naming it | Tick and wash appear or go |
| `add a {program} subcommand`, `add a command` | Opens one box; `Add` names the command at the mode that already answers for it | The line appears under its program, which opens. A tool's name, `other`, or a word that is not a program is refused under the box |
| A line's mode, or Other's | Opens the four modes; picking one sets it | The button takes the mode's glyph, word and colour |
| A tool's implementation | Opens `JaiRA` and the agent's own; picking one sets which runs the tool | The button's word changes |

## The copy names the setting, its value and the reason each choice exists

| Where | String |
| --- | --- |
| Card titles | `Model` · `Thinking` · `Tools` |
| Chip tooltip | `{title}: {value}` |
| Chip values | `{route}/{model}` or `no model configured` · `low` `medium` `high` `xhigh` or `the model's default` |
| Segments | `{bucket}/{name}` · `⋯ {n}` · `tools · {n}` `· {n}` · `+`; collapsed: the shield, the bottom's icon, `+{n}` |
| Segment tooltips | `{id} · {scope}` (`· pinned to this project`) `— adjust this layer` · `{n} more layers: {id} · {id}` · `tools: {n} offered — this conversation's own lines` (`; {n} answers from this run, marked on the lines they are about`) · `Lay a permission set on top` · the shield `Permissions: everything the stack comes to` · collapsed `Permissions: {bottom}; {n} more layers: …; {n} lines of this conversation's own; {n} answers from this run` |
| Run marks | `this run · allow` · `this run · deny in {place}` · `×` `Let go of this answer: the line decides again` |
| Shield's browser | `This conversation` `oldest first` · `tools` `{n} offered · {n} from this run` · `what the whole stack comes to — what this run changed is marked` · `Done` · `Lay it on top` |
| Origin | `your choice for this conversation` · `nothing here sets it` · `inherited` · `inherited from {state}` |
| Reset | `reset` |
| Thinking rows | `low` quickest, least deliberation · `medium` a balance · `high` works the problem · `xhigh` `deepest — slowest and dearest` |
| Thinking sentence | `A model that tops out lower clamps rather than refusing.` |
| A layer's card | crumbs `Built in` `Global` `Project` › `{bucket}` › `{name}.json` (`choose a set`) · `{scope} · {n} lines — only what it writes is shown` · `‹ earlier` `later ›` `pin to this project` `unpin from this project` `edit a copy` `remove` · ⤢ `expand to browse — stays expanded until you press it again` · ⤡ `back to compact — stays until you press it again` |
| A crumb's menu | `{n} sets` · `{n} sets, and {n} inside` · `{n} lines · in the stack` · `{scope} has its own` · `nothing here` |
| The browser | `what ships` · `~/.jaira` · `.jaira` · `{n} lines` · `in the stack` · `pick a permission set` · `Pick a set on the left to see what it writes.` · `open in Settings` · `Cancel` · `Use as this layer` · `Lay it on top` |
| `runtime` | `runtime` `this run` `clear` · `answers you gave in this task — emptied when a run opens` · `No answers yet — what you allow or refuse for this run is kept here.` · `in {place}` · `anywhere` |
| `⋯ {n}` | `Folded — oldest first` · `{scope} · pinned · {n} lines` · `Press one to adjust it, as its own segment would.` |
| Tools switch | `This conversation` · `Everything` · `save this stack as a set` · `saved as {bucket}/{name}` · form `Keep this stack — its layers, and this conversation's lines — as a permission set in {bucket}` · `name` · `where` `in this project` `for all projects` · `Save` |
| Everything sentence | `What the whole stack comes to, each line with the layer that decided it. Change a line under This conversation, or in the layer that says it.` |
| Sections | `File permissions` reading, searching and changing files in the workspace · `Execution` running commands on this machine · `Web` reaching the network · `Tasks & workflows` starting, moving and answering tasks · `MCP` tools served by connected MCP servers · `Other` anything not listed above — an agent's own tools with no equal here included · `nothing here` |
| Execution | `shell` the shell — and the mode for any command not named below · `{program}` over `{n} subcommands named; any other {program} asks` `is allowed` `is refused` `goes to the approver` when open, and its subcommands joined by ` · ` when shut · `script` running a file — ./x.sh, npm run, python x.py, make · `add a {program} subcommand` · `add a command` · `Cancel` · `Add` |
| Modes | `ask` stop and ask before each call · `auto` decided per call by the approver · `allow` goes ahead without asking · `deny` refused every time · `custom` |
| Mode tooltips | `{section}: sets every tool under it` · `{tool}: {mode hint}` · `Anything this project has no name for` |
| Tool rows | `{label}` over `{hint}`; a tool nothing serves yet ends ` · not served yet` |
| Implementation | `JaiRA` our implementation, through the artifact map · `{agent's name for it}` `the agent's own — still gated by the mode beside it` · tooltip `Implementation: {hint}` |
| Tools sentence | `Ticking a tool offers it; the mode beside it is what happens when it is called. A shell line is taken apart, and each part answers to its own line here.` · `This project registers no tools.` |

## The stack folds first, then the chips shrink, and every card opens upward

- Narrow composer: the foot stays one line (`footFitOf`): the stack folds its middle into `⋯ {n}` first, then the chips' words drop in steps — shorter words; the model's name, Thinking's icon, the stack's first layer as its icon and its counts bare; icons alone. A card is as wide as its content up to 560px or 78% of the window (a layer's card 480, the browser 860, each at most the window less 32), and can reach past the composer's edge.
- A mode list, an implementation list or a crumb's menu floats over the card and may hang below it; opening one never changes the card's size.
- Theme: grounds, washes and mode colours are tokens. A brand mark keeps its own colour in both themes, so Anthropic's near-black mark all but vanishes on the dark ground.
- Focus: chips, segments, crumbs, rows, folds and mode buttons are native buttons in Tab order. Escape closes a card; a mode or implementation list, a crumb's menu and the save form close only on a click outside them. The name, the place and a new command are asked through the schema form, like every other typed input. Arrow keys do nothing.
- Only one card is open at a time, because opening a second is a click outside the first.
- Phones: the cards are the same floats, inside the window; the browser stands its tree over the contents.

## The chips set data in the app face and draw tools as standard buttons

- Model ids, tool names and state ids are data set in the app face; set ids in a crumb, the tree and the fold are in the data face.
- A tool's button keeps the standard grey bordered button look with its words centred, unlike the plain rows of the other cards.
