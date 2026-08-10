# The feature workflow

This document describes the workflow that builds a feature, in the form
`jaira workflow check` reads: eight phases, their steps in order, the loops, the
human gates, what is delegated to a coding agent rather than a model, and the
artifacts each step produces.

```bash
npm run jaira -- workflow check WORKFLOW.md --project .
```

It is the description; `.jaira/workflows/feature/**` is the implementation. When
they disagree the check says which side drifted, and CI gates on them staying in
step ([WORKFLOWS.md §11.1](WORKFLOWS.md)).

**What is a requirement here.** The numbered **Steps** table of each phase, plus
its **Loop**, **Gate**, **Artifacts**, and **Inputs** lines. Those are extracted
and judged. Everything under *What the prompt must cover* and *What the critique
checks* is content for the states to use — it shapes the prompts, it is not a
claim about control flow.

# Contents
0. Conventions — the state tree, the uniform phase, docs, exploration
1. Product Spec — `feature/product`
2. UX Spec — `feature/ux`
3. UI Spec — `feature/ui`
4. Engineering Spec — `feature/engineering`
5. Engineering Implementation — `feature/implementation`
6. Acceptance — `feature/acceptance`
7. Documentation — `feature/documentation`
8. Review — `feature/review`
9. Worked translation — phase 1 as state files

---

## 0. Conventions

### 0.1 The root

`feature` is a pure composite: no operation, eight children, one sequence.

```text
feature
  ├─ product          → docs/product/<name>.md
  ├─ ux               → docs/ux/flows/<name>.md, docs/ux/patterns/<name>.md
  ├─ ui               → docs/ui/{surfaces,components}/<name>.md + mockups
  ├─ engineering      → docs/engineering/{units,contracts,decisions}/<name>.md
  ├─ implementation   → code + unit tests defending phase-4 invariants
  ├─ acceptance       → e2e tests defending phase-1 deliverables, verified_by
  ├─ documentation    → docs/guides/<name>.md, docs/reference/<name>.md
  └─ review           → findings; on revise, jumps back to the failing phase
```

**Inputs.** `issue` (blob, `text/markdown`) — what is being asked for.

**Outputs.** `features` (the product ids that shipped), `verdict`
(`ship` | `revise` | `drop`), and the artifact list.

**Sequence.** The eight phases in order.

**Transitions.** Three phases can jump backwards, which is why the sequence is
written out rather than inferred. Evaluated in order, first match wins:

| When | To |
| --- | --- |
| `implementation.outputs.design_findings.length > 0` | `engineering` — the unit doc cannot be satisfied (§5) |
| `acceptance.outputs.design_findings.length > 0` and the class is `design` | `engineering` |
| `acceptance.outputs.design_findings.length > 0` and the class is `spec` | `ux` — the flow cannot deliver its success signal (§6) |
| `review.outputs.verdict === 'ship'` | `terminate.success` |
| `review.outputs.verdict === 'drop'` | `terminate.success` |
| `review.outputs.verdict === 'revise'` | `review.outputs.failing_layer`, a fresh instance |
| iterations exhausted | `terminate.error` |

`limits.max_iterations: 3` on the root. A fourth revise means the feature is
wrong, not the work.

The first three are the reason testing is split the way it is. A test that fails
is not automatically a coding mistake: it can mean the design cannot hold, or
that the flow cannot deliver what phase 2 promised. Those go back to the phase
that owns the claim, carrying the failing test as evidence — and the alternative,
letting the phase that found it "fix" the problem locally, is precisely how a
design defect becomes a weakened assertion.

**Re-entering a phase is a fresh instance** ([WORKFLOWS.md §7](WORKFLOWS.md)), so
the returning phase re-reads the docs the earlier one just corrected.

Each phase's outputs are the next phase's inputs. **That wiring is what makes
traceability true** — a UI state cannot run without a flow id to realize, because
the slot is required. The `satisfies` / `realizes` / `implements` fields written
into the docs are the durable *record* of the same link, for a reader who arrives
next quarter with no run in front of them.

### 0.2 Every phase has the same seven children

The phases differ in who drafts, what the gate asks, and what lands in `docs/`.
The shape does not. This is what makes the document translate mechanically.

| # | Child | Runs as | Does |
| --- | --- | --- | --- |
| 1 | `context` | function | Loads this phase's standing docs and catalog index. No model. |
| 2 | `explore` | composite | Candidates → score → synthesize. Skipped by guard when the catalog already answers it (§0.5). |
| 3 | `draft` | prompt or agent | Produces the phase's artifacts. |
| 4 | `critique` | prompt | Judges the draft against *What the critique checks*. Outputs `findings` (each with a `severity`), `max_severity`, and `target`. |
| 5 | `confidence` | function | Scores how much this phase should be trusted to proceed without a person, and builds the decision brief (§0.6). No model. |
| 6 | `gate` | human | **Always entered.** The component decides whether to park for a person or resolve on the recommendation, from the brief's score and the viewer's threshold (§0.6). |
| 7 | `publish` | function | Validates structure, writes the artifacts to their `docs/` paths, updates the catalog index row. No model. |

#### The refine loop

**`explore` + `draft` + `critique` repeat until nothing substantial is left.**
Not "until clean" — a critique that always finds something would never exit, and
one that must find nothing to exit teaches the critic to be quiet.

`critique` grades each finding on the severity scale this repo already uses for
its planning workflow — `blocker` · `significant` · `minor` · `note` — and the
phase carries a `severity_threshold` input, default `significant`. **Substantial
means at or above the threshold.**

It also emits `target`, which is what makes the loop worth running twice:

| `target` | Means | Loop re-enters |
| --- | --- | --- |
| `draft` | The chosen approach is right, the execution isn't | `draft` |
| `explore` | The approach itself is wrong — the criteria missed something, or the winning candidate loses on a criterion nobody wrote down | `explore`, with the findings appended to the brief |
| `upstream` | This phase cannot be fixed here; an earlier phase is wrong | `gate` as `blocked`, and the person routes it |

So the loop, evaluated in order:

- `max_severity < severity_threshold` → `confidence`. This is the exit.
- `target === 'upstream'` → `confidence`, carrying `blocked`. A person always sees this one.
- `run.iteration >= limits.max_iterations` → `confidence`, carrying `exhausted`. **Never silently proceed** — three rounds that did not converge is itself the finding.
- `target === 'explore'` → `explore`.
- otherwise → `draft`.

Each pass receives the previous pass's findings, so the loop converges instead of
rediscovering the same weakness. `limits.max_iterations: 3`.

`publish` being host code rather than a model call is deliberate: "adding the
index row in the same sitting" is a rule the machine keeps, not one people
remember. It also means the artifact bytes land wherever the project's
`artifacts.destination` says ([WORKFLOWS.md §10](WORKFLOWS.md)), and the agent
never learns where.

#### Structure is machine-checked; `critique` judges substance

Whether an id resolves, an index row exists, a required section is present, a
status is legal, or a mockup carries `captured` and `reflects` — none of that
needs a model, and a critique that spends its attention there will not spend it
on whether two user stories are the same story.

So `publish` validates and refuses, once, for every phase:

- every id referenced resolves to a file that exists
- every new doc has its index row, and every index row a doc
- required frontmatter and required sections are present, and `status` is legal
- `requires` / `depends_on` graphs have no cycles
- every mockup carries `captured` and `reflects`
- no `proposed` status on work the run marked shipped

`critique` is told these already hold. **Its job is coverage and substance** —
does the output actually capture what it was supposed to capture, is anything
duplicated, does anything claimed here fail to survive contact with the goal it
came from. Each phase's list below is written in those terms deliberately.

### 0.3 What lands in `docs/`

Only what a future feature's author needs. The test: *would someone starting an
unrelated feature next quarter need this?* A component's "don't use when" — yes.
The list of files a change touched — no.

So there is no `changes/`, `tests/`, `reviews/`, or `explorations/` folder. Those
phases and states produce process output that lives on the task, plus **edits**
to the docs above.

An exploration is the clearest case. Five candidates, a scoring table and a
synthesis are how a decision got made; a month later nobody reads them, and the
one line that mattered — *we tried the single-pane version and it lost on
recoverability* — belongs in the doc the exploration produced. So the candidates
and their scores are run artifacts on the task, and what survives into `docs/` is
one row: **Framings considered** on a product doc, **Instead consider** on a
component, a numbered **decision record** in engineering. If the residue is worth
more than a row, it was a decision, and decisions have their own file.

```text
docs/
  product/     principles.md ·· <feature>.md
  ux/          principles.md ·· flows/ ·· patterns/
  ui/          principles.md ·· direction.md ·· surfaces/ ·· components/ ·· assets/
  engineering/ architecture.md ·· principles.md ·· standards.md ·· units/ ·· contracts/ ·· decisions/
  guides/ ·· reference/
  _templates/
```

**A doc's id is its path under `docs/`, without the suffix** — the same rule
state ids follow. `ui/components/session-list` is
`docs/ui/components/session-list.md`.

Every catalog doc carries: the upward link for its phase, a **Where this fits**
section (serves / neighbors / depends on / history), and — for anything reusable
— **Use when / Don't use when / Instead consider**. Templates are in
`docs/_templates/`, and `draft` states are given the template as prompt context.

### 0.4 Standing docs are inputs, amendments are outputs

[`product/principles.md`](docs/product/principles.md),
[`ux/principles.md`](docs/ux/principles.md),
[`ui/principles.md`](docs/ui/principles.md),
[`ui/direction.md`](docs/ui/direction.md),
[`engineering/architecture.md`](docs/engineering/architecture.md),
[`engineering/principles.md`](docs/engineering/principles.md),
[`engineering/standards.md`](docs/engineering/standards.md) — what the product
and the codebase already believe. Each phase's `context` state loads its
own, and the `draft` state receives them as a required input, so a phase cannot
run without them in front of it.

A phase's draft ends in exactly one of three states, and its doc says which:

- **Conforms** — the default; silence means this.
- **Exception** — an `exceptions` entry with the reason, on the doc claiming it.
  Three exceptions to the same rule mean the rule is wrong.
- **Amendment** — the standing doc is wrong. `draft` emits a
  `standing_amendment` output; the gate approves it separately from the feature.

A silent departure is none of these, and `feature/review/standards` finds it.

### 0.5 `explore` — a sub-workflow, not a mood

Same five states everywhere; only what a *candidate* is changes.

| # | State | Runs as | Does |
| --- | --- | --- | --- |
| 1 | `brief` | prompt | Restates the constraint, and writes the criteria — 3–6, weighted. **Runs before candidates exist**, which is the only reason the scores mean anything. |
| 2 | `candidates` | prompt, or agent for UI | N candidates, each a different stance, one per instance. Independent — they should run concurrently ([WORKFLOWS.md §6](WORKFLOWS.md)). |
| 3 | `score` | prompt | Every candidate against every criterion, plus, per candidate, the one thing no other candidate does. |
| 4 | `synthesize` | prompt | The composite, and what it dropped. Scored against the same criteria. |
| 5 | `verdict` | function | If the composite scores below its best parent, the parent wins. Arithmetic, not judgment. |

**Artifacts — on the task, not in `docs/`.** The brief, the criteria, every
candidate and the scoring table are run artifacts: they explain how the decision
was reached, and they stop being read once it is made.

**What survives into `docs/`** is written by `synthesize`, in one or two lines, on
the doc this exploration produced:

| Phase | Where the residue lands |
| --- | --- |
| 1 Product | **Framings considered** — the rejected reading, and why not |
| 2 UX | The flow's **Where this fits**, or a new `ux/pattern` if the shape recurs |
| 3 UI | **Instead consider** on the component, and the winning mockups under `docs/ui/assets/` |
| 4 Engineering | A numbered **decision record** — the one place a losing option keeps its full argument, because someone will re-propose it |
| 5–7 | A line in the doc the phase produced |

The rule: if a losing candidate is worth more than a row, it was a decision, and
it gets a decision record.

**Entered when** the phase's `context` reports no catalog match, or the caller
asked for it. Skipped otherwise — an exploration when an existing pattern fits is
waste.

**Before starting one, `context` reads the catalog, not an exploration archive.**
"What did we already try?" is answered by the residue above — a decision record's
rejected options, a component's *Instead consider* — because that is the form
someone actually reads.

**What varies, by phase:**

| Phase | Varies | A candidate is | Mandatory candidate |
| --- | --- | --- | --- |
| 1 Product | The framing | A competing set of stories | Do nothing |
| 2 UX | The path | A different step table | An existing pattern, unchanged |
| 3 UI | The form | A rendered mockup with a stance | An existing component, unchanged |
| 4 Engineering | The architecture | A diagram plus its invariants | No new unit |
| 5 Implementation | The decomposition | A change list with its graph | The two-change minimum |
| 6 Acceptance | How the value is driven | A different way to reach the success signal — through the UI, the CLI, or the contract seam | Extend an existing suite |
| 7 Documentation | The entry point | A different first ten lines | Fix the existing doc |

A candidate holds the earlier phases fixed. One that is only good because it
changes an earlier decision is a finding: `verdict` reports it, and the root's
review transition is what acts on it.

### 0.6 `confidence` — when a person is asked

Every gate is expensive: it stops the run and spends attention. A phase that
converged on the first pass, with no exceptions claimed and nothing
irreversible, should not cost the same interruption as one that scraped through
on iteration three.

So `confidence` runs before every gate and emits
`{ score, reasons[], must_ask[], brief }`.

**The gate state always runs.** It is not guarded, and no transition skips it.
What varies is what the gate *does* with the brief: park for a person, or resolve
on the recommendation and continue. That decision belongs to the component and
the viewer's setting —

```text
ask when   score < ask_below   OR   must_ask is non-empty
```

— where `ask_below` is the person's own threshold, per phase, set once in the
project rather than argued per feature: "only ask me below 80%" is
`gate_policy: { ask_below: 0.8 }`.

Putting the policy in the gate rather than in a guard buys three things:

- **One code path.** Every phase has a gate child, always; there is no
  auto-approved branch that behaves differently from the answered one.
- **A record either way.** A guard that skips the gate produces no child instance
  and therefore no record. An unconditional gate always writes what was decided,
  by whom or by what score, and why — which is exactly what §8's calibration
  check reads.
- **The threshold can change without touching a workflow.** It is a viewer
  setting, not a state file, so raising it mid-project re-asks rather than
  re-authors.

#### The score is computed, not claimed

A model's own "I'm 90% sure" is not a measurement: it moves with phrasing, and
it is the same model whose work is being judged. **`confidence` is a host
function**, and the model's self-report is at most one input among several.
Everything below is already sitting in the run:

| Signal | Read from | Pushes confidence |
| --- | --- | --- |
| Exit severity | `critique.max_severity` | Down, sharply, near the threshold |
| Rounds used | `run.iteration` | Down — converging on pass 3 is not converging |
| Critic disagreement | Two `critique` instances with different prompts | Down when they disagree about severity, which is the cheapest real calibration available |
| Exploration margin | `explore.score` — winner minus runner-up | Down on a near-tie: the scoring itself says the choice was arbitrary |
| Mandatory-candidate margin | Winner minus the do-nothing / reuse candidate | Down when barely beaten — that is the case where building was probably wrong |
| Coverage | Required slots the draft left thin | Down |
| Self-report | The draft's own stated confidence | Weakly, and only downward — a model saying it is unsure is informative; a model saying it is sure is not |

`reasons[]` carries the two or three that moved it most, in words. **The gate
shows the reasons, never the bare number** — "0.62" tells a person nothing;
"the two critics disagreed on whether the migration is reversible" tells them
where to look.

#### `must_ask` overrides the threshold

Some decisions are asked regardless of score, because the cost of being wrong is
not what confidence measures:

- anything irreversible — a migration that has run, deleted data, a published
  contract change
- an amendment to a standing doc, or a claimed exception to one
- a verdict of `cut` or `drop`
- `target === 'upstream'` or `exhausted` from the loop
- the first N runs of a newly authored phase, while the threshold is being
  calibrated

#### An auto-resolved gate is recorded, not invisible

Because the gate always runs, an auto-resolved decision is an ordinary gate
record — same shape as an answered one, carrying its score, its reasons, and the
threshold in force. It appears in the task's history beside the answered ones.

Phase 8 checks them: **an auto-resolved decision that review later overturns is
the calibration signal.** It says the threshold is too low for that phase, and it
is the only honest way to tune `ask_below`.

### 0.7 What a gate shows

A gate that shows an artifact and three bare words is asking a person to
reconstruct the decision from scratch. Every gate is handed a **decision brief**,
built by `confidence` from what the phase already produced:

| Part | Contents |
| --- | --- |
| Question | One sentence. What is being decided, not "please review". |
| Context | What upstream decided that constrains this, the artifact itself, and what happens next under each answer. |
| Options | Per option: the label, **what it means**, **pros**, **cons**, and which criterion or finding drives it. |
| Recommendation | Which option, its `score`, and the two or three `reasons`. |
| Free text | Always available. **Required** when the person overrides the recommendation — the why is what the next reader needs. |
| Multi-select | Where the decision is "which of these", not "which one": which findings to accept, which deliverables to keep, which candidates to carry forward. |

#### This needs two component changes

Today's contracts (DESIGN §1f) are: `choose_option` and `review_artifact` return
`{ decision, comments? }`; `edit_markdown` `{ content }`; `confirm_action`
`{ confirmed }`; `fill_form` a flat object over a JSON-Schema **subset** —
`string` · `number` · `boolean` · `enum`, with `optional`, `default`,
`multiline`.

So of the brief above: context and free text are renderable today (`comments`),
and two parts are not.

| Needed | Today | Change |
| --- | --- | --- |
| Options with pros / cons / consequence | `options` is a list of bare values | `choose_option` accepts option **objects** — `{value, label, means, pros[], cons[], drives}` — and keeps returning `{decision, comments?}`, so no state's outputs change |
| Multi-select | No array kind in the `fill_form` subset | Either add `enum` + `multiple` to the subset, or a sixth component `select_many` returning `{selected[]}` |

Both are contract amendments, which is exactly what §0.4 says to do with them:
[`docs/engineering/contracts/gate-components.md`](docs/engineering/contracts/gate-components.md)
records the contract, and
[`docs/engineering/decisions/0001-decision-brief-gates.md`](docs/engineering/decisions/0001-decision-brief-gates.md)
records the choice and what was rejected. **Until they land, gates degrade
honestly**: the brief's options render as `enum` values with the pros and cons
folded into the prompt text, and a multi-select renders as one boolean per item.
Worse to read, same decision, and no state file changes when the components
catch up.

---

## 1. Product Spec — `feature/product`

**Purpose.** Turn the issue into product deliverables: who is served, what they
can do, and how we would know it worked.

**Inputs.** `issue` ← `.inputs.issue` · `principles` ← `docs/product/principles.md`
· `catalog` ← `docs/product/index.md`

**Outputs.** `features` (array of `{id, story, importance, metrics, requires}`) ·
`feature_docs` (blobs) · `standing_amendment` (optional blob)

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Load `product/principles.md` and the feature catalog | `principles`, `catalog` |
| 2 | `explore` | composite | Framings, including **do nothing** (§0.5) | `framing`, `exploration_doc` |
| 3 | `draft` | prompt | Write the deliverables and their docs | `features`, `feature_docs` |
| 4 | `critique` | prompt | Judge against the checklist below | `findings`, `max_severity`, `target` |
| 5 | `confidence` | function | Score and reasons (§0.6) | `score`, `reasons`, `must_ask` |
| 6 | `gate` | human — `review_artifact` | Decision brief: approve / revise / cut | `decision`, `comments` |
| 7 | `publish` | function | Write `docs/product/<id>.md`, add the index row, update the dependency graph | `paths` |

**Loop.** Steps 2–4 repeat until `max_severity < significant`, max 3 (§0.2).
**Gate.** Always runs; asks when `score < ask_below`, and always when `must_ask`
names a standing-doc amendment. `cut` terminates the whole workflow — there is no
point specifying UX for a feature nobody is building — so `cut` is in `must_ask`:
it can only be chosen by a person, never resolved on a score.
**Artifacts.** `docs/product/<feature>.md` per deliverable · an edit to
`docs/product/index.md`. The exploration's candidates stay on the task; its
residue is the **Framings considered** rows.

### What the prompt must cover
1. Who are we serving? Is it the user/developer/support/marketing?
2. What are the goals? How does it bring value to the person we are serving? Can we measure that value? What does success/failure look like?
3. How does this feature bring the value to the person from the goals? What is necessary? What is sufficient? What is nice to have?
4. What other features are necessary for this feature to bring its value?
5. Where does this sit among the features that already exist — what does it overlap with, what does it make redundant, and what would a user expect it to do because of a neighbour?
6. Does it conform to the product principles? If not: exception or amendment?

Each deliverable takes the form
`{id: "feature-name", story: "As a [who], I should be able to [what] so that I can [value]", importance: 0.0-1.0, metrics: [...], requires: ["other-feature-name"]}`
and becomes one doc.

### What the critique checks
Coverage first — does this set of deliverables actually capture the goals?

- **Goals with no story.** Take each goal from the issue in turn: which deliverable delivers it? Anything unclaimed is named, not glossed.
- **Stories with no goal.** The reverse. A deliverable nothing in the issue asked for is either a missing goal or scope that crept in.
- **Duplicates and near-duplicates.** Are any two stories the same thing in different words? Is one a special case of another, or the same job for two audiences? Say which, and merge or distinguish them explicitly — this is the most common defect in a first draft and the most expensive later, because each duplicate grows its own flow, its own component, and its own unit.
- **Value, or restatement?** Does each `so that I can …` name something the person wanted before this feature existed? "so that I can use the new panel" is the feature wearing a story's clothes.
- **Does the person fit?** Would the named audience recognize this as their job? A story that says "developer" while describing support's work will produce the wrong flow three phases from now.
- **Do the metrics measure the value or the activity?** Opens, clicks, and runs-started measure that the feature was reached, not that it worked. Which of these would move if the feature were popular and useless?
- **Is the importance ordering defensible?** Read the `1.0` set alone: is that a thing worth shipping? Then read the low ones: is any of them actually load-bearing for a `1.0`?
- **Departures from principles** are an exception or an amendment, never silence.

---

## 2. UX Spec — `feature/ux`

**Purpose.** For each deliverable, the path from intent to value.

**Inputs.** `features` ← `feature/product` · `principles` ←
`docs/ux/principles.md` · `patterns` ← the pattern catalog

**Outputs.** `flows` · `flow_docs` · `new_patterns`

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Load `ux/principles.md` and the pattern catalog; report whether an existing pattern matches | `principles`, `patterns`, `pattern_match` |
| 2 | `explore` | composite | Paths — entered only when `pattern_match` is false (§0.5) | `path`, `exploration_doc` |
| 3 | `draft` | prompt | One flow per path: steps, states, reversibility, success signal | `flows`, `flow_docs` |
| 4 | `lift` | prompt | Any shape now used by two flows becomes a pattern doc | `new_patterns` |
| 5 | `critique` | prompt | Judge against the checklist below | `findings`, `max_severity`, `target` |
| 6 | `confidence` | function | Score and reasons (§0.6) | `score`, `reasons`, `must_ask` |
| 7 | `gate` | human — `review_artifact` | Decision brief: approve / revise | `decision`, `comments` |
| 8 | `publish` | function | Write the flow and pattern docs, add index rows | `paths` |

**Loop.** Steps 2–5 repeat until `max_severity < significant`, max 3 (§0.2). A
`target === 'explore'` finding re-opens the path candidates rather than
re-drafting the same flow.
**Artifacts.** `docs/ux/flows/<flow>.md` · `docs/ux/patterns/<pattern>.md` · an
edit to `docs/ux/index.md`.

Step 4 exists as its own state because lifting is the only way the pattern
catalog grows, and a step nobody is asked for is a step nobody takes.

### What the prompt must cover
1. What does this person do today to get the same value, and what does that cost them — steps, waiting, guessing, giving up?
2. Where does the feature start? How do they find out it exists at the moment they need it?
3. What is the shortest path from intent to value, and what on it isn't strictly necessary?
4. What must they know at each step to decide the next one — and what are we asking them to remember instead of showing them?
5. What happens when it is empty, slow, partial, denied, or broken? Which of those is the common case?
6. What is irreversible? What can be undone, and for how long? What is lost if they walk away mid-flow?
7. How does it behave on keyboard only, a screen reader, a small window, a slow machine?
8. Which existing pattern is this an instance of? Where it deviates, why is this case different?

Each flow declares its steps as `actor does` / `system does` / `actor knows`, and
one row per state: `first_run`, `empty`, `loading`, `partial`, `error`, `denied`,
`success`.

### What the critique checks
Does the path deliver the value, or only present the feature?

- **Deliverables with no path**, and paths that serve no deliverable.
- **Does the success signal match the deliverable's metric?** If the metric cannot be observed anywhere along this flow, one of the two is wrong — and it is usually the metric.
- **Duplicate flows.** Are two flows the same path with different entry points? Then it is one flow with two triggers, and splitting it here produces two of everything downstream.
- **Steps that serve the system.** Which step exists because the machine needs it — a confirmation, a mode switch, a name it could have generated? Each is a step the person did not ask for.
- **Knowledge the actor does not have.** Walk the steps as someone who has never seen this: at which step would they not know what to choose? `actor knows` is the evidence, and a step needing knowledge from three steps back is a defect, not a step.
- **Does the error state carry them forward,** or merely inform them? A flow whose error row ends the path has been labelled, not designed.
- **Is the "today" path honestly described?** If the current way is not really as bad as step 1 claims, phase 1 overstated the value, and this is where it shows.
- **Deviations from a pattern** are justified; a shape now used twice was lifted in step 4.

---

## 3. UI Spec — `feature/ui`

**Purpose.** What each flow step looks like, in every state, with mockups.

**Inputs.** `flows` ← `feature/ux` · `principles` ← `docs/ui/principles.md` ·
`direction` ← `docs/ui/direction.md` · `components` ← the component catalog

**Outputs.** `components` · `surfaces` · `component_docs` · `mockups`

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Load both standing docs and the component catalog; report the nearest existing components | `principles`, `direction`, `near_matches` |
| 2 | `explore` | composite | **Five designs, each a different stance** — `candidates` runs as a coding agent, one instance per stance, concurrently; then score, synthesize, and if the composite is worse than its best parent, ship the parent | `design`, `candidate_mockups`, `exploration_doc` |
| 3 | `draft` | prompt | Surface and component docs: anatomy, states, interactions, copy, behavior | `component_docs` |
| 4 | `render` | agent | A mockup per state — including empty and error — each stamped `captured` and `reflects` | `mockups` |
| 5 | `critique` | prompt | Judge against the checklist below | `findings`, `max_severity`, `target` |
| 6 | `confidence` | function | Score and reasons (§0.6) | `score`, `reasons`, `must_ask` |
| 7 | `gate` | human — `review_artifact` | Decision brief over the mockups; approve / revise. **Multi-select** where the question is which candidate elements to carry forward | `decision`, `comments` |
| 8 | `publish` | function | Write the docs, place mockups under `docs/ui/assets/<component>/`, add index rows | `paths` |

**Loop.** Steps 2–5 repeat until `max_severity < significant`, max 3 (§0.2). A
finding that names a flow step rather than a rendering sets
`target === 'upstream'`: it is a UX finding, the gate always sees it, and the
person routes it back to phase 2.
**Confidence.** The exploration margin matters most here — five designs scored
within a point of each other means the choice was arbitrary, and that is exactly
when a person should look.
**Delegation.** Steps 2 and 4 are coding agents because they write files. Nothing
else in this phase is.
**Artifacts.** `docs/ui/surfaces/<name>.md` · `docs/ui/components/<name>.md` ·
`docs/ui/assets/<component>/<state>.{png,svg,html}` — **winners only** · an edit
to `docs/ui/index.md`. Losing candidate mockups are run artifacts on the task;
what they leave behind is the component's *Instead consider*.

### What the prompt must cover
1. Which surfaces does this live in? Which already exist?
2. What is the one thing seen first on each, and the hierarchy below it?
3. What in the catalog already does this? Read each near match's **Use when / Don't use when** before deciding to build, and record what was checked.
4. What does every UX state look like — not just the happy one? What occupies the space when there is nothing to show?
5. What is the exact copy, and does it read the way `direction.md` says we speak?
6. Behavior under resize, theme, focus order, long or missing content.
7. What must the person learn, versus a pattern they already know?
8. Does it fit the direction — density, motion, weight, colour? If not: exception or amendment?

### What the critique checks
Could a person complete the flow from these screens alone?

- **Flow steps with nowhere to happen**, and elements on a surface no step needs.
- **Does the hierarchy match the job, or the data model?** What reads first should be what the person came for, not the field that happens to be the primary key.
- **Is a new component genuinely a different thing?** Compare it to its nearest catalog entry by *purpose*, not appearance. Two that differ only in padding and label are one component with a prop, and the doc has to say why this is not that.
- **Do the empty and error states carry the person forward?** An empty state reading "no items" has spent the most teachable moment in the interface saying nothing.
- **Does the copy say what the person needs, or what the system did?** "Validation failed" is the system narrating itself.
- **States omitted because they seemed unlikely.** Unlikely is not the bar. Impossible is, and it has to be argued.
- **Would the mockups alone get someone through the flow?** Read them in order as a stranger would; where the sequence stops making sense is a real finding, not a nitpick.
- **Departures from `direction.md`** are an exception or an amendment.

---

## 4. Engineering Spec — `feature/engineering`

**Purpose.** How it is built: the units, their invariants, their failure modes,
and the contracts they own.

**Inputs.** `components` ← `feature/ui` · `flows` ← `feature/ux` · `architecture`
← `docs/engineering/architecture.md` · `principles` · `contracts` ← the catalog

**Outputs.** `units` · `unit_docs` · `contract_docs` · `decisions` ·
`architecture_amendment` (optional)

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Load architecture, principles, contract catalog; report which layer this lands in | `architecture`, `principles`, `layer` |
| 2 | `explore` | composite | Architectures — entered when the work crosses a boundary or adds a unit (§0.5) | `design`, `exploration_doc` |
| 3 | `draft` | prompt | Unit docs: responsibility, data, invariants, failure modes, budgets, compatibility | `unit_docs` |
| 4 | `contracts` | prompt | A doc per API, schema, event, format, or CLI surface, with its compatibility answer | `contract_docs` |
| 5 | `decide` | prompt | A numbered decision record per rejected alternative someone will re-propose | `decisions` |
| 6 | `critique` | prompt | Judge against the checklist below | `findings`, `max_severity`, `target` |
| 7 | `confidence` | function | Score and reasons (§0.6) | `score`, `reasons`, `must_ask` |
| 8 | `gate` | human — `choose_option` | Decision brief: approve / revise / escalate | `decision`, `comments` |
| 9 | `publish` | function | Write unit, contract, and decision docs; amend `architecture.md` if approved; add index rows | `paths` |

**Loop.** Steps 2–6 repeat until `max_severity < significant`, max 3 (§0.2).
**Gate.** The most consequential gate in the workflow: an approved architecture
amendment changes what every later feature is measured against, so it is decided
separately from the units, and it is in `must_ask` — no score resolves it.
**Artifacts.** `docs/engineering/units/<name>.md` ·
`docs/engineering/contracts/<name>.md` ·
`docs/engineering/decisions/<NNNN>-<slug>.md` · an edit to `architecture.md` when
amended · an edit to `docs/engineering/index.md`.

### What the prompt must cover
1. Where does this sit in the architecture — which layer, which side of which boundary? If it doesn't fit the map, is the map wrong or the design wrong?
2. What is the data, where does it come from, and which store is the source of truth when two disagree?
3. What contracts does it own? Which are already public, and who depends on them?
4. What is backward compatible? What migrates, and can it be rolled back after it has run?
5. What are the failure modes — partial write, lost connection, two writers, a process that dies mid-operation?
6. What are the budgets, and which is at risk?
7. Who can do this, what can they see, and what is reachable now that wasn't?
8. What was considered and rejected, and what would make us revisit?
9. What is out of scope, and which deliverable does that leave unmet?

Invariants are phrased so a test can assert them — phase 5's `unit_tests` state
consumes them verbatim, and reports any it cannot express.

### What the critique checks
Do the units cover the behaviour, and do the invariants say anything?

- **Components and flows with no unit behind them** — and units that serve nothing.
- **Invariants that cannot be false.** "The store returns valid data" is decoration. One worth writing names a state the system could actually reach and is forbidden from, and phase 5 has to be able to assert it.
- **Failure modes that are only the easy ones.** Which has it *not* answered: two writers at once, a process killed mid-write, a partial read, a retry that duplicates, a clock that moved? Naming "network error" and stopping is the usual shape of an incomplete list.
- **Every failure mode maps to a UX state.** If one has none, that is `blocked`: either phase 2 missed a state or the failure cannot occur, and a person decides which.
- **One owner per fact.** Where two stores hold the same thing, is the source of truth named and the other one derived?
- **Units that are one responsibility split across a file boundary**, or one file holding two responsibilities.
- **Is the compatibility answer honest about existing data** — not just the schema, but rows written by the version running right now?
- **Budgets that are adjectives.** "Fast" is not a budget. If nothing is at risk, say so and drop the section.
- An architecture change lives in `architecture.md`, not only in the unit doc.

---

## 5. Engineering Implementation — `feature/implementation`

**Purpose.** Land it, in an order that keeps the tree green at every step —
**with the unit tests that defend phase 4's invariants, written here, beside the
code they check.**

**Inputs.** `units` ← `feature/engineering` (with their invariants and
contracts) · `standards` ← `docs/engineering/standards.md`

**Outputs.** `changes` · `unit_tests` · `verified_by` · `docs_touched` ·
`design_findings` · `standards_amendment` (optional)

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Load `standards.md`, the unit docs, and every invariant and contract they declare | `standards`, `units`, `invariants` |
| 2 | `explore` | composite | Decompositions — one big change, a flagged series, a strangler (§0.5) | `plan` |
| 3 | `confirm` | human — `confirm_action` | Only when the plan contains an irreversible change: a migration that has run, a published contract, deleted data. Shows the recovery plan | `confirmed` |
| 4 | `implement` | **agent** | Write the code, one change at a time, in the plan's order | `changes` |
| 5 | `unit_tests` | **agent — a separate instance** | Unit and contract tests, **written from `invariants` rather than from the diff**. Reads the code only to find the seams. Reports any invariant it cannot assert | `unit_tests`, `unassertable` |
| 6 | `verify` | function | Build and run the suite after **each** change, not only the last | `green`, `results` |
| 7 | `classify` | prompt | Per failure: is the *code* wrong, or is the *design* wrong? (below) | `finding_class`, `design_findings` |
| 8 | `sync_docs` | agent | Apply the change's `doc_updates`, and write `verified_by` onto each unit doc | `docs_touched`, `verified_by` |
| 9 | `critique` | prompt | Judge against the checklist below | `findings`, `max_severity`, `target` |
| 10 | `confidence` | function | Score and reasons (§0.6) | `score`, `reasons`, `must_ask` |
| 11 | `gate` | human — `review_artifact` | Decision brief over the diff, the tests, and the doc edits; approve / revise | `decision`, `comments` |

**Loop.** `verify` failing → `classify`; an `implementation` finding goes back to
step 4 for that change, max 3. Then steps 2–9 repeat until
`max_severity < significant`, max 3 (§0.2).
**Branch.** A `design` finding leaves this phase and re-enters
`feature/engineering` at the root (§0.1), carrying the evidence.
**Delegation.** Steps 4, 5, and 8 are coding agents. **Steps 4 and 5 are separate
instances**: an agent that writes a test right after writing the code tests what
it built, not what was specified. Step 5 is prompted from the unit doc.
Steps 6 and 7's arithmetic — did it build, did it pass — is host code. "The tests
pass" is not a judgment call and must not be one.
**Gate.** Step 3 is a gate *before* the work, not after: the point of confirming
an irreversible change is that it has not happened yet.
**Artifacts.** Code and unit tests. Plus `verified_by` and `doc_updates` edits.
**No new doc file** — the change plan lives on the task, because a list of files
is worthless to next quarter's reader.

### Implementation wrong, or design wrong?

A failing test means one of two things, and conflating them is how a design
defect becomes a weakened assertion.

| Class | Looks like | Goes to |
| --- | --- | --- |
| `implementation` | The code does not do what the unit doc says | Step 4 |
| `design` | The unit doc cannot be satisfied: an invariant that cannot hold, a failure mode with no recovery, a contract that cannot be met, two invariants that contradict | `feature/engineering` |

Two rules make the split real rather than nominal:

- **A test may not be weakened to pass.** An assertion that encodes a phase-4
  invariant is a fixed point. Changing it requires a `design` finding, and the
  invariant text is in the unit doc, so this is checkable rather than a matter of
  trust.
- **`unassertable` is a design finding, not a gap.** If step 5 cannot express an
  invariant as a test, the invariant is not phrased so a test can assert it —
  which is what phase 4's checklist demanded. That goes back too.

### What the prompt must cover
1. What is the smallest thing that can land and be useful — or at least safe — on its own?
2. What order keeps the tree working? What hides behind a flag until the rest arrives?
3. What depends on what, and what can go in parallel?
4. What is deleted? Does the old path go in this change, or a named follow-up?
5. What rolls back independently, and what is a one-way door?
6. What does "done" mean for each change — the observable, not the intent?
7. Which docs does this make wrong the moment it lands?
8. For step 5: what would have to be true for each invariant to fail, and what is the cheapest test that would catch it?

### What the critique checks
Does the code do what the unit doc says, and do the tests defend the claim rather than the code?

- **Behaviour that diverges from the unit doc** — including the parts the doc specified and the code merely approximated.
- **Tests that assert the implementation rather than the invariant.** The tell: a test that would have to change during any honest refactor, or one whose structure mirrors the code's internals. It is testing shape, not behaviour.
- **Invariants asserted only incidentally**, by a test aimed at something else. That test will be rewritten one day by someone who does not know it was load-bearing.
- **Every invariant asserted, or raised as a `design` finding.** None silently unverified.
- **No assertion encoding an invariant was edited to make a test pass.**
- **Changes that only stand alone on paper.** Would change 2 really be safe to merge without change 3? `verify` proved it built; this asks whether it was *useful*.
- Every irreversible change went through step 3; every `doc_updates` entry was edited in the same change.
- Departures from `standards.md` are an exception or an amendment.

---

## 6. Acceptance — `feature/acceptance`

**Purpose.** Prove the **product deliverables**, not the units. Phase 5 already
defended every phase-4 invariant with a unit test beside the code; nothing here
repeats that. This phase asks the only question those tests cannot: *can the
person from the story actually get the value?*

The split follows the traceability spine — unit and contract tests defend
`engineering/units/*` invariants, acceptance tests defend `product/*`
deliverables. That is also why the review conformance pass reads this phase's
results for its Product row and phase 5's for its Engineering row.

**Inputs.** `features` (with their success signals) ← `feature/product` · `flows`
← `feature/ux` · `changes` and `unit_tests` ← `feature/implementation`

**Outputs.** `acceptance_tests` · `diagnosability` · `verified_by` ·
`manual_procedures` · `design_findings` · `unverified`

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Collect every deliverable with `importance >= 0.5`, its success signal and flow, plus the existing e2e suites and what phase 5 already covers | `claims`, `covered`, `suites` |
| 2 | `explore` | composite | How to drive it — through the UI, through the CLI, at the contract seam, or against a real store (§0.5) | `map` |
| 3 | `write` | **agent** | One test per deliverable, walking the flow's steps, asserting the **success signal** — not mocking the thing under test | `acceptance_tests` |
| 4 | `run` | function | Run them | `results` |
| 5 | `mutate` | function | Break the code deliberately, in two or three ways you actually expect, and check the suite fails **and names the cause** | `diagnosability` |
| 6 | `classify` | prompt | Per failure: implementation, design, or **spec** — the flow as written cannot deliver the value | `finding_class`, `design_findings` |
| 7 | `link` | function | Write `verified_by` onto the feature and component docs each test defends | `verified_by` |
| 8 | `manual` | prompt | What cannot be automated becomes a procedure a person runs | `manual_procedures` |
| 9 | `critique` | prompt | Judge against the checklist below | `findings`, `max_severity`, `target` |
| 10 | `confidence` | function | Score and reasons (§0.6). `must_ask` on any unverified claim | `score`, `reasons`, `must_ask` |
| 11 | `gate` | human — `choose_option` | Decision brief. **Multi-select** over the unverified claims: which gaps to accept, which to send back | `decision`, `accepted`, `comments` |

**Loop.** Steps 2–9 repeat until `max_severity < significant`, max 3 (§0.2).
**Branch.** `classify` routes out of this phase, and the class decides where:
`implementation` → `feature/implementation`; `design` → `feature/engineering`;
`spec` → `feature/ux`, because a flow that cannot deliver its success signal is
a UX defect, not a test failure.
**Delegation.** Step 3 is an agent. Steps 4, 5, and 7 are host code — a model
must not be the thing that reports whether tests passed.
**Gate.** Always runs, and resolves quietly when every claim was verified — an
unverified claim is in `must_ask`, so the gaps are what reach a person.
**Artifacts.** Acceptance tests in the repo. Plus `verified_by` edits, and manual
procedures written as `docs/guides/<name>.md` with `audience: operator` — a
procedure run every release is durable operational knowledge, not process output.

### What the prompt must cover
1. For each deliverable, what is the success signal from its flow, and what test fails when the person stops getting it?
2. Which deliverables break *silently* — no crash, no error, just wrong? Those get the most coverage.
3. What is already covered by phase 5's unit tests? Do not re-assert an invariant here; assert the value.
4. What has to be real for this test to mean anything — the store, the agent runtime, the file system — and what may still be faked?
5. What does each phase-4 failure mode look like to the *person*, not to the unit?
6. What cannot be tested automatically, and what is the script a person follows?
7. What existing test does this feature invalidate?

### What the critique checks
Would these tests still pass if the feature delivered nothing useful?

- **The central question, per test:** imagine the feature technically working and worthless — the data loads but is wrong, the run starts but never finishes. Does this test still pass? Then it asserts an intermediate, not the success signal.
- **Deliverables with no test**, especially the ones that break *silently*: no crash, no error, just wrong. Those need the most coverage and usually have the least.
- **Tests that take a shortcut the person cannot take** — through the API when the deliverable is reached through the UI. They pass while the real path is broken.
- **Acceptance tests that re-assert a unit invariant** already covered in phase 5: duplicated cost, and a false reading of coverage.
- **Failure modes invisible from outside.** Every phase-4 mode should be reachable and observable the way the person experiences it, or recorded as unverified.
- **Diagnosability.** Step 5's mutations must make the suite fail *and name the cause*. A suite that goes red without saying why gets ignored in six months.
- Every `done_when` from phase 5 has a test that would notice it regressing; invalidated tests are deleted or rewritten, not skipped.

---

## 7. Documentation — `feature/documentation`

**Purpose.** The audience-facing writing, and the sweep for what the last six
phases made wrong.

**Inputs.** `features` · `contracts` · `paths` (every doc touched so far)

**Outputs.** `guides` · `reference` · `corrections`

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `context` | function | Collect every doc this feature touched, and the audiences from the product docs | `touched`, `audiences` |
| 2 | `explore` | composite | Entry points — a guide, a reference table, an example, or in-product copy that means no doc is needed (§0.5) | `shape` |
| 3 | `draft` | prompt | Write the guide or reference, one per audience | `guides`, `reference` |
| 4 | `verify_example` | function | Run every example verbatim, from the state a new reader is in | `example_verified` |
| 5 | `sweep` | function | Find what is now stale: broken `supersedes` chains, mockups marked `stale`, `proposed` status on shipped work, missing index rows, unresolved ids | `stale` |
| 6 | `correct` | agent | Fix what the sweep found | `corrections` |
| 7 | `confidence` | function | Score and reasons (§0.6) | `score`, `reasons`, `must_ask` |
| 8 | `gate` | human — `edit_markdown` | The person edits the text directly rather than approving someone else's | `final_text` |
| 9 | `publish` | function | Write the guides and corrections | `paths` |

**Loop.** `verify_example` failing → back to step 3, max 3.
**Gate.** `edit_markdown`, not `review_artifact` — copy is the one artifact where
the reviewer's own words are faster than a round of revision.
**Artifacts.** `docs/guides/<name>.md` · `docs/reference/<name>.md` · corrections
across the tree.

### What the prompt must cover
1. Who reads this, and what were they trying to do when they went looking?
2. What do they need in the first ten lines to get unstuck?
3. Which existing document is now *wrong*? Stale docs cost more than missing ones.
4. What is the worked example, and has it been run?
5. What is the trap — the thing that fails silently, or works differently than the obvious reading suggests?
6. Guide, reference, changelog, or a comment next to the code?

### What the critique checks
Does the reader get unstuck, and is any of this untrue?

- **Does the first paragraph answer what they came for?** Read it as someone mid-task with a specific question. If the answer is in paragraph six, the document is organized around the writer.
- **Does it describe what exists, or what was intended?** Every claim checkable against the code that shipped, not the spec that preceded it. This is where phases 1–6's drift surfaces.
- **Missing traps.** The team knows things that fail silently or read the wrong way. Which of those did phases 3 and 4 record and this document omit?
- **Two documents saying the same thing differently.** One of them is now stale and nobody knows which.
- **Is the example real?** It must run from the state a new reader is actually in, not from the author's shell.
- **Reachable but undocumented**: any deliverable an outside person can reach, any public contract with no reference entry.
- Every manual procedure from phase 6 is followable without asking a question.

---

## 8. Review — `feature/review`

**Purpose.** Ask, layer by layer, whether what was built matches what *that
layer* said it would be. Review is not a document and adds no folder; it is the
pass, and its output is findings plus corrections.

**Inputs.** everything: `features`, `flows`, `components`, `units`, `changes`,
`tests`, `paths`

**Outputs.** `verdict` (`ship` \| `revise` \| `drop`) · `failing_layer` ·
`findings` · `disposition`

### Steps

| # | State | Runs as | Does | Outputs |
| --- | --- | --- | --- | --- |
| 1 | `conformance` | prompt | One judgment per layer, each against that layer's own statement (table below) | `layer_verdicts` |
| 2 | `lens_a` | **agent** | Independent find pass — correctness and the next maintainer | `findings_a` |
| 3 | `lens_b` | **agent, a different runtime** | Independent find pass — the person we serve, and the operator at 3am | `findings_b` |
| 4 | `merge` | prompt | Reconcile: dedupe, keep disagreements as separate rows, attribute each finding to a lens and a deliverable id | `findings`, `failing_layer` |
| 5 | `dispose` | prompt | Every deliverable into exactly one of shipped / cut / reduced | `disposition` |
| 6 | `confidence` | function | Score and reasons (§0.6). `must_ask` on any open blocker, any `drop`, any auto-approved gate this run that conformance overturned | `score`, `reasons`, `must_ask` |
| 7 | `gate` | human — `choose_option` | Decision brief: ship / revise / drop. **Multi-select** over the findings: which to accept now, which become follow-ups | `verdict`, `accepted`, `comments` |
| 8 | `correct` | agent | Edit the docs that turned out to be wrong: reduced deliverables, accepted risks onto the unit docs, process lessons into this file | `corrections` |

**Branch.** `verdict === 'revise'` returns to `failing_layer` at the root (§0.1).
`drop` and `ship` both terminate; the difference is what `dispose` recorded.
**Delegation.** Steps 2 and 3 are two coding agents on different runtimes,
running concurrently and **not sharing a document** — that independence is the
whole mechanism, and it is the two-agent review of
[WORKFLOWS.md §12.1](WORKFLOWS.md). Step 4 is the third state that merges what
they found.
**Artifacts.** No new doc. Findings and disposition live on the task; step 7
edits the docs that were wrong.

### The conformance pass

| Layer | Checked against | Passes when |
| --- | --- | --- |
| Product | The story, the scope lists, the importances | A person from the story can get the value, and the `importance: 1.0` set is present |
| UX | The flow's steps, states, reversibility | Every step exists in order; every state occurs as written; undo works within its stated window |
| UI | Anatomy, states, copy, mockups | The screen matches the mockups or they were re-captured; every error names a next action |
| Engineering | Invariants, failure modes, budgets, contracts | Invariants hold under the tests; every failure mode was triggered; public contracts changed only as the compat note allows |
| Standards | `standards.md`, `direction.md`, the principles docs | Every departure is an exception or a landed amendment — no silent ones |

A failing row names the **deliverable id**, not a file. That is what makes it
answerable: "this violates `ux/flows/prune-session` step 3" ends an argument that
"this feels wrong" cannot — and it is what lets the root transition know which
phase to re-enter.

### What the merge state must produce
- Findings with severity (blocker / should-fix / note), the claim, the evidence (`path:line` or a reproduction), the deliverable id, and the lens that found it.
- Before recording a finding, the strongest argument that it is *not* a problem. If that argument holds, it was a note.
- `failing_layer`: the earliest layer with a blocker. Earliest, because a UX blocker makes the UI findings moot.
- Follow-ups, including every deferred deletion from phase 5 and every unbuilt `importance >= 0.5` deliverable.

### What the critique checks
Does the evidence actually establish the claim each layer made?

- **Conformance rows marked pass on thin evidence.** "The invariants hold" backed by a suite that never triggered the failure mode is not a pass, it is an absence of information. Which rows are green because nothing looked?
- **Findings that are taste, not defects.** Each should name the deliverable it violates. One that cannot is a note, and notes should not be holding up a ship.
- **The disposition against reality.** A deliverable marked shipped whose acceptance test asserts an intermediate did not ship. Read the disposition against phase 6's results, not against the diff.
- **Reductions that were never written down.** A `reduced` deliverable whose product doc still describes the original is the single most common way this tree starts lying.
- **A lens that found nothing twice running** — misconfigured, or unnecessary; say which.
- **Every auto-resolved gate this run, against what conformance found.** One that review overturns means `ask_below` is too low for that phase — recorded as a calibration finding against the phase, not against the feature.
- Every accepted risk is written where the next person will hit it, not only in the findings.

---

## 9. Worked translation — phase 1 as state files

What §1 becomes, so the mapping is not a matter of taste. Abridged to the parent,
one leaf, and the gate.

**`feature/product.json`** — the seven children, the refine loop, and the
confidence-guarded gate.

```jsonc
{
  "label": "Product Spec",
  "environment": { "kind": "prompt", "model": "anthropic/claude-sonnet-5" },
  "inputs": {
    "issue": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } }
  },
  "outputs": {
    "features":  { "binding": ".children.draft.outputs.features" },
    "decision":  { "binding": ".children.gate.outputs.decision" },
    "paths":     { "binding": ".children.publish.outputs.paths" }
  },
  "children": {
    "context": { "inputs": { "area": { "text": "product" } } },
    "explore": { "inputs": { "issue": ".inputs.issue", "principles": ".children.context.outputs.principles" } },
    "draft":   { "inputs": {
      "issue":       ".inputs.issue",
      "principles":  ".children.context.outputs.principles",
      "catalog":     ".children.context.outputs.catalog",
      "framing":     ".children.explore.outputs.framing"
    } },
    "critique": { "inputs": {
      "features":           ".children.draft.outputs.features",
      "severity_threshold": { "text": "significant" },
      "prior_findings":     ".children.critique.outputs.findings"
    } },
    "confidence": { "inputs": {
      "critique":   ".children.critique.outputs",
      "exploration": ".children.explore.outputs",
      "iteration":  { "expr": ".run.iteration" },
      "ask_below":  ".inputs.ask_below"
    } },
    "gate":    { "inputs": {
      "docs":  ".children.draft.outputs.feature_docs",
      "brief": ".children.confidence.outputs.brief"
    } },
    "publish": { "inputs": { "docs": ".children.draft.outputs.feature_docs" } }
  },
  "sequence": ["context", "explore", "draft", "critique", "confidence", "gate", "publish"],
  "transitions": [
    { "to": "confidence",
      "when": ".children.critique.outputs.max_severity_rank < .inputs.threshold_rank" },
    { "to": "confidence",
      "when": ".children.critique.outputs.target === 'upstream'" },
    { "to": "confidence",
      "when": ".run.iteration >= .limits.max_iterations" },
    { "to": "explore",
      "when": ".children.critique.outputs.target === 'explore'" },
    { "to": "draft",
      "when": ".children.critique.outputs.target === 'draft'" },
    { "to": "terminate.error",   "when": ".children.gate.outputs.decision === 'cut'" },
    { "to": "terminate.success", "when": ".children.publish.outcome === 'success'" }
  ],
  "limits": { "max_iterations": 3 }
}
```

**`feature/product/draft.json`** — a prompt state. The doc artifact is a `blob`
slot; `contentMediaType` is what makes it one
([WORKFLOWS.md §10](WORKFLOWS.md)).

```jsonc
{
  "label": "Draft deliverables",
  "inputs": {
    "issue":      { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } },
    "principles": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } },
    "catalog":    { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } },
    "framing":    { "schema": { "type": "string" }, "optional": true }
  },
  "outputs": {
    "features": { "schema": { "type": "array", "items": {
      "type": "object",
      "required": ["id", "story", "importance", "metrics"],
      "properties": {
        "id":         { "type": "string" },
        "story":      { "type": "string" },
        "importance": { "type": "number", "minimum": 0, "maximum": 1 },
        "metrics":    { "type": "array", "items": { "type": "string" } },
        "requires":   { "type": "array", "items": { "type": "string" } }
      } } } },
    "feature_docs": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } }
  },
  "operation": { "prompt": "…the six questions of §1, the deliverable form, and docs/_templates/product-feature.md…" }
}
```

**`feature/product/gate.json`** — a UI gate is a function state. Declaring
`kind: "function"` drops the inherited call settings so it does not silently
receive the model ([WORKFLOWS.md §5.2](WORKFLOWS.md)).

**This state is not guarded.** It runs on every pass. Whether it parks for a
person or resolves on the recommendation is the component's call, from `brief`
and the viewer's `ask_below` — so the state file says nothing about the policy,
and raising the threshold mid-project changes no workflow.

The option objects and `ask_below` below are the proposed contract
([gate-components](docs/engineering/contracts/gate-components.md)); until it
lands they degrade to bare `enum` values with the pros and cons folded into
`prompt`.

```jsonc
{
  "label": "Approve deliverables",
  "inputs": {
    "docs":  { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } },
    "brief": { "schema": { "type": "object" } }
  },
  "outputs": {
    "decision": { "schema": { "type": "string", "enum": ["approve", "revise", "cut"] } },
    "comments": { "schema": { "type": "string" }, "optional": true }
  },
  "operation": {
    "kind": "function",
    "function": "review_artifact",
    "args": {
      "prompt":   "These are the product deliverables. Approve, send back, or cut the feature.",
      "artifact": { "expr": ".inputs.docs" },
      "brief":    { "expr": ".inputs.brief" },
      "ask_below": { "expr": ".inputs.brief.ask_below" },
      "options": [
        { "value": "approve", "means": "UX planning starts from these deliverables",
          "pros": ["…"], "cons": ["…"], "drives": "…", "recommended": true },
        { "value": "revise",  "means": "Back to draft with your comments",
          "pros": ["…"], "cons": ["…"] },
        { "value": "cut",     "means": "The workflow terminates; nothing downstream is built",
          "pros": ["…"], "cons": ["…"] }
      ]
    }
  }
}
```

### How to read the rest of this document as states

| In a phase section | Becomes |
| --- | --- |
| **Inputs** line | the state's `inputs`, bound to the producing phase's outputs |
| **Steps** row | one child state; `runs as` picks `operation.kind` and, for `function`, which function |
| Step order | `sequence` |
| **Loop** line | `transitions` guarded on `critique.outputs.max_severity` and `target`, plus `limits.max_iterations` |
| **Gate** line | an **unguarded** `function` child naming a gate component, with its options as the output enum. Asking or auto-resolving is the component's decision, from the brief — never a transition |
| **Delegation** line | `operation.function` naming an agent runtime — `claude-code`, `claude-cli`, `codex-cli` |
| **Artifacts** line | `blob` outputs with `contentMediaType`; placement is the project's `artifacts.destination`, never the workflow's |
| **What the prompt must cover** | prompt text for that state |
| **What the critique checks** | prompt text for the `critique` state, and the source of its `findings`. Structural rules are **not** here — `publish` validates those in host code (§0.2) |
