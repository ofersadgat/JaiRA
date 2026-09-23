---
id: ui/surfaces/settings-toolsets
type: ui-surface
status: shipped
updated: 2026-09-22
kind: panel
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists, ux/patterns/name-it-where-it-will-live, ux/patterns/absence-is-stated, ux/patterns/fold-to-a-summary-expand-in-place]
serves: [product/agents-act-only-where-allowed, product/risky-actions-wait-for-approval, product/share-processes-across-projects]
components: [ui/components/toolset-card, ui/components/settings-header, ui/components/schema-form, ui/components/settings-field, ui/components/icon]
mockups: [ui/assets/settings-toolsets/project.html, ui/assets/settings-toolsets/built-in.html, ui/assets/settings-toolsets/inherited.html, ui/assets/settings-toolsets/unsaved.html, ui/assets/settings-toolsets/nested.html, ui/assets/settings-toolsets/new-toolset.html, ui/assets/settings-toolsets/new-bucket.html, ui/assets/settings-toolsets/refused.html, ui/assets/settings-toolsets/function.html, ui/assets/settings-toolsets/function-menu.html, ui/assets/settings-toolsets/function-form.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-executors, ui/surfaces/settings-providers, ui/surfaces/settings-configuration]
---

# Settings toolsets

The Toolsets section of the [Settings view](settings-view.md): every toolset this machine can name, as a rail of buckets beside one toolset drawn the way the composer's Tools card draws it. It sits under the [settings header](../components/settings-header.md) — which here has a third, read-only segment, `Built in`, because this is the first Settings section whose values JaiRA itself ships.

## A rail of buckets, and the toolset beside it

- **Column.** At most 780px wide, left-aligned, under the layer picker.
- **Group head.** `Toolsets`, then the hint: what a toolset is and how a state names one.
- **Box.** One bordered box in two columns, 8px corners: a 212px rail and the detail pane, which is at least 330px tall so the pane does not jump between toolsets. The box does not clip — an add menu opens past its edge.
- **Rail.** The bucket hierarchy. A bucket is a heading, not a tab: a folder glyph, its name in the data face at 11.5/12.5 weight 600, and the layer that defines it as a `--tok-hint` pill at the far right. Under it, one tab per toolset — its name in the data face over a `--dim` one-line summary, `{n} lines · other {mode}` or `{n} lines · all {mode}` — then `+ toolset` in `--tok-hint`. `+ bucket` closes the rail. A toolset the layer being edited states carries a 6px `--accent` dot after its name; one with lines not yet saved reads `unsaved · {summary}`; one whose file could not be read reads `could not be read`. A nested bucket and everything in it hang 12px further in per step. The chosen tab takes a `--panel` ground and a `--line` outline. Arrows move within the rail and skip the headings.
- **Detail head.** The toolset's path in the data face, `{bucket} / {name}`, its file as the tooltip; then a status pill — `--accent` on `--tint-accent` when this layer states it, `--dim` otherwise — and a second pill when a nearer layer hides it. Under them, in `--dim`, which states name it.
- **Detail body.** The [toolset card](../components/toolset-card.md): the sections, a line per subject with its implementation and mode buttons, commands grouped under their program, a red minus starting every held line and an add line ending every section and every group.
- **Actions.** At the foot of the pane however short the card is: `Save` filled and `Revert` ghost at the left; then, where this layer's file overrides a lower one, `Compare with {what ships|the shared one}` as a link and `Reset to {built in|shared}` ghost in `--bad` at the far end.
- **Built in.** The same rail and the same card, inert, with no minus, no add line and no `+` rows. Its only actions are `Override for all projects` and `Override here`.
- **Inherited.** A toolset this layer does not state, read the same way, offering the one override that makes sense here.
- **Comparison.** Under the card when it is open: a bordered `--panel-2` table, three columns — the line in the data face, what the lower layer says, what this layer says — with `no line` and `taken out` in italic `--tok-hint`.
- **Detach note.** Where the draft takes out a line the followed toolset holds, an amber note above the actions says so before the save, not after.
- **`+ toolset` / `+ bucket`.** The rail with a detail pane titled `A new toolset in {bucket}` or `A new bucket`, holding one or two [settings fields](../components/settings-field.md) drawn by the [schema form](../components/schema-form.md), and a filled `Add it`.

## The section shows a toolset this layer states, one it inherits, what ships, a draft, a comparison, an addition, or a refusal

| State | Surface shows | Mockup |
| --- | --- | --- |
| project | The layer that states it: the accent dot on its tab, `overrides built in` beside its path, the card live, and all four actions. | [project.html](../assets/settings-toolsets/project.html) |
| built in | What ships, read: every row inert, no minus and no add line, and the two overrides in place of the actions. | [built-in.html](../assets/settings-toolsets/built-in.html) |
| inherited | A toolset this layer does not state: read the same way, `built in` beside its path, `Override here` its only action. | [inherited.html](../assets/settings-toolsets/inherited.html) |
| unsaved | Lines changed and not saved: the tab reads `unsaved · `, `Save` and `Revert` are live, the detach note names the line an override cannot drop, and the comparison is open. | [unsaved.html](../assets/settings-toolsets/unsaved.html) |
| nested | A project's own toolset in a bucket that holds another bucket, indented under it; Execution open with a command group and the add menu. | [nested.html](../assets/settings-toolsets/nested.html) |
| new toolset | `+ toolset` chosen with a name typed that the bucket already holds: the box outlined in `--bad`, the reason under it, `Add it` inactive. | [new-toolset.html](../assets/settings-toolsets/new-toolset.html) |
| new bucket | `+ bucket` chosen: a bucket and a first toolset, both required, and `Add it` live. | [new-bucket.html](../assets/settings-toolsets/new-bucket.html) |
| a line names a function | A line whose mode is `{ "function": … }` ([decision 0007](../../engineering/decisions/0007-toolsets.md), amended 2026-09-22): its mode chip is a star and the function's name in the data face; the `Other` row reads the same way. | [function.html](../assets/settings-toolsets/function.html) |
| mode menu | `allow` · `ask` · `deny`, each with its hint, then a rule and `function…` — `a function decides each call, and may ask you — smart, or your own`; on a line that names one, that row reads the name, ticked. | [function-menu.html](../assets/settings-toolsets/function-menu.html) |
| naming a function | `function…` chosen: the one schema form with a `function` field, its hint naming what a reference may be, the sentence under it, and `Back` / `Set`, `Set` inactive while the box is empty. | [function-form.html](../assets/settings-toolsets/function-form.html) |
| refused | While a write is in flight: every control at half strength and inert, and what the last write was refused with said above the actions. | [refused.html](../assets/settings-toolsets/refused.html) |
| empty | Cannot occur: eight toolsets ship, and the built-in layer is on the search path of every project. A layer with nothing of its own still lists them. | |
| error | The toolsets cannot be read: `Toolsets could not be read — {reason}` in `--dim` in place of the box. A single FILE that cannot be read is listed in the rail and says so in the pane instead. | |

| Where | String |
| --- | --- |
| Group head | `Toolsets` · `Which tools are offered, and what happens when each is called. A state names one as $/toolsets/<bucket>/<name>; a bucket is a place with its own versions of the same names.` |
| Layer picker | `This project` · `Shared (all projects)` · `Built in`, the last titled `what ships with JaiRA — read-only; it is changed by overriding it in one of the other two` |
| Rail | `{name}` with the dot's tooltip `set in the layer you are editing` · `+ toolset` · `+ bucket` |
| Rail summary | `{n} lines · other {mode}` · `{n} lines · all {mode}` · prefixed `unsaved · ` · `could not be read`; a function reads as its name |
| Mode menu | `allow` — `goes ahead without asking` · `ask` — `stop and ask before each call` · `deny` — `refused every time` · `function…` — `a function decides each call, and may ask you — smart, or your own` |
| Naming a function | `function`, hint `smart, or a function of your own — a name on the search path, a module symbol, or $BASE/functions/…` · `It is handed the call and answers allow or deny; to ask you, it calls approve_tool_call.` · `Back` · `Set` |
| Standing | `overrides built in` · `overrides all projects` · `built in` · `all projects` · `this project` · `overridden in this project` · `overridden for all projects` |
| Used by | `used by {state}` · `used by {a} and {b}` · `used by {state} and {n} more states` · `no state names it` |
| Actions | `Save` · `Revert` · `Compare with what ships` / `Compare with the shared one` / `Hide the comparison` · `Reset to built in` / `Reset to shared` |
| Overrides | `Override for all projects` · `Override here` |
| Comparison | `line` · `what ships` / `the shared one` / `this project's` · `here` · `no line` · `taken out` · `Nothing differs: this says exactly what {lower} says.` |
| Detach note | `Taking out '{a}', '{b}' is something an override cannot say — a line left out means "as {lower} says". Saving writes this toolset whole, and it stops following {lower}.` |
| YAML | `This layer holds it as a YAML file, which JaiRA reads and does not edit. Change it in Files.` |
| Unreadable file | `{file} could not be read as a toolset — {reason}. Open it in Files to fix it.` |
| New toolset | `A new toolset in {bucket}` · `It starts holding nothing, with everything else asked about. Its lines are added once it has a name.` · `Name`, hint `The file's name — what a state writes after the bucket.` |
| New bucket | `A new bucket` · `A place with its own versions of the same names — chat/ask-first and chat_control/ask-first are two toolsets.` · `Bucket`, hint `A folder under toolsets/. It may nest: feature/implementation.` · `First toolset`, hint `A bucket is a folder, and exists by holding one.` · `Add it` |
| Name refused | `there is already a toolset called '{id}'` · `'{id}' is inherited here — open it and override it` · `a name is letters, digits, '-', '_' and '.', starting with a letter or a digit` |

## A person picks a layer, then a toolset, and what a save does depends on what the layer holds

- `Toolsets` in the settings sheet shows every toolset the chosen layer can see — its own files and those of the layers below it — opened on the first. `Built in` shows only what ships. A layer switch redraws the rail from that layer, keeps the toolset if it is there, and holds its unsaved lines apart per layer, so looking at what ships loses nothing.
- Choosing a toolset shows it and its card; lines changed in one are kept while another is looked at, and its tab says `unsaved`.
- `Save` writes the whole map into the layer, and what that IS depends on what the layer holds: the layer's own file is edited in place with its comments, its key order and its line endings kept; a layer with no file of its own gets an override holding only the lines that differ from the nearest lower layer's, by that layer's explicit root, so it keeps inheriting what it does not say. A line the followed toolset holds that the draft does not is something `$ref` plus siblings cannot express, so the file is written whole and stops following — said in the note above the button before the save, not after.
- `Revert` puts back what is on disk. `Compare with …` lists every line the two layers disagree on. `Reset to …` deletes this layer's file, so the layer below answers again; it is offered only where a lower layer holds one, because deleting a toolset states name is the Files view's act.
- `Override for all projects` and `Override here` write `{ "$ref": "$SYSTEM/toolsets/{id}" }` — an override that says nothing yet and inherits everything — and move the pane to the layer they wrote into, opened on the same toolset, where it can be changed.
- `+ toolset` writes a toolset holding nothing with `other: ask`, and the pane moves to it. `+ bucket` does the same and makes the folder by putting the first toolset in it. A name the layer already holds is refused rather than replacing that toolset, and so is a name a reference could not carry.
- A write that is refused says so above the actions and changes nothing; the pane re-reads after every write, so a file changed by hand between two saves is never silently overwritten.
- What ships is never written to, however the request is spelled: the pane offers no way, and the service refuses one anyway.
