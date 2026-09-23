---
id: engineering/contracts/gate-components
type: engineering-contract
status: proposed
updated: 2026-09-22
visibility: public
kind: api
owned_by: [engineering/units/interaction-hub]
consumers: ["every workflow state with a UI gate", "@jaira/app renderer", "@jaira/cli reviewer", "--interactions scripting"]
since: proposed — reshaped by [decision 0002](../decisions/0002-one-gate-vocabulary.md)
---

# Gate components

The built-in UI components a `FunctionOp` can name, and what each returns.
A gate's result lands directly on the state's declared outputs, with no adapter
in between, so **the result shape is the contract**.

## Use when

A run needs a human decision before it can continue.

## Don't use when

The decision is derivable. If a host function can compute it — "did the tests
pass", "is the composite's score above its best parent" — it must, and
[WORKFLOW.md §0.6](../../../WORKFLOW.md) decides whether a person is asked at
all.

## Instead consider

| Situation | Use | Why |
| --- | --- | --- |
| The answer is arithmetic | a `function` state | A gate spends attention; arithmetic doesn't need it |
| The person should write, not approve | `edit_artifact` | Their words are faster than a revision round |
| The decision is WHERE the task goes next | `on_user_event` in a transition guard ([WORKFLOWS.md §7.4](../../../WORKFLOWS.md)) | A gate is a state the task sits in and a dialog it has to answer. "Which column does this belong in" is already a gesture the board offers — the card is dragged, and no state, no dialog and no interruption is needed to record it |

## Where this fits

- **Serves** — every phase's `gate` child.
- **Neighbors** — the interaction hub owns delivery; this owns shape.
- **Depends on / used by** — re-validated in the main process by
  `validateComponentResult`; authored config parsed by `parseComponentConfig`.
- **History** — five shipped in phase 4 (DESIGN §1f); the changeset gate added
  by CHANGESETS.md §4.1; reshaped into the vocabulary below by
  [decision 0002](../decisions/0002-one-gate-vocabulary.md).

## Shape

Four ideas, composed rather than parallel. `review_artifact` is a viewer plus a
`choose_option`; `review_artifacts` is a chooser plus a `review_artifact`.

| Component | Returns |
| --- | --- |
| `choose_option` | `{ decision, comments? }`, or `{ answers }` when it carries more than one question |
| `review_artifact` | `{ decision, comments?, notes? }` |
| `review_artifacts` | `{ decision?, comments?, decisions: [{ id, decision, comment?, notes?, content? }] }` |
| `edit_artifact` | `{ content }` |
| `fill_form` | a flat object of its fields |
| `confirm_action` | `{ confirmed }` |
| `approve_tool_call` | `{ decision: "allow" \| "deny" }` — the APPROVAL PROMPT, which a permission function calls to ask the person about one tool call ([decision 0007](../decisions/0007-toolsets.md), amended 2026-09-22); its config is `{ request, prompt? }`, `request` the `PermissionFunctionRequest` the function was handed, and the function's own value is the `decision` |

`fill_form` reads a JSON-Schema **subset**: `string` · `number` · `boolean` ·
`enum`, with `optional`, `default`, `multiline`, and — on an `enum` only —
`custom`, which makes the declared values suggestions rather than the only
answers: the box offers them and takes any other non-empty text. The fields are
converted to a JSON Schema (`fillFormSchema`) and drawn by the app's one schema
form — the renderer the Run panel and Settings use — so an optional field has a
switch that leaves it out of the answer, and a `default` is the answer the form
starts on.

### `choose_option` — one component, two callers

A prompt and a set of labelled choices. The **authored** caller is a gate state
whose `options` the workflow declares; the **agent** caller is a running model's
`AskUserQuestion`, whose options are its own. The two differ in where the answer
goes and in whether it is validated against a declared enum — and in nothing a
person can see, which is why they are not two components.

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The question, as the person reads it |
| `options` | yes | The choices, in order. A bare string is an option whose label is its value |
| `options[].value` | yes | What `decision` becomes |
| `options[].label` | no | Display text; defaults to `value` |
| `options[].description` | no | What choosing it means |
| `options[].tone` | no | `danger` draws it as the destructive choice |
| `comments` | no | Offer a free-text field beside the choice |
| `multiple` | no | Several options may be chosen; `decision` is then an array |
| `require_confirm` | no | Picking holds the choice; a Confirm button sends it |
| `custom` | no | Offer an own-answer box; `decision` may then be any non-empty string. Exclusive with `comments` |
| `questions` | no | Several questions in one gate — see below. Replaces `options` |
| `follow_up` | no | With `questions` only: the model may ask follow-up questions — after each round of answers, as another round of this gate, until it has nothing to ask |

Both callers normalize to one `Choice` — `choicesOfConfig` for a state,
`choicesOfQuestions` for an agent — and the renderer draws that and nothing else.

**Several questions, one at a time.** `questions` replaces `options` with a
list of parts, each a question of its own, asked in steps by the same stepper an
agent's batch uses, and the answer is `{ answers }` keyed by each part's `name`.
The single question's knobs move down a level — `comments`, `multiple`,
`custom` and `require_confirm` are refused at the top — because there is no
longer one question for them to be about.

| Field | Required | Meaning |
| --- | --- | --- |
| `questions[].name` | yes | The key the answer lands on. Unique within the state |
| `questions[].question` | yes | The question, as the person reads it |
| `questions[].options` | yes, unless `custom` | As above. Absent with `custom`: the part is answered in the person's own words alone |
| `questions[].header` | no | A short chip beside the question |
| `questions[].description` | no | Why it is asked, or what each answer would change — a line under it |
| `questions[].multiple` | no | The answer is a list |
| `questions[].custom` | no | Offer an own-answer box on this part |
| `questions[].optional` | no | The step may be passed; the key is then **absent** from `answers` |
| `questions[].default` | no | Pre-picked when the step appears. Must be one of its options |
| `questions[].schema` | no | The answer is a VALUE of this JSON Schema, not a word — see below |

**A typed part.** With `schema`, what the part answers is a value of that schema: the pick, or
the own answer, is READ as one (`readAnswer`) — as written where the schema takes text, as JSON
where it does not, so `3` answers an integer, `false` a boolean and `{"a": 1}` an object — and an
option's `value` is that value's words (`answerText`: an enum member `3` is offered as `"3"`). The
stepper holds the step while the words cannot be read or the schema refuses the value, saying why
under the options (the run's own validator, through `schema:check`), and the own-answer box says
what to type ("Type a number…"). The contract check reads only that a pick is one of the options;
main then checks every typed answer against its schema with the run's validator and refuses
`invalid answer: {name}…` otherwise. The host's own MOVE QUESTION is this shape
([task-channels](task-channels.md), "Inputs"): one part per input, and it is listed with
`moves: true`, since answering it takes a move rather than continuing a run.

A passed question is an absent key, never a word. That is what makes "they had
no view" reach the state as an absence it can test for rather than a value it
has to know to ignore — and why a "no view" option in the list is the wrong
spelling.

**Follow-up questions are the component's to ask, and the state's to allow.**
`follow_up: true` is a parameter of the state, never a choice put to the person:
nothing on screen differs, and the answer carries nothing about it. With it, the
gate does not settle on the click: the host holds the call, asks a model whether the answers opened anything
else only a person can settle — with the gate's prompt, every question and answer
so far, and the state's other inputs as context — and either parks the same call
again with the new questions (a new request, a new durable row, the same engine
promise) or settles it. The result the state gets is one `{ answers }` keyed by
every question asked across the rounds, the follow-ups included; the loop's own
bookkeeping never reaches the state. A round asks only what the answers opened, never what
could have been asked the first time; a name already used is dropped; a model
that fails settles with the answers given; and the loop stops after five rounds.
The context is whatever inputs the author wired into the state beyond the config,
so a state that wants useful follow-ups passes the draft and the issue in. A gate
recovered after a quit settles as answered: the loop needs a live run to re-park
on.

**The free-text field has a role, and the role is the only real difference.** A
gate's `comments` is `alongside`: said in addition to the choice, so clicking an
option is a complete answer even with text in the box. An agent's "Other" is
`instead`: the text replaces whatever was picked, so the answer is not complete
until it is confirmed. Naming the role is what lets one control serve both, and
it is what decides whether a click submits on the spot.

**Dismissal** is the one caller-specific affordance. An agent's question can be
dismissed — "use your own judgment" — because the agent continues either way. A
gate cannot: its state has declared outputs that must receive a value.

A multi-select answers with a list, checked the way one value is: every member
declared, nothing repeated, and never empty — "none of these" is not a choice the
state offered.

### `review_artifact` — one artifact, decided

Its decision surface **is** a `choose_option` — the same control, given the
state's own `options` and its `comments` — so option descriptions and the
`danger` tone come along without this component knowing about either.

The artifact renders through `ValueView`, the same component every other surface
uses for a model-produced value, so its view toggle (`viewsFor`) comes along:
markdown and its source, an image, HTML, a diff. A decision about something you
cannot see is the failure this component exists to prevent, and a decision about
something you can only see one way is the same failure a step later.

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The question |
| `artifact` | yes | Which of the state's inputs holds the thing to show |
| `options` | no | The review-level vocabulary; defaults to `merged` / `reverted` |
| `comments` | no | Offer a review-level free-text field |

**A comment implies the send-back.** A review with a comment or an anchored
note on it is a round going back, never an approval that happens to carry
words — the same rule the plural derives from gestures. The singular has no
per-artifact layer and no status step after it (a gate's transitions read
`decision` as the author wrote it), so the decision itself carries it: once
anything is written, the row of options collapses to one **Send back with
comments** button, which submits the author's send-back option. That option is
found by position in the author's vocabulary — the first non-`danger` option is
the affirmative, the next non-`danger` one is the send-back — so
`approve` / `revise` / `cut` sends back as `revise`. A vocabulary with no
second non-`danger` option (`merged` / `reverted`) has no word for "go back";
the row then stays, and the comment rides alongside whatever is clicked.

### `review_artifacts` — N artifacts, each decided

A chooser on the left, a `review_artifact` on the right. The changeset gate is
this component's N-artifact case: each artifact is a change, and therefore
renders as a diff.

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The question |
| `artifacts` | no | Which input holds the list; absent ⇒ found among the inputs by shape |
| `options` | no | The review-level vocabulary; defaults to `merged` / `reverted` |
| `tree` | changesets only | What the files currently hold: `proposal` for a worktree an agent already edited, `base` for a sync whose edits exist only as data |

#### The two layers

A review has a **per-artifact** layer and a **review-level** layer, and they are
what let the singular and the plural be one component.

The per-artifact vocabulary is fixed and **derived from the gesture**, never
clicked:

| Gesture | Decision |
| --- | --- |
| untouched | `approved` |
| X'd out of the list | `denied` |
| commented | `comment` |

Then across the set: **no comment anywhere ⇒ the review is final**, and
`approved` → `merged`, `denied` → `reverted`. Any comment and nothing is
applied; the set travels back as judgements. This is why `DecisionKind` has five
values — `approved`/`denied` are the same dispositions on a round that is not
being applied, which is what "separate the judgement from the application" means.

`reviewSettled` therefore reads the **applied form** — every decision is
`merged` or `reverted` — rather than "no decision is `comment`". The difference
is the review-level comment: a reviewer who writes "this whole approach is
wrong" and touches no individual change leaves every change `approved`, which
has no `comment` in it and is plainly not settled. Because the conversion only
happens when nothing was commented on anywhere, the applied form is exactly the
signal, with no extra field to carry.

Three rules that make the derivation total:

- **X and comment are mutually exclusive.** X'ing an artifact that carries
  comments discards them, behind a confirm.
- **A review-level comment is a comment on everything**, and blocks the
  conversion to `merged`/`reverted` exactly as a per-artifact one does.
- **The review-level vocabulary is the author's.** `merged`/`reverted` is the
  default when a state names no `options`, not a changeset special case — the
  authored `review_artifact` states offer `approve` / `revise` / `cut`, and
  `cut` terminates the feature.

Two more things are unlike the other components:

- **Its result is validated against its input.** A decision anchors to an
  artifact id and the set must be complete, so `validateComponentResult` takes
  the resolved inputs for this component alone.
- **It mounts itself** (CHANGESETS.md §8.1). The contract is
  `mount(node, ctx): () => void`, not a React element — the host owns the node,
  and everything the component needs arrives on an explicit `services` object
  (§8.2). Built-ins only for now: a third-party mount is a code-execution path
  into the renderer, and the trust model for that is not designed.

The non-interactive halves are ordinary registered functions:
`apply-changeset` (the pure application step, §4.2) and
`changeset-review-status`, which now derives `settled` from **whether any
comment exists in the set** rather than from a decision word. The loop policy is
authored transitions on the `changeset/review` workflow, never component code
(§4.3).

### `edit_artifact`

The file-surface editor stack, pointed at an artifact: the editor is chosen by
media type the way the file registry chooses one, edits live in a draft box that
survives unmount, and Revert means "throw away what I typed".

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The instruction |
| `source` | no | The input whose content seeds the editor; absent ⇒ start empty |

`editorKindOf` decides which editor by media type, the way `viewsFor` decides
which readings apply: `markdown` gets a Write/Preview pair, `json` (including
`…+json`) gets the schema editor, everything text-shaped gets the plain one, and
`readonly` covers anything a player would render. A declared type beats a sniff
at the text; the markdown sniff fires only where nothing declared one.

A type with no editor degrades to the `review_artifact` viewer, read-only —
rather than offering a textarea full of base64. It still submits, handing back
what it was given: the gate is parked until it receives a value, and "I looked at
it" is a real answer.

**Save is never disabled**, unlike in a file editor. `EditorActions` refuses to
save a file with nothing to write, which is right there and wrong here: handing
the text back unchanged is the normal way to agree with what the model wrote, and
a disabled button would park the run with no way forward. Revert appears only
once there is something to throw away.

### Comments

One record, both review components:

```
{ artifact, quote, range?, side?: "before" | "after", body, author, at }
```

Anchoring resolves by `quote` first and `range` second, because the quote is
what the next reader — usually a model — needs anyway, and it survives the
artifact being regenerated. `side` distinguishes the two halves of a diff.
`author` comes from `git config user.name`, resolved by the HOST and handed to
the component — a self-mounting one may not reach the IPC bridge itself (§8.2).

Selection anchoring is offered on text-bearing views only. A rendered image
takes review-level comments and no anchored ones, rather than pretending a
region of a picture is a quote. For the same reason every artifact also takes a
**whole-artifact comment**: an `unshowable` change — a binary file, a rename —
has no passage to point at and must still be answerable.

`content` — the reviewer's own edit — is allowed on any decision that keeps the
change (`merged`, `approved`, `comment`) and refused on `denied`/`reverted`. It
was `merged`-only until derivation made the wider case real: an edit plus
somebody else's comment elsewhere yields `approved` here, and dropping the edit
would throw away the reviewer's work between rounds.

### Icons

Every gate carries a glyph beside the word it illustrates, never instead of it —
`icons.tsx`'s rule, and the reason a component's icon sits next to its wire name
in the dialog's sub-line rather than in the author's prompt.

| Where | Glyph |
| --- | --- |
| `choose_option` | a forking path |
| `review_artifact` | an eye |
| `review_artifacts` | two offset sheets |
| `edit_artifact` | a pencil |
| `fill_form` | a sheet with fields |
| `confirm_action` | a check |
| `approve_tool_call` | a shield |
| A change's action | a file marked `+` / `−` / lines, beside `CRE` / `DEL` / `UPD` |
| The submit summary | check · cross · comment · alert, one per count |

The action glyph repeats in shape what the badge already says in colour, which is
what makes a chooser row scannable without separating two hues.

### Who may answer: questions and judgements, never approvals

A fast-forward ([decision 0005](../decisions/0005-connect.md) §4) runs the states
between where a task stands and where it was sent, and its **controlling
conversation** answers the gates on the way, through `answer_question`. Which
gates it may answer is a property of the COMPONENT, fixed here and nowhere else
(`ANSWERABLE_COMPONENTS`, `app/main/workflowHost.ts`):

| Component | A conversation may answer it | Why |
| --- | --- | --- |
| `choose_option` | yes | a question |
| `fill_form` | yes | a question |
| `review_artifact` | yes | a judgement on a document |
| `edit_artifact` | yes | a judgement on a document |
| `confirm_action` | **no** | an approval — a publish, a push, a merge |
| `review_artifacts` | **no** | applies, merges or publishes a changeset |
| `approve_tool_call` | **no** | an approval — whether a tool call may run |

A tool permission and an agent's parked approval are not gates at all: they are
on the approval hub, which neither the workflow tools nor the fast-forward are
handed. An answer given this way is held to the same result contract as a
person's (checked BEFORE it is journaled), and recorded as

```jsonc
// journal row on the task that asked — host vocabulary, as `jaira.supplied` is
{ "type": "jaira.answered", "requestId": "ui-7", "kind": "interaction",
  "instanceId": "<the gate's instance>", "byTaskId": "<the conversation's task>",
  "settled_by": { "via": "control", "confidence": 0.86 } }
// an agent's AskUserQuestion: kind "question", and the id of the call it answered
{ "type": "jaira.answered", "requestId": "question-3", "kind": "question",
  "instanceId": "<the asking agent's instance>", "toolCallId": "toolu_01…",
  "byTaskId": "<the conversation's task>", "settled_by": { "via": "control", "confidence": 0.8 } }
```

which the projection folds onto the instance as `settledBy` — drawn on the gate
as "Answered for you by the conversation", with "Answer it yourself", a rewind to
where that state was entered. Every `question` row also lands in the instance's
`answeredQuestions`, each with its `toolCallId`, and the agent's transcript draws the
same line under the `AskUserQuestion` block whose call has that id
(`markAnsweredQuestions`). Both ids ride the parked request: the engine names the asking
instance on every question it hands on, and the agent's transport reports the call's own id.
A row naming no call is drawn nowhere. The RESULT is unchanged: a gate's outputs do not
say who answered, so nothing downstream can tell and nothing downstream has to.
The confidence is the one `autopilot.askBelow` was held against; below it the
gate waits for the person as it would have.

## Errors

| Condition | Response | Caller does |
| --- | --- | --- |
| Undeclared `decision` | Refused in the main process — unless the state said `custom` | Fix the state's options |
| Missing required field | Refused in the main process | Fix the form config |
| `choose_option` with no options | ERROR at parse time, not an empty dialog | Fix the state file |
| `options` and `questions` together, or `comments` beside `questions` | ERROR at parse time | One spelling; per-question knobs go on the question |
| An `answers` key naming no question | Refused in the main process | Nothing on screen could have produced it |
| `follow_up` beside `options` | ERROR at parse time | A single decision has no turn to ask more |
| A `review_artifacts` result missing an artifact | Refused in the main process | The set must be complete |
| A conversation's answer that does not fit the contract | Refused before anything is journaled; the gate stays parked for the person | Nothing — the fast-forward counts it as left to you |
| A conversation naming a `confirm_action`, `review_artifacts` or `approve_tool_call` request | Refused by component: `'<component>' is an approval, not a question` | Nothing — it is the person's |

Re-validation happens in main because the renderer is the untrusted side of the
IPC boundary; the engine's own output-schema check is a second, independent
gate.

## Compatibility

The renames — `edit_markdown` → `edit_artifact`,
`user-approve-changeset` → `review_artifacts` — take **no compatibility path**
and no alias. A registered function name is a wire contract, but the authored
surface was one file and the workflows are edited in the same change
([decision 0002](../decisions/0002-one-gate-vocabulary.md)). `--interactions`
scripting keys on function name, so scripted answers must be renamed with them.

`notes` on a review result is additive; `decision` and `comments` keep their
shapes. The per-artifact decision kinds are unchanged in value and narrowed in
meaning.

## Traps

- A gate's outputs are ordinary state outputs. Renaming a result field is a
  workflow-wide breaking change, not a UI tweak.
- The engine lands DECLARED outputs only. A `review_artifact` state that names
  `decision` and `comments` but not `notes` drops every comment pinned to a
  passage without a word; the lint warns on it (`outputs`).
- Declaring `kind: "function"` on a gate **drops inherited call settings** — do
  it, or the gate silently receives the subtree's `model`
  ([WORKFLOWS.md §5.2](../../../WORKFLOWS.md)).
- A `sequence` is a cursor, not a barrier: independent gates park at once. If
  two gates must be answered in order, wire one's output into the other.
- **Doing nothing is an answer.** Derivation means an untouched artifact is
  `approved`, so submitting a large review without opening it approves work
  nobody read. The submit summary counts what was never opened; it is a
  disclosure, not a guard.
- The CLI reviewer and the app reviewer are **deliberately different surfaces**
  from here on. A change to the decision derivation is a change to both; a
  change to the layout is a change to one.
