---
id: ui/surfaces/settings-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/checked-status-with-the-fix]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects, product/agents-act-only-where-allowed, product/read-comfortably, product/keep-history-within-bounds]
components: [ui/components/settings-header]
mockups: [ui/assets/settings-view/in-a-project.html, ui/assets/settings-view/no-project.html, ui/assets/settings-view/unlayered.html]
siblings: [ui/surfaces/sidebar, ui/surfaces/app-window, ui/surfaces/settings-providers, ui/surfaces/settings-executors, ui/surfaces/settings-configuration, ui/surfaces/settings-files, ui/surfaces/settings-appearance, ui/surfaces/settings-conversation, ui/surfaces/settings-history, ui/surfaces/inbox-strip]
---

# Settings view

The Settings room: one scrolling column right of the [sidebar](sidebar.md) that holds a header bar and one section of settings. It takes the place of whichever room was open, has no context panel, and its title bar holds only the empty filler. The list of sections is not here: it is the settings sheet that covers the sidebar while this room shows.

## The header reads first, then the section under it

- **Column.** On `--bg` with 14px of padding above and below and 16px at the sides, scrolling up and down and never sideways.
- **Header.** The [settings-header](../components/settings-header.md), when the section has one: the layer switch or the no-project sentence at the left, and on Providers and Executors the age of the checks and `Re-check` at the far right, over a 1px `--line` rule.
- **Section.** Under the header, left-aligned: [Providers](settings-providers.md), [Executors](settings-executors.md), [Configuration](settings-configuration.md), [Files](settings-files.md), [Appearance](settings-appearance.md), [Conversation](settings-conversation.md) or [History](settings-history.md). A section of grouped settings is at most 780px wide, and Appearance at most 1040px.
- **Inbox strip.** The [inbox strip](inbox-strip.md) stays at the foot of the room while anything waits.

| Section | Header |
| --- | --- |
| Providers, Executors | Layer switch or no-project sentence, then the check age and `Re-check` |
| Configuration, Files | Layer switch or no-project sentence |
| Appearance, Conversation, History | None |

## The room changes only its header between states, and each section draws its own content

| State | Surface shows | Mockup |
| --- | --- | --- |
| in a project | A project is open and the section is layered: the layer switch with `This project` or `Shared (all projects)` filled, and the section reading and writing that layer. On Providers and Executors the header also shows `checked {n} min ago` and `Re-check`, which reads `checking…` while the checks run. While a change is being written, the header's buttons and every control in the section are at half strength and inert. | [in-a-project.html](../assets/settings-view/in-a-project.html) |
| no project | No project is open: the header's sentence stands where the switch was, every layered section edits the shared settings, and History is not offered in the sheet. | [no-project.html](../assets/settings-view/no-project.html) |
| unlayered | Appearance, Conversation or History: no header, and the section starts at the top of the column. | [unlayered.html](../assets/settings-view/unlayered.html) |
| empty | Cannot occur: a section is always shown, Providers the first time Settings opens. | |
| loading | Cannot occur as its own look: the settings are read at launch and read again in place on entering. Checks that have not reported show as `not checked yet` in the header and `not checked` on each provider. | |
| error | Settings that cannot be read: a section that edits them shows `The configuration could not be read.` in `--dim` under its header. A save or check that fails puts the [error notice](error-notice.md) at the foot of the window and leaves the section as it was. | [settings-providers error](../assets/settings-providers/error.html) |

## A person arrives from the sidebar and leaves for the room they came from

- `⚙ Settings` at the foot of the sidebar opens the settings sheet and this room at the section shown last. The rail's `⚙` expands the sidebar and does the same.
- A section in the sheet shows that section, and from Logs, Debug or Components it returns to Settings at that section. Opening Providers or Executors shows the last check result without running a check.
- `‹` or the Settings row at the top of the sheet leaves for the room shown before Settings. `≡ Logs`, `⌁ Debug` and `▤ Components` in the sheet leave for those rooms.
- Choosing an entry in the inbox strip leaves for the Tasks room with that task selected.

## The column keeps its sections narrow, moves no focus, and drops unsaved provider and preset typing

- **Resize.** The column takes every pixel right of the sidebar. Sections keep their maximum width and stay at the left, so a wide window leaves space to their right. The header wraps rather than shrinking.
- **Theme.** Ground, rule, header and sections are tokens with a light and a dark value, and the sheet's `Dark` or `Light` row switches them while Settings is open.
- **Focus.** Entering moves focus nowhere. Tab reaches the header's buttons, then the section's controls in reading order.
- **Unsaved work.** Switches, choices and most fields are written the moment they change. A provider's fields and a preset's settings are held until their `Save`, and leaving the section, switching the layer or leaving Settings discards that typing without a prompt.
