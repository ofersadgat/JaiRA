---
id: ui/surfaces/module-approval-dialog
type: ui-surface
status: shipped
updated: 2026-09-13
kind: dialog
realizes: [ux/patterns/consent-to-exactly-what-was-shown, ux/patterns/refuse-with-the-reason-and-the-fix]
serves: [product/only-approved-code-runs, product/hand-work-to-agents, product/try-one-step-on-its-own]
components: [ui/components/icon]
mockups: [ui/assets/module-approval-dialog/asking.html, ui/assets/module-approval-dialog/overflow.html]
siblings: [ui/surfaces/gate-modal, ui/surfaces/confirm-dialog, ui/surfaces/error-notice, ui/surfaces/app-window]
---

# Module approval dialog

A wide card centred over a `--scrim` that covers the whole [app window](app-window.md), raised when work is started on a process that calls TypeScript or JavaScript files never approved on this machine or changed since they were. It shows every such file's full source and asks whether they may run. Nothing has started while it is open, and it comes before any other card: a [gate modal](gate-modal.md) raised at the same moment waits behind it.

## The question reads first, then what is at stake, then each file whole

- **Card.** The wide card: `--panel` with a 1px `--line` border, 12px corners, 18px of padding and the `--lift` shadow, 1100px or 94% of the window, whichever is less, and at most 90% of the window tall.
- **Heading.** A 16px shield glyph in `--dim`, then `Run this workflow's TypeScript?` in `--text` at 17/12.5 of the app size.
- **Summary.** Under the heading in `--dim` at 11/12.5 of the app size: how many files, how many changed since they were approved, and that nothing has run yet.
- **Each file.** A `--dim` line naming the file in the app face, whether it was never approved or changed since, and which of its functions the process calls. Under it the whole source on `--bg` in a 1px `--line` box with 8px corners and 10px padding, in the data face at 12/12, wrapped, scrolling inside itself past 320px.
- **Answers.** 14px under the last file, 8px apart: `Approve and run` in the plain button look, then `Cancel` outlined in `--bad`.
- **Failure line.** When something fails elsewhere while the card is open, the reason in `--bad` at 11/12.5 of the app size under the answers.

## The card asks once per start and shows every file at once

| State | Surface shows | Mockup |
| --- | --- | --- |
| asking | The heading, the summary and one block per file. A file never approved reads `never approved`; a file changed since its approval reads `changed since you approved it`, and the summary counts those. A file reached only as another file's import has no `calls` part. A failure elsewhere adds the red line under the answers; both variants are drawn. | [asking.html](../assets/module-approval-dialog/asking.html) |
| overflow | Two files whose sources fill their boxes are taller than an 800px window. The card stops at 90% of the window, the later files and the answers run out past its bottom edge onto the scrim and off the window, and `Approve and run` and `Cancel` cannot be reached, because the card has no scroll of its own. | [overflow.html](../assets/module-approval-dialog/overflow.html) |
| empty | Cannot occur: the card is raised only with at least one file. When the start fails for another reason, that reason goes to the [error notice](error-notice.md) and no card appears. | |
| loading | Cannot occur: `Approve and run` closes the card at once, and the work shows as started where it was started from. | |
| error | Cannot occur in the card after an answer: a start that fails after approving is reported by the error notice, and the approval stays recorded. | |
| success | Cannot occur in the card: approved files start the work and the card is gone. | |

## The card comes from starting work and leaves on either answer

- It appears when a task is started, a single step is run, a new conversation starts or the self-test runs, and that process calls a file needing approval. The start is held back entirely, so a second start after answering is a first start.
- `Approve and run` records each file as it reads at that moment, closes the card and starts the work with exactly the request that was held. A further file found only after approving raises the card again for that file.
- `Cancel` closes the card and starts nothing. The files stay unapproved and the next start asks again.
- Escape does not close it, a click on the scrim does nothing, and there is no close button.

## The source never shrinks, focus stays behind, and nothing is typed

- **Resize.** The card follows the window at 94% of its width and its lines rewrap. Each source box keeps its 320px limit whatever the window's height, so a short window cuts off the answers sooner.
- **Theme.** Scrim, card, source boxes and buttons are tokens with a light and a dark value.
- **Focus.** Focus is not moved into the card and is not held there, and the card is not announced as a dialog. Tab reaches `Approve and run` and `Cancel` only after the room behind.
- **Unsaved work.** None. Cancelling loses nothing, because nothing was started.

## The card departs from the visual direction in two places

- The heading is set at 17/12.5 of the app base with no register.
- A file path, which is data, is set in the app face on its file line.
