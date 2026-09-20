---
id: ui/surfaces/settings-providers
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/checked-status-with-the-fix, ux/patterns/inherited-unless-set-here, ux/patterns/secret-goes-in-never-comes-back, ux/patterns/name-it-where-it-will-live, ux/patterns/absence-is-stated]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects]
components: [ui/components/provider-row, ui/components/switch, ui/components/settings-field, ui/components/icon]
mockups: [ui/assets/settings-providers/listing.html, ui/assets/settings-providers/adding.html, ui/assets/settings-providers/writing.html, ui/assets/settings-providers/error.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-executors, ui/surfaces/settings-configuration]
---

# Settings providers

The Providers section of the [Settings view](settings-view.md): everything on this machine that can answer a model call, as two lists, model providers reached through an API and agent providers that run as programs, each row with its last check, and at the foot a closed `Add an agent CLI` disclosure for registering another agent program. It sits under the [settings header](../components/settings-header.md), which picks the layer it writes and re-runs the checks, and it replaces whichever section was shown.

## Model providers read first, agents second, and adding a new agent comes last

- **Column.** At most 780px wide, left-aligned, with 34px between groups and 28px under the last.
- **Group head.** Padded 11px at the sides to share the rows' left edge: the group's name at 15/12.5 of the app size and weight 650, then a `--dim` hint at 11/12.5 at most 70 characters wide.
- **Model providers.** Always four rows: `Anthropic`, `OpenRouter`, `Local server` and `Embedded weights`.
- **Agent providers.** The built-in `claude-code`, `claude-cli` and `codex-cli`, then every agent program added in either layer, named as registered.
- **Rows.** Each is a [provider row](../components/provider-row.md), 2px apart: vendor mark with its status dot, name, version, a [switch](../components/switch.md) and a chevron, over the check sentence and the key line.
- **Add an agent CLI.** Under the last group, a 1px `--line` rule and a full-width head holding, centred in it, a `▶` caret, `Add an agent CLI` at 12/12.5 and weight 600, and `· any other coding-agent binary` in `--dim`, all `--dim` until pointed at. Opened, the caret turns a quarter and the body is indented 17px: a `--dim` hint, two [settings fields](../components/settings-field.md) with the label at the left and the box on the right-hand rail, and a plain `Add it` button.

## The section is a list of checked providers, an open form, or a sentence that it cannot read

| State | Surface shows | Mockup |
| --- | --- | --- |
| listing | Both groups with each row's last check, and the disclosure closed. Before the first check reports, a row reads `not checked` with a `--dim` dot; that is the loading look. | [listing.html](../assets/settings-providers/listing.html) |
| adding | The disclosure open. `Add it` is inactive until both boxes hold more than spaces. Both variants are drawn. | [adding.html](../assets/settings-providers/adding.html) |
| writing | While a settings change is being written: every switch, field, key button and `Add it` at half strength and inert. Chevrons and the disclosure still open and close. | [writing.html](../assets/settings-providers/writing.html) |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of both groups and the disclosure. | [error.html](../assets/settings-providers/error.html) |
| refused | An agent program whose name the layer already uses, or a built-in's name: the boxes clear, nothing is added, and the [error notice](error-notice.md) says why. | [error-notice](../assets/error-notice/action-failed.html) |
| empty | Cannot occur: the four model providers and the three built-in agents are always listed. | |

| Where | String |
| --- | --- |
| Group heads | `Model providers` · `Agent providers` |
| Model hint | `They return a completion. A model id's prefix names one — anthropic/claude-sonnet-5 goes to the first of these.` |
| Agent hint | `They answer by RUNNING — reading files, executing commands — on their own subscription or key. A prefix names one of these too: claude-cli/sonnet.` |
| Disclosure | `Add an agent CLI` · `· any other coding-agent binary` |
| Disclosure hint | `It is registered under the name you give it, which is what a state's function then names and what a model prefix routes to. It enforces no policy of its own, so a project whose policy can require approval will refuse it.`, with `function` in the data face |
| Fields | `Registry name`, hint `How a workflow will name it.`, key `agents.genericCli[].name`, example `opencode` · `Command`, hint `The executable, or a full path.`, key `agents.genericCli[].command`, example `opencode` |
| Button | `Add it` |
| Unreadable | `The configuration could not be read.` |
| Refusals | `this layer already configures an executor called '{name}'` · `'{name}' is a built-in executor — configure it above rather than adding a CLI with its name` |

## A person arrives from the settings sheet, and an added agent appears in its group

- `Providers` in the settings sheet shows this section with the last check results, running no check. It is the section Settings opens on the first time.
- `Add it` writes the agent program into the layer being edited, clears both boxes and leaves the disclosure open. The new row appears at the end of `Agent providers` once the settings are read back, showing `not checked` until the checks report.
- `Re-check` in the header runs every check and each row takes its new result.
- Switching the layer redraws the section from that layer and closes every open row, discarding its typing. The disclosure keeps its state and its boxes keep their text, and `Add it` then writes to the newly chosen layer.
- Leaving for another section or another room discards what was typed into the disclosure and into any open row without a prompt.

## The section keeps its width, gives the fields a rail, and holds nothing typed across a visit

- **Resize.** The section is 780px at most and narrower with the window. Each field keeps its box on a right-hand rail of 140px to 240px, and stacks label over box once the section is under 380px wide.
- **Theme.** Group heads, hints, rows, rule and caret are tokens with a light and a dark value. Vendor logos keep their own colours.
- **Focus.** Tab moves down the rows' switches, chevrons and key buttons, then the disclosure head, which announces whether it is open, then `Registry name`, `Command` and `Add it`.
- **Unsaved work.** The disclosure is closed on every visit and remembers nothing.

## The section departs from the type registers in its headings

- Group heads, hints and the disclosure title use size ratios of their own rather than the registers.
- The agent names under `Agent providers` are data and are set in the app face.
