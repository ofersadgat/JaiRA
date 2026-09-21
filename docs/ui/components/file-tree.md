---
id: ui/components/file-tree
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/filter-in-place, ux/patterns/name-it-where-it-will-live, ux/patterns/draft-belongs-to-the-file, ux/patterns/problems-marked-where-they-are, ux/patterns/the-window-remembers-its-arrangement, ux/patterns/verbs-on-the-thing-itself, ux/patterns/absence-is-stated, ux/patterns/second-deliberate-step-for-irreversible]
serves: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running, product/share-processes-across-projects, product/all-projects-in-one-place]
surfaces: [ui/surfaces/sidebar, ui/surfaces/files-view]
reuses: [ui/components/context-menu]
implemented_by: [packages/app/src/renderer/files.tsx, packages/app/src/renderer/builtIn.tsx, packages/app/src/renderer/App.tsx]
verified_by: [packages/app/test/fileTreePanel.test.ts, packages/app/test/builtInStates.test.ts]
mockups: [ui/assets/file-tree/empty.html, ui/assets/file-tree/success.html, ui/assets/file-tree/marked.html, ui/assets/file-tree/filtering.html, ui/assets/file-tree/naming.html, ui/assets/file-tree/built-in.html]
siblings: [ui/components/folder-view, ui/components/sidebar-row, ui/components/project-row, ui/components/state-rail]
---

# File tree

The drawer under the open project's `FILES` row in the sidebar: a scrolling list of mono file names with a thin rule per nesting level, a twisty or kind glyph before each name, and coloured dots and small outlined count chips at the end of rows that have unsaved edits or problems.

## The tree is where every file is found, opened and created

**Use when.** A person browses the files of every open project and the shared `~/.jaira` at once, opens one into the Files view, or makes a new file, folder or state in the place it will live.

**Do not use when.** One directory's contents fill the middle column: that is [folder-view](folder-view.md). The nesting is a run's states rather than folders: that is [state-rail](state-rail.md).

## The standing checkout reads first, then each other root under its own name

- **Roots.** The checkout the drawer hangs under, or every open project at the root of the address, or `~/.jaira` when that is where the person stands; then `Built in`, the states and files JaiRA ships, last in every tree. The root the drawer hangs under has no heading; each other root starts with its name in `.data-secondary`, uppercased in `--dim` with wide tracking, and a `+` at its end.
- **Built in.** Always headed. In place of the `+` its heading ends with a hairline `read-only` chip in the app face at its own case, and, while the shared root holds copies of shipped states that JaiRA itself wrote, a link in `--accent` data type reading `{n} old copies…`. Its folders have no `+`.
- **Row.** 3px by 6px padding, 5px radius, 5px gaps. One 13px guide per level: the innermost a `--rule` hairline, the ancestors `--line`. Then a 13px glyph column in `--dim`: `▸` or `▾` for a folder, `◻` a state file, `◈` a prompt, `✦` a skill, `⚙` settings, `·` anything else. Then the name in the data face at 11.5/12 of its base, one line.
- **End of row.** In order: an `--accent` dot for unsaved edits, a `--bad` or `--warn` dot for problems, one outlined pill chip in the app face, a `shadowed`, `overridden` or `override` chip, and on a folder a 16px `+` that shows only under the pointer or on focus but keeps its width.
- **Folding.** Every folder starts shut, and opening one shows only its own entries. What is open is kept for the person and restored next time.

## Every mark sits on the row it is about and rolls up onto its folders

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Before a tree has been read the drawer reads `Open a project to browse its files.` A root with nothing to show reads `empty`; a root not on disk reads `not created yet — adding a state here will create it`, in `--dim` under its heading. | [empty.html](../assets/file-tree/empty.html) |
| loading | Cannot occur as a look of its own: until the tree arrives the drawer shows the first empty line. | |
| partial | Cannot occur: an open folder lists all of its entries. | |
| error | Cannot occur as a look of its own: a file that cannot be read or parsed is one of the marks below. | |
| success | Guides, glyphs and names; the open file on `--fill-ghost-selected` at weight 600, matched by project, root and path, so a state of the same id elsewhere stays plain. A file that is not text is `--dim` with a plain cursor and still opens. | [success.html](../assets/file-tree/success.html) |
| marked | Unsaved edits: an `--accent` dot on the file and on every folder above it. Errors: name in `--bad`, a `--bad` dot and a chip with the count. Warnings only: the same in `--warn`. A file that cannot be read or parsed: a `!` chip, its tooltip the error. A state no workflow root reaches: name italic at 60%. A shared file this project overrides: row at 55%, name struck through, a `shadowed` chip. A folder carries the totals below it, so a fault shows with the branch shut. | [marked.html](../assets/file-tree/marked.html) |
| built in | The last root. A shipped state that a project or shared file overrides: row at 55%, name struck through, an `overridden` chip. The file that overrides it, in its own root: an `override` chip after the name. A shipped state nothing overrides carries neither. | [built-in.html](../assets/file-tree/built-in.html) |
| filtering | The find field over the list takes focus. Typing flattens every root to the files whose path contains the text, ignoring case: no folders, no guides, root headings kept. | [filtering.html](../assets/file-tree/filtering.html) |
| naming | A row typed into where the new thing will be, with the glyph it will have, any folders still to be made as a dim mono lead such as `workflows/`, and a field with only an `--accent` underline. | [naming.html](../assets/file-tree/naming.html) |

## Click opens, right-click offers what the row can do, and a name is typed in place

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row | Nothing | `--fill-ghost-hover` ground; a folder's or root's `+` appears |
| Click a folder | Opens or shuts it | Twisty turns, entries appear or go |
| Click a file | Opens it in the Files view | Row selected; address bar, middle column and context panel follow |
| Right-click a row | Selects a file, then opens its menu in a [context-menu](context-menu.md) | Menu at the pointer |
| Right-click a root heading or the space under a root | Opens the root's menu | Menu at the pointer |
| Right-click a row under `Built in` | Opens the read-only menu: Open, the two overrides, and the copy and reveal items; a folder or a file that is not a state gets only the last two | Menu at the pointer |
| Override for all projects, Override here | Copies the shipped state into `~/.jaira` or the project's `.jaira/` under the same id and opens the copy; refused when that layer already has one | The copy selected in its root; the shipped row gains `overridden`. A refusal shows in the error notice |
| `{n} old copies…` on the `Built in` heading | Asks in a [confirm-dialog](../surfaces/confirm-dialog.md), naming every file; on yes deletes the copies that are still identical | The link goes once none are left; an open copy is replaced by the shipped file |
| `+` on a folder or root, or `+` on the `FILES` row | Offers New file…, New folder…, and New state… or New workflow… where one belongs | Menu under the button |
| Pick a New item | Opens the folders on the way and starts a row to name it in, under the deepest one that exists | Field focused |
| Enter, or leaving the field | Creates the file, folder or state from the trimmed name; an empty name creates nothing | The typed row is replaced by the new entry; a new state opens |
| Escape while naming | Drops the typed row | Row gone |
| `⌕` on the `FILES` row | Shows or hides the find field | The verb tints `--accent` while on |
| Typing in the find field | Filters in place and drops any row being named | Flat list |
| Escape in the find field | Clears the text | Full tree |
| Rename…, Duplicate…, Delete, Override or Copy | Asks in a [confirm-dialog](../surfaces/confirm-dialog.md); when other states name it as a child, asks a second time in danger colours | Dialog; a failure shows in the error notice |
| Copy path, Copy state id | Copies to the clipboard | None |
| Reveal in file explorer | Opens the system file browser at it | The system window |

A state's name drops a typed `.json`, `.jsonc`, `.yaml` or `.yml` and any leading or trailing slash.

## The copy names the thing, the place and what would break

| Where | String |
| --- | --- |
| Find field | placeholder `Filter…` |
| No tree | `Open a project to browse its files.` |
| Root empty | `empty` · `not created yet — adding a state here will create it` · under `Built in`: `nothing ships with this build` |
| Built in heading | `Built in` · chip `read-only`, tooltip `What ships with JaiRA. Read it here; change it by overriding it.` · link `1 old copy…` or `{n} old copies…`, tooltip `{n} files in the shared root identical to what JaiRA installed there — not needed any more` |
| `+` | tooltip `new file, folder or workflow in {name}`; label `New in {name}` |
| Dots | tooltip `unsaved edits` · `unsaved edits below here` |
| Row tooltip | `{n} errors, {n} warnings`, with ` below here` on a folder · `not validated — no workflow root reaches this state` · `{read or parse error}` · `{path}` |
| Chips | `!` · `{errors}` · `{warnings}` · `shadowed` · `overridden` · `override`, tooltip `Overrides built in: JaiRA ships a state with this id, and this file runs instead of it` |
| Name field | placeholder `folder name` · `state id` · `file name`; label `new state id` · `new file name` · `new directory name` |
| New items | `New file…` · `New folder…` · `New state…`, note `{id prefix}` · `New workflow…`, note `.jaira/workflows` or `workflows` |
| Folder or file menu | the New items for its folder, then `Rename…` · `Delete` · `Copy path` · `Reveal in file explorer` |
| State menu | `Open` · `New child state…`, note `{id}/` · `Duplicate…` · `Rename…` · `Override in this project` or `Copy to shared root`, disabled when shadowed or with no project open · `Copy state id` · `Copy path` · `Reveal in file explorer` · `Delete` |
| Root menu | the New items, then `Copy path` · `Reveal in file explorer`, disabled when the root is not on disk; under `Built in` the last two only |
| Built in state menu | `Open`, note `read-only` · `Override for all projects`, note `~/.jaira` · `Override here`, note `.jaira`, disabled with no project open · `Copy state id` · `Copy path` · `Reveal in file explorer` |
| Delete old copies | title `Delete {n} copies of built-in states?` or `Delete 1 copy of a built-in state?`; note `JaiRA used to install its own states into the shared root. These files are identical to {what ships now, so deleting them changes nothing that runs / a version an earlier JaiRA installed, so deleting them goes back to what ships now}. Nothing else is touched.` then every absolute path; confirm `Delete {n} copies` or `Delete the copy` |
| Rename a path | title `Rename '{name}'`; field `Path`, filled with its path; note `Relative to ~/.jaira/` or `Relative to .jaira/`; confirm `Rename` |
| Delete a path | title `Delete this folder?` or `Delete this file?`; note `{absolute path} — and everything inside it.` or `{absolute path}`; confirm `Delete` |
| Path refused | title `{verb} '{path}' anyway?`; note `{states} declares it as a child. They will name a state that no longer exists.`, or `They will fail to load without it.` after a delete, with `{n} states inside it` for a folder; confirm `{verb} anyway` |
| Duplicate a state | title `Duplicate '{id}'`; field `New state id`, filled `{id}-copy`; confirm `Duplicate` |
| Rename a state | title `Rename '{id}'`; field `New state id`; note `A state's id is its path, and every state that names it as a child names this id.`; confirm `Rename` |
| Delete a state | title `Delete '{id}'?`; note `{absolute path}`; confirm `Delete` |
| State refused | title `{verb} '{id}' anyway?` · `Delete '{id}' anyway?`; note `{states} declares it as a child. They will name a state that no longer exists.` · `{states} declares it as a child, and will fail to load without it.`; confirm `{verb} anyway` · `Delete anyway` |
| Dialog cancel | `Cancel` |

`declares` reads `declare` when more than one state is named.

## The tree takes the sidebar's width and cuts names, never marks

- The drawer is the sidebar's width less its nesting rules, and fills the height the section leaves; the list scrolls inside it and never scrolls sideways.
- Names and root headings ellipsise; dots, chips and the `+` never shrink. Each level costs 13px, so a deeply nested name is cut first.
- Theme: every colour is a token with a light and a dark value; dots carry the meaning a second time beside the name's colour.
- Focus: rows are not tab stops. The `+` buttons, the find field and a name field are; a folder's `+` shows when it has focus. Opening, selecting and the menus are pointer gestures.
- Unsaved work: unsaved edits to a file stay with that file after the person moves on, and their dot stays on the row and its folders until they are saved, reverted or the window is closed.

## The tree marks some data the way app words are marked

- A root heading uppercases a project name or `~/.jaira`, which are data.
- A shadowed row and an unchecked name are quietened with opacity instead of the `--tok-hint` register.
- The selected file is shown with the ghost fill and weight, not the `--tint-accent` ground a selected nav row takes.
- Count chips set their numbers, and the find field its path text, in the app face.
