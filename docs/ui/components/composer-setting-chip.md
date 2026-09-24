---
id: ui/components/composer-setting-chip
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists]
serves: [product/chat-with-agents, product/steer-agents-mid-task, product/risky-actions-wait-for-approval, product/agents-act-only-where-allowed, product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/model-cascade, ui/components/icon]
implemented_by: [packages/app/src/renderer/composer.tsx, packages/app/src/renderer/composerPermissionSet.ts, packages/shared/src/permissionSetBuckets.ts]
verified_by: [packages/app/test/composer.test.ts, packages/shared/test/permissionSetBuckets.test.ts]
mockups: [ui/assets/composer-setting-chip/resting.html, ui/assets/composer-setting-chip/inherited.html, ui/assets/composer-setting-chip/overridden.html, ui/assets/composer-setting-chip/buckets.html, ui/assets/composer-setting-chip/custom.html, ui/assets/composer-setting-chip/tools.html]
siblings: [ui/components/composer, ui/components/model-cascade, ui/components/context-menu, ui/components/preset-chips]
---

# Composer setting chip

A borderless rounded chip in the composer's footer, a small grey glyph and a dim word naming what the next message will run under, such as `claude-cli/claude-sonnet-5`, `high`, `ask first` or `3 tools`, that opens a card upward headed by the setting's name and where its value comes from.

## A setting chip changes one setting for one message

**Use when.** A message is about to be sent and the person checks or changes what it runs under: its model, how hard it thinks, its permission posture, and which tools it is offered and what each may do. There are exactly four, always in that order, one per question.

**Do not use when.** The setting belongs to a process, a project or every project: the settings screens and the state's own form edit it. The choice is one of a few verbs on an item: use a [context-menu](context-menu.md). The words pick a preset in a settings row: use [preset-chips](preset-chips.md).

## The value reads first, and the card says where it came from before offering the choices

- **Chip.** A glyph at 13px in `--tok-hint`, 5px, then the value in the app face at 11.5/12.5 in `--dim`, padded 3px by 9px, fully rounded, at most 210px wide with the value ending in an ellipsis. The model chip's glyph is the route's brand mark in its own colour; the others are a spark for Thinking, a shield for Permissions and a wrench for Tools.
- **Chosen for this message.** Word and glyph in `--accent`.
- **Open.** `--fill-ghost-selected` ground, a 1px `--line` edge and `--text`.
- **Card.** 7px above the chip, left-aligned to it, on `--panel` with a 1px `--line` edge, 12px corners and the lifted shadow, padded 10px by 12px, between 250px and 560px wide as its content needs.
- **Card head.** The setting's name at 11/12.5 and weight 600 in `--text`, then its origin at 10.5/12.5 in `--tok-hint`, and a `reset` pill in `--panel-2` at the far end when the value was chosen here. The head keeps 132px clear at its right.
- **Thinking and Permissions.** A list of full-width rows 1px apart: a 14px glyph, the name at 12/12.5 weight 500 over a hint at 10.5/12.5 in `--tok-hint`, and a `✓` in `--accent` at the far end of the row in force, which sits on a 13% `--accent` wash. A hint sentence closes the card in `--tok-hint`, at most 320px wide.
- **Permissions head.** Between the title and the origin, a bucket picker: a 12px folder glyph, the bucket's name at weight 600 in `--text` and a `›`, borderless, on a 7% `--text` wash when hovered or open. It opens the card's own list below it, left-aligned and at least 320px wide: one row per bucket with a tick, a folder glyph, the name, a `--panel-2` pill naming the layer at 9.5/12.5, and a hint of what it holds; a bucket inside another is indented 16px. After the origin, a `+` pill in `--panel-2`, washed 13% `--accent` when there is a map to keep and at 45% opacity when there is not. It opens a 270px form below it: a sentence naming the bucket, a name, where it goes, and an `--accent` `Add`.
- **Model.** The card holds the [model-cascade](model-cascade.md).
- **Tools.** Six sections under 1px `--line` rules: File permissions, Execution, Web, Tasks & workflows, MCP, then Other. A section with tools is a fold, a `›` turning down when open, the name over its hint, a round `--accent` count of the lines held, and a mode button. Open, its tools hang under it behind a 1px `--line` rule 9px in. Each tool is a standard grey bordered button with its tick, glyph, name and hint centred, tinted `--accent` when offered, then an outlined implementation button in `--tok-hint` when an agent answers and has its own version, then a mode button with a glyph and a word. `allow` is `--ok`, `deny` is `--bad`, and `custom` is `--tok-hint` with a dashed edge. A section with no tools shows its name in `--tok-hint` over `nothing here`. A mode button opens a small list of the four modes below it, right-aligned, on `--panel` with 9px corners and a deep shadow.
- **Execution.** After the shell's line, one fold per program the permission set names, drawn as a section is without the rule above it: `›`, a terminal glyph, the program, a hint, a count of its named subcommands, and a mode button. Open, its subcommands hang 18px further in, each a tool's line with no implementation button, then a line that adds one: a 17px dashed circle holding `+` and the words in `--tok-hint`. `script` follows the programs as one more line, with a page glyph, and the section ends with the line that adds a command. An adding line opens in place into one box over `Cancel` and an `--accent` `Add`.

## Every chip shows the value that will run, and the card shows who decided it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a chip always names a value. Where nothing sets one it names what decides instead: `the model's default`, `default tools` for an agent route, `no tools`, or `no model configured` beside a faint grey square. | |
| loading | Until the settings are read, Thinking and Permissions read `…` and the model reads `no model configured`. Drawn third in the resting mockup. | [resting.html](../assets/composer-setting-chip/resting.html) |
| resting | Four dim chips. A value chosen for this message turns its chip `--accent`. Permissions reads the name of the permission set the tools and modes exactly match in the card's bucket, and `custom` when they match none. A call that declares no tools reads what decides instead, `ask by default`. Drawn: inherited, chosen here, nothing declared, and loading. | [resting.html](../assets/composer-setting-chip/resting.html) |
| inherited | The chip open over its card: `inherited from {state}` or `inherited`, and the value in force ticked. On Permissions the head names the bucket before the origin and ends in a dim `+`. With nothing setting it the origin reads `nothing here sets it` in italic and no row is ticked. | [inherited.html](../assets/composer-setting-chip/inherited.html) |
| overridden | A row picked here: the chip `--accent`, the origin `your choice for this message` in `--accent`, the picked row washed and ticked, and `reset` in the head. | [overridden.html](../assets/composer-setting-chip/overridden.html) |
| buckets | The bucket picker open over the rows: every bucket with what it holds and the layer that defines it, nested ones indented, the card's own ticked. Below it, the card on another bucket: the same four names with that bucket's own hints. | [buckets.html](../assets/composer-setting-chip/buckets.html) |
| custom | The tools and modes match no permission set of the bucket: the chip reads `custom`, no row is ticked, `+` is lit and the closing sentence says what it does. Below it, `+` open on its form. | [custom.html](../assets/composer-setting-chip/custom.html) |
| tools | The Tools card with Execution open: the shell, `git` open onto its subcommands and the line that adds one, `npm` shut, `script`, and the line that adds a command; a section whose lines disagree reads `custom`, and MCP has nothing in it. Below it, Tasks & workflows open over a permission set that holds only those tools, each saying it is not served yet. With no tools registered every section reads `nothing here`, Other keeps its mode, and the closing sentence says so. | [tools.html](../assets/composer-setting-chip/tools.html) |
| error | Cannot occur on the chip: a setting that is an expression is named by the composer's amber note, and a send that fails is reported above the composer. | |

## Picking a row changes this message only, and reset gives it back

| On | Does | Feedback |
| --- | --- | --- |
| Click a chip | Opens its card, or closes it | Chip ground and edge, card above |
| Click outside the card, or Escape | Closes the card | The card is gone |
| A Thinking row | Sets the effort for this message | The row washed and ticked, the chip `--accent` |
| A Permissions row | Writes that permission set's ticks, implementations and modes onto the Tools card for this message | The row ticked and the chip reading its name; the Tools card shows the new lines |
| The bucket in the Permissions head | Opens the bucket hierarchy; picking one changes the rows | The head names the bucket; the chip reads the match in that bucket, or `custom` |
| `+` in the Permissions head | Opens a name and where it goes; `Add` keeps the tools and modes as a new permission set in the bucket, in this project or for all projects | The form closes, the permission set is a row of the bucket and is ticked, and `+` dims. A name that cannot be a file, or one the layer already holds, is said under the form |
| `reset` | Drops the choice for this message, on both cards, and returns to the bucket the state's own tools open on | The chip dims to the inherited value |
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
| Card titles | `Model` · `Thinking` · `Permissions` · `Tools` |
| Chip tooltip | `{title}: {value}` |
| Chip values | `{route}/{model}` or `no model configured` · `low` `medium` `high` `xhigh` or `the model's default` · `{permissionSet}`, which for what ships is `ask first` `read-only` `auto` `full access`, or `custom`, or `{mode} by default` when no tools are declared · `{n} tools` · `{tool}` · `no tools` · `default tools` |
| Origin | `your choice for this message` · `nothing here sets it` · `inherited` · `inherited from {state}` |
| Reset | `reset` |
| Thinking rows | `low` quickest, least deliberation · `medium` a balance · `high` works the problem · `xhigh` `deepest — slowest and dearest` |
| Thinking sentence | `A model that tops out lower clamps rather than refusing.` |
| Permission rows, `chat` | `ask first` stop and ask before every call · `read-only` reading goes ahead, anything that writes is refused · `auto` each call decided by the approver · `full access` anything, without asking |
| Permission rows, `chat_control` | `ask first` ask before starting, moving or answering anything · `read-only` may look at tasks and workflows; starts and moves nothing · `auto` each call decided by the approver · `full access` steer without asking |
| Permission rows, anybody else's | `{file name}` over `{n} lines · all {mode}` or `{n} lines · other {mode}` |
| Bucket picker | `{bucket}` `built in` · `all projects` · `this project` over `{permission set} · {permission set} · …`, or `{n} permission sets, and {n} buckets inside`; `chat_control` reads `its own four — the task and workflow tools only` · tooltip `Which bucket of permission sets these rows are` |
| `+` | tooltip `Keep these tools and modes as a new permission set in {bucket}` · `These tools and modes are already a permission set here` · form `Keep these tools and modes as a permission set in {bucket}` · `name` · `where` `in this project` `for all projects` · `Add` |
| Permissions sentence | `A permission set: which tools are offered, and what happens when each is called. Change any of it under Tools and this becomes custom.` · `These tools and modes match no permission set in {bucket} — + keeps them as a new one.` · `No permission sets in {bucket} yet. + keeps the tools and modes under Tools as the first.` |
| Sections | `File permissions` reading, searching and changing files in the workspace · `Execution` running commands on this machine · `Web` reaching the network · `Tasks & workflows` starting, moving and answering tasks · `MCP` tools served by connected MCP servers · `Other` anything not listed above — an agent's own tools with no equal here included · `nothing here` |
| Execution | `bash` the shell — and the mode for any command not named below · `{program}` over `{n} subcommands named; any other {program} asks` `is allowed` `is refused` `goes to the approver` when open, and its subcommands joined by ` · ` when shut · `script` running a file — ./x.sh, npm run, python x.py, make · `add a {program} subcommand` · `add a command` · `Cancel` · `Add` |
| Modes | `ask` stop and ask before each call · `auto` decided per call by the approver · `allow` goes ahead without asking · `deny` refused every time · `custom` |
| Mode tooltips | `{section}: sets every tool under it` · `{tool}: {mode hint}` · `Anything this project has no name for` |
| Tool rows | `{label}` over `{hint}`; a tool nothing serves yet ends ` · not served yet` |
| Implementation | `JaiRA` our implementation, through the artifact map · `{agent's name for it}` `the agent's own — still gated by the mode beside it` · tooltip `Implementation: {hint}` |
| Tools sentence | `Ticking a tool offers it; the mode beside it is what happens when it is called. A shell line is taken apart, and each part answers to its own line here.` · `This project registers no tools.` |

## The chips shrink before the composer's buttons, and every card opens upward

- Narrow composer: chips give up width first, each value ending in an ellipsis. A card is as wide as its content up to 560px or 78% of the window, and can reach past the composer's edge.
- A mode list or implementation list floats over the card and may hang below it; opening one never changes the card's size.
- Theme: grounds, washes and mode colours are tokens. A brand mark keeps its own colour in both themes, so Anthropic's near-black mark all but vanishes on the dark ground.
- Focus: chips, rows, folds and mode buttons are native buttons in Tab order. Escape closes a chip's card; a mode or implementation list, the bucket picker and the `+` form close only on a click outside them. The name, the place and a new command are asked through the schema form, like every other typed input. Arrow keys do nothing.
- Only one card is open at a time, because opening a second is a click outside the first.
- Choices last until the message is sent or the composer goes away.

## The chips set data in the app face and draw tools as standard buttons

- Model ids, tool names and state ids are data set in the app face.
- A tool's button keeps the standard grey bordered button look with its words centred, unlike the plain rows of the other cards.
