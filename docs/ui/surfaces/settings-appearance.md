---
id: ui/surfaces/settings-appearance
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/preview-beside-the-setting, ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings]
serves: [product/read-comfortably, product/read-what-work-produced]
components: [ui/components/size-stepper, ui/components/switch, ui/components/status-pill, ui/components/file-types-pane]
mockups: [ui/assets/settings-appearance/default.html, ui/assets/settings-appearance/chosen.html, ui/assets/settings-appearance/face-menu.html, ui/assets/settings-appearance/disabled.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-conversation, ui/surfaces/settings-files]
---

# Settings appearance

The Appearance section of the Settings room: this person's typefaces and text sizes for the app's two voices, two text switches and a small preview of both voices side by side, then the file types workspace below a wide rule. It fills the settings column with no layer header above it, is reachable with no project open, and replaces whichever section was showing.

## The section names whose settings these are, then the two voices, then the preview

- **Head.** `Appearance` in `.app-title` and, pushed to the right, `every project on this machine` in `.app-secondary`, over a 1px `--line` rule.
- **Voice rows.** `app text` then `data text`, each an `.app-label` over one line of a face stack and a [size-stepper](../components/size-stepper.md), with a note under them in `.data-faint` on one ellipsised line: `→ ` and the stack the window is set in.
- **Face stack.** One `--panel` box with a 1px `--line` border holding chips read left to right, each on `--fill-ghost-hover` with a `.data-num` number, the family name set in that family and in its voice's register, and a `✕`, ending in a borderless `+ add…` in `.app-secondary`.
- **Toggle rows.** After a rule, `Separate editor size` and `Smooth text`, each a [switch](../components/switch.md), its name in `.app-text` and at the far right what the position does.
- **Preview.** After a rule, `preview` in `.app-label` over a card with a `--line` border and card corners: a `FILES` band on `--panel-3`, then two halves side by side. The left half on `--panel-2` holds `declarative-ai` in `.data-title`, `prompts/review.md` in `.data-text` and `4.2 kB` in `.data-secondary`. The right half on `--bg` holds `tighten the sync lint` in `.data-text`, a running [status-pill](../components/status-pill.md) reading `running` and `40s · 3 turns` in `.data-secondary`. Every line ellipsises.
- **File types.** A wide rule, a wide head `File types` with `what opens a file, and what that thing looks like`, then the [file-types-pane](../components/file-types-pane.md).

Everything down to the preview stops at 560px wide; the File types head, rule and pane use the section's full 1040px.

## The stacks show the shipped faces until a person chooses their own

| State | Surface shows | Mockup |
| --- | --- | --- |
| default | Nothing chosen: each stack is one dashed chip, `DM Sans` or `JetBrains Mono`, numbered `1` and ending in `ours` instead of `✕`. The notes read the shipped stacks, `Separate editor size` is off with `follows the data text`, and `Smooth text` is off with `the platform's own`. File types follows, drawn here simplified. | [default.html](../assets/settings-appearance/default.html) |
| chosen | Families chosen in both voices, each chip numbered and removable, the note listing them before the default stack. A proportional family in the data stack sits on `--tint-warn`. `Separate editor size` is on and shows its own stepper; `Smooth text` is on with `grayscale`. | [chosen.html](../assets/settings-appearance/chosen.html) |
| face menu | `+ add…` pressed: a lifted menu under the stack headed `sans faces` or `mono faces`, one row per offered family set in that family, a `--accent` tick and a `--tint-accent` ground on chosen rows, `ours, in use` or `not on this machine` at the right, a box for `another family…`, and a last line `always ends with the default stack`. | [face-menu.html](../assets/settings-appearance/face-menu.html) |
| disabled | While any write in the window is in flight: every stepper at reduced strength, and the chips' `✕`, `+ add…` and both switches inert. | [disabled.html](../assets/settings-appearance/disabled.html) |
| empty | Cannot occur: a stack always shows at least the shipped face. | |
| loading | Cannot occur: the preferences arrive with the window. | |
| error | Not a look of its own: a choice applies at once, and a write that fails is reported by the [error-notice](error-notice.md) while the choice stays on screen. | |

## Every choice applies to the whole window as it is made

| On | Does | Feedback |
| --- | --- | --- |
| `+ add…` | Opens or closes the face menu; a click anywhere outside it closes it | The stack's border turns `--accent` and the menu drops under it, lifted, over the rows below |
| A family row in the menu | Adds that family at the end of the stack, or removes it if chosen; the first choice replaces the shipped face | The tick moves, the chips renumber and every text in the window redraws in the new stack |
| Typing a family, then Enter or leaving the box | Adds the typed family if it is not already chosen | A new chip at the end |
| `✕` on a chip | Removes that family; removing the last brings back the shipped face | The chip goes and the note follows |
| A stepper | Sets that voice's size within its range | Every register of that voice resizes, the preview included |
| `Separate editor size` | On gives editors their own size; off makes them follow the data text | The stepper replaces `follows the data text`, or the reverse |
| `Smooth text` | Switches between grayscale smoothing and the platform's own | `grayscale` or `the platform's own` |

Nothing is saved by a button and nothing is left unsaved.

## The copy names the voices as text a person reads

| Where | String |
| --- | --- |
| Head | `Appearance` · `every project on this machine` |
| Voice labels | `app text` · `data text` |
| Shipped chip | `DM Sans` · `JetBrains Mono` · `ours`; tooltip `JaiRA's own — choosing a family replaces it` |
| Chip | tooltip `remove {family}`; proportional warning tooltip `not monospaced — columns will not line up` |
| Add | `+ add…` |
| Notes | `→ "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` · `→ "JetBrains Mono", "SF Mono", "SFMono-Regular", Menlo, Consolas, monospace` · `→ {chosen families}, {default stack}` |
| Face menu | `sans faces` · `mono faces` · `ours, in use` · `not on this machine` · placeholder `another family…` · `always ends with the default stack` |
| Offered families | app `DM Sans` · `Inter` · `Segoe UI` · `Helvetica Neue` · `IBM Plex Sans` · `Roboto`; data `JetBrains Mono` · `Cascadia Code` · `SF Mono` · `Fira Code` · `IBM Plex Mono` · `Consolas` · `Menlo` |
| Toggles | `Separate editor size` · `follows the data text` · `Smooth text` · `grayscale` · `the platform's own` |
| Preview | `preview` · `Files` · `declarative-ai` · `prompts/review.md` · `4.2 kB` · `tighten the sync lint` · `running` · `40s · 3 turns` |
| File types head | `File types` · `what opens a file, and what that thing looks like` |

## A person arrives from the Settings panel with or without a project, and leaves by choosing another section

- The sidebar's Settings panel lists `Appearance` whether or not a project is open. The header above the column is not drawn for this section.
- Choosing another section, `‹`, or another room leaves. Every choice is already applied and written, so nothing is lost on leaving.
- The theme is not set here; it lives in the Settings panel's foot.

## The typography half stays narrow while File types takes the width

- Resize: the stacks, toggles and preview stop at 560px so a chip and its stepper stay close. The stack's box wraps its chips. The File types pane takes up to 1040px.
- Theme: every ground, rule and the warning tint are tokens. The editor previews inside File types paint in the palette chosen for them.
- Focus: nothing takes focus on entry. The order is each chip's `✕`, `+ add…`, the stepper, then the next voice, the switches, then File types. The face menu's rows follow `+ add…` while it is open. Escape does not close the menu.
- Long content: the notes ellipsise on one line; a long family name widens its chip and the stack wraps.

## The preview departs from real surfaces

- The preview is a fixed sample drawn in the registers, not the real sidebar and task row.
