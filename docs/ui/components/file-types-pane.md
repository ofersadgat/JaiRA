---
id: ui/components/file-types-pane
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/preview-beside-the-setting, ux/patterns/one-document-several-readings, ux/patterns/inherited-unless-set-here]
serves: [product/read-comfortably, product/read-what-work-produced]
surfaces: [ui/surfaces/settings-appearance]
reuses: [ui/components/switch, ui/components/preset-chips, ui/components/size-stepper, ui/components/code-editor, ui/components/code-view, ui/components/markdown-editor, ui/components/markdown-view, ui/components/schema-json-editor, ui/components/data-tree, ui/components/schema-form, ui/components/table-view, ui/components/patch-view, ui/components/diff-editor, ui/components/workflow-editor, ui/components/workflow-sync-panel, ui/components/task-board]
implemented_by: [packages/app/src/renderer/fileTypesPane.tsx, packages/app/src/renderer/editorKnobs.tsx, packages/app/src/renderer/fileTypes.ts, packages/app/src/renderer/appearancePane.tsx]
verified_by: [packages/app/test/fileTypesPane.test.ts, packages/app/test/fileTypes.test.ts]
mockups: [ui/assets/file-types-pane/success.html, ui/assets/file-types-pane/partial.html, ui/assets/file-types-pane/mixed.html, ui/assets/file-types-pane/editor.html, ui/assets/file-types-pane/off.html, ui/assets/file-types-pane/cannot-show.html, ui/assets/file-types-pane/busy.html]
siblings: [ui/components/value-view, ui/components/file-panel, ui/components/settings-field, ui/components/llm-config-form]
---

# File types pane

A bordered card in two columns: a grey tree of file families on the left, and on the right a stage headed by the chosen type's name, a strip of three tabs `TEXT`, `DATA` and `PREVIEW` each with a green dot and what draws it, a lifted menu of renderers with a tick, a theme row with colour swatches, a box of editor switches, and a live preview of the real renderer.

## The pane decides which renderer draws each kind of file and how that renderer looks

**Use when.** A person chooses, for one file type or a whole family, what draws its text, its parsed data and its rendered preview, separately for the view that is only read and the editor typed into, and sets the palette and switches of the renderer they chose. It is the one place those choices are made, and the Files view, value readings and editors follow them.

**Do not use when.** A person switches the reading of one value on screen: [value-view](value-view.md) offers its readings in its own header and remembers nothing. A text size or face for the whole app is set above the pane with a [size-stepper](size-stepper.md) and a font stack. This pane has no other host.

## The type and its three kinds read first, and the preview of the choice reads last

- **Card.** 1px `--line` border, `--card-radius` corners, a grid of a fixed 178px tree and a stage taking the rest, at least 320px tall.
- **Tree.** On `--panel-2` with a `--line` rule on its right. Five family rows in the app face at weight 500, each a `▸` or `▾` caret, the name and a `.data-faint` count of its types at the right. One family is open at a time; under it, hung off a `--rule` line 12px in, an `All {family}` row then one row per type at weight 400. A type that carries a choice of its own ends in a 5px `--accent` dot. The selected row has a `--fill-ghost-selected` ground at weight 500.
- **Head.** The subject in `.app-title`, never wrapped, and at the far right in `.app-secondary` its media type, or for an All row how many types it covers. A `--line` rule under it.
- **Kind tabs.** Three equal tabs on `--panel-2`. Each has a 6px dot, `--ok` while something draws that kind and `--rule` when nothing does, the kind in `.app-label`, and under it what draws the read-only view in the data face at 0.92 of the data size in `--dim`, ellipsised. The chosen tab has a `--panel` ground, `--text` summary and a 2px `--accent` underline.
- **Arranging.** `ARRANGING` then a sunken `--panel-3` switch of `the read-only view` and `the editor`; the pressed one is on `--panel` in `--text` at 500.
- **Menu.** A picture of the menu the Files view offers for that view: a 1px `--rule` border, `--lift` shadow, at most 520px wide. Its head on `--panel-2` names the kind and the view. Each row is a tick column in `--accent`, the renderer's name in `.app-text` with ` ours` on the first and a `.data-faint` reach chip on a `--panel-2` ground where it reaches only some of a family, its note in `.app-secondary` under it, and a `✕` at the right. The leading row has a `--fill-ghost-selected` ground. Renderers taken off follow a rule under `NOT OFFERED`, dimmed, each ending in `+`.
- **Explanation.** One `.app-secondary` sentence under the menu when the tick is hollow or missing.
- **Theme.** For a renderer with a palette only: a bordered `--panel-2` strip with `THEME`, a select at most 220px wide, five 12px swatches of the palette's ground, keyword, string, function and type colours, none for `Follows the app` or while types disagree, and at the right a sentence naming the renderer, the view and the types. In the editor view the sentence ends with a clause in `--warn`.
- **How it is drawn.** For a renderer that is an editor only: a bordered box headed `HOW IT IS DRAWN` and a sentence, then one row per switch the editor honours, each a [switch](switch.md), its name in `.app-text` and what it does in `.app-secondary` at the right, then `2` `4` `8` [preset-chips](preset-chips.md) for Tab width and a [size-stepper](size-stepper.md) in `×` for Line spacing.
- **Preview.** A bordered box with a `--panel-2` bar reading `PREVIEW`, the type, kind and renderer in `.data-faint`, and a `--panel-3` pill naming the view; under it the real renderer drawing a sample of that type in a 190px scrolling area without its Save and Revert, or a centred note.

| Editor | Switches it shows |
| --- | --- |
| Code and diff | Line numbers, Wrap long lines, Minimap, Indent guides, Mark the current line, Show spaces and tabs, Colour bracket pairs, Tab width, Line spacing |
| Markdown | Line numbers, Wrap long lines, Mark the current line, Tab width, Line spacing |
| JSON | Wrap long lines, Tab width, Line spacing |

## Every state keeps the tree and the tabs, and the stage says what the family agrees on

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the tree always lists its five families and their nineteen types. | |
| loading | Cannot occur as its own look: the pane draws from settings already in the window, and a renderer that loads shows its own loading inside the preview. | |
| success | One answer for the subject: a solid tick on the leading row, each tab's summary naming the reading and, where the editor differs, `✎` and the editor, the theme row, the switches and the renderer drawing its sample. | [success.html](../assets/file-types-pane/success.html) |
| partial | An All row whose chosen renderer reaches only some of its types: the leading row on a 6% `--accent` wash with a half-strength tick and a reach chip such as `only Markdown`, the tab summary ending in `1/2`, and the hollow-tick sentence. | [partial.html](../assets/file-types-pane/partial.html) |
| mixed | An All row whose types are set differently: the tab summary `types disagree` in italic, no row ticked, the no-tick sentence, no switches, and the preview replaced by a note. A type set on its own carries its dot in the tree. | [mixed.html](../assets/file-types-pane/mixed.html) |
| editor | `the editor` pressed: the menu head says `the view you type into`, a renderer that cannot be typed into is dimmed to 45% and cannot be picked, the theme sentence gains its `--warn` clause, and the preview pill reads `editor view` over a renderer that takes typing. | [editor.html](../assets/file-types-pane/editor.html) |
| off | Every renderer of a kind taken off: the tab's dot turns `--rule` and its summary reads `off`, the menu holds only `NOT OFFERED` rows with `+`, the off sentence follows, and the preview says `Nothing is drawn here.` | [off.html](../assets/file-types-pane/off.html) |
| error | Shown as cannot show: a renderer that needs an open file becomes a note in the preview and never breaks the window. | [cannot-show.html](../assets/file-types-pane/cannot-show.html) |
| cannot show | A renderer that draws a run, such as a workflow's board, puts its note in the preview. `Nothing` as the pick shows its own note. A type with no rendering of a kind shows that kind's tab at 55% with `—`, and when that kind is selected the stage below the tabs holds one sentence. | [cannot-show.html](../assets/file-types-pane/cannot-show.html) |
| busy | While the app carries out an action, the picks, `✕` and `+`, the theme select and every switch, chip and stepper fade to half and do not answer. The tree, tabs and view switch still move. | [busy.html](../assets/file-types-pane/busy.html) |

## A pick is written at once and the preview redraws with it

The pane opens on Code, `All code`, `TEXT` and the read-only view each time it is drawn.

| On | Does | Feedback |
| --- | --- | --- |
| A family row | Opens that family, closing any other, and selects its All row; on the open family it closes it | The caret turns; the head, tabs and menu redraw for the family |
| `All {family}` or a type row | Selects that subject | The row takes the selected ground; head, tabs, menu and preview redraw with that type's sample |
| A kind tab | Shows that kind below | The tab takes the `--panel` ground and `--accent` underline |
| `the read-only view` or `the editor` | Arranges the menu for that view | The pressed segment moves; the menu, theme sentence and preview pill follow |
| A menu row | Makes that renderer lead the view; on an All row it clears every type's own line that it can reach, so the family agrees | The tick moves, the tab summary changes and the preview redraws |
| `✕` | Takes the renderer off this menu; on an All row where only some types offer it, puts it back on for all of them instead | The row moves under `NOT OFFERED`, or stays where it was put back |
| `+` | Puts the renderer back on the menu | The row returns above the rule |
| Theme select | Sets the palette for this view, and for the other view too when the same renderer draws both | The swatches and the preview repaint |
| A switch, tab chip or line-spacing stepper | Changes how that editor draws every file it draws, not only this type | The value word changes and the preview and every open editor of that kind redraw |
| Typing in the preview, editor view | Edits the sample only | The text changes; it is thrown away when the subject, kind, view or renderer changes |

While the pane is on screen, the previewed type's palette is the one the window's Monaco editors are painted in.

## The copy names families, kinds and renderers in plain words

| Where | String |
| --- | --- |
| Families, with tooltip | `Prose` `documents — including text with nothing claimed about it` · `Code` `source files, drawn by grammar` · `Data` `documents that denote a value — rows included` · `Changes` `a patch, and the edit it describes` · `Media` `pictures, and the markup that draws them` |
| Types, in order | Prose: `Markdown` `Plain text`. Code: `TypeScript` `JavaScript` `Python` `Shell` `CSS` `HTML` `XML` `SQL`. Data: `JSON` `YAML` `TOML` `Workflow (JSON)` `Workflow (YAML)` `CSV` `TSV`. Changes: `Diff`. Media: `SVG` |
| All row, tooltip | `All {family in lower case}` · `every type in this family — a value shows where they already agree` |
| Type row tooltip · dot tooltip | `{media type}` · `set here, on its own` |
| Head, All row | `All {family}` · `{n} types — a value shows where they agree` |
| Kind tabs, with tooltip | `text` `the characters as they are on disk — an editor, or coloured source` · `data` `the value the document denotes, once parsed — a tree, a table, a form` · `preview` `what the document means, rendered — prose, a page, a drawing, a board` |
| Unavailable tab | `—` · tooltip `this type has no rendering of that kind` |
| Tab summary | `{reading}` then `  ✎ {editor}` where the editor differs, then `  {reaches}/{of}` on a partial All row · `types disagree` · `off` |
| Arranging | `arranging` · `the read-only view` · `the editor` |
| Menu head | `{kind}` · `the view you cannot type into` · `the view you type into` |
| Menu row | `{renderer}` with ` ours` on the first · `only {type} and {type}` or `{n} of {m} types` · `{note}` |
| Pick tooltip | `make this the one that leads` · `this renderer cannot be typed into, so it is never an editor` |
| Off and back | `✕` `take it off this menu` · `not offered` · `+` `put it back on the menu` |
| Hollow tick | `The tick is hollow: {renderer} reaches {n} of these {m} types, and the rest keep what they had.` |
| No tick | `No row is ticked: the types in this family are set differently. Clicking one sets this view for every type that can take it.` |
| Kind off | `Every renderer is off, so this kind is off: nothing of it is drawn for this type.` |
| No rendering | `This type has no rendering of that kind — a TypeScript file denotes no value, a CSV has nothing to render.` |
| Theme | `theme` · `— types disagree —` · `Follows the app` · `Monokai Light` · `Monokai` · `Solarized Light` · `One Dark` · `{renderer} — the {read-only view, editor view or one view and the other} of {type or these types}` · ` · editors share one, and the last one you were in wins` |
| How it is drawn | `how it is drawn` · `every file {renderer} draws, not only {this type}` |
| Switches, on and off | `Line numbers` `numbered` `no gutter` · `Wrap long lines` `wrapped` `scrolls sideways` · `Minimap` `down the right edge` `hidden` · `Indent guides` `shown` `hidden` · `Mark the current line` `marked` `the caret says it` · `Show spaces and tabs` `dots and arrows` `hidden` · `Colour bracket pairs` `Monaco's three colours` `the theme's own` |
| Tab width · Line spacing | `2` `4` `8` `Tab width` `columns` · `Line spacing` |
| Preview bar | `preview` · `{type} · {kind} · {renderer or nothing}` · `read-only view` or `editor view` |
| Preview notes | `Nothing is drawn here.` · `Nothing — this type has no view of that kind.` · `{renderer} needs a file that is actually open — it draws a run, not a sample. Open one to see it.` · `The types in this family are set differently, so there is nothing single to show. Choose above to make them agree, or open one type in the tree to see it on its own.` |

## The tree holds its width, the stage gives way, and the preview keeps a fixed height

- Resize: the tree stays 178px and the stage takes the rest of the Appearance column, which is at most 1040px. Tab summaries, the head's second line, the theme sentence and switch values ellipsise; the theme row wraps; the menu stops at 520px.
- The preview is always 190px tall and scrolls inside, so typing in it never moves the controls above.
- Theme: tree, stage, menu and dots are tokens. The swatches and the preview are painted in the chosen palette, which stays itself in both app themes.
- Focus: tree rows, then the three tabs, the view switch, each menu row's pick then its `✕` or `+`, the theme select, the switches, chips and stepper, then the preview's own controls. Rows and tabs take Enter and Space; there is no arrow-key movement.
- Long content: a renderer's note wraps under its name inside the menu.

## Three parts depart from the type registers

- Renderer names in the tab summaries are JaiRA's words set in the data face.
- A disabled tab, a dimmed row and a hollow tick are drawn with opacity rather than `--tok-hint`.
- The tree rows and the tick and `✕` columns set their own sizes rather than a register.
