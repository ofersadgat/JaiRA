---
id: ui/components/state-graph
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/context-beside-what-you-stand-on, ux/patterns/drill-in-and-back-out]
serves: [product/see-how-a-process-flows, product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel]
reuses: []
implemented_by: [packages/app/src/renderer/stateGraphView.tsx, packages/app/src/renderer/stateGraph.ts]
verified_by: [packages/app/test/stateGraph.test.ts]
mockups: [ui/assets/state-graph/fitted.html, ui/assets/state-graph/focused.html, ui/assets/state-graph/too-big.html, ui/assets/state-graph/empty.html, ui/assets/state-graph/error.html]
siblings: [ui/components/workflow-editor, ui/components/state-form, ui/components/schema-json-editor, ui/components/state-inspector]
---

# State graph

A legend line over a bordered map of 258px cards laid left to right in run order, `Entry` first and `Exit` last, joined by thick grey and coloured arrows carrying white guard tags and by thin grey wires between port dots on the cards' edges.

## The graph answers what runs after what and where each value comes from

**Use when.** A person reads one state file as a picture: the Graph tab of a state file in the Files view, and the Graph tab of a state's configuration held in the context panel. It shows the sequence, every transition and its guard, every binding from the port that produces a value to the port that reads it, and which children share a conversation.

**Do not use when.** The person edits: nothing on the graph changes the file, and the Form and JSON tabs are [state-form](state-form.md) and [schema-json-editor](schema-json-editor.md). A state's validation, runs and environment are in [state-inspector](state-inspector.md).

## The boxes read first, the arrows second and the wires only when pointed at

- **Legend.** One wrapping line: `values` with a grey-to-colour swatch, `the sequence` in `--rule`, then only the keys this drawing uses: `onward` in `--go-onward`, `back` in `--go-back`, `abort` in `--go-abort`, `from any` dashed, `one conversation` as a dashed square. Each is a 20px swatch and a word in `.app-secondary`. Then a plain chip per limit, `max_iterations {n}` or `timeout {n}s`. At the right, `drag to pan · scroll to zoom` and a joined `−`, `{k}%` and `+`; the percentage is filled while the map is fitted.
- **Map.** `--bg` ground, 1px `--line` border, card radius, no scrollbars, a grab cursor. It fills the pane.
- **Columns.** Run order from left to right: `Entry`, the operation when there is one, each child in the sequence, `Exit`. A child the sequence never reaches, the `any` box and every outcome box sit in a lower lane.
- **Box.** 258px wide on `--panel` with a 1px `--line` border. A bold title, `Entry`, `Exit` and `any` in the app face and keys in `.data-title`. A subtitle in `.data-secondary`: the state's label, the child's reference or `./{key}`, `terminate.success`. A conversation line with a small dashed square and the session name. A row of chips. Then ports: what the box takes on the left, what it hands back on the right, each a name in `.data-text` with a note in `.data-faint` and an 8px dot on the border. Every line ellipsises; nothing wraps.
- **Box grounds.** `Entry` `--panel-2`; `Exit` `--tint-ok`; the operation `--tint-accent` with a `--rule` border and an accent chip naming its kind; a child off the sequence and `any` dashed with no ground; an outcome such as `terminate.error`, and a target that names nothing, `--tint-bad` with a `--go-abort` border.
- **Arrows.** The sequence is a 2.5px `--rule` arrow between neighbours, dotted for a child that runs without the cursor waiting. A transition is a 2px arrow coloured by where it goes: `--go-onward` to a later step, `--go-back` to a step already covered, `--go-abort` to an ending that is not success. An onward arrow between two steps of the sequence arcs above the boxes; every other arrow arcs below. A rule from the state's own list leaves `any` dashed.
- **Guard tags.** On each transition, a `--panel` tag with a 3px left edge in the arrow's colour, one clause per line with `&&` or `||` in `--dim` before it, and every value it reads dotted-underlined. A transition with no guard reads `when it finishes` or `always` in italic sans.
- **Wires.** 1.7px grey lines between port dots at 62% opacity: solid for a binding, dashed for one read of an expression, dotted for an output filled by the operation's own result, fainter dotted for a guard's read. A wired dot is filled grey, an unwired dot is hollow, and a port only a binding names has a dashed `--go-abort` ring.
- **Conversation frame.** When two or more boxes share a session, they stack in one column inside a 2px dashed `--rule` frame with a faint `--dim` wash, its name in the data face and its scope in `.app-secondary` along the top.

## The camera and the pointer decide what is legible

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A file with no inputs, outputs, operation or children, or no text at all: `Entry` with a `no inputs` chip, one grey arrow, `Exit` with `no outputs`. | [empty.html](../assets/state-graph/empty.html) |
| loading | Not a look of its own: until the children's declared slots arrive, a child shows only the ports its bindings name. | |
| partial | Cannot occur as a look of its own: what the camera leaves out is the too-big state. | |
| error | The text does not parse: no legend and no map, only a red sentence naming the parse error and sending the person to the JSON tab. | [error.html](../assets/state-graph/error.html) |
| fitted | The whole drawing, centred, at the largest scale up to 100% at which it fits, with `{k}%` filled. | [fitted.html](../assets/state-graph/fitted.html) |
| focused | The pointer is on a box, a port, a line, a guard tag, a read inside a guard, a frame or a name in an edge pill. The answer comes forward: boxes gain an `--accent` border and a `--lift` shadow, lines thicken to 3.2px, and wires take their value's colour, one hue per value, dots included. What those lines touch falls to 45% for boxes and 60% for lines; everything else falls to 12% for boxes and tags and 7% for lines. | [focused.html](../assets/state-graph/focused.html) |
| too big | Fitting would need less than 55%: the map sits at 55% from the top left corner. Where a visible line leaves the map, a floating pill at that edge names what is out there, such as `→ confidence` or `critique.target`, with `→` on the side the lines run and each name in its line's colour; lines leaving close together share one pill, which spells out four names and counts the rest as `+{n}`. A guard tag whose place is off screen slides along its arrow to the nearest visible spot. | [too-big.html](../assets/state-graph/too-big.html) |
| moved | Not a look of its own: after a drag, a wheel turn or a zoom button, `{k}%` is a ghost button; `−` is disabled at 20% and `+` at 200%. | |

## Pointing lights, dragging pans, clicking describes and double-clicking goes

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over any part of the drawing | Asks about that thing | Its answer lit, its neighbours receded, the rest faded; a port row takes `--fill-ghost-hover` and its dot grows |
| Drag past 3px | Pans the map | Grabbing cursor; `{k}%` turns ghost |
| Wheel | Zooms about the pointer, between 20% and 200% | The percentage changes |
| `−` or `+` | Zooms out or in by a quarter about the middle | The percentage changes |
| `{k}%` | Fits the whole state again | The button fills |
| Click a box | Puts its configuration in the context panel: a child's state as its own editor, any other box as that part of this file | The panel opens; the map does not move |
| Double-click a child | Opens the state it mounts in the Files view | That file opens |
| Resize the pane | Fits again while the map is fitted; a moved map stays where it is | The drawing rescales |

The camera is not remembered: reopening the tab fits the state again. Where there is no context panel to fill, as inside the context panel itself, a click on a box does nothing and its tooltip leaves that line out.

## The copy is the file's own names plus the legend's words

| Where | String |
| --- | --- |
| Legend | `values` · `the sequence` · `onward` · `back` · `abort` · `from any` · `one conversation` · `max_iterations {n}` · `timeout {n}s` · `drag to pan · scroll to zoom` |
| Legend tooltips | `nearer the end: on to a later step, or out` · `over ground already covered: a loop, or a step re-entered` · `an ending that is not success — terminate.error, .canceled, .timeout` · `the cursor's own path: the sequence, in order` |
| Zoom | `−` `zoom out` · `{k}%` `fit the whole state in the pane` · `+` `zoom in` |
| Box titles | `Entry` · `Exit` · `operation` · `any` · `{child key}` · `terminate.error` · `terminate.canceled` · `terminate.timeout` · `{target}` or `(no target)` |
| Box subtitles | `{state label}` or `{state id}` · `{reference}` or `./{key}` · `terminate.success` · `after any round` · `no such child` · `kind inherited` |
| Box chips | `no inputs` · `no outputs` · `{operation kind}` · `{function}` · `{model}` · `async` · `jump target` |
| Port notes | `= {default}` · `optional` · `{type}` · `unbound` · `{literal value}` |
| Box tooltip | `click to put its configuration in the side panel` · `double-click to open {state id}` |
| Port tooltip | `{name} — taken` or `{name} — handed back`, then `nothing is wired here` or `nothing declares this slot; a binding names it` |
| Guard tag | `{clause}` per line · `when it finishes` · `always` · chip `no such target`; a read's tooltip `reads {path}` |
| Arrow and tag tooltip | `{guard}` or `unconditional`, then `declared on this child — considered in the round its completion triggers` or `declared in the state's own list — considered after every round, whatever finished`, then `weighed {nth} of {n}; the first match wins` when there are several |
| Edge pill tooltip | `off the screen at the end of the lines that cross here` or `off the screen at the start of the lines that cross here`, then one name per line |
| Frame tooltip | `{name} — one conversation, shared by {n} of these`, then `scoped {scope}: two states are in one conversation only when the name AND the scope match, so the same name written somewhere else is somewhere else` |
| Parse failure | `This file is not valid JSON ({parse error}) — fix it on the JSON tab to see the graph.` |

## The drawing keeps fixed pixel sizes and scales only through the camera

- Resize: box sizes, row heights and gaps are fixed pixels; only the camera scale changes. Edge pills sit outside the scaled drawing, so they keep their size at every zoom.
- Theme: wire colours share one lightness per theme, lighter in dark, so every value reads equally on the ground. Direction is carried by colour, arrowheads and where an arrow arcs; attention is carried by opacity and shadow, never by hue.
- Focus order: only the zoom buttons take keyboard focus. Boxes, ports and lines answer to the pointer alone.
- Long content: box titles, subtitles, chips and ports ellipsise, the port note giving way before the name. Guard tags never truncate: they wrap at 460px. A larger data size setting does not grow the boxes, so larger text is cut sooner.
- Missing content: a side with no ports is not drawn and the other takes the width; a box with no subtitle drops that line.

## The graph departs from the direction in colour meaning and quiet text

- A loop back is drawn in `--bad` red and an unsuccessful ending in `--warn` amber, while outcome boxes take the `--tint-bad` wash.
- Receding and fading use opacity from 7% to 60%, and lit boxes gain the `--lift` shadow.
- `operation`, a word of the app's, is set in `.data-title`; chips naming a function or a model are data set in the app face.
- `when it finishes` and `always` switch to the italic app face inside a data-voiced tag, and the tag's size is a raw ratio rather than a register.
- Edge pill names take their colours from the value hues rather than from tokens.
