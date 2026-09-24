---
id: ui/surfaces/settings-runs
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/schema-driven-form, ux/patterns/absence-is-stated]
serves: [product/work-inside-wsl, product/share-processes-across-projects, product/try-a-process-without-spending, product/move-work-on-by-hand]
components: [ui/components/settings-header, ui/components/settings-field, ui/components/schema-form, ui/components/switch]
mockups: []
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-data, ui/surfaces/settings-models]
---

# Settings runs

The Runs page of the [Settings view](settings-view.md): how a run behaves while it is going — where its commands run, whether a model's answer is remembered, when a fast-forward leaves a question to the person, and where a bare workflow reference is looked up. Four short sections of rows, each row led by a switch that says whether the layer being edited states it.

## The page is four sections, one question each

- **Head.** `Runs`, the lead `How a run behaves while it is going.` followed by the layer sentence, and the [layer switch](../components/settings-header.md) at the head's top-right.
- **Where commands run.** `Environment`, a select of `natively on Windows` and `inside a WSL distro`. `Distro`, a mono box, appears under it while a distro is chosen and follows the same switch.
- **Memoization.** `Remember model answers`, a yes/no.
- **Fast-forward.** `Leave it to me below`, a number between 0 and 1.
- **Workflow lookup.** `Search path`, a list across the row, one root per line.

Each section is a quiet sentence-case heading with an `ⓘ` over one bordered card, at most 740px wide. A row is its name, one sentence under it, the control at the right edge, and an `ⓘ` holding the rest of its explanation and the key it writes; the [schema form](../components/schema-form.md) draws the last three sections' rows.

## Each row reads as stated here or inherited, and the page locks while a change is written

| State | Surface shows |
| --- | --- |
| stated | The row's switch on: the control is live and edits this layer. |
| inherited | The switch off: the row dimmed, its control inert, showing the inherited value or `not set here — inherits {value}`; `not set` where nothing sets it. |
| distro | `inside a WSL distro` chosen: `Distro` shows under `Environment`, holding `Ubuntu` unless one is named. |
| writing | While a change is being written: every switch and control at half strength and inert, with every value still drawn. |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of the sections. A write that fails is reported by the [error-notice](error-notice.md) and the values stay as they were. |
| empty | Not a look of its own: a layer that states nothing shows every row switched off, inheriting. |
| loading | Cannot occur as its own look: the settings are read at launch. |

| Where | String |
| --- | --- |
| Section heads | `Where commands run` · `Memoization` · `Fast-forward` · `Workflow lookup` |
| Section notes, behind `ⓘ` | `Natively, or inside a WSL distro — which is where git and every agent then run too. Deliberately not Windows git against \\wsl$, which is slow and permission-fragile.` · `Remember what a model answered and reuse it. Off by default, because it changes what a re-run observes.` · `When a fast-forward lets the conversation answer a question for you, and when it leaves it.` · `The roots a bare workflow reference is searched along — shell PATH semantics, first match wins.` |
| Environment | `Environment`, `Naming a distro runs everything inside it.`, key `execEnvironment` · `natively on Windows` · `inside a WSL distro` · `Distro`, `As wsl -l lists it.`, placeholder `Ubuntu` |
| Memoization | `Remember model answers`, `It saves real money, and it is not a pure optimization: a re-run returns the first run's answer rather than asking again — surprising if you re-ran precisely because you wanted a fresh one.`, key `memo.enabled` |
| Fast-forward | `Leave it to me below`, `A fast-forward runs the states between where the work stands and where you sent it, and the conversation steering it answers the questions that come up — each marked, and each a point you can rewind to.`, key `autopilot.askBelow` |
| Workflow lookup | `Search path`, `Empty means the layers in order, generated from the roots — which is what almost every project wants.`, key `workflows.path` |
| Unreadable | `The configuration could not be read.` |

## A person arrives from the sidebar, and every change is written as it is made

- `Runs` in the sidebar shows this page, with or without a project open; with none open, the switch offers `Just you` and `Shared (all projects)`, and every write goes to one of those.
- A row's switch on pins the value the row shows into this layer, so nothing changes until it is edited; off removes the key, and the row inherits again.
- Choosing `inside a WSL distro` writes the distro `Ubuntu` unless one is named. An emptied box removes its key.
- Nothing is held unsaved: choosing another page or room leaves with every change already written.

## The page keeps its width cap, and its rows stack when narrow

- **Resize.** Sections stop at 740px. A row's control drops under its sentence in a card 380px wide or less; the search path always runs across the row.
- **Theme.** Cards, switches, dimmed rows and boxes are tokens in both themes.
- **Focus.** Nothing takes focus on entry. The order runs down the page, each row's switch before its control.
- **Long content.** Sentences wrap; the rest of a row's explanation is behind its `ⓘ`, so a row stays two or three lines tall.
