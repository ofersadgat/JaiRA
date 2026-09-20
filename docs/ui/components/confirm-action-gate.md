---
id: ui/components/confirm-action-gate
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask]
serves: [product/decisions-stay-yours]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/gate-surface]
implemented_by: [packages/app/src/renderer/components.tsx]
verified_by: [packages/app/test/components.e2e.test.ts]
mockups: [ui/assets/confirm-action-gate/asking.html, ui/assets/confirm-action-gate/settled.html]
siblings: [ui/components/choose-option-gate, ui/components/fill-form-gate, ui/components/command-approval]
---

# Confirm action gate

A process's yes-or-no on one step: the prompt with a tick glyph, then two buttons whose words are the author's verbs, such as a plain `Merge` beside a ghost `Not yet`, and once answered the pressed one filled blue.

## A confirm action gate is for one step the person lets happen or holds back

**Use when.** A state of a process stops for a person to say yes or no to the next step, such as merging a plan or deleting a worktree, and the answer carries nothing but that yes or no.

**Do not use when.** There are more than two outcomes, or the choice needs a description or a comment: use [choose-option-gate](choose-option-gate.md). The person must read something first: use [review-artifact-gate](review-artifact-gate.md). An agent's command waits on policy: use [command-approval](command-approval.md).

## The prompt reads first, and the two verbs sit under it

- **Heading.** Drawn by [gate-surface](gate-surface.md) with the tick glyph; `Confirm this action` when the state gives no prompt.
- **Buttons.** A row 14px under the heading, 8px apart, each as wide as its words. The confirm verb first in the plain button look, on `--panel-2` with a 1px `--line` border. The cancel verb second as a ghost with a transparent ground. Neither is filled while the question is open.

## The answer is shown by which verb is filled

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a state that names no verbs gets `Confirm` and `Cancel`. | |
| loading | Cannot occur: a pressed button changes nothing until the run reports the answer, and the question stays answerable until then. | |
| asking | The two verbs, plain then ghost, with the author's words or the defaults. | [asking.html](../assets/confirm-action-gate/asking.html) |
| settled | The pressed verb filled blue with white words, whichever of the two it was, and the other left as it was drawn. Both stay at full colour, with no pointer and no hover. A question nobody answered fills neither, under `Never answered.` from [gate-surface](gate-surface.md). | [settled.html](../assets/confirm-action-gate/settled.html) |
| error | The configuration does not parse, or an answer is refused: drawn by [gate-surface](gate-surface.md) and the window's error notice. | |

## Either press answers at once

| On | Does | Feedback |
| --- | --- | --- |
| The confirm verb | Answers yes | The gate settles in place with that verb filled |
| The cancel verb | Answers no | The gate settles in place with that verb filled |
| Pointer over a verb | Nothing | The plain button's ground moves to `--panel-3`; the ghost takes `--fill-ghost-hover` |

## The copy is the author's two verbs

| Where | String |
| --- | --- |
| Heading | `{prompt}`, or `Confirm this action` |
| Confirm verb | `{confirm label}`, such as `Merge`, or `Confirm` |
| Cancel verb | `{cancel label}`, such as `Not yet`, or `Cancel` |

## The row keeps its verbs whole and wraps before it cuts one

- It sits at the left of its host at any width. A verb never wraps inside its button; where the host is narrower than both buttons, the cancel verb drops to a second line.
- Theme: every colour is a token, and the settled fill is `--fill-accent` in both themes.
- Focus: Tab reaches the confirm verb, then the cancel verb, and Enter or Space presses the focused one. A settled gate's buttons are skipped.
- Missing content: without labels the verbs are `Confirm` and `Cancel`, and without a prompt the heading is `Confirm this action`.
