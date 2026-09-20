---
id: ui/components/task-metrics
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/context-beside-what-you-stand-on]
serves: [product/know-what-work-costs]
surfaces: [ui/surfaces/files-view]
reuses: []
implemented_by: [packages/app/src/renderer/files.tsx]
verified_by: []
mockups: [ui/assets/task-metrics/partial.html, ui/assets/task-metrics/success.html]
siblings: [ui/components/task-panel, ui/components/state-inspector, ui/components/letterhead]
---

# Task metrics

A `METRICS` section in the Files context panel with its call count at the far right, over a two-column list of dim labels and tabular values: when it started, time spent in calls, cost with an amber chip when the figure is not the provider's own, and input, output and cache tokens.

## The section sums what a run or a task consumed, where the panel describes it

**Use when.** The Files view's context panel describes a run on the address, where the section sums that run's own calls under its facts, or a task, where it sums every call the task made above the list of states it ran.

**Do not use when.** One state's cost is shown where the state is: the Files panel's list of states a task ran carries each state's cost, and a folded [letterhead](letterhead.md) carries its own. The task's standing and verbs are [task-panel](task-panel.md), drawn below this section. A state's configuration is [state-inspector](state-inspector.md).

## The heading and count read first, then one fact per row in a fixed order

- **Heading.** The small uppercase app caption in `--dim` with wide tracking: `METRICS` at the left, the call count at the right in the same caption at normal weight.
- **Rows.** A grid with a 58px label column and 10px between columns, 4px between rows, in the app face at the small size. Labels in `--dim`, values in `--text` with tabular figures and thousands separators.
- **Order.** `started`, `in calls`, `cost`, `in`, `out`, `cache`. A row shows only when its value was recorded.
- **Cost chip.** After the figure, 5px away: an outline pill chip in `--warn`, `price table` when the cost was worked out from a price table, `unknown` when any call's cost source is unknown. A provider's own charge has no chip. The worst source among the calls decides.
- **Out and cache.** `out` adds ` · {n} thinking` in smaller `--dim` text; `cache` reads `{n} read` then ` · {n} written`, with `—` standing for reads that were not reported.

## The rows that appear say how much was reported

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the panel draws the section only for a run or task with at least one call, and every call has a start time. | |
| loading | Cannot occur: the section sums what is already recorded and redraws as calls settle. | |
| partial | Calls that have not reported usage, such as one still in flight: `started` alone, or `started` and `in calls`. | [partial.html](../assets/task-metrics/partial.html) |
| error | Cannot occur: a figure the app cannot vouch for is marked with the chip, not refused. | |
| success | Every row, with the cost chip absent for a provider's charge, `price table` for an estimate and `unknown` where the source is unknown. The three are drawn stacked. | [success.html](../assets/task-metrics/success.html) |

## The rows answer a resting pointer and nothing else

| On | Does | Feedback |
| --- | --- | --- |
| Pointer rests on `started` | Nothing | The start as an ISO timestamp |
| Pointer rests on `in` | Nothing | `total billed input, including cache reads and writes` |
| Pointer rests on `cache` | Nothing | `read at roughly a tenth of the base rate; written above it` |
| Pointer rests on the cost chip | Nothing | `not the provider's own charge` |

## The copy is short labels and exact figures

| Where | String |
| --- | --- |
| Heading | `Metrics` · `{n} calls`, also `1 calls`; drawn uppercase |
| Labels | `started` · `in calls` · `cost` · `in` · `out` · `cache` |
| Started | `{local date and time}` |
| In calls | `{n} ms` under a second · `{s.s} s` under a minute · `{m} m {s} s` |
| Cost | `${cost to 4 decimal places}`, such as `$0.2143` |
| Cost chip | `price table` · `unknown` |
| In | `{n}`, such as `48,912` |
| Out | `{n}` then ` · {n} thinking` |
| Cache | `{n} read` or `—`, then ` · {n} written` |

## The section stretches with the panel and wraps long values

- It takes the panel's width. Values wrap anywhere rather than ellipsise; the label column stays 58px.
- Theme: labels, values and the chip are tokens.
- Focus: nothing in the section is focusable, so its tooltips are reached by pointer only.

## The figures are set in the app face

- The counts, durations and cost are data drawn in the app face with tabular figures, not `.data-num`.
