---
id: ui/components/context-menu
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/verbs-on-the-thing-itself]
serves: [product/hand-work-to-agents, product/author-processes-without-memorising-the-format, product/chat-with-agents, product/read-what-work-produced]
surfaces: [ui/surfaces/tasks-view, ui/surfaces/sidebar, ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/conversation-list, ui/surfaces/run-view, ui/surfaces/run-conversation]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/menu.tsx, packages/app/src/renderer/pointerMenu.tsx, packages/app/src/renderer/App.tsx, packages/app/src/renderer/files.tsx]
verified_by: [packages/app/test/pointerMenu.test.ts, packages/app/test/selectionHold.test.ts]
mockups: [ui/assets/context-menu/verbs.html, ui/assets/context-menu/partial.html, ui/assets/context-menu/kinds.html, ui/assets/context-menu/pointer.html]
siblings: [ui/components/address-bar, ui/components/composer-setting-chip, ui/components/model-cascade]
---

# Context menu

A 232px floating list on `--panel` with a hairline `--line` border, 8px corners and a lifted shadow: one line per entry in the app face, dim notes at the right, rules between groups, a red destructive entry last, greyed entries that cannot be taken, and sometimes a small uppercase caption on top.

## A context menu offers the verbs of the thing under the pointer, one level deep

**Use when.** Right-clicking a task card, a board column, a file or a conversation offers what can be done to it or to a chosen set. A `+` or a chevron offers a few alternatives or kinds, such as what to create in a folder or what type a message is. Right-clicking text, a field, an image, a diagram or a link anywhere with no menu of its own offers copy, paste and save.

**Do not use when.** The choice has levels or needs a preview beside it: the [model-cascade](model-cascade.md) and the popover of a [composer-setting-chip](composer-setting-chip.md) do that. One action is the main thing to do with the item: it is a button. The act is irreversible: the menu entry opens the [confirm-dialog](../surfaces/confirm-dialog.md), which states what will be lost.

## The entries read first, their notes second, and the caption says what the menu is about

- **Caption.** Optional. A small uppercase line in the data face, letterspaced, in `--dim`, above the entries: how many tasks are chosen, the state a column stands for, or the question a list of kinds answers.
- **Entry.** The label in the app face at the app base size in `--text`, on one line, 5px above and below and 12px at the sides.
- **Note.** At the far end of an entry, in the app face at 0.88 of the base in `--dim`, taking at most 45% of the width: what tells two entries apart, or what a verb on a set will skip.
- **Groups.** A 1px `--line` rule over the first entry of a group, 4px above the rule and 8px below it.
- **Destructive entry.** In `--bad`, last, after a rule.
- **Kinds.** Where the entries are kinds rather than verbs, a 13px [icon](icon.md) in `--dim` stands before each label.
- **Current choice.** Where the entries are alternatives to something already chosen, a `•` in `--accent` sits in the left gutter and the label takes weight 600.

## Every menu is a list of verbs, a set's verbs, a list of kinds or the pointer's verbs

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a menu opens only with entries. A right-click on content with nothing to offer opens no menu at all. | |
| loading | Cannot occur: the entries are known when the menu opens. | |
| verbs | One item's verbs in groups. An entry that cannot be taken stays in its place in `--dim` and reacts to nothing; a destructive entry that cannot be taken stays `--bad`. Shown for a finished task, a running task, and the `+` of a checkout's Files row. | [verbs.html](../assets/context-menu/verbs.html) |
| partial | A set: the caption counts the chosen tasks or names the column's state, each verb names how many tasks it will touch, and a note names the kind it skips. A verb that would touch none is unavailable. | [partial.html](../assets/context-menu/partial.html) |
| error | Cannot occur in the menu: it closes before its verb runs, a failed verb reports its reason elsewhere, and the copy and save verbs of the pointer's menu fail without a word. | |
| kinds | The caption as a question, an icon before every kind, the current kind marked with `•` at weight 600 and a note saying where that answer came from. | [kinds.html](../assets/context-menu/kinds.html) |
| pointer | The window-wide menu: no caption, notes or icons. A field offers its four edit verbs, with those that do not apply unavailable; an image, a diagram, a selection and a link offer their own. | [pointer.html](../assets/context-menu/pointer.html) |

## A right-click opens the menu at the pointer, and choosing or looking away closes it

| On | Does | Feedback |
| --- | --- | --- |
| Right-click a task card on the Tasks view | Makes that card the only chosen one, unless it is one of several chosen, then opens its verbs at the pointer | The card tinted and described beside the board; the menu at the pointer |
| Right-click one of several chosen cards | Opens the verbs for the whole set | Caption `{n} tasks` |
| Right-click a column on the Tasks view | Opens the column's verbs, a way to choose its tasks, and the set's verbs | Caption `{state id}` |
| Click the `+` on a Files row | Opens what can be created there, right-aligned under the `+` | The menu 4px below the button |
| Click `Open a project…` | Opens the two ways to add a project, left-aligned under the row | The menu 4px below the row |
| Right-click content with no menu of its own | Opens the pointer's menu for what is under the pointer; a component's own menu takes precedence | The menu at the pointer |
| Pointer over an entry that can be taken | Nothing | Ground `--accent` with label, note, mark and icon in `--panel`; a destructive entry's ground is `--bad` |
| Pointer over an entry that cannot be taken | Nothing | No change |
| Click an entry that can be taken | Closes the menu, then acts | The menu is gone; a delete opens the confirm dialog |
| Press inside the menu | Nothing | Focus stays where the right-click left it, so Cut and Paste act on that field |
| Escape, a press outside, or resizing the window | Closes the menu | The menu is gone |
| Scrolling the area that holds the item, or the page | Closes the menu | The menu is gone |
| Scrolling any other area | Nothing | The menu stays open |
| The window losing focus | Closes the pointer's menu only | The menu is gone |

## The copy is the verb, a count and a note that says what is different

| Where | String |
| --- | --- |
| Task card | `Open` · `Start` for a queued task, `Re-run as a new task` with note `fresh copy` for a finished task or a conversation, otherwise `Re-run`, unavailable while running · `Cancel`, unavailable once finished · rule · `Copy task id` · rule · `Delete…`, unavailable while running |
| Chosen tasks | Caption `{n} tasks` · `Re-run {k} tasks`, note `running skipped` · `Cancel {k} tasks`, note `finished skipped` · rule · `Copy task ids` · rule · `Delete {k} tasks…`, note `running skipped`; `{k} task` when it is one |
| Board column | Caption `{state id}` · `Open` · `Describe` · rule · `Select {n} tasks` · rule · then the chosen-tasks verbs for every task in the column |
| Folder `+` | `New file…` · `New folder…` · rule · `New state…` in a workflows folder, noted `{state id prefix}/` below its top, or `New workflow…` at the top of a root or inside a checkout's `.jaira`, noted `workflows` at the shared root and `.jaira/workflows` in a checkout; any other folder offers only the first two |
| Open a project | `Open project…` · `New project…` |
| Type of a message | Caption `This text is` · `Markdown` `Plain text` `JSON` `HTML` `Diff` `YAML` `CSV` `TypeScript` `JavaScript` `Python` `Shell` `CSS` `XML`, one of them noted `detected`, `declared`, `this thread` or `yours` · rule · `Use for every message here`, note `until you say otherwise` · `Back to what JaiRA detected`, note `{type}`, or `Stop using it for every message`, note `back to {type}`, where a choice has been made |
| Pointer, field | `Cut` · `Copy` · `Paste` · rule · `Select all` |
| Pointer, image | `Copy image` · rule · `Save image as…` · `Copy image address`, left out for an embedded picture |
| Pointer, diagram | `Copy image` · `Copy as SVG` · rule · `Download SVG…` · `Download PNG…` |
| Pointer, selection and link | `Copy` · `Copy link`, with a rule between when both apply |
| Pointer, video or audio in a frame | `Save video as…` · `Save audio as…` |

Menus opened from a file tree row, a conversation row, a value's `…`, a run's index or the address bar's chevrons list their verbs in their own docs.

## The menu keeps its width, stays inside the window, and never takes focus

- Resize: the width is 232px whatever the entries. Labels and notes end in an ellipsis, and the note gives up its width first. The menu is placed at the point it was opened from and moved in to stay 4px inside the window's edges, and no pane clips it. A menu taller than the window runs past the bottom edge, because it does not scroll.
- Theme: ground, border, shadow, text and the inverted hover are tokens with a light and a dark value.
- Focus order: the menu never takes focus. Arrow keys do nothing, and the entries are buttons reached only by Tab after everything else on the page. Escape closes it. A screen reader hears a menu of menu items.
- Long or missing content: an entry with no note ends at its label; a set verb with nothing to touch reads `0 tasks` and cannot be taken.

## The caption and the notes put words in the other voice

- The caption is uppercase in the data face, so a state id in a column menu loses its case, and app words such as `3 tasks` and `This text is` are set in mono.
- Notes are in the app face even when they carry data, such as a state id prefix or `.jaira/workflows`.
