---
id: ui/components/produced-artifacts
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/one-document-several-readings]
serves: [product/read-what-work-produced, product/chat-with-agents]
surfaces: [ui/surfaces/chat-view]
reuses: [ui/components/value-view, ui/components/icon]
implemented_by: [packages/app/src/renderer/chatPane.tsx, packages/app/src/renderer/transcriptView.tsx]
verified_by: []
mockups: [ui/assets/produced-artifacts/closed.html, ui/assets/produced-artifacts/open.html, ui/assets/produced-artifacts/selected.html, ui/assets/produced-artifacts/error.html]
siblings: [ui/components/value-view, ui/components/artifact-pane, ui/components/file-changes-list, ui/components/transcript]
---

# Produced artifacts

A slim strip across the top of a chat thread, above the scrolling conversation and under a hairline, reading a chevron, `Produced` and a count centred in the column, which opens into a list of the files the conversation made, each a path with a `runs` chip when it is an interactive page and its size at the right, and under the list the chosen file drawn in full.

## Produced artifacts collects what a conversation made in one place above it

**Use when.** A chat conversation has produced at least one artifact, and the person wants the documents, pages and data it made without scrolling back to the turn that made each one.

**Do not use when.** The conversation has produced nothing: the strip is not drawn at all. One value is read where it was produced, beside its call: that is the [value-view](value-view.md) in the [transcript](transcript.md). A person reviews one artifact to decide on it: use [artifact-pane](artifact-pane.md). A set of file changes is listed by [file-changes-list](file-changes-list.md). A run's conversation has no produced strip.

## The count reads first, then the paths, then the file itself

- **Strip.** Full width of the thread column, never scrolling away, with a 1px `--line` rule under the whole component. The head is a line padded 6px by 12px with its parts centred and 8px apart: a 13px chevron in `--tok-hint`, `Produced` in the app face in `--dim`, and the count in `--dim` at weight 400. Pointing at the head turns the word `--text`.
- **Body.** Padded 0 by 12px with 8px below, parts 6px apart, at most 45% of the window's height.
- **List.** At most 20% of the window's height, scrolling. Each row padded 4px by 8px with 6px corners and 8px gaps: the path in the app face at the app base in `--text`, taking the spare width and ending in an ellipsis; a small rounded `runs` chip on a 22% `--accent` wash for a page that runs its own scripts; the size in `.app-secondary` at the far right.
- **Chosen row.** `--fill-ghost-selected` ground and the path at weight 600. Pointing at any row gives it `--fill-ghost-hover`.
- **File.** Under the list, the chosen file as a [value-view](value-view.md) with its readings, taking the rest of the body's height and scrolling inside it. An interactive page runs in its frame, and a message it sends fills the composer.
- **Failure.** A line in `--bad` at 11/12.5 of the app size between the list and where the file would be.

## Every state keeps the head and changes what hangs under it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look: with nothing produced the strip is absent and the thread starts at the top of the column. | |
| closed | The head alone: chevron pointing down, `Produced` and the count. The count grows when a new turn produces a file, whether the strip is open or not. | [closed.html](../assets/produced-artifacts/closed.html) |
| open | The chevron turned a quarter to point left and the list under it, with nothing chosen. | [open.html](../assets/produced-artifacts/open.html) |
| loading | A row chosen and its file not yet read: the row is tinted and bold, and nothing stands under the list. Drawn second in the open mockup. Choosing another row keeps the previous file on screen until the new one arrives. | [open.html](../assets/produced-artifacts/open.html) |
| success | The chosen file drawn under the list in its first reading, such as rendered markdown, a running page or JSON. | [selected.html](../assets/produced-artifacts/selected.html) |
| error | The file could not be read: the reason in `--bad` under the list, and no file drawn. | [error.html](../assets/produced-artifacts/error.html) |

## The head folds the list and a row opens its file

| On | Does | Feedback |
| --- | --- | --- |
| Click the head | Opens or closes the list | The chevron turns a quarter; the list appears or goes |
| Click a row | Chooses that file and reads it | Row tinted and bold, then the file under the list |
| Click the chosen row | Puts the file away | The tint goes and the file with it |
| A reading, `…` or a running page's controls | As [value-view](value-view.md) describes | The file redraws, or the composer fills with the page's message |

## The copy is one word, a count and the files' own paths

| Where | String |
| --- | --- |
| Head | `Produced` · `{n}` |
| Row | `{path}`, with its full text as the tooltip |
| Interactive chip | `runs` |
| Size | `{n} B` · `{n} KB` · `{n.n} MB` |
| Failure | `{reason}` |

## The strip spans the column, stays above the thread, and bounds its own height

- Width: the whole column, wider than the 900px thread and composer below it. Paths end in an ellipsis; the chip and the size keep their width.
- Height: the open strip takes at most 45% of the window, the list at most 20%, and each scrolls inside itself, so the thread keeps the rest.
- Theme: rule, grounds, chip wash and the failure colour are tokens with a light and a dark value.
- Focus: the head and each row are native buttons in Tab order before the thread.
- Whether the strip is open and which file is chosen are not kept across a restart.

## The strip centres its head and sets paths in the app face

- The head's words sit centred in the column, where other disclosure heads align left.
- Paths are data set in the app face.
