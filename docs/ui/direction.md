---
id: ui/direction
type: standing
status: proposed
updated: 2026-08-18
---

# Visual direction

The vocabulary: theme, tone, density, motion, typography, colour. Where
[principles.md](principles.md) is how we decide, this is what we decided —
the shared language a component doc can point at instead of re-specifying.

Phase 3 of [WORKFLOW.md](../../WORKFLOW.md) checks a design against this; a
component that must break it records an `exceptions` entry or amends this file.

> **Needs filling in.** This is the one standing doc that cannot be inferred from
> code without looking at the running app, and guessing at it would be worse than
> leaving it open — every wrong value here propagates into every component doc.
> The headings are the questions worth answering. `npm run app`, or
> `JAIRA_CAPTURE=<file.png> npm run app` for a screenshot without a human at the
> keyboard, is the fastest way to write the first draft from what exists.

## The one-line description

_To write._ If someone described this product's look in a sentence to a designer
who had never seen it, what is the sentence? Everything below should be
recognisably downstream of it.

## Tone of voice

_To write._ How the product talks: in labels, in empty states, in errors. Terse
or explanatory. Whether it ever uses "we". What it never does — apologise,
exclaim, personify the agent.

This section is cited more often than any other, because every component doc has
a Copy table.

## Colour

_To write._ The roles, not the hex values — surface, raised surface, border,
text, muted text, accent, and the status colours (running, parked at a gate,
failed, cancelled). Where the values live in code, link to them here rather than
duplicating; a token list copied into a doc is stale within a month.

Also: what colour is *not* allowed to be the only carrier of.

## Typography

**Two voices.** A string's family says what kind of word it is before anybody
reads it.

- **App voice** (sans, `--font-app`) is for words JaiRA chose: the names of
  rooms, actions and states. They are the same on every machine and in every
  project. `JAIRA`, `Files`, `Tasks`, `Settings`, `Awaiting you`, `running`,
  `waiting for user`, `All projects`.
- **Data voice** (mono, `--font-data`) is for words something else chose: paths,
  project names, state ids, workflow names, task titles, commands, counts.
  Different on every machine, and the thing a person is actually there to read.
  `declarative-ai`, `prompts/review.md`, `feature.plan`, `rm -rf ./build`, `40s`.

The awkward cases are what the rule is for. A board column heading (`plan`,
`build`, `review`) looks like an app label and is not — those are the child
states of whatever workflow is open, so they are data. `All projects` is the
opposite case: the one app crumb in an otherwise data-voiced address bar,
because it names a level rather than a directory.

Three laws:

1. **Voice is the face. State is weight, colour and ground.** Selection and
   emphasis may move weight, colour and background as far as they like. Neither
   may touch the family. A row that switches to mono to look more selected is
   how this system stops meaning anything.
2. **Data never takes `text-transform`.** Uppercasing `review.md`
   misrepresents it — paths and ids are case-sensitive, so changing their case
   is a lie about the value. That is what leaves uppercase free as an app-only
   signal.
3. **The quietest register is `--tok-hint`, not an opacity.** The palette
   already carries it, described as "dimmer than `--dim`", for a hint sitting on
   a line of code.

**Ten registers**, in `styles.css`. No component carries a literal font-size:
every register is a multiple of its voice's base (`--size-app`, `--size-data`),
so one preference moves a whole voice with every ratio intact.

| Register | Size | Weight | Case | Colour |
| --- | --- | --- | --- | --- |
| `.app-title` | `--size-app` × 1.05 | 700 | sentence | `--text` |
| `.app-label` | × 0.80 | 700 | UPPER, `.1em` | `--dim` |
| `.app-text` | × 1.00 | 500 | sentence | `--text` |
| `.app-secondary` | × 0.88 | 400 | sentence | `--dim` |
| `.app-absent` | × 1.00 | 500 | italic | `--tok-hint` |
| `.data-title` | `--size-data` × 1.12 | 700 | — | `--text` |
| `.data-text` | × 0.96 | 400 | — | `--text` |
| `.data-secondary` | × 0.84 | 400 | — | `--dim` |
| `.data-faint` | × 0.84 | 400 | — | `--tok-hint` |
| `.data-num` | × 0.79 | 600 | tabular | `--dim` or semantic |

`.app-label` is for a **heading over a group**, not for a row that goes
somewhere; that allocation is what keeps the nav consistent. `.app-absent` is
app text standing where data would be — "open a project…", an empty column — and
is the register that makes a meaningful blank not read as an omission.

`.is-active` is the only state class, and it may touch exactly three properties:
weight, colour, ground.

Both stacks lead with **concrete names**; `ui-monospace` sits at the back rather
than the front, because some engines alias it to the proportional system UI font
and would turn every code surface proportional. Both are user-settable — see
[SHELL.md](../../SHELL.md) §6, which prepends a chosen family onto the default
stack rather than replacing it, so a face missing a glyph falls through instead
of showing tofu.

## Spacing and density

_To write._ The base unit and the scale. This product shows dense state — boards,
trees, event streams — so the interesting question is which surfaces are allowed
to be dense and which must stay calm.

## Elevation and borders

_To write._ How separation is expressed. Whether panels are bordered, shadowed,
or only differentiated by surface colour.

## Motion

_To write._ Durations, easing, and what is allowed to animate. Runs here take
minutes; the honest question is what motion communicates *progress* versus what
merely fills time.

## Iconography

_To write._ The set, the weight, whether icons ever appear without a label.

## Dark and light

_To write._ Whether both are supported, which is primary, and what is allowed to
differ beyond colour.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Created as a scaffold | The docs tree was created |
| 2026-08-18 | Typography filled in: two voices, ten registers | SHELL.md §3 — the shell redesign needed a rule that decides the awkward cases, and this is the doc that holds it |
