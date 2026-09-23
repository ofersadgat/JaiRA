---
id: ui/surfaces/settings-files
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/absence-is-stated, ux/patterns/verbs-on-the-thing-itself]
serves: [product/share-processes-across-projects, product/find-out-why-the-app-misbehaves, product/keep-track-of-everything]
components: [ui/components/settings-header, ui/components/settings-field, ui/components/chip-box, ui/components/switch]
mockups: [ui/assets/settings-files/default.html, ui/assets/settings-files/success.html, ui/assets/settings-files/empty.html, ui/assets/settings-files/disabled.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-configuration, ui/surfaces/settings-appearance]
---

# Settings files

The Files section of the Settings room: three levels that say which paths the file tree hides, a shared list for everyone who opens the project and a personal list for this person alone, a switch that shows JaiRA's own `system/` directory, and every rule in the order it is applied. It fills the settings column under the [settings-header](../components/settings-header.md) and replaces whichever section was showing.

## The two lists read first, the system switch second, and the combined order last

- **Level.** Each of the three is an uppercase level heading in `--dim` with a hint under it, from [settings-field](../components/settings-field.md).
- **Hidden in the tree.** Two settings rows. `Shared` is led by a switch: on, the layer being edited states its own list; off, it shows the defaults dimmed and the layer inherits them — the switch is what the old Reset button did. `Yours` is kept in this person's own settings and has no switch. Each control is a [chip-box](../components/chip-box.md) on the right-hand rail.
- **JaiRA's own directory.** One row, `Show system/`, whose control is a [switch](../components/switch.md) and whose hint says what the switch is doing.
- **In effect.** Every rule as a chip in one wrapping line with no box around it, the shared list first and the personal list after, each chip ending in its origin word.

A rule chip holds a mark, the pattern in `.data-text` and an end part:

| Rule | Mark | Ground | End |
| --- | --- | --- | --- |
| Hide | `◌` in `--dim` | `--fill-ghost-hover` | `✕` when it can be removed, else the origin word |
| Reveal, written `!{pattern}` | `◉` in `--accent`; the `!` is not drawn | `--tint-ok` | the same |
| Default, while the shared list is not stated | `◌` | none, a 1px dashed `--line` border | `default` in `.app-secondary` |

## The lists show defaults, stated rules or no rules, and lock while a write is in flight

| State | Surface shows | Mockup |
| --- | --- | --- |
| default | The layer states no list: the shipped patterns are drawn as dashed `default` chips with no `✕`, both in `Shared` and in `In effect`, and no Reset button. | [default.html](../assets/settings-files/default.html) |
| success | A stated shared list with `✕` on each chip, a personal list holding `!system` as a green reveal chip, the switch on, and Reset under the combined order. | [success.html](../assets/settings-files/success.html) |
| empty | The shared list is stated as empty and the personal list is empty: both boxes hold only their add field, and `In effect` reads `No rules: every root shows everything, system/ included.` | [empty.html](../assets/settings-files/empty.html) |
| loading | Cannot occur as its own look: the lists arrive with the window's settings. | |
| error | Not a look of its own: a write that fails is reported by the [error-notice](error-notice.md) and the chips stay as they were. | |
| disabled | While a shared-list change or any other write in the window is in flight: the layer switch, both add fields, the system switch and Reset are inert, and every chip shows its origin word in place of `✕`. | [disabled.html](../assets/settings-files/disabled.html) |

## Every add and remove is written at once

| On | Does | Feedback |
| --- | --- | --- |
| Typing a pattern, then Enter or leaving the field | Appends it to that list; an empty entry or a bare `!` adds nothing | A new chip before the field, and the tree re-reads |
| Escape in the add field | Clears the typed text | The placeholder returns |
| The first add to a list shown as defaults | Writes every default with the new pattern, so nothing the defaults hid appears | The dashed chips become removable chips and the row's switch turns on |
| `✕` on a chip | Removes that rule; removing the last shared rule states an empty list, which shows everything | The chip goes from its box and from `In effect` |
| The system switch | Adds or removes `!system` at the end of the personal list | The hint changes and a reveal chip appears or goes |
| `Shared`'s switch, off | Removes the layer's list, with no confirmation | Dashed `default` chips return, dimmed |

## The copy says where each list is kept and who sees it

| Where | String |
| --- | --- |
| Level one | `Hidden in the tree` · `Glob patterns, matched against the path inside each root. A folder that matches takes its contents with it. Later rules win, so a !pattern below can put something back.` |
| Shared row | `Shared`, key `files.hidden`; hint `What every root hides until someone says otherwise. Adding one keeps these.` while defaults show, else `Written in {the shared root's / this project's} {settings file}, so everyone who opens it sees the same tree.` |
| Yours row | `Yours`, key `filesHidden`; hint `Applied after the shared list and kept out of it — in {personal settings file}, so it never arrives through a pull request.` |
| Add fields | `+ pattern…` · `+ pattern, or !pattern to reveal…` |
| Chip | tooltip `remove {pattern}` · origin words `default` · `shared` · `yours` |
| Level two | `JaiRA's own directory` · `system/ holds the database, tasks, snapshots, logs and artifacts. Nobody authors it, so it is hidden — but reading what a run wrote is a fair thing to want when a run has gone wrong.` |
| System row | `Show system/`; hint `Shown, for you alone. This is a `!system` rule in your own list.` or `Hidden — the default, and what almost everyone wants.`; switch name `shown` · `hidden` |
| Level three | `In effect` · `Every rule, in the order it is applied. The last one to match a path decides.` · `No rules: every root shows everything, system/ included.` |

## A person arrives from the Settings panel and returns to the tree to see the effect

- The sidebar's Settings panel lists `Files`, with or without a project open. With none open, the shared list is the shared root's.
- Choosing another section or room leaves. Nothing is held unsaved, and the Files drawer already draws the new rules.
- The personal list and the system switch follow the person into every project and stay editable on either layer.

## The chip boxes wrap, and the combined order wraps with them

- Resize: chips wrap inside their box, and a long pattern ellipsises within its chip. Rows stack under their statement in a box 380px wide or less. The section has no width cap of its own, so the combined order runs the width of the column.
- Theme: chip grounds, the dashed border, the reveal tint and the marks are tokens in both themes.
- Focus: nothing takes focus on entry. The order is the layer switch, each chip's `✕` then its box's add field, the system switch, then Reset. Chips in `In effect` take no focus.
- Long content: the full default list is 18 chips and wraps onto several lines in both places it appears.

## The screen departs from the direction in its reveal colour

- A reveal chip's `◉` takes `--accent` on a `--tint-ok` ground, so one chip mixes the accent and success roles.
