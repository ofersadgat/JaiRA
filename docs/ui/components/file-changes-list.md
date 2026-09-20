---
id: ui/components/file-changes-list
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/absence-is-stated, ux/patterns/refuse-with-the-reason-and-the-fix]
serves: [product/read-what-work-produced, product/keep-process-and-description-in-step, product/complete-record-of-every-run, product/review-changes-before-they-land]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/files-view]
reuses: [ui/components/diff-editor]
implemented_by: [packages/app/src/renderer/valueView.tsx]
verified_by: []
mockups: [ui/assets/file-changes-list/empty.html, ui/assets/file-changes-list/success.html, ui/assets/file-changes-list/open.html]
siblings: [ui/components/changeset-review, ui/components/patch-view, ui/components/diff-editor, ui/components/value-view]
---

# File changes list

A compact list of changed files: `4 files +34 −7` in small type, then one ruled line per file with a chevron, a quiet `update` pill, the path in mono, green and red line counts and a green tick or red cross at the end, each line opening in place to a read-only diff.

## The file changes list shows what a set of changes was, without asking anything

**Use when.** A value is a set of file changes and is read rather than decided: a tool result or produced value in a conversation, the proposed files in a workflow sync report, or an artifact being edited in a non-prose format once it differs from what arrived.

**Do not use when.** A person decides which changes land: use [changeset-review](changeset-review.md). The value is a patch file read as its hunks with the patch's own line numbers: use [patch-view](patch-view.md). One file's before and after are the whole subject: use the [diff-editor](diff-editor.md) directly.

## The files and their sizes read first, the outcome at the end of the line, the diff on demand

- **Head.** `{n} files` in `.app-secondary`, then the total counts, baseline-aligned with 8px between and 5px under.
- **Row line.** A 1px `--line` rule above each row. The line is one button, 4px by 2px inset with 4px corners, 7px between its parts: the chevron in `--tok-hint`, pointing down while folded; the action as a `.chip`, a 1px `--line` pill in the app face at 10/12.5 in `--dim`; the path in mono at 11.5/12 filling the line; the counts in mono at 11/12, `+{n}` in `--ok` and `−{n}` in `--bad`, or `no change` in `--tok-hint`; a 14px tick in `--ok` or cross in `--bad` when the host knows the outcome.
- **Row action.** A host's own small accent link, such as `Open`, sits after the line button, outside it.
- **Open body.** 4px above and 8px below: the joined `Inline | Side by side` toggle at the right, then the [diff-editor](diff-editor.md), read-only, then the change's reason in `.app-secondary` 5px under it.

## The list folds to its rows and opens one file at a time

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | No changes: `No files change.` in `--dim`, or the host's own sentence, such as `Nothing to change.` in a sync report. | [empty.html](../assets/file-changes-list/empty.html) |
| loading | Cannot occur for the list, which draws from the changes it is given. A row opened before the diff editor has loaded is part of the open state. | |
| partial | Cannot occur: every change in the set has a row. | |
| error | Cannot occur as a look of its own: a change that cannot be shown opens to its reason, and a change the app refused is marked on its line. | |
| success | Every row folded. Outcome marks show only when the host knows them: a tick for applied, a cross for refused whose tooltip gives the reason. No diff is loaded. | [success.html](../assets/file-changes-list/success.html) |
| open | A row opened: the chevron turned a quarter to point left and the body under the line. A change that cannot be shown opens to its reason in `--dim`, such as `binary`, with no toggle. A diff still loading shows the toggle over `loading the diff editor…` centred in `--dim`. | [open.html](../assets/file-changes-list/open.html) |

## A click on a line opens that file's diff in place

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row line | Nothing | The line takes a `--panel-2` ground |
| Click a row line | Opens or folds that row; the first opening loads the diff | The chevron turns and the body appears or goes |
| `Inline` or `Side by side` | Lays out every diff in this list that way; the list starts on `Inline` each time it is drawn | The chosen word takes the pressed look; open diffs re-lay |
| Pointer over the cross | Nothing | Tooltip with the reason the change was not applied |
| A host's row action, such as `Open` in a sync report | Whatever the host defines; `Open` opens that state file in the Files view | The Files view moves to the file |

## The copy is counts and the host's reasons

| Where | String |
| --- | --- |
| Head | `{n} file` · `{n} files` |
| Counts | `+{added}` · `−{removed}` · `no change` |
| Path tooltip | `{full path}` |
| Tick tooltip | `applied` |
| Cross tooltip | `{reason}` · `not applied` when there is none |
| Empty | `No files change.` · or the host's sentence |
| Toggle group label | `How to lay the diff out` |
| Inline | `Inline` · tooltip `One column: removals above additions` |
| Side by side | `Side by side` · tooltip `Two columns: before and after` |
| Loading | `loading the diff editor…` |
| Unshowable | `{reason}`, such as `binary` |
| Reason under a diff | `{why the change was made}` |

## The path gives up width first, and an open diff takes the list's width

- Width is the host's, from the 360px context panel to a wide conversation column. The path ellipsises at its end and its tooltip holds it whole; the chevron, pill, counts and mark never shrink.
- An open diff spans the list and grows with its content from 120 to 620px, so opening a row pushes the rows under it down.
- Theme: the list is drawn in tokens; an open diff is painted in the Changes or editor palette.
- Focus: each row line is a button that announces whether it is open, followed by the host's action; the toggle words announce which is pressed.
- Missing content: without outcomes no mark is drawn; without a reason nothing sits under the diff.
