---
id: ux/patterns/own-answer-beside-offered-options
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/decide-with-the-context-in-front-of-you, product/agents-ask-instead-of-guessing]
siblings: [ux/patterns/ask-one-or-several-questions, ux/patterns/pick-from-what-exists, ux/patterns/schema-driven-form]
---

# Own answer beside offered options

Beside the offered answers there is room for the person's own words wherever the question allows it. An agent's question always allows it, and a decision a process declares allows it when the process says so. Writing there makes the words the answer. Picking an offered answer instead makes the pick the answer and keeps the words, and choosing the space again brings them back. An own answer always needs an explicit confirm, and words that are only blank count as no answer. In a form field with a fixed set of values that allows own answers, the values are offered as suggestions while the person types and do not restrict what is typed.

## Use it when the offered answers are a best guess that may not fit

**Use when.** The asker offers likely answers but cannot know every answer the person might mean, as with an agent that is unsure.

**Do not use when.** The work is only correct with one of a closed set: the process leaves own answers off, and the person picks as in [ask-one-or-several-questions](ask-one-or-several-questions.md). The value must name something that exists: use [pick-from-what-exists](pick-from-what-exists.md).

## Writing chooses the words, picking keeps them aside, and a confirm sends the chosen one

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Writes in the own-answer space, or moves into it | Makes the space the chosen answer and holds the question for a confirm | That their words will be the answer |
| 2 | Picks an offered answer instead | Makes the pick the answer, keeps the words, and still holds the question for a confirm while any words remain | That their words are there to switch back to |
| 3 | Confirms | Sends the chosen answer, and refuses to treat blank words as one | That the answer was sent |

## Every state treats blank words as no answer and any other words as a valid one

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: the space exists only within a question | Answer |
| empty | The space chosen with no words, or only blanks, counts as unanswered and cannot be confirmed. A pick from there still answers a lone single-choice question at once | Write, or pick |
| loading | Cannot occur: choosing and writing happen as the person acts | Keep writing |
| partial | Words written but not confirmed, whether or not the space is the chosen answer | Confirm, pick instead, or clear the words |
| error | Cannot occur for the words themselves: any words that are not blank are accepted | Confirm |
| denied | A question the process closes to own answers offers no space | Pick an offered answer |
| success | The record shows the words as the answer given, beside the options that were offered | Read the record |

## Words can be changed or set aside until the confirm, and leaving first loses them

Before confirming, the words can be edited, cleared, or set aside by picking an offered answer. After confirming, the answer is final, as in [park-and-ask](park-and-ask.md).

Leaving the question before confirming discards the words, and the question stays waiting.

## The space is chosen by focusing its box, and is announced outside any group

**Keyboard only.** The space is reached through its text box by Tab, and moving the focus into the box chooses the space. The space cannot be chosen without entering its box.

**Screen reader.** The space is announced as a radio option that belongs to no group, while offered single-choice answers beside it are plain buttons, so the choice among them is not conveyed as one set.

**Small window.** The box grows with the words, so a long answer stays fully visible.

**Slow machine.** Nothing waits: choosing and writing stay local until the confirm.
