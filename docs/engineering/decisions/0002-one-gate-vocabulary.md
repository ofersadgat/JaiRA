---
id: engineering/decisions/0002-one-gate-vocabulary
type: decision
status: proposed
updated: 2026-08-24
decides_for: [engineering/units/interaction-hub, engineering/contracts/gate-components]
---

# 0002. One gate vocabulary, and a review's decisions come from gestures

## Context

The six components grew one at a time, each solving the case in front of it, and
the result is six answers to questions that turned out to be the same question.

1. **Two components render the same picture.** `choose_option` is an authored
   gate; `AskUserQuestion` is a running agent's tool call. The data source and
   the answer's destination differ — and nothing else does. On screen both are a
   prompt and a row of labelled choices, drawn by two unrelated pieces of code
   with two spellings of free text (`comments` vs. "Other"), and multi-select and
   option descriptions available on only one of them.
2. **The artifact viewer is a `<div>`.** `review_artifact` shows its artifact
   through `displayText` — no markdown, no image, no HTML, no diff, and no way
   to see the source behind a rendering. Meanwhile `ValueView` is exactly that
   component, already deciding which renderings apply through `viewsFor`, used
   everywhere else a model-produced value lands.
3. **Comments are one blob per review.** The component exists so a person can
   send work back with notes, and the only place to put them is a single
   textarea for the whole artifact. "The second paragraph is wrong" has to be
   written out as prose because there is no way to point.
4. **`edit_markdown` is a bare `<textarea>`.** The app has an editor stack —
   type-dispatched surfaces, a draft box that survives unmount, Save/Revert —
   and the gate reimplements none of it, so navigating away mid-edit discards
   the edit.
5. **The changeset gate is a different shape from all of them**, down to its
   name (`user-approve-changeset`, kebab among five `verb_noun`s), and it offers
   five decision buttons per change where the reviewer's actual gesture already
   says which one is meant.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Patch each component in place | Smallest diff; no renames, no workflow edits | Keeps six vocabularies and six renderings of four ideas. Every future affordance — an icon set, a comment anchor, a view toggle — gets built between two and six times, and drifts. |
| B. One vocabulary, decisions derived from gestures (**chosen**) | Four ideas, composed: a value viewer, a chooser over it, a choice control, an editor. Anchored comments and the view toggle are built once and appear everywhere. The decision surface shrinks to an X and a comment box. | Renames four registered function names, which are wire contracts. Derivation is a real semantic claim — "untouched means approved" — and it is wrong if a person can submit without looking. |
| C. Collapse the presentation, keep explicit decision buttons | Half the win for none of the semantic risk | The five buttons per change are what makes a fourteen-file review tiring, and they ask the reviewer to restate in a click what the X they just clicked already said |

## Decision

**B.**

### The components

Six become four ideas, composed rather than parallel:

- `choose_option` — a prompt and labelled choices. **One component, two
  callers**: an authored gate state, and a running agent's `AskUserQuestion`.
  The union of today's two feature sets — multi-select, option descriptions, one
  free-text field, and a list of questions whose length is normally one.
- `review_artifact` — a `ValueView` over one artifact, plus anchored comments,
  plus a `choose_option`.
- `review_artifacts` — a chooser on the left, `review_artifact` on the right.
  The changeset gate is its N-artifact case, where each artifact is a change and
  therefore renders as a diff.
- `edit_artifact` — the file-surface editor stack, pointed at an artifact.

`fill_form` and `confirm_action` are unchanged.

The renames — `edit_markdown` → `edit_artifact`, `user-approve-changeset` →
`review_artifacts`, and the gallery's `summarise_findings` →
`unknown_function` — take **no compatibility path**. A registered function name
is a wire contract, but the authored surface is one file using `edit_markdown`
and no file using the changeset gate outside generated snapshots. The workflows
are edited in the same change; an alias would outlive the thing it was easing.

### Decisions are derived, not clicked

Per artifact, one of three states, from the gesture:

| Gesture | Decision |
| --- | --- |
| untouched | `approved` |
| X'd out of the list | `denied` |
| commented | `comment` |

Then across the set: **no comment anywhere ⇒ the review is final**, and
`approved` → `merged`, `denied` → `reverted`. Any comment and nothing is
applied — the set travels back as judgements for the author to work from.

This is a pull request's two-verdict shape, and it is the reason
`DecisionKind`'s five values exist. `approved`/`denied` are not, as they look, a
redundant pair beside `merged`/`reverted`; they are the same dispositions on a
round that is **not being applied**. The contract's claim that they "separate the
judgement from the application" is exactly right, and the set-level rule is what
chooses between the two.

Three consequences that follow, and were decided rather than derived:

- **X and comment are mutually exclusive.** X'ing an artifact that carries
  comments discards them, behind a confirm — the X is the stronger statement,
  and a note on a change that is not in the review is a note about nothing.
- **A review-level comment is a comment on everything.** It blocks the
  conversion to `merged`/`reverted` the same way a per-artifact one does.
  Otherwise "this whole approach is wrong" merges.
- **The review-level vocabulary is the author's**, on the plural as on the
  singular. `merged`/`reverted` is the default when a state names no options,
  not a changeset special case. The five authored `review_artifact` states
  already prove the general shape is needed: they offer `approve` / `revise` /
  `cut`, where `cut` terminates the feature — a routing decision, not a
  disposition.

So a gate has **two layers**, and they are what let the singular and the plural
be one component: a per-artifact layer with a fixed derived vocabulary, present
only when there is a list; and a review-level layer with the author's
vocabulary, present always.

### Comments are one record

```
{ artifact, quote, range?, side?: "before" | "after", body, author, at }
```

Quote-first anchoring, because the quote is what the next reader — usually a
model — needs anyway, and it survives the artifact being regenerated in a way an
offset does not. A diff hunk is text, so the same anchoring serves both
surfaces; `side` is the only field the changeset case adds. `author` comes from
`git config user.name`, which nothing in the product reads today.

### The CLI diverges

The app's reviewer becomes a chooser and a viewer, which needs width. The CLI's
stays a linear list with explicit keys. This retires the reason CHANGESETS.md
§8.3 gave for unified-inline rendering — that one component had to serve a
terminal too — but not the constraint itself: the app reviewer still has two
hosts, and the second is a conversation pane.

## Consequences

**Easy.** A view toggle, an anchored comment, an icon, a keyboard path: built
once, and every surface that shows a value has it. The artifacts pane in the
conversation view is already `review_artifacts` with the decision layer off, so
it collapses into the same component rather than being a fourth thing.

**Hard.** Derivation makes doing nothing mean `approved`. On a forty-file
changeset one click can approve work nobody opened, and the forcing function
that prevented it — Submit disabled while any change is undecided — is exactly
what derivation removes. Replaced by a submit-time summary that counts what was
never opened. That is weaker, deliberately: the alternative is the click-through
approval the gate exists to prevent, arrived at from the other direction.

**Forecloses.** Nothing structurally, but it spends the `comment` decision kind
on a specific meaning ("kept, on a round that is not being applied"), so a
future third disposition cannot reuse the word.

## Revisit when

- Reviews start landing with a large "never opened" count in the summary. That
  is derivation's failure mode showing up as data, and it argues for the harder
  gate rather than the softer one.
- A caller needs a per-artifact vocabulary that is not approve/deny/comment. The
  per-artifact layer is fixed on purpose; a second real case means it should
  take the author's options the way the review level does.
