---
id: ui/surfaces/<surface-name>
type: ui-surface
status: proposal
updated: YYYY-MM-DD
kind: screen | panel | dialog | output | notification
realizes: [ux/flows/<flow-name>]
components: [ui/components/<component-name>]
mockups: [ui/assets/<surface-name>/default.png]
siblings: [ui/surfaces/<adjacent-surface>]
---

# <Surface name>

What this is and where it physically lives — what it sits beside, and what it
displaces when it appears.

## Where this fits

- **Serves** — the flows and steps that land here.
- **Neighbors** — the surfaces a person could confuse this with, and the rule
  for which one a given job belongs on.
- **Depends on / used by** — components placed here; how a person arrives.
- **History** — what this replaces or splits from.

## Hierarchy

The one thing the person should see first, then everything below it in priority
order.

## States

| State | Surface shows | Notes |
| --- | --- | --- |
| empty | | What occupies the space when there is nothing to show. |
| loading | | |
| error | | |
| success | | |

## Entry and exit

How a person gets here, and where each exit leaves them.

## Behavior

Resize, theme, focus order on entry, what happens to unsaved work on exit.

## Mockups

| State | File | Captured | Reflects |
| --- | --- | --- | --- |
| | | YYYY-MM-DD | proposal / shipped / stale |
