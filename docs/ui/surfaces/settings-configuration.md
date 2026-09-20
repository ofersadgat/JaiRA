---
id: ui/surfaces/settings-configuration
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/schema-driven-form, ux/patterns/verbs-on-the-thing-itself, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/draft-belongs-to-the-file, ux/patterns/absence-is-stated]
serves: [product/risky-actions-wait-for-approval, product/share-processes-across-projects, product/bring-your-own-models-and-agents, product/work-inside-wsl, product/read-what-work-produced]
components: [ui/components/settings-header, ui/components/settings-field, ui/components/preset-chips, ui/components/llm-config-form, ui/components/schema-form, ui/components/switch, ui/components/editor-chrome, ui/components/data-tree]
mockups: [ui/assets/settings-configuration/success.html, ui/assets/settings-configuration/policy.html, ui/assets/settings-configuration/empty.html, ui/assets/settings-configuration/raw-document.html, ui/assets/settings-configuration/disabled.html, ui/assets/settings-configuration/error.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-providers, ui/surfaces/settings-executors, ui/surfaces/settings-files]
---

# Settings configuration

The Configuration section of the Settings room: one scrolling column, at most 780px wide, that shows one configuration layer as six headed groups of settings rows, the ordered safety rules as numbered cards, and the whole file as text behind a closed disclosure at the foot. It fills the settings column under the [settings-header](../components/settings-header.md) and replaces whichever section was showing.

## Six groups read top to bottom, each a large heading over rows, with the raw file folded last

- **Group.** A heading in the app face at 15/12.5 of the app size, weight 650, over one `.app-secondary` sentence at most 70 characters wide, then [settings-field](../components/settings-field.md) rows. Groups sit 34px apart.
- **Artifacts.** `Destination` with four [preset-chips](../components/preset-chips.md) over a mono template box and a line of variables in code, then `Artifact directory` and `Keep inline below`.
- **Where commands run.** `Environment` as a select. `Distro` appears under it only while a WSL distro is chosen.
- **Default environment.** `Default model` in a mono box, the [llm-config-form](../components/llm-config-form.md) under it, then a `.app-secondary` line summarising the call settings.
- **Safety policy.** Three selects, `Anything else`, `Unlisted tools` and `Built-in rules`, then a nested level `Rules ({n})` holding one rule card per rule and a plain `Add a rule` button.
- **Memoization and Workflow lookup.** Each is a [schema-form](../components/schema-form.md) in its layered reading, where a [switch](../components/switch.md) before a name means set in this layer.
- **The raw document.** A disclosure closed on every visit. Open, it holds a hint, the layer's file path in `.app-secondary` ellipsised from the left, a shared-root notice on the shared layer, a plain text box of the JSON with the [editor-chrome](../components/editor-chrome.md) `Save` and `Revert` pinned under it, and a ghost `Show effective`.

## A rule card is numbered, carries its verdict first, and moves in place

Each rule is a card with a 1px `--line` border, 8px corners, a `--panel` ground and 9px by 11px padding.

- **Head.** An 18px hollow circle holding the rule's number in `--dim`, a 130px select of `allow`, `ask first` or `deny`, then at the far right ghost `↑` and `↓` and a ghost `Remove` in `--bad`. The head wraps when narrow.
- **Match fields.** Five rows always stacked, each label over a full-width box: `Program`, `Subcommand`, `Any of these flags` and `An argument contains` in mono, `Reason` in the app face. No row carries a `SET HERE` tag.
- `↑` is disabled on the first card and `↓` on the last.

The cards list the rules in effect. A project layer that states no rules shows the shared root's rules and counts them, and any edit to a card writes the whole list into the layer being edited.

## The pane shows the layer's settings, locks while a change is written, and says when it cannot read the file

| State | Surface shows | Mockup |
| --- | --- | --- |
| success | A project layer: `This project` filled in the header, stated rows tagged `SET HERE`, `inside a WSL distro` chosen so `Distro` shows, and the call settings at their defaults. | [success.html](../assets/settings-configuration/success.html) |
| policy | Two rules as cards, the first with `↑` disabled and the last with `↓` disabled, under the three verdict selects. | [policy.html](../assets/settings-configuration/policy.html) |
| empty | No rules in effect: `No rules of this project's own — the built-ins and the default above decide everything.` stands above `Add a rule`. Memoization and Workflow lookup follow with their values not set, then the closed disclosure. | [empty.html](../assets/settings-configuration/empty.html) |
| loading | Not a look of its own: until the configuration is first read the pane shows the error sentence. | |
| raw document | No project open: the header's sentence in place of the switch, the disclosure open on the shared root's file with its notice, unsaved typing with `Save`, `Revert` and `unsaved changes`, and `Effective configuration` shown under `Hide effective`. | [raw-document.html](../assets/settings-configuration/raw-document.html) |
| disabled | While a change is being written: the header, every box, select, chip, switch and card button at reduced strength and inert, with every value still drawn. | [disabled.html](../assets/settings-configuration/disabled.html) |
| error | The configuration cannot be read: `The configuration could not be read.` in `--dim` alone under the header. A write that fails is reported by the [error-notice](error-notice.md) and the values stay as they were. | [error.html](../assets/settings-configuration/error.html) |

## Every structured change is saved as it is made, and the raw text waits for Save

| On | Does | Feedback |
| --- | --- | --- |
| A preset chip | Writes that destination | The chip fills and the template box shows it |
| Typing in a box | Writes the layer on each keystroke; an emptied box removes the key so it inherits | Every control disables until the write lands, then `SET HERE` follows the value |
| `Environment` set to `inside a WSL distro` | Writes the distro `Ubuntu` unless one is named | `Distro` appears |
| `Built-in rules` set to `on — the built-in refusals apply` | Removes the key, so only `off` is ever stated | The tag goes |
| `↑`, `↓` | Swaps the card with its neighbour | The numbers follow the new order |
| `Remove` | Deletes the rule at once, with no confirmation | The card goes and the count drops |
| `Add a rule` | Appends a rule reading `ask first` with no match fields | A new last card |
| The disclosure head | Opens or closes the raw document | The caret turns |
| `Save` under the text | Parses the text and writes the layer | `not valid JSON: {message}` under the box when it does not parse |
| `Show effective` | Shows the merged configuration | `Hide effective`, the heading, `shared config with this project's laid over it` and the value as a [data-tree](../components/data-tree.md) |

## The copy states what each setting decides

| Where | String |
| --- | --- |
| Group headings | `Artifacts` · `Where commands run` · `Default environment` · `Safety policy` · `Memoization` · `Workflow lookup` |
| Destination chips | `the workspace` · `one directory per task` · `one flat directory` · `memory only` |
| Destination box | placeholder `$JAIRA/artifacts/$TASK_ID/$RELPATH`, then `Variables: $JAIRA $PROJECT $TASK_ID $RELPATH $ARTIFACT_DIR` |
| Environment options | `natively on Windows` · `inside a WSL distro`; Distro placeholder `Ubuntu` |
| Default model placeholder | `left to the state` |
| Verdict selects | `— inherit (allow)` or `— inherit`, then `allow` · `ask first` · `deny`; Built-in rules `on — the built-in refusals apply` · `off — this project's rules only` |
| Rules level | `Rules ({n})` · `First match wins, so order matters.` · `Add a rule` |
| Rule card | tooltips `earlier` · `later`; `Remove`; placeholders `git` · `push` · `--force, -f` · `.ssh` · `force-pushing rewrites published history` |
| Raw document | `The raw document` · `· everything, as it is stored` · `Show effective` · `Hide effective` · `Effective configuration` |
| Shared-root notice | `This is the shared root. Every project on this machine reads it unless it sets the same field itself.` |
| Unreadable | `The configuration could not be read.` |

## A person arrives from the Settings panel and leaves by choosing another section

- The sidebar's Settings panel lists `Configuration`; choosing it shows this section, with or without a project open. With none open, every write goes to the shared root.
- Choosing another section or another room leaves. Structured changes are already saved.
- Unsaved text in the raw document stays with that file: leaving and returning shows it again, and the Files view opens the same draft on the same file.
- Whether the effective configuration is shown is remembered across visits and launches.

## The column keeps its width cap, and every look is a token

- Resize: the column never grows past 780px, so a wide window leaves space at the right. Rows stack under their statement in a box 380px wide or less, and rule cards always stack their fields.
- Theme: grounds, borders, the `--bad` Remove and the notice's `--tint-accent` are tokens in both themes.
- Focus: nothing takes focus on entry. The order runs down the page, group by group, a rule card's head controls before its fields.
- Long content: hints wrap, config keys ellipsise, and the file path ellipsises from its start so the file name stays in view.

## The pane departs from the direction in its group heading size

- Group headings use a 15/12.5 size at weight 650 rather than `.app-title`.
