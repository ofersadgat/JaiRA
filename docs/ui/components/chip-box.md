---
id: ui/components/chip-box
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/preview-beside-the-setting]
serves: [product/read-comfortably, product/share-processes-across-projects]
surfaces: [ui/surfaces/settings-files, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/filesPane.tsx, packages/app/src/renderer/appearancePane.tsx]
verified_by: [packages/app/test/appearance.test.ts]
mockups: [ui/assets/chip-box/empty.html, ui/assets/chip-box/defaults.html, ui/assets/chip-box/chosen.html, ui/assets/chip-box/warning.html, ui/assets/chip-box/menu-open.html, ui/assets/chip-box/read-only.html]
siblings: [ui/components/preset-chips, ui/components/size-stepper, ui/components/settings-field]
---

# Chip box

A bordered box holding a wrapping row of small grey chips, each a mono path pattern or a numbered font name with a `✕` at its end, closed by a borderless `+ pattern…` field or a quiet `+ add…` button.

## A chip box edits a short ordered list in place, where the order is the meaning

**Use when.** A setting is an ordered list of short values read left to right and edited where it stands: the path patterns the file tree hides, where a later pattern wins, and the font families a voice tries in turn. Two kinds share the look. A pattern box adds by typing. A font box adds from a menu of faces or by typing a name.

**Do not use when.** Each item needs fields of its own, such as the numbered allow and deny rules in [executor-tree](executor-tree.md). One value is picked from a few presets: use [preset-chips](preset-chips.md). The value is a size: use [size-stepper](size-stepper.md). The list is free text of many lines: a text box on a [settings-field](settings-field.md) row.

## The chips read first, in order, and the way to add one closes the row

- **Box.** 1px `--line` border, `--control-radius` corners, `--panel` ground, 4px by 5px padding, chips 5px apart and wrapping. A font box's border turns `--accent` while its menu is open.
- **Chip.** `--fill-ghost-hover` ground, `--control-radius-sm` corners, 6px between its parts, ending in a 17px `✕` in `--dim`.
- **Pattern chip.** A mark first: `◌` in `--dim` for a rule that hides, or `◉` in `--accent` on a `--tint-ok` ground for a rule that reveals. Then the pattern in `.data-text`, drawn without its leading `!`.
- **Font chip.** Its place in the stack in `.data-num`, then the family's name set in that family at the voice's own register, `.app-text` or `.data-text`.
- **Default chip.** While nothing has been chosen, the chips stand for what applies anyway: transparent with a 1px dashed `--line` border, and a word in `.app-secondary` where the `✕` would be, `default` for the file tree's built-in patterns and `ours` for the face JaiRA ships.
- **Origin word.** Where a chip cannot be removed, the `✕` gives way to where the rule comes from: `default`, `shared` or `yours`.
- **Add.** A pattern box ends in a borderless field in `.data-text`, at least 120px wide, taking the rest of the line. A font box ends in a quiet `+ add…` in `.app-secondary`.
- **Face menu.** Overlays the content below, as wide as the box: `SANS FACES` or `MONO FACES`, the offered faces with chosen ones first, each row a 12px tick column, the name in its own face and a quiet note at the far end; then a rule, a typing row, a rule and a foot line that never scrolls away. The list scrolls past 210px. `--panel` ground, `--line` border, `--lift` shadow.
- **Line of rules in effect.** The same chips with origin words, laid out with no box and no field.

## Every state changes which chips are drawn and whether they can be removed

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A pattern list with no values holds only its field and placeholder. A line of rules in effect with nothing in it says `No rules: every root shows everything, system/ included.` A font box is never empty. | [empty.html](../assets/chip-box/empty.html) |
| loading | Cannot occur: the values arrive with the settings, before the section draws. | |
| partial | Cannot occur: every chip draws whole. | |
| error | Cannot occur as a refusal: empty text and a bare `!` are dropped without a word, and nothing typed is rejected. The one warning is on a font, drawn in the warning row. | |
| defaults | Nothing chosen: the shared pattern list shows the tree's 18 built-in patterns as dashed `default` chips and has no `SET HERE` tag; the app text box shows `1 DM Sans ours`. | [defaults.html](../assets/chip-box/defaults.html) |
| chosen | Solid chips with `✕`: hiding and revealing patterns side by side, text still waiting in a field, and a data text stack of two numbered faces. | [chosen.html](../assets/chip-box/chosen.html) |
| warning | A data text face that is not monospaced: its chip on `--tint-warn`, with the reason as its tooltip. The face is kept. | [warning.html](../assets/chip-box/warning.html) |
| menu open | The face menu under the app text box with the chosen face ticked on `--tint-accent`, faces missing from this machine noted, the typing row and the foot line. | [menu-open.html](../assets/chip-box/menu-open.html) |
| read-only | The line of rules in effect, and boxes that cannot change: while a settings change is being written, or the shared layer cannot be edited, pattern chips carry origin words, the field is inactive, and a font box greys its `✕` and `+ add…`. | [read-only.html](../assets/chip-box/read-only.html) |

## Every change is written as it is made

| On | Does | Feedback |
| --- | --- | --- |
| Type a pattern, then Enter or leave the field | Adds it at the end of the list | A chip appears before the field and the field clears |
| Escape in a pattern field | Clears the typed text | The placeholder returns |
| First pattern typed into a list showing defaults | Writes the defaults out with the new pattern, so none of them is lost | The dashed `default` chips become removable chips and `SET HERE` appears |
| Click `✕` on a pattern chip | Removes that rule | The chip goes. Removing the last shared pattern writes an empty list, which shows everything; only the section's reset brings the defaults back |
| Pointer over a `✕` | Nothing | It turns `--text` on `--fill-ghost-selected` |
| Click `+ add…` | Opens or closes the face menu | The box border turns `--accent` and the menu overlays what is below |
| Click a face in the menu | Adds it at the end of the stack, or takes it out | The tick and the tint follow, the chips change, and the whole app redraws in the new stack at once |
| Type a family, then Enter or leave the field | Adds it if it is not already chosen | A chip appears and the field clears |
| Click `✕` on a font chip | Removes that face | The chips renumber; with none left the dashed `ours` chip returns |
| Press anywhere outside the box | Closes the face menu | The menu goes |

## The copy is the values themselves and a few quiet words about where they come from

| Where | String |
| --- | --- |
| Pattern field | `+ pattern…` on the shared list · `+ pattern, or !pattern to reveal…` on a person's own list |
| Marks | `◌` hides · `◉` reveals |
| Remove tooltip | `remove {pattern}`, including a revealing rule's `!` · `remove {family}` |
| Origin words | `default` · `shared` · `yours` · `ours` |
| Default font chip tooltip | `JaiRA's own — choosing a family replaces it` |
| Add button | `+ add…` |
| Menu heading | `sans faces` · `mono faces`, drawn uppercase |
| Menu row notes | `ours, in use` · `not on this machine` |
| Typing row | `another family…` |
| Menu foot | `always ends with the default stack`, with the full fallback stack as its tooltip |
| Warning tooltip | `not monospaced — columns will not line up` |
| Offered faces | `DM Sans` · `Inter` · `Segoe UI` · `Helvetica Neue` · `IBM Plex Sans` · `Roboto` for app text; `JetBrains Mono` · `Cascadia Code` · `SF Mono` · `Fira Code` · `IBM Plex Mono` · `Consolas` · `Menlo` for data text |
| Nothing in effect | `No rules: every root shows everything, system/ included.` |

## The chips wrap, a chip never outgrows the box, and the menu keeps the box's width

- Resize: chips wrap onto new lines and a chip is never wider than the box, its name ellipsising. The pattern field drops to its own line when fewer than 120px remain. On Files the box sits in its row's right-hand rail of at most 240px, so the built-in list stands as a tall column of chips. A font box takes what its line leaves beside the size stepper, within 560px. The menu is as wide as the box, and at least 230px unless the box is narrower.
- Theme: grounds, borders, marks and tints are tokens in both themes. Font names are drawn in their own faces in both.
- Focus: pattern chips are not tab stops; each `✕` and the field are. In a font box, each `✕`, then `+ add…`, which announces whether the menu is open, then the menu's rows and its typing field. The menu takes no arrow keys and Escape does not close it.
- Long or missing content: a long pattern or family ellipsises inside its chip. A face that is not on the machine keeps its name on the chip but is drawn in the fallback face.
