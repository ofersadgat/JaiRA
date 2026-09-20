---
id: ui/surfaces/components-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/preview-beside-the-setting, ux/patterns/one-document-several-readings, ux/patterns/schema-driven-form, ux/patterns/problems-marked-where-they-are]
serves: [product/try-a-process-without-spending, product/author-processes-without-memorising-the-format]
components: [ui/components/gate-surface, ui/components/choose-option-gate, ui/components/review-artifact-gate, ui/components/edit-artifact-gate, ui/components/fill-form-gate, ui/components/confirm-action-gate, ui/components/changeset-review, ui/components/command-approval, ui/components/agent-question, ui/components/schema-form, ui/components/schema-json-editor]
mockups: [ui/assets/components-view/gallery.html, ui/assets/components-view/answered.html, ui/assets/components-view/broken.html, ui/assets/components-view/narrow.html]
siblings: [ui/surfaces/app-window, ui/surfaces/sidebar, ui/surfaces/debug-view, ui/surfaces/logs-view, ui/surfaces/settings-view, ui/surfaces/gate-modal]
---

# Components view

The Components room: one scrolling page that draws every question a run can put in front of a person, one row per kind of question with a carousel of its variants, each shown as the working control beside the configuration that produces it. It fills the window right of the [sidebar](sidebar.md), whose settings sheet stays over the sidebar column while it shows, and takes the place of every other room. It has no context panel, reads and writes no files, and the title bar above it holds only the empty filler.

## The page heading reads first, then a bar that moves every row, then the rows

The page is on `--bg` with 12px by 14px padding and 18px between its heading and the gallery.

- **Heading.** `Components` bold at 15/12.5 of the app base, over a `--dim` paragraph at most 80 characters wide saying what the page holds, with `operation.function` in the data face.
- **Variant bar.** Sticky at the top of the page on `--bg`, 8px above and below, with a `--line` rule under it, wrapping: `Every row to` in `--dim`, then one hairline pill per variant name in the data face with the number of rows that have it in `--dim`. Pointing at a pill gives it `--panel-2` and `--text`.
- **Row head.** A `--line` rule, 8px, then the heading: the row's title, a hairline pill with its kind, and the component's name in the data face, spread across the row's width, all uppercase at 14/12.5 of the app base in `--dim` with wide tracking. Under it a `--dim` blurb at most 80 characters wide. Then the variant tabs and, at the far right, a ghost `‹`, `{n}/{m}` in the data face and a ghost `›`, with no arrows on a row of one variant.
- **Variant tabs.** A run of joined buttons at 11/12.5 of the app base with 5px outer corners, wrapping before the arrows move. The chosen one is filled `--fill-accent` with `--on-accent` at weight 600; the others are ghost. Each tab's tooltip is its variant's note.
- **Card.** One per variant, the width of the row, sliding sideways under the tabs with no scrollbar. On `--panel` with a 1px `--line` edge, the card radius and 12px padding: the variant's title bold at the app base, its note in `--dim`, then two columns 10px apart. The left is the stage: a dashed `--line` box on `--bg` with 8px corners holding the control. The right is at least 280px and 34% of the card, the height of the stage and never under 320px, holding the configuration on `--panel-2` with a 1px `--line` edge and 8px corners, scrolling inside itself.
- **Stage.** A workflow's question is drawn as the card it is everywhere else, on `--panel` with 12px corners, and wide for reviews and edits. A command approval and an agent's question are drawn inline under a 2px `--accent` rule.
- **Configuration.** A head that stays put while it scrolls: `Form` and `JSON` as joined tabs, a `--dim` caption ending in an ellipsis, and `reset` in `--accent`. Under it the document as a [schema-form](../components/schema-form.md), or as a [schema-json-editor](../components/schema-json-editor.md) whose schema is shown as a pill and cannot be changed.
- **Result.** After the control is answered, under the two columns: `what it submitted` in `--dim`, a pill `contract ok` in `--ok` or `rejected` in `--bad` for a workflow's question, the answer as JSON in a box on `--bg` at most 220px tall, and the contract's complaint in `--bad` under a rejected one.

| Row | Kind | Variants |
| --- | --- | --- |
| `Choose an option` | `interaction` · `choose_option` | `One tap` · `With a comment` · `With an answer of your own` · `Several at once` · `Held until confirmed` · `Several questions, one at a time` · `With follow-up questions` |
| `Review an artifact` | `interaction` · `review_artifact` | `Read and decide` · `With a review-level comment` · `Editable` |
| `Edit an artifact` | `interaction` · `edit_artifact` | `Seeded from an input` · `From nothing` |
| `Fill in a form` | `interaction` · `fill_form` | `Every type once` · `Pre-answered, all optional` · `An enum with a way out` |
| `Confirm an action` | `interaction` · `confirm_action` | `Buttons that say what they do` · `Defaults` |
| `Review a set of artifacts` | `interaction` · `review_artifacts` | `A proposal in a worktree` · `With a review-level decision` · `A sync against the base` |
| `A gate JaiRA does not know` | `interaction` · `unknown_function` | `The JSON box` |
| `Approve a command` | `approval` | `A command line` · `Structured input` |
| `Answer an agent's question` | `question` | `One question` · `Several, in steps` · `Pick several` |

The variant bar lists `basic 9`, `comments 2`, `custom 2`, `multiple 2`, `steps 2`, `follow_up 1`, `confirm 1`, `defaults 2`, `editable 1`, `routed 1`, `base 1`, `input 1` and `empty 1`, in that order.

| Where | String |
| --- | --- |
| Heading | `Components` |
| Variant bar | `Every row to` · `{variant} {rows}` · tooltip `slide the one row that has a "{variant}" variant to it` or `slide the {n} rows that have a "{variant}" variant to it` |
| Arrows | `‹` · `{n}/{m}` · `›`; named `Previous variant` and `Next variant` |
| Configuration head | `Form` · `JSON` · `the state's authored args` for a workflow's question · `the request the dialog was raised with` for an approval or an agent's question · `reset`; `Form` tooltip `edit it as a form` |
| Result | `what it submitted` · `contract ok` · `rejected` |
| Broken document | `Not JSON yet: {parse error}` on the stage · `This is not JSON yet: {parse error}. Fix it in the JSON view — the form edits a parsed document.` in the form · `the document must be a JSON object` |
| Empty question | `A question request needs at least one question.` |

## Every card shows the working control, its answer, or why it cannot be drawn

| State | Surface shows | Mockup |
| --- | --- | --- |
| gallery | The heading, the variant bar and every row on its first variant, each card drawn from its built-in example with the configuration in `Form`. | [gallery.html](../assets/components-view/gallery.html) |
| empty | Cannot occur: every row and variant is built in. | |
| loading | Cannot occur as its own look: every card is drawn at once. A configuration in `JSON` shows `checking…` in its status pill until its first check answers. | |
| answered | The result block under the card. A workflow's question adds `contract ok` or `rejected` with the complaint; an approval shows `{decision, scope}` and an agent's question `{answers}`, or `{dismissed: true}` for `Let the agent decide`, with no pill. | [answered.html](../assets/components-view/answered.html) |
| error | The document is broken where it is edited and the stage says so. A document that is not JSON puts `Not JSON yet: {error}` in `--bad` on the stage, and the form reads `This is not JSON yet…`. A document the component refuses draws the question's heading over `This state's {component} config is invalid: {reason}`, as a run would. An agent's question with no questions reads `A question request needs at least one question.`. The JSON view marks problems with a `{n} problem` or `{n} problems` pill and a `--bad` line per problem. | [broken.html](../assets/components-view/broken.html) |
| narrow | A card 720px wide or less puts the configuration under the stage, at most 420px tall. | [narrow.html](../assets/components-view/narrow.html) |

## A person arrives from the settings sheet and nothing here leads anywhere else

- `▤ Components` at the foot of the sidebar's settings sheet opens the room with every row on its first variant. Components is lit in the sheet.
- A pill in the variant bar slides every row that has that variant to it, smoothly; a row without it stays where it is.
- A tab, `‹` or `›` slides that row. Swiping or shift-scrolling the row snaps to the nearest card, and the tab and the count follow.
- Editing the form or the text rewrites the one document behind the card, and the stage redraws from it at once. `Form` and `JSON` switch between two readings of that same document.
- Answering the control records what it returned in the result block and changes nothing else. `reset` restores the example and clears the result.
- A section, `Logs` or `Debug` in the settings sheet leaves for that room, and `‹` leaves for the room shown before Settings.

## Cards keep their edits while the room is open and lose them when it closes

- **Resize.** Rows take the page's width and each card fills its row. The two columns stack once a card is 720px wide or less. The variant bar and the tabs wrap; a wide control scrolls sideways inside its stage.
- **Theme.** Grounds, rules, pills, tabs and the controls on the stage are tokens with a light and a dark value.
- **Focus.** Entering moves focus nowhere. Tab reaches the variant pills, then each row's tabs, arrows, the control on its stage and its configuration, in page order, including the cards slid out of view.
- **Long or missing content.** The configuration caption ends in an ellipsis. A long document scrolls inside the configuration beside the stage instead of stretching the card.
- **Unsaved work.** Edits and answers survive sliding between cards and are discarded, without a word, when the room is left.

## The page departs from the visual direction in three places

- The row heading uppercases the component's name, which is data, and spreads the title, kind and name across the row.
- Blurbs and notes show names between literal backquote marks, in the app face.
- The card is a filled box with a hairline edge and a radius.
