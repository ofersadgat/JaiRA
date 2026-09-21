---
id: ui/components/toolset-card
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/absence-is-stated]
serves: [product/agents-act-only-where-allowed, product/risky-actions-wait-for-approval, product/share-processes-across-projects]
surfaces: [ui/surfaces/settings-toolsets, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/icon, ui/components/schema-form]
implemented_by: [packages/app/src/renderer/toolsetRows.tsx, packages/app/src/renderer/toolsetCard.tsx, packages/app/src/renderer/composerToolset.ts]
verified_by: [packages/app/test/toolsets.test.ts, packages/app/test/composer.test.ts]
mockups: [ui/assets/settings-toolsets/project.html, ui/assets/settings-toolsets/built-in.html, ui/assets/settings-toolsets/nested.html, ui/assets/tools-field/state-field.html]
siblings: [ui/components/composer-setting-chip, ui/components/tools-field, ui/components/command-approval, ui/components/settings-field]
---

# Toolset card

A toolset drawn as the sections of the tool vocabulary — File permissions, Execution, Web, Tasks & workflows, MCP, then Other — each folding open onto a line per subject with its implementation button and its mode button, and commands grouped under their program. It is the composer's Tools card, and the same rows standing still in [Settings → Toolsets](../surfaces/settings-toolsets.md) and in the state editor's [Tools field](tools-field.md).

## One set of rows wherever a toolset is on screen

**Use when.** A map from a subject to a mode is shown or changed: the composer's Tools card for the next message, a toolset file in Settings, the lines a state writes over the toolset it names.

**Do not use when.** A whole toolset is being PICKED rather than read — that is the Permissions card's rows, on the [composer setting chip](composer-setting-chip.md). One shell line being judged part by part is the [command approval](command-approval.md).

**Two things differ between hosts, and both are props rather than forks.** How a line leaves: the composer lists every tool and TICKS the held ones, so an unticked tool keeps its row and the mode it would run under; a toolset being edited lists what it HOLDS, so every held line starts with a red minus and what is not held is reached through the section's last line. And whether anything can change: what ships is drawn with the same rows, inert.

## Sections fold, a line carries two buttons, and commands hang under their program

- **Section.** A chevron that rotates when open, the section's name at 12/12.5 weight 500 over its `--dim` hint at 11/12.5, and a count badge in `--panel` on `--accent` when it holds anything. In the composer it also carries a mode button that writes every line under it; in a toolset being edited it does not — the lines are the statement.
- **Line.** 7px radius, tinted `--accent` at 13% when the toolset holds it. In a toolset being edited: a red minus first, then the tool's glyph, its name and its sentence, then the implementation and mode buttons at the right. In the composer the name is a button carrying a tick instead.
- **Minus.** A 17px `--bad` circle at the very start of the line, white glyph, 4px from the edge; it brightens 8% on hover. Its tooltip and label are `remove {subject}`. On a command group it sits in the head, before the fold, and takes the program and every subcommand under it.
- **Mode button.** The four modes with their glyphs — a shut lock `ask`, a star `auto`, an open lock `allow` in `--ok`, a shield `deny` in `--bad` — opening a submenu with a sentence under each. `custom` with no glyph is what a section reads as when its lines disagree.
- **Implementation button.** Quieter than the mode beside it: `JaiRA` or the agent's own name for that tool. Drawn only where there is a choice — the answering agent has a built-in for the job. In a toolset with no one agent answering it reads `native`, and the menu names which agent calls it what.
- **Command group.** A program under Execution, folded, its name in the data face over `{n} subcommands named; any other {program} {verb}` when open and the subcommand names joined by ` · ` when closed. Its mode is the entry for the bare program and is NOT derived from its subcommands. Its subcommands hang 18px further in.
- **Add line.** Last in a section and last in a group, in a toolset being edited: a dashed `+` circle and a `--tok-hint` label. It opens the card's own floating menu listing what that section does not hold — the tools, `script`, and the programs nobody has named — with `another…` last, which swaps the line for a one-box [schema form](schema-form.md) that takes anything typed. A section with nothing left to offer and nothing to type draws no add line.
- **Other.** Always last, parted by a rule: the catch-all with its own mode button and no minus.
- **Empty section.** Drawn with `nothing here` rather than dropped — a category with nothing in it is a fact about this project. In a reading, a section that holds no line is left out entirely.
- **Flat.** The state editor's few lines use the same rows with no sections, no rule down the left and no indent.

| Where | String |
| --- | --- |
| Sections | `File permissions` · `Execution` · `Web` · `Tasks & workflows` · `MCP` · `Other` |
| Shell line | `the shell — and the mode for any command not named below` |
| Script line | `running a file — ./x.sh, npm run, python x.py, make` |
| Unserved tool | `{hint} · not served yet` |
| Other | `anything not listed above — an agent's own tools with no equal here included` |
| Modes | `ask` `stop and ask before each call` · `auto` `decided per call by the approver` · `allow` `goes ahead without asking` · `deny` `refused every time` |
| Implementations | `JaiRA` `our implementation, through the artifact map` · `{native}` `the agent's own — still gated by the mode beside it`, or `the agent's own — {name} on {route}, …` where no one agent is answering |
| Group | `{n} subcommands named; any other {program} {asks\|is allowed\|is refused\|goes to the approver}` · `every {program} command — {rest}` |
| Add lines | `add a tool` · `add a command, the shell, or script` · `add a {program} subcommand` · `another…` `type one, like {example}` |
| Add menu | `{program}` `every {program} command — then name the ones that differ` |
| Minus | `remove {subject}` |
| Empty section | `nothing here` |

## A line is added, re-moded or taken out, and the whole map leaves

- Folding a section or a group shows what is under it and changes nothing.
- The minus takes the line out of the map at once. Absent is how a map says not offered, so there is no separate "off" state to leave behind.
- A mode or an implementation button writes that one line. A section's mode button, where it is drawn, writes every line under it.
- The add line's menu adds a line at the mode that already answers for it, so adding changes nothing until its mode is. A command typed into `another…` is refused by name when it reads as a tool, as `other`, as `script`, or as nothing a program could be called; the reason is said under the box.
- A command added from Execution opens the group it landed in, so the new line is on screen.
- Every edit is a pure function of the map in `composerToolset.ts`, and what leaves the card is the WHOLE map: a toolset is one statement, and there is no writing half of one.
