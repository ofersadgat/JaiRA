---
id: ui/surfaces/settings-files
type: ui-surface
status: shipped
updated: 2026-09-23
kind: panel
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/absence-is-stated, ux/patterns/verbs-on-the-thing-itself, ux/patterns/preview-beside-the-setting]
serves: [product/share-processes-across-projects, product/find-out-why-the-app-misbehaves, product/keep-track-of-everything]
components: [ui/components/settings-field, ui/components/switch]
mockups: [ui/assets/settings-files/default.html, ui/assets/settings-files/success.html, ui/assets/settings-files/loading.html, ui/assets/settings-files/disabled.html]
siblings: [ui/surfaces/settings-appearance, ui/surfaces/settings-view]
---

# Settings files

The `Files tree` section, the last section of the [Appearance](settings-appearance.md) page: every rule that decides what the Files tree leaves out, with what each rule hides in THIS root — counted from one walk of it — where it came from, and a switch. It replaced the Files page (2026-09-23), whose chips could say a pattern was a rule but not what it hid: `**/build` stayed a default for months while every folder it hid in this repository was a workflow state's snapshot that `.jaira/system` already hid. It is drawn by `FilesTreeSection` in `filesTreePane.tsx`, and `data-part="files-tree"` is what the sidebar's accordion lists.

## The layers add to one list, and the section draws it whole

`files.hidden` concatenates across the layers: the built-in defaults first, then `Shared`, `This project` and `Just you`, each layer's list being what it ADDS. Later rules win, so `!pattern` puts back what an earlier rule hid, and a folder that matches takes its contents with it — the walk never goes inside a hidden folder, so a `!` for something inside one puts back nothing.

- **Hidden in the tree.** One settings row, key `files.hidden`, led by the set / not set switch of the layer being edited. Its control says how many rules that layer adds. Off, the layer adds nothing and every rule it wrote goes.
- **The rule list.** A bordered box with a head row — `Pattern` · `What it hides here` · `From` · the switch column — then one fold per group, in the order the rules apply: `JaiRA's own files`, `Secrets`, `Version control`, `Dependencies`, `Build output`, then `Added in Shared`, `Added in this project`, `Added just for you` for each layer that adds a rule. A fold head is a chevron, the group's name and `{n} rules · hides {amount}`, with `· puts back {amount}` and `· {n} off` where they apply.
- **The add line.** Under the box: an input and `Add`. As a pattern is typed, a preview under it reads what the rule would do if it were added last.
- **Why is a path hidden?** A wide row with an input; the answer is a line under it.
- **Show system/.** A row with a switch, for this person alone: on, their own layer puts back `system` and `.jaira/system`.

A rule line:

| Part | Shows |
| --- | --- |
| Pattern | `.data-text`; a leading `!` in `--ok`, and a `puts back` chip on the `--tint-ok` ground |
| What it hides here | `{amount}` (`8 folders`, `1 file`, `2 folders and 1 file`) over the first three matches and `+{rest}` in `.data-secondary`; `nothing here` in `.app-absent` when it decides nothing |
| Note | a `--tint-warn` line where a rule earns one: `every match is inside .jaira/system, which is already hidden`, or `puts back nothing: {folder} is hidden by {rule}, and a hidden folder takes its contents with it` |
| From | a pill: `built in` · `shared` · `this project` · `just you`; the edited layer's own in the accent |
| Switch | on while the rule is in effect |

A layer that switches off a rule it did not write writes `!pattern` — and that `!` is drawn as the rule's own line, off, struck through, reading `off here, so {layer} shows it (writes !pattern)`, not as a second rule of the layer's. A rule a layer read AFTER the one being edited has the last word on cannot be changed from here, and its switch is disabled with a tooltip naming the layer to edit.

## The list folds what hides nothing, and says when it is partial

| State | Surface shows | Mockup |
| --- | --- | --- |
| default | Every group that hides something open, the rest folded; a rule switched off here drawn off; a rule whose only matches are under `.jaira/system` noted. | [default.html](../assets/settings-files/default.html) |
| success | A pattern typed with its preview under the add line, and a path answered under `Why is a path hidden?`. | [success.html](../assets/settings-files/success.html) |
| loading | The box holds `reading the tree…` until the walk answers; the rows around it are drawn. | [loading.html](../assets/settings-files/loading.html) |
| capped | The walk ran out of its budget (1.5 s or 60,000 entries): every amount reads `at least …`. | |
| error | The box holds the reason the report could not be read; a refused `why` (a full path outside the root) is the answer line, in `--bad`. | |
| disabled | While a write is in flight: every switch, the add line and the system switch are inert. | [disabled.html](../assets/settings-files/disabled.html) |

A group that hides nothing starts folded unless a layer switched one of its rules off; a fold the person opened or closed stays that way while the page is open.

## Every switch writes the layer's whole document at once

| On | Does | Feedback |
| --- | --- | --- |
| A rule's switch, off, on a rule another layer wrote | Appends `!pattern` to the edited layer | The line goes off and says what it writes; the report re-reads |
| The same switch, on | Removes that `!` (or, where a lower layer had switched it off, writes `pattern`) | The line comes back on |
| A rule's switch, off, on the edited layer's own rule | Removes it from the layer | The line goes |
| `Hidden in the tree`'s switch, off | Removes the layer's `files.hidden` — never writes `[]` — and `files` with it when nothing else is in it | The layer's group goes |
| Typing in the add line | After a 250 ms pause, asks `files:hiddenReport` with the pattern as `extra` | `would hide {amount}: a, b, +{rest}`, `would put back …` or `… nothing here` |
| Enter, or `Add` | Appends the pattern to the edited layer; a blank, a bare `!` or a rule the layer already has adds nothing | The input clears and the line appears in its group |
| Typing in the why line | After a 250 ms pause, asks `files:whyHidden` | `hidden by {rule}, {origin}, in {group}: its folder {folder} matches`, `not hidden: {rule}, {origin}, puts it back`, or `not hidden` |
| `Show system/` | Adds or removes `!system` and `!.jaira/system` in the person's own layer | The hint changes |

## The copy

| Where | String |
| --- | --- |
| Section | `Files tree`; ⓘ `What the Files tree leaves out, and why. Built-in rules come first, then what Shared, this project and you add; the last rule to match a path decides.` |
| Row | `Hidden in the tree`; `Later rules win, so a !pattern puts back something an earlier rule hid.`; ⓘ `A folder that matches takes its contents with it. Writes files.hidden.`; control `{layer} adds nothing` · `{layer} adds {n} rules` |
| Add line | placeholder `pattern, or !pattern to put something back` · `Add` |
| Why | `Why is a path hidden?` · `A path inside the tree's root, or a full path from a file manager.` · placeholder `packages/cli/dist/index.js` |
| System row | `Show system/`; `Hidden — the default.` (ⓘ `It holds the database, tasks, snapshots and logs, which nobody authors.`) or `Shown, for you alone: a !system rule in your own list.` |

## What the walk counts

- One walk of one root — the project's checkout, or the shared root with no project open — breadth first, so a rule's samples are its shallowest matches.
- Each path the tree would reach goes to the rule that DECIDES it, the last that matches. A hidden folder is one folder, and nothing under it is counted or walked. A `!` rule counts what it puts back: a path an earlier rule would have hidden.
- After the visible tree, with what is left of the budget, it looks inside the folders JaiRA's own group hides, so a rule whose every match is there can say so.

## Narrow, a line stacks

- Below 520px of box width the head row goes, and each line puts its pattern, origin and switch across the top with what it hides under them.
- Theme: every colour is a token or a tint of one, so the section reads in each palette and both modes.
- Focus: the fold heads, each rule's switch in order, the add input and `Add`, the why input, the system switch.
