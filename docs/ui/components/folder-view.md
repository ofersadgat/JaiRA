---
id: ui/components/folder-view
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/drill-in-and-back-out, ux/patterns/problems-marked-where-they-are, ux/patterns/absence-is-stated]
serves: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running, product/share-processes-across-projects]
surfaces: [ui/surfaces/files-view]
reuses: []
implemented_by: [packages/app/src/renderer/files.tsx]
verified_by: []
mockups: [ui/assets/folder-view/success.html, ui/assets/folder-view/root.html, ui/assets/folder-view/empty.html]
siblings: [ui/components/file-tree, ui/components/file-panel, ui/components/address-bar]
---

# Folder view

One directory listed down the Files view's middle column as full-width rows: a dim `↰ ..` row first, then folders in bold with a `▸`, then files with their kind glyph, each name at the left and any problem chip at the far right.

## A folder view is what the middle column shows when the address ends on a folder

**Use when.** The person has gone to a folder through the [address-bar](address-bar.md) and wants what is in that one place, one level deep, to go further in, back up, or open a file.

**Do not use when.** The person needs every file at once and where each sits: that is [file-tree](file-tree.md). A document is open: the middle column is [file-panel](file-panel.md).

## The way up reads first, then folders, then files

- **List.** 8px by 10px padding, 1px between rows, scrolling when longer than the column.
- **Row.** A button across the column: 5px by 8px padding, 6px radius, a transparent 1px border, 8px gaps. A 14px glyph in `--dim`, the name in the app face at 13/12.5 of its base, one line, and chips at the far right.
- **Up row.** `↰` and `..` in `--dim`, first, on every folder but the top of a root.
- **Folders.** `▸` and the name at weight 600, sorted by name, before every file.
- **Files.** `◻` for a state, `◈` a prompt, `✦` a skill, `⚙` settings, `·` anything else, sorted by name. A state is named by the last segment of its id with no extension, so `review.yaml` reads `review`.
- **Chips.** Outlined pills in the app face: `!` in `--bad` for a file that cannot be read or parsed, else the error count in `--bad`, else the warning count in `--warn`; `shadowed` in `--dim` for a shared file this project overrides. Names never take the problem's colour and no row shows unsaved edits.

A folder of the project layer lists the entries at that path in every open project, one after another.

## The listing is either entries, a way up alone, or a top level

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The up row, then `This folder is empty.` in `--dim`. | [empty.html](../assets/folder-view/empty.html) |
| loading | Cannot occur: the listing is drawn from the tree the app has already read. | |
| partial | Cannot occur: every entry at the path is listed. | |
| error | Cannot occur as a look of its own: an entry that cannot be read keeps its row with a `!` chip, and its tooltip is the error. | |
| success | The up row, folders, then files with their chips. | [success.html](../assets/folder-view/success.html) |
| root | The top of a checkout or of `~/.jaira`: the same rows with no up row. | [root.html](../assets/folder-view/root.html) |

## Every row is a step: up, in, or open

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row | Nothing | Ground `--panel-2` and a `--line` border |
| Click, Enter or Space on `..` | Lists the parent folder | The listing and the address change |
| Click, Enter or Space on a folder | Lists that folder | The listing and the address change |
| Click, Enter or Space on a state | Opens the state | The address ends on the state; the column becomes its file panel |
| Click, Enter or Space on any other file | Opens the file | The column becomes its file panel |

## The copy is the names and nothing more

| Where | String |
| --- | --- |
| Up row | `..` |
| Folder or file | `{name}` · `{last segment of the state id}` for a state |
| Row tooltip | `{path}` · `{read or parse error}` |
| Chips | `!` · `{errors}` · `{warnings}` · `shadowed` |
| Empty | `This folder is empty.` |

## The listing fills the column and cuts names before chips

- Rows span the column at any width; a name ellipsises and chips never shrink.
- Theme: ground, border and chip colours are tokens with a light and a dark value.
- Focus: every row is a native button in tab order, in the order drawn, with the app's focus outline.
- Long content: a long listing scrolls inside the column; a long name shows whole only in its path tooltip.

## The view sets file names in the app face

- Folder and file names are data and are set in the app face at 13/12.5 of the app base, where the tree beside it sets the same names in the data face.
- Chip counts are numbers set in the app face.
