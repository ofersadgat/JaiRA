---
id: ui/surfaces/error-notice
type: ui-surface
status: shipped
updated: 2026-09-13
kind: notification
realizes: [ux/patterns/refuse-with-the-reason-and-the-fix]
serves: [product/failures-explain-themselves, product/find-out-why-the-app-misbehaves]
components: []
mockups: [ui/assets/error-notice/empty.html, ui/assets/error-notice/action-failed.html, ui/assets/error-notice/interface-failed.html]
siblings: [ui/surfaces/app-window, ui/surfaces/crash-screen, ui/surfaces/inbox-strip, ui/surfaces/confirm-dialog]
---

# Error notice

A notice centred near the bottom of the [app window](app-window.md) that reports a failure away from the control that caused it: a filled red box carrying the message when an action fails, or a bordered bar with `Copy` and `Dismiss` when a part of the interface fails while the rest keeps working. It floats over the whole window, sidebar and dialogs included, and displaces nothing.

## An action's failure is a filled red box, and an interface failure is a quieter bar

- **Action failed.** A filled `--bad` box with white text at weight 600 in the app face, 8px by 14px of padding and 8px corners. It stands 52px above the bottom of the window, clear of the 40px inbox strip, centred on the whole window, and wraps within 70% of the window's width. The text is the failure's message exactly as reported, with nothing added; a refusal from the app's back end arrives prefixed `Error invoking remote method '{channel}': Error: `. It has no close glyph and no timer.
- **Interface failed.** A `--panel` bar with `--text`, a 1px border of `--bad` mixed into `--line`, 8px corners and a soft shadow. It stands 16px above the bottom of the window, at most 720px wide, so it covers the inbox strip when both show. One line reads `Something failed in the interface: {first line}` and ends in an ellipsis, with the whole error and where it was thrown on its tooltip. Two plain buttons follow, `Copy` and `Dismiss`.
- Both can show at once. The bar draws over everything in the window, the crash screen included, and the box draws over dialogs but under menus.

| Where | String |
| --- | --- |
| Action failed | `{message}` |
| Interface failed | `Something failed in the interface: {first line of the error}` |
| Interface failed tooltip | `{error with its frames}`, and for an uncaught error `{file}:{line}` after a blank line |
| Interface failed buttons | `Copy` · `Dismiss` |

## Each notice is absent until its kind of failure happens

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | Nothing has failed: no notice, and the window's foot shows the room and the inbox strip. | [empty.html](../assets/error-notice/empty.html) |
| loading | Cannot occur: a notice appears only once a failure is known. | |
| action-failed | An action such as starting a task, saving a file or opening a project was refused or failed: the red box with its message. A command approval or module approval dialog that is open shows the same message inside itself at the same time. | [action-failed.html](../assets/error-notice/action-failed.html) |
| interface-failed | A failure inside the interface that nothing handled, while the window still draws: the bar. A later failure replaces its text; only the latest is kept. The browser's report of a resize loop is not a failure and never shows. | [interface-failed.html](../assets/error-notice/interface-failed.html) |
| success | Cannot occur: a notice reports only failure, and a success draws nothing. | |

## A notice arrives on its own and leaves on a click or the next action

- The red box appears when any action in the app fails. A click anywhere on it dismisses it, and it also goes as soon as the next action begins.
- The bar appears when the interface fails outside drawing. `Dismiss` removes it. `Copy` puts the whole error on the clipboard and shows nothing to say it did.
- Every interface failure is also written to the app's log, so it outlives the window.
- Neither notice leads anywhere; the person acts on the reason in the room they were in.

## Neither notice moves with the layout, and neither can be reached by keyboard alone

- **Resize.** The box wraps its message within 70% of the window's width. The bar stays one line and cuts its text.
- **Theme.** The box's ground follows `--bad` in both themes and its text stays white. The bar's ground, text and border are tokens.
- **Focus.** Neither takes focus when it appears. The box takes no focus and no keys, so dismissing it needs a pointer or the next action, and it is not announced. The bar is announced as an alert, and its two buttons take focus.
- **Unsaved work.** None; a notice changes nothing.

## The notices depart from the visual direction in two places

- The box's text is a literal white, not `--on-accent`, and takes no register.
- The bar's shadow is its own, not `--lift`.
