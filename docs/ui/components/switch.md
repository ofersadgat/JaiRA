---
id: ui/components/switch
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/schema-driven-form, ux/patterns/inherited-unless-set-here]
serves: [product/bring-your-own-models-and-agents, product/read-comfortably, product/hand-work-to-agents, product/try-one-step-on-its-own]
surfaces: [ui/surfaces/settings-providers, ui/surfaces/settings-executors, ui/surfaces/settings-configuration, ui/surfaces/settings-files, ui/surfaces/settings-appearance, ui/surfaces/new-task-popover, ui/surfaces/files-view, ui/surfaces/run-conversation, ui/surfaces/gate-modal]
reuses: []
implemented_by: [packages/app/src/renderer/controls.tsx, packages/app/src/renderer/editorKnobs.tsx]
verified_by: [packages/app/test/schemaForm.test.ts]
mockups: [ui/assets/switch/off.html, ui/assets/switch/on.html, ui/assets/switch/disabled.html]
siblings: [ui/components/preset-chips, ui/components/segmented-control, ui/components/settings-field]
---

# Switch

A 30 by 18 pill-shaped track with a 12px round knob: a grey knob at the left of a pale track when off, a white knob at the right of a blue track when on.

## A switch shows an on-off value and changes it in the same place

**Use when.** A value is on or off and its position is worth reading at a glance: a preference in a toggle row, whether an optional value in a [schema-form](schema-form.md) is set at all, whether a provider is used in the layer being edited on a [provider-row](provider-row.md), or a single boolean setting on a [settings-field](settings-field.md) row.

**Do not use when.** The choice is between named options: use [preset-chips](preset-chips.md), or [segmented-control](segmented-control.md) for two readings of one thing. The value itself is a boolean inside a schema form: that is a checkbox reading `yes` or `no`, because the switch before the field's name already says whether it is set. The control performs an act rather than holding a state: use a button.

## The track and the knob carry the state, and the words beside it carry the meaning

- **Off.** Track `--panel-2` with a 1px `--line` border; knob `--dim`, 5px left of centre.
- **On.** Track and border `--fill-accent`; knob `--on-accent`, 5px right of centre.
- **No words of its own.** The host's label is the tooltip and the name read aloud. The words a person reads sit beside it.
- **Toggle row.** The switch first, then the setting's name in `.app-text`, and at the far end a phrase in `.app-secondary` saying what the current position does, such as `scrolls sideways`. 10px apart, at least 26px high, at most 560px wide.
- **Before a field name.** In a schema form the switch leads the name. Off, a dashed note such as `not set — the default applies: 0.8` stands where the control would be; on, the control appears.
- **As a field's control.** On a settings row the switch sits on the right-hand rail where a box would, and the hint on the left changes with it.

## The switch has three looks: off, on and disabled

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a switch always holds a position. | |
| loading | Cannot occur as its own look: the switch draws the position its host holds, and moves when that value changes. A host that writes to disk keeps the old position until the write lands. | |
| partial | Cannot occur: the value is on or off. | |
| error | Cannot occur on the switch: a refused change leaves it where it was, and the host says why. | |
| off | Grey knob left on the pale track. Drawn in a toggle row, before a field name with the dashed note, and as a field's control. | [off.html](../assets/switch/off.html) |
| on | White knob right on the blue track, in the same three places; the toggle phrase, the field's box and the hint change with it. | [on.html](../assets/switch/on.html) |
| disabled | Either position at half strength with the default cursor, while a settings change is being written or the host is locked. | [disabled.html](../assets/switch/disabled.html) |

## A click slides the knob and the words beside it follow

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over, off | Nothing | Border `--rule`, track `--panel-3` |
| Pointer over, on | Nothing | No change |
| Click, Space or Enter | Asks the host to flip the value | The knob slides 10px and the track fills or empties over 120ms; a toggle row's phrase, a field's box or a row's hint changes with it |

## The copy is the host's, and a toggle row says what each position does

| Where | String |
| --- | --- |
| Tooltip and announced name | The host's label: `Smooth text` · `Wrap long lines` · `hidden` and `shown` · `stop using {name} in this project` and `use {name} again` · `set {name}` and `leave {name} out` · `set {name} here` and `{name} is set here — switch off to inherit it` |
| Toggle row, name then on and off phrases | `Separate editor size`: an editor size stepper, `follows the data text` · `Smooth text`: `grayscale`, `the platform's own` · `Line numbers`: `numbered`, `no gutter` · `Wrap long lines`: `wrapped`, `scrolls sideways` · `Minimap`: `down the right edge`, `hidden` · `Indent guides`: `shown`, `hidden` · `Mark the current line`: `marked`, `the caret says it` · `Show spaces and tabs`: `dots and arrows`, `hidden` · `Colour bracket pairs`: `Monaco's three colours`, `the theme's own` |

## The switch never changes size, and a toggle row's phrase ellipsises

- Resize: the switch is 30 by 18 at every width and never shrinks. In a toggle row a long phrase ellipsises on one line.
- Theme: track, border and knob are tokens in both themes.
- Focus: a native button in the tab order with the app's focus outline, announced as a switch with whether it is on.
- Motion: the knob slides even under a reduced-motion preference.
