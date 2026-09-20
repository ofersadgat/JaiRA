---
id: ui/components/patch-view
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/absence-is-stated]
serves: [product/read-what-work-produced]
surfaces: [ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/context-panel, ui/surfaces/settings-appearance]
reuses: [ui/components/diff-editor, ui/components/icon]
implemented_by: [packages/app/src/renderer/valueView.tsx, packages/app/src/renderer/fileSurfaces.tsx]
verified_by: [packages/app/test/patchView.test.ts, packages/app/test/valueViewToggle.test.ts, packages/app/test/fileRegistry.test.ts]
mockups: [ui/assets/patch-view/empty.html, ui/assets/patch-view/loading.html, ui/assets/patch-view/error.html, ui/assets/patch-view/success.html, ui/assets/patch-view/collapsed.html, ui/assets/patch-view/no-lines.html, ui/assets/patch-view/side-by-side.html]
siblings: [ui/components/file-changes-list, ui/components/diff-editor, ui/components/changeset-review]
---

# Patch view

A unified diff read as the change it describes: `2 files +14 −3` on top, then one thin-bordered head line per file with a chevron, an uppercase verb, the mono path and its counts, over hunks of numbered lines washed green where added and red where removed.

## A patch view reads a patch as a change, with only the lines the patch carries

**Use when.** Text is a unified diff: the `Changes` reading above a `.patch` or `.diff` file in the Files view, and the `Diff` reading of a value that is a patch, in a conversation, a gate or a pinned value. The `Side by side` reading of a patch file draws its first file as two panes.

**Do not use when.** The change carries the whole before and after of each file, as a produced set of changes does: use [file-changes-list](file-changes-list.md). Each change must be kept, dropped or commented on: use [changeset-review](changeset-review.md). Two whole texts are compared: use [diff-editor](diff-editor.md).

## The totals read first, each file's head second, and its hunks under the head

- **Totals.** `{n} files` in `.app-secondary` `--dim`, then `+{added}` in `--ok` and `−{removed}` in `--bad` in small mono.
- **File head.** A full-width line with a 1px `--line` border and 5px corners, 4px by 6px padding. The chevron in `--dim`, then the verb in the app face at a small size, uppercase with .04em tracking: `CREATE` in `--tok-string`, `DELETE` in `--bad`, `UPDATE` and `RENAME` in `--dim`. Then the path in mono `.data-text` size, and the file's counts at the far end. Files stand 8px apart.
- **Hunk band.** Across the top of each hunk, on an 8% `--dim` wash: the hunk header as the patch writes it, then the enclosing function or section, both `--dim`, the section fainter and cut with an ellipsis.
- **Lines.** Mono at the `.data-text` size, line height 1.5, never wrapped. Two right-aligned gutters of faint `--dim` line numbers, the patch's own, with a blank cell where a side has no line. Then a sign column and the text. An added line has a 14% `--tok-string` wash and a `+` in `--tok-string`; a removed line has a 13% `--bad` wash and a `−` in `--bad`; a context line has no wash.
- **Breaks.** A 1px dashed `--line` rule between hunks, because the lines on either side are not neighbours in the file.

## Every file is open, folded or says why it has no lines, and the view says when there is no patch

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | In the Files view, a file holding only whitespace reads `This file is empty.` in `--dim`. As a value's `Diff` reading, text with no hunks reads `No hunks in this patch.` in `--dim`. | [empty.html](../assets/patch-view/empty.html) |
| loading | `Side by side` only: until the panes arrive, the raw patch fills their bordered band in `--dim` mono, with the file note pinned under it. | [loading.html](../assets/patch-view/loading.html) |
| partial | Cannot occur: every line a patch carries is drawn, and the view never shows part of a hunk. | |
| error | In the Files view, text with no hunk in it reads `not a unified diff — the editor below has the text` as a `--bad` sentence on a `--tint-bad` wash, in both readings. | [error.html](../assets/patch-view/error.html) |
| success | Every file open, heads and hunks, totals on top. A line with no newline at the end of the file carries a dim `⏎̸ no newline at end of file` after its text. A bare hunk with no file lines above it, as a fenced block usually holds, heads its file `(no file named)`. | [success.html](../assets/patch-view/success.html) |
| collapsed | A file whose head was clicked: only its head line, the chevron turned to point right. The other files keep their own fold. | [collapsed.html](../assets/patch-view/collapsed.html) |
| no lines | A file the patch gives no lines for. A binary file says `binary — the patch carries no readable content` under its head; a rename or a mode change says `No lines change — a rename or a mode change.` A rename shows the old path in `--dim`, an arrow, then the new one. Counts read `no change` in `--tok-hint`. | [no-lines.html](../assets/patch-view/no-lines.html) |
| side by side | The Files view's second reading: the first file's hunks as two read-only panes drawn by [diff-editor](diff-editor.md), before on the left and after on the right, filling the upper half. Under them, pinned, the path and how many other files the patch holds. | [side-by-side.html](../assets/patch-view/side-by-side.html) |

## A file's head folds it, and nothing in a patch can be edited

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a file head | Nothing | The border mixes 40% `--accent` into `--line` |
| Click a file head, or Enter or Space on it | Folds the file to its head, or opens it | The hunks go or return and the chevron turns |
| Scroll the view | Moves through the files, past 460px of height | The native scrollbar |
| Scroll a file's lines sideways | Shows the rest of a long line inside that file only | The file's own scrollbar |
| Drag across lines | Selects the text; line numbers and signs are not selected | The system selection |

## The copy is the patch's own paths and lines, and a few statements about what it lacks

| Where | String |
| --- | --- |
| Totals | `{n} file` for one, `{n} files` for more |
| Counts | `+{added}` · `−{removed}` · `no change` when both are zero |
| Verb | `create` · `update` · `delete` · `rename`, drawn uppercase |
| Rename | `{old path} → {path}` |
| No path | `(no file named)` |
| Binary | `binary — the patch carries no readable content` |
| No lines | `No lines change — a rename or a mode change.` |
| Hunk band | `{hunk header}` such as `@@ -41,7 +41,9 @@`, then `{section}` |
| No newline | `⏎̸ no newline at end of file` |
| Empty file | `This file is empty.` |
| Empty value | `No hunks in this patch.` |
| Not a patch | `not a unified diff — the editor below has the text` |
| Side by side note | `{path}` · `{path} — and 1 other file in this patch` · `{path} — and {n} other files in this patch` |

## The view scrolls as a whole, each file scrolls sideways, and heads keep their paths whole

- The view stops at 460px tall and scrolls inside itself; in the Files view's upper half the half scrolls around it when shorter.
- A long line scrolls sideways inside its own file and never widens the host. A long path in a head wraps anywhere rather than pushing the counts off the line.
- Every file is drawn open again when the view is drawn afresh, such as on reopening the file.
- `Side by side` shows one comparison: a patch of several files names how many others it holds, and the `Changes` reading is the way to read them.
- Theme: washes are mixed from `--tok-string` and `--bad` into transparent, so added and removed lines read in both themes. The side-by-side panes take the palette chosen for that reading in Settings › Appearance › File types.
- Focus: each file head is a tab stop in file order. The lines take no focus.

## The patch view departs from the UI direction in one place

- Line numbers and the hunk section are quieted with opacity, .6 and .75, rather than with `--tok-hint`.
