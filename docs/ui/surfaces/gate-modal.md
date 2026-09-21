---
id: ui/surfaces/gate-modal
type: ui-surface
status: shipped
updated: 2026-09-13
kind: dialog
realizes: [ux/patterns/park-and-ask, ux/patterns/consent-to-exactly-what-was-shown]
serves: [product/risky-actions-wait-for-approval, product/decisions-stay-yours, product/try-a-process-without-spending]
components: [ui/components/command-approval, ui/components/gate-surface, ui/components/choose-option-gate, ui/components/review-artifact-gate, ui/components/edit-artifact-gate, ui/components/fill-form-gate, ui/components/confirm-action-gate, ui/components/changeset-review]
mockups: [ui/assets/gate-modal/approval.html, ui/assets/gate-modal/gate.html, ui/assets/gate-modal/wide.html]
siblings: [ui/surfaces/module-approval-dialog, ui/surfaces/confirm-dialog, ui/surfaces/components-view, ui/surfaces/inbox-strip, ui/surfaces/error-notice, ui/surfaces/app-window]
---

# Gate modal

A card centred over a `--scrim` that covers the whole [app window](app-window.md), holding a request for a person that has no conversation to sit in. In the window it holds only a [command approval](../components/command-approval.md) that names no task, over whichever room is open. On the [Components view](components-view.md) the same card holds a process's question, drawn in place on the page. Every other request renders inline in its task's conversation, and the [inbox strip](inbox-strip.md) leads there.

## The hosted request is the whole card, heading first

- **Scrim.** `--scrim` over the whole window, sidebar included. It sits above every room and under the [error notice](error-notice.md), and takes every click aimed at the room behind it.
- **Card.** `--panel` with a 1px `--line` border, 12px corners, 18px of padding and the `--lift` shadow. At least 380px wide and at most 720px or 90% of the window, sized to its content between.
- **Wide card.** For reviewing one artifact, editing one or reviewing a set of changes: 1100px or 94% of the window, whichever is less, and at most 90% of the window tall. The set-of-changes reviewer scrolls inside the card.
- **Content.** The hosted component, whole. Its heading is the card's heading: `Approve this command?` after a shield glyph, or a gate's prompt after the glyph for its kind, in `--text` at 17/12.5 of the app size. The card adds no title, close button or footer of its own.

## The card has one look in the window and two on the Components view

| State | Surface shows | Mockup |
| --- | --- | --- |
| approval | A command approval with no task, over the scrim: the tool, the command in its mono box, the policy's reason, the three allows and `Deny`. A failed answer adds its reason in `--bad` under `Deny`; both variants are drawn. | [approval.html](../assets/gate-modal/approval.html) |
| gate | A process's question on the Components view, in the standard card drawn in place in the card's stage, with no scrim, no shadow and no minimum width: the prompt with its glyph over the control. | [gate.html](../assets/gate-modal/gate.html) |
| wide | Reviewing one artifact, editing one or reviewing a set of changes on the Components view: the wide card filling its stage, its well or reviewer inside. | [wide.html](../assets/gate-modal/wide.html) |
| agent question | Cannot occur: an agent's question always renders in its task's conversation. | |
| empty | Cannot occur: the card is raised only with a request in it. | |
| loading | Cannot occur: the request arrives whole, and a pressed answer changes nothing in the card until the request is dropped. | |
| success | Cannot occur in the card: an answered request leaves, and the card and scrim leave with it. | |

Only one card shows at a time. A [module approval dialog](module-approval-dialog.md) raised at the same moment is shown first and the command approval waits behind it. Two command approvals with no task show one at a time, and the next appears when the first is answered.

## A command approval arrives by itself and leaves only when it is answered

- The card appears over any room, Settings included, the moment an agent's call with no task is held by policy. The inbox strip lists it too, and choosing that entry does nothing, because the card is already on screen.
- `Allow` or `Deny`, or a reach chosen from the arrow beside either, answers it. The card and scrim go and the room behind is exactly as it was.
- Escape does not close it, a click on the scrim does nothing, and there is no close button. Closing the project it belongs to denies the command and removes the card.
- On the Components view the card is part of a variant's stage. Answering records the result under the card, which stays.

## The card stays centred, takes no focus, and holds nothing typed

- **Resize.** The card stays centred at every window size. The standard card keeps its 380px minimum, so a window narrower than that cuts it. The command box inside scrolls past 320px, which keeps an approval shorter than a small window. The wide card follows the window at 94%.
- **Theme.** Scrim, card, border, shadow and the hosted component are tokens with a light and a dark value.
- **Focus.** Focus is not moved into the card and is not held there, so Tab still reaches the room behind it while the pointer cannot. The card is not announced as a dialog.
- **Unsaved work.** A command approval holds no typing. A process's question on the Components view keeps its typing for as long as that view does.

## The card's heading takes a size outside the registers

- The hosted heading is set at 17/12.5 of the app base with no register.
