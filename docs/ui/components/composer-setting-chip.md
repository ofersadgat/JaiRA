---
id: ui/components/composer-setting-chip
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists]
serves: [product/chat-with-agents, product/steer-agents-mid-task, product/risky-actions-wait-for-approval, product/agents-act-only-where-allowed, product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/model-cascade, ui/components/icon]
implemented_by: [packages/app/src/renderer/composer.tsx]
verified_by: [packages/app/test/composer.test.ts]
mockups: [ui/assets/composer-setting-chip/resting.html, ui/assets/composer-setting-chip/inherited.html, ui/assets/composer-setting-chip/overridden.html, ui/assets/composer-setting-chip/tools.html]
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
- **Model.** The card holds the [model-cascade](model-cascade.md).
- **Tools.** Five sections under 1px `--line` rules: File permissions, Execution, Web, MCP, then Other. A section with tools is a fold, a `›` turning down when open, the name over its hint, a round `--accent` count of the tools offered, and a mode button. Open, its tools hang under it behind a 1px `--line` rule 9px in. Each tool is a standard grey bordered button with its tick, glyph, name and hint centred, tinted `--accent` when offered, then an outlined implementation button in `--tok-hint` when an agent answers and has its own version, then a mode button with a glyph and a word. `allow` is `--ok`, `deny` is `--bad`, and `custom` is `--tok-hint` with a dashed edge. A section with no tools shows its name in `--tok-hint` over `nothing here`. A mode button opens a small list of the four modes below it, right-aligned, on `--panel` with 9px corners and a deep shadow.

## Every chip shows the value that will run, and the card shows who decided it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a chip always names a value. Where nothing sets one it names what decides instead: `the model's default`, `default tools` for an agent route, `no tools`, or `no model configured` beside a faint grey square. | |
| loading | Until the settings are read, Thinking and Permissions read `…` and the model reads `no model configured`. Drawn third in the resting mockup. | [resting.html](../assets/composer-setting-chip/resting.html) |
| resting | Four dim chips. A value chosen for this message turns its chip `--accent`. Permissions reads the preset the tool modes match, `custom` when they match none, and names a narrowing profile first, such as `plan · custom`. | [resting.html](../assets/composer-setting-chip/resting.html) |
| inherited | The chip open over its card: `inherited from {state}` or `inherited`, and the value in force ticked. With nothing setting it the origin reads `nothing here sets it` in italic. | [inherited.html](../assets/composer-setting-chip/inherited.html) |
| overridden | A row picked here: the chip `--accent`, the origin `your choice for this message` in `--accent`, the picked row washed and ticked, and `reset` in the head. | [overridden.html](../assets/composer-setting-chip/overridden.html) |
| tools | The Tools card with one section open: offered tools washed and ticked, each with its implementation and mode, a section whose tools disagree reading `custom`, and MCP with nothing in it. With no tools registered every section reads `nothing here`, Other keeps its mode, and the closing sentence says so. The mode list is drawn open under Other. | [tools.html](../assets/composer-setting-chip/tools.html) |
| error | Cannot occur on the chip: a setting that is an expression is named by the composer's amber note, and a send that fails is reported above the composer. | |

## Picking a row changes this message only, and reset gives it back

| On | Does | Feedback |
| --- | --- | --- |
| Click a chip | Opens its card, or closes it | Chip ground and edge, card above |
| Click outside the card, or Escape | Closes the card | The card is gone |
| A Thinking row | Sets the effort for this message | The row washed and ticked, the chip `--accent` |
| A Permissions row | Writes that preset's mode onto every tool for this message | The row ticked; the Tools card shows the new modes |
| `reset` | Drops the choice for this message | The chip dims to the inherited value |
| A section's fold | Opens or closes its tools | `›` turns a quarter |
| A section's mode | Writes that mode onto every tool in the section | Each tool's mode button changes |
| A tool's button | Offers the tool, or stops offering it | Tick and wash appear or go; the section's count changes |
| A tool's mode, or Other's | Opens the four modes; picking one sets it | The button takes the mode's glyph, word and colour |
| A tool's implementation | Opens `JaiRA` and the agent's own; picking one sets which runs the tool | The button's word changes |

## The copy names the setting, its value and the reason each choice exists

| Where | String |
| --- | --- |
| Card titles | `Model` · `Thinking` · `Permissions` · `Tools` |
| Chip tooltip | `{title}: {value}` |
| Chip values | `{route}/{model}` or `no model configured` · `low` `medium` `high` `xhigh` or `the model's default` · `ask first` `read-only` `auto` `full access` `custom`, led by `{profile} · ` when a profile narrows · `{n} tools` · `{tool}` · `no tools` · `default tools` |
| Origin | `your choice for this message` · `nothing here sets it` · `inherited` · `inherited from {state}` |
| Reset | `reset` |
| Thinking rows | `low` quickest, least deliberation · `medium` a balance · `high` works the problem · `xhigh` `deepest — slowest and dearest` |
| Thinking sentence | `A model that tops out lower clamps rather than refusing.` |
| Permission rows | `ask first` stop and ask before every call · `read-only` reading goes ahead, anything that writes is refused · `auto` each call decided by the approver · `full access` anything, without asking |
| Permissions sentence | `A starting point. Change any tool's mode under Tools and this becomes custom.` · `These modes match no preset — set per tool under Tools.` |
| Sections | `File permissions` reading, searching and changing files in the workspace · `Execution` running commands on this machine · `Web` reaching the network · `MCP` tools served by connected MCP servers · `Other` anything not listed above · `nothing here` |
| Modes | `ask` stop and ask before each call · `auto` decided per call by the approver · `allow` goes ahead without asking · `deny` refused every time · `custom` |
| Mode tooltips | `{section}: sets every tool under it` · `{tool}: {mode hint}` · `Anything this project has no name for` |
| Tool rows | `{label}` over `{hint}`, or `reads only` · `can change things` |
| Implementation | `JaiRA` our implementation, through the artifact map · `{agent's name for it}` `the agent's own — still gated by the mode beside it` · tooltip `Implementation: {hint}` |
| Tools sentence | `Ticking a tool offers it; the mode beside it is what happens when it is called. Access is always JaiRA's, whichever implementation runs.` · `This project registers no tools.` |

## The chips shrink before the composer's buttons, and every card opens upward

- Narrow composer: chips give up width first, each value ending in an ellipsis. A card is as wide as its content up to 560px or 78% of the window, and can reach past the composer's edge.
- A mode list or implementation list floats over the card and may hang below it; opening one never changes the card's size.
- Theme: grounds, washes and mode colours are tokens. A brand mark keeps its own colour in both themes, so Anthropic's near-black mark all but vanishes on the dark ground.
- Focus: chips, rows, folds and mode buttons are native buttons in Tab order. Escape closes a chip's card; a mode or implementation list closes only on a click outside it. Arrow keys do nothing.
- Only one card is open at a time, because opening a second is a click outside the first.
- Choices last until the message is sent or the composer goes away.

## The chips set data in the app face and draw tools as standard buttons

- Model ids, tool names and state ids are data set in the app face.
- A tool's button keeps the standard grey bordered button look with its words centred, unlike the plain rows of the other cards.
