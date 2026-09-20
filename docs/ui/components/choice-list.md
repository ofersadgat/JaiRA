---
id: ui/components/choice-list
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/ask-one-or-several-questions, ux/patterns/own-answer-beside-offered-options]
serves: [product/decide-with-the-context-in-front-of-you, product/decisions-stay-yours, product/agents-ask-instead-of-guessing]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/choices.tsx]
verified_by: [packages/app/test/choices.test.ts]
mockups: [ui/assets/choice-list/words.html, ui/assets/choice-list/cards.html, ui/assets/choice-list/multiple.html, ui/assets/choice-list/own-answer.html, ui/assets/choice-list/read-only.html]
siblings: [ui/components/question-stepper, ui/components/confirm-action-gate, ui/components/fill-form-gate, ui/components/schema-form]
---

# Choice list

One question's answers: a wrapping row of word buttons with the first one filled blue, or, when any option explains itself, full-width cards with a grey line under each label, optionally closed by a card to type your own answer in or followed by a `Comments (optional)` box.

## A choice list is the one control for picking among offered answers

**Use when.** A person picks one or several of a question's offered answers: a process's decision, a review's verdict row, a running agent's question, and the settled record of any of them.

**Do not use when.** Several questions are asked together: [question-stepper](question-stepper.md) shows them one at a time, each through this list. Two fixed verbs decide an action: use [confirm-action-gate](confirm-action-gate.md). The answer is typed values: use [fill-form-gate](fill-form-gate.md) or [schema-form](schema-form.md).

## The options read first, and what explains them sits inside each option

- **Question line.** Only when several questions are asked or the question has a short header: a pill `.chip` holding the header, then the question in `--text`. A lone question's text is the host's heading and is not repeated.
- **Description.** When the question has one, a line at 12/12.5 of the app size in `--dim`, line height 1.5, at most 80 characters wide.
- **Options.** 12px under what is above, 8px apart. With no description on any option, a wrapping row of word-sized buttons. With a description on any, a stack of full-width cards. Each option is `--bg` with a 1px `--line` border, radius 8px and `8px 12px` padding. Its label is in `--text` in the app face, after a 13px authored glyph when the author named one, with the description under it in `--dim`.
- **Affirmative.** In a row of words, the first option that is not dangerous is filled with `--fill-accent`, its label white at 600.
- **Danger.** A dangerous option's label is `--bad` and its border is `--bad` mixed into `--line`.
- **Own answer.** A full-width card after the options, labelled `Your own answer`, or `Other` on an agent's question, holding a borderless box one line tall that grows with the words, in the option's own face.
- **Comments.** A `Comments (optional)` label in `--dim` over a three-row box, under the options. A review draws it above them.

## Every state keeps the offered options in view and lights the chosen one

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a list with nothing in it: a question always offers an option. A review with feedback written draws the list with its options taken away, leaving only the comment box, as [review-artifact-gate](review-artifact-gate.md) shows. | |
| loading | Cannot occur: the options arrive with the question. | |
| words | The bare row, first option filled, a dangerous option outlined in `--bad`. With comments the box sits under the row. | [words.html](../assets/choice-list/words.html) |
| cards | The stacked cards with their descriptions and glyphs. A picked card takes an `--accent` border and a 1px inset `--accent` ring. A question in a set that names a default opens with that option picked. | [cards.html](../assets/choice-list/cards.html) |
| multiple | Each card has a 16px box at its right edge, centred on the whole card; a picked box fills with `--fill-accent` and shows a white tick. Any number stay lit. | [multiple.html](../assets/choice-list/multiple.html) |
| own answer | The own-answer card lit with the ring once chosen or typed in, the words growing the box. Picking an option afterwards moves the ring to it and keeps the words. Unchosen and empty, it shows `Type your own answer…`. | [own-answer.html](../assets/choice-list/own-answer.html) |
| read-only | A settled question: the chosen options and own answer lit, nothing pressable, no placeholders, full colour kept. An affirmative option that was not chosen loses its fill. Under an agent's question in a transcript the list sits 6px under the line above it instead of 14px. | [read-only.html](../assets/choice-list/read-only.html) |

## A lone single pick answers on the click, and anything more waits for the host's confirm

| On | Does | Feedback |
| --- | --- | --- |
| Click an option, on one single-choice question with no confirm asked for and no own words typed | Answers the question at once | The host settles |
| Click an option otherwise | Picks it, or toggles it on a multiple question | The ring moves or a box fills; the host's confirm enables |
| Click the own-answer card, or Tab into its box | Chooses the own answer | The ring moves to the card and the caret lands in the box |
| Type in the own-answer box | Chooses it and holds the question for a confirm, even after an option is picked again | The host shows its confirm |
| Type in the comment box | Keeps the words alongside the pick | None; a click still answers at once |
| Pointer over an option | Nothing | Border turns `--accent`; the filled option deepens to `--fill-accent-hover` |

## The copy is the author's options, and the list's own words are four

| Where | String |
| --- | --- |
| Option label | `{label}`, or `{value}` when the option has no label, such as `request_changes` |
| Option description and tooltip | `{description}`, such as `back to the model with your note` |
| Question line | `{header}` in a pill, then `{question}` |
| Own answer, process | `Your own answer` |
| Own answer, agent | `Other` |
| Own answer placeholder | `Type your own answer…` |
| Comment label | `Comments (optional)` |

## The list takes its host's width and grows with its words

- It has no width of its own. A row of words wraps onto more lines at the 360px context panel; cards always span the host.
- Long labels and descriptions wrap inside their card; nothing is cut. The own-answer box grows a line at a time and never scrolls.
- Theme: every fill, border and ring is a token, so both themes keep the affirmative fill and the danger outline.
- Focus: each option is a button in the tab order, then the own-answer box, then the comment box. In read-only every option and box is skipped by Tab.
- Missing content: an option with no label shows its value, and an option with no description draws its label alone and has no tooltip.

## Option labels depart from the two voices

- An option's label is often a value the author wrote, such as `request_changes`, and is set in the app face rather than the data face.
- The picked option is marked by `.selected`, a second state class beside `.is-active`, and it draws a ring rather than touching weight or ground.
