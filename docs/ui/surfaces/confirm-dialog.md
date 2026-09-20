---
id: ui/surfaces/confirm-dialog
type: ui-surface
status: shipped
updated: 2026-09-13
kind: dialog
realizes: [ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/button-says-what-will-happen, ux/patterns/arm-the-cut-then-confirm]
serves: [product/hand-work-to-agents, product/parallel-work-without-collisions, product/chat-with-agents, product/author-processes-without-memorising-the-format, product/rewind-to-where-it-went-wrong, product/all-projects-in-one-place]
components: []
mockups: [ui/assets/confirm-dialog/confirm.html, ui/assets/confirm-dialog/name.html]
siblings: [ui/surfaces/app-window, ui/surfaces/gate-modal, ui/surfaces/module-approval-dialog, ui/surfaces/error-notice]
---

# Confirm dialog

A card centred over a `--scrim` that covers the whole [app window](app-window.md), asking the person to confirm one act before it happens and, when the act needs a new name or path, asking for it in one field. It floats over whichever room is open and blocks it until it is answered or cancelled.

## The question reads first, then what the act costs, then the verb that does it

- **Card.** `--panel` with a 1px `--line` border, 12px corners, 18px of padding and the `--lift` shadow; at least 380px wide and at most 720px or 90% of the window.
- **Title.** The question in `--text` at 17/12.5 of the app base, sentence case, line height 1.35. A task or conversation title in it is in double quotes, a state id, file or folder name in single quotes.
- **Note.** When the act has something to say: a washed box at 11/12.5 of the app base. Its ground is `--tint-bad` with `--bad` text when the act destroys, and `--tint-accent` with `--dim` text otherwise. Long paths break anywhere.
- **Field.** When a name is needed: 12px below, an uppercase `--dim` label over a full-width input prefilled with the current value, with spelling checks off.
- **Actions.** 14px below, 8px apart: the confirm button, named with the act's verb, then a ghost `Cancel`. The confirm is a danger button, red text on a red-tinted border, when the act destroys, and the primary filled button otherwise.

## The dialog has two looks, a plain confirmation and one that asks for a name

| State | Surface shows | Mockup |
| --- | --- | --- |
| confirm | Title, note and buttons, with the confirm button holding focus. A destroying act has the red note and the danger button; setting a folder up as a project has the accent note and the primary button. The second ask after a refused rename or delete looks the same, naming the states that depend on the target. | [confirm.html](../assets/confirm-dialog/confirm.html) |
| name | Title, an optional note, the field holding focus and prefilled, and the buttons. While the field is empty or only spaces, the confirm button is at half opacity and cannot be pressed. | [name.html](../assets/confirm-dialog/name.html) |
| empty | Cannot occur: every dialog has a title and a confirm button. | |
| loading | Cannot occur: the dialog closes when it is confirmed, and nothing shows the act under way. | |
| error | Cannot occur in the dialog: a failure after confirming is reported by the [error notice](error-notice.md). | |
| success | Cannot occur in the dialog: once confirmed it is gone, and the change shows where the item was. | |

| Asked from | Title | Field and initial value | Note | Confirm |
| --- | --- | --- | --- | --- |
| A task's `Delete…` | `Delete "{title}"?` | | `This deletes the task, every run it made, and its worktree — uncommitted work included. None of it comes back.` | `Delete`, destroying |
| Deleting several tasks | `Delete {n} tasks?`, `task` for one | | `This deletes each task, every run it made, and its worktree — uncommitted work included. None of it comes back.` | `Delete`, destroying |
| A conversation's `Delete…` | `Delete "{title}"?` | | `This deletes the conversation and everything said in it. None of it comes back.` | `Delete`, destroying |
| Opening a folder that is not a project | `Set up JaiRA in {folder name}?` | | `{folder} is not a JaiRA project yet. Setting it up creates a .jaira/ folder there for its workflows, settings and run history. Nothing else in the folder is touched.` | `Set up project` |
| A state's `Duplicate…` | `Duplicate '{state id}'` | `New state id`, `{state id}-copy` | | `Duplicate` |
| A state's `Rename…` | `Rename '{state id}'` | `New state id`, `{state id}` | `A state's id is its path, and every state that names it as a child names this id.` | `Rename` |
| A state's `Delete` | `Delete '{state id}'?` | | `{absolute path}` | `Delete`, destroying |
| A file's or folder's `Rename…` | `Rename '{name}'` | `Path`, `{path}` | `Relative to ~/.jaira/` or `Relative to .jaira/` | `Rename` |
| A file's or folder's `Delete` | `Delete this file?` or `Delete this folder?` | | `{absolute path}`, and for a folder `{absolute path} — and everything inside it.` | `Delete`, destroying |
| A refused state duplicate, rename or copy | `{verb} '{state id}' anyway?` | | `{states} declares it as a child. They will name a state that no longer exists.`, `declare` for several | `{verb} anyway`, destroying |
| A refused state delete | `Delete '{state id}' anyway?` | | `{states} declares it as a child, and will fail to load without it.` | `Delete anyway`, destroying |
| A refused file or folder rename or delete | `{verb} '{path}' anyway?` | | `{states} declares it as a child.` or `… declares {n} states inside it as a child.`, then `They will name a state that no longer exists.` or `They will fail to load without it.` | `{verb} anyway`, destroying |
| Rewinding a run | `Rewind to before {state name}?` | | `It and every state entered after it are deleted, and the run enters it again. Files edited in the worktree stay as they are. This cannot be undone.` | `Rewind`, destroying |

A task quoted in a delete title is named by its stored title, which can differ from the computed name its card shows.

## The dialog opens from a verb and closes on its answer, and Escape does not close it

- It opens from a [context-menu](../components/context-menu.md) item on a task, a column, a conversation, a state, a file or a folder, from a run's rewind, and when `Open project…` picks a folder that is not a project.
- Enter or the confirm button performs the act with the field's value trimmed, and the dialog closes.
- `Cancel`, or a press on the scrim outside the card, closes it and changes nothing. Escape does nothing.
- A rename, duplicate, copy or delete that other states depend on is refused, and a second destroying dialog names those states and offers `{verb} anyway`.

## The card keeps a minimum width, holds focus on its answer, and loses a typed name on cancel

- **Resize.** The card keeps its 380px minimum, so in a window narrower than that part of it falls outside. Titles and notes wrap within it.
- **Theme.** Scrim, card, note washes and buttons are tokens with a light and a dark value.
- **Focus.** On opening, focus goes to the field, or to the confirm button when there is no field, even when that button destroys, so a single Enter commits. Focus is not held inside the card, and the dialog is not announced as one.
- **Unsaved work.** A name typed into the field is lost on cancel.

## The dialog's title takes a size outside the registers

- The title is set at 17/12.5 of the app base with no register.
