---
id: ui/components/<component-name>
type: ui-component
status: proposal          # proposal → shipped; stale when the code moved on
updated: YYYY-MM-DD
realizes: [ux/flows/<flow-name>]
surfaces: [ui/surfaces/<surface-name>]
reuses: [ui/components/<other>]
implemented_by: [engineering/units/<name>]   # added in phase 4
verified_by: ["packages/…/foo.test.ts"]      # added in phase 6
mockups: [ui/assets/<component-name>/default.png]
exceptions: [{doc: ui/direction, rule: "…", why: "…"}]
siblings: [ui/components/<confusable>]
---

# <Component name>

One sentence someone could match against a screenshot.

## Use when

The situations this is the right component for.

## Don't use when

The situations it isn't — as concrete as the list above.

## Instead consider

| Situation | Use | Why |
| --- | --- | --- |
| | [ui/components/…](…) | |

## Where this fits

- **Direction** — how this reads against [ui/direction.md](../direction.md):
  density, tone of the copy, motion. Silence means it conforms; a departure is an
  `exceptions` entry or an amendment to the direction itself.
- **Serves** — the flow steps this carries.
- **Neighbors** — the components nearest this one and how we keep them distinct.
- **Depends on / used by** — what it reuses; which surfaces place it.
- **History** — what it replaces. If new, what in the catalog was checked first
  and why none of it fit.

## Anatomy

Contents in priority order, most prominent first.

## States

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | | [empty.png](../assets/<component-name>/empty.png) |
| loading | | |
| partial | | |
| error | | |
| success | | |

## Interactions

| On | Does | Feedback |
| --- | --- | --- |
| | | |

`Feedback` is what changes to confirm it happened. "Nothing" is an answer that
needs defending.

## Copy

| Where | String |
| --- | --- |
| | |

Every error says what happened and what to do next.

## Behavior

Resize, theme, focus order, overflow, missing or very long content.

## Mockups

| State | File | Captured | Reflects |
| --- | --- | --- | --- |
| | | YYYY-MM-DD | proposal / shipped / stale |

`reflects: shipped` means it matched the code on the captured date. A mockup
without these columns is worse than no mockup, because it will be believed.
