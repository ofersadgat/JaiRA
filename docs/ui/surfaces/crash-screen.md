---
id: ui/surfaces/crash-screen
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: []
serves: [product/find-out-why-the-app-misbehaves, product/failures-explain-themselves]
components: []
mockups: [ui/assets/crash-screen/crashed.html]
siblings: [ui/surfaces/app-window, ui/surfaces/error-notice]
---

# Crash screen

One card centred on `--bg` that replaces the whole [app window](app-window.md), sidebar included, when drawing the interface throws: a heading saying the window stopped drawing, a sentence saying the work is safe, the error's stack, and a button to reload. It is drawn in the app's own palette and displaces everything until the window reloads.

## The heading says the window broke, and the sentence under it says the work did not

- **Ground.** `--bg` over the whole window with 32px of padding, the card centred both ways. A window too short for the card scrolls.
- **Card.** Up to 860px wide on `--panel`, with a 1px `--line` border, 10px corners, 24px of padding and 12px between its parts.
- **Heading.** `The interface stopped drawing.` in bold at 1.25 times the root size.
- **Sentence.** In `.sub`: `Nothing that was running has been lost — this is the window, not the work. Reloading rebuilds the view from what is already recorded.`
- **Stack.** Mono at 12px on `--panel-2` with a `--line` border and 8px corners, wrapping long lines, at most 46% of the window's height and scrolling inside. It holds the error with its frames, then after a blank line the chain of interface parts that were drawing when it threw.
- **Actions.** `Reload the window` as the primary button, then `Copy the error` as a plain one.

## The screen has one state, and only its stack grows

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the screen exists only once drawing has thrown. | |
| loading | Cannot occur: the screen draws in the same moment the throw is caught. | |
| crashed | The card with the error's stack. For its first moment the stack holds the error alone; the chain of interface parts is added under it as soon as it is known. | [crashed.html](../assets/crash-screen/crashed.html) |
| success | Cannot occur: the only way out is a reload, which draws the app instead. | |

## A throw while drawing brings the screen, and a reload is the only way out

- It arrives when any part of the interface throws while drawing. Runs and agents keep going behind it, because they do not live in the window.
- `Reload the window` reloads the page, and the app draws again from what is recorded, with the window's arrangement restored.
- `Copy the error` puts the stack's text on the clipboard and shows nothing to say it did.
- There is no retry, no dismiss and no way to the sidebar. The error is also written to the app's log.
- A later failure outside drawing can still put the interface failure bar of the [error notice](error-notice.md) over this screen.

## The card narrows with the window, and a reload discards unsaved edits

- **Resize.** The card takes the window's width less its padding up to 860px, the stack wraps, and a short window scrolls.
- **Theme.** Every ground, border and text colour is a token.
- **Focus.** Nothing takes focus when it appears. Tab reaches `Reload the window`, then `Copy the error`.
- **Unsaved work.** Reloading discards edits not saved to disk, without a prompt.

## The screen sets two sizes outside the registers

- The heading and the stack take literal sizes, 1.25 times the root size and 12px, with no register.
