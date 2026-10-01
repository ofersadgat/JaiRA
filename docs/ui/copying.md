# Copying a component to the universal tree

How a DOM component in `packages/app/src/renderer` gets its universal copy in `packages/universal`, the
one a phone draws (decision [0015](../engineering/decisions/0015-one-universal-client.md)). The copy must
**look the same, pixel for pixel, and do the same**. The desktop is the reference and never changes for
the sake of the copy.

## The loop

```bash
npm --workspace @jaira/app run build:main                  # once, for the desktop's main process
npx tsx packages/app/shots/studio.mts --port 9301          # leave running: your own desktop and world
npx tsx packages/app/shots/pair.mts --port 9301 --region board             # compare
npx tsx packages/app/shots/cascade.mts '.column' --port 9301 --depth 4     # what the CSS does to it
npx tsx packages/app/shots/peek.mts 'document.title' --port 9301           # what the window is showing
```

- **The studio** keeps a desktop open on a seeded world: a task parked at its gate, a finished one, a
  failed one, an archived one. Its window loads One's dev server, so a saved edit is in the next page
  load with no build. Studios on different `--port`s have their own worlds and windows and share one dev
  server. Stop yours when you are done (kill its `tsx … studio.mts` process and its `electron.exe`).
- **`pair.mts`** loads `/` (the desktop's page) and `/rn` (the universal shell) in the same window, the
  same state and the same look, photographs both, and compares them region by region
  (`sidebar`, `titlebar`, `board`, `panel`, `inbox`, `editor` for the workflow editor, and `viewport` for
  a whole room; `--region` for one). `--scene board|task|gate|archived|settings|files|chat|logs`
  picks a state (`--scene a,b` several, `--scene all` every one, `--all` every scene and specimen) and
  `--look light|dark|<palette>[-wash]-<theme>` a look (`--every-look` for all eight).
  Pictures and red-on-grey diffs land in `packages/app/shots/parity/rn-<port>/`: read the `.diff.png`,
  and the `.dom.png` and `.rn.png` beside it. A copy is done when its region says **identical** (or
  "identical to the eye") in every look.
- **`cascade.mts`** prints, for an element and the ones inside it, every declaration Chromium chose and
  the rule it came from — including a palette's override and which of two equal rules won — plus the
  computed font of every piece of text (`= 13.44px/20.16px "JetBrains Mono" 700 …`). This is the spec.
  Run it with `--look` for each palette whose rules the component has. `--page rn` shows the copy's
  computed boxes instead (`~ flex row | pad … | border … | bg …`), for finding what differs.
- `/rn` has **no `styles.css`** on it and reads the **replayed** tokens, as a phone does. Nothing there
  can be helped by the stylesheet; `pair.mts` refuses the page if it is.

## Where things go

- The copy: `packages/universal/src/components/<Name>.tsx`, same name and props as the DOM component
  where that makes sense. Its header comment lists the `styles.css` rules it carries, as the existing
  copies do (`TaskCard.tsx`, `Sidebar.tsx`, `InboxStrip.tsx`).
- Where the shell draws it: the region files in `packages/universal/src/app/` (`SidebarRegion.tsx`,
  `TitleBar.tsx`, `BoardColumn.tsx`, `PanelColumn.tsx`). Each builds its component's props from the store,
  as `App.tsx` builds the DOM one's — `useShell()` gives `{ state, actions, appearance }`.
- **Logic is shared, never copied.** If `App.tsx` or the DOM component derives something (counts, which
  rows, what a label says), move that code unchanged into a pure module in the renderer
  (`shellModel.ts`, `boardModel.ts` are the pattern) and call it from both. The DOM component must keep
  working exactly as before; `npx tsc --noEmit -p packages/app` and its tests must pass.
- A region not copied yet is `<Uncopied name="…" />`.

## The primitives (`packages/universal/src/primitives.tsx`)

- **`Txt`** — every piece of text. Nothing inherits into a native `Text`, so every `Txt` states its whole
  font. `register="data-title"` etc. are `styles.css`'s ten registers; `spec={{ voice, scale, weight,
  ls, upper, color, lineHeight, tabular, italic }}` overrides or replaces one. `scale` multiplies
  `--size-app`/`--size-data` (write `11 / 12.5` where the CSS says `calc(var(--size-app) * 11 / 12.5)`).
  Line height defaults to the body's 1.5 × the size; `lineHeight: { px: 15 }` for a fixed one. `ellip` is
  `.ellip` (one line, …).
- **`Press`** — anything clickable. React Native's `Pressable` (Tamagui's `onPress` never fires on
  Android). Sizing props go on the outside, the rest on the box inside; `box={({ hovered }) => ({…})}` and
  children as a function give the `:hover` state (web only — a phone has no pointer). What the desktop
  writes on its `<button>` goes on the `Press` and reaches the element that takes the focus: `role`
  (`tab`, `switch`, `checkbox`, `menuitem`, `combobox` — the element stays a `<button>`), `aria-expanded`,
  `aria-selected`, `aria-pressed`, `aria-current`, `aria-haspopup`, and `onKeyDown` / `onFocus` / `onBlur`.
- **`useHover()`** — `:hover` on a box that is not itself pressed (a row).
- **What the desktop does for its window, not for a component** (web only, nothing on a phone):
  `DRAG_REGION` / `NO_DRAG` in a `style` (`-webkit-app-region`: where the frameless window is moved by, and
  the controls and floats that opt out), `WINDOW_GUTTER` (the room the OS's window buttons take),
  `landmark("navigation")` (a `<nav>`, `<header>`, `<aside>`, `<footer>` as its role), `ENTER_KEEPS_FOCUS`
  on a `TextInput` (react-native-web blurs a single-line box on Enter; an `<input>` does not). The page's
  own rules — `:focus-visible`'s ring, the one scrollbar for a scroller nobody styled — and the window's
  name are `app/windowPage.web.ts`'s.
- **`edge(t, { bottom: 1 }, "line")`** — a border on some sides. **Never** `borderStyle="solid"` with
  only some widths: on web Tamagui leaves the other sides at the browser's 3px.
- **`Glyph`** — a symbol in the app voice (▶ ⚙ ⌕), optionally in a fixed width.
- **Tokens**: `const t = useTokens()`; `t.v("line")` a variable, `t.scaled("size-app", 0.8)` a size,
  `t.mix(a, pct, b)` and `t.tint(name, pct)` for `color-mix()`. `colorOf(t, "var(--p1)")` resolves a colour
  the host wrote as CSS (a project's hue). `useLook()` says the palette, scheme, `wash`, `buckets` and
  `lanes` — for rules the stylesheet scopes to `:root[data-palette=…]` and the like, which a copy carries
  by hand. `<TokenScope scope="sidebar">` for a subtree whose variables the stylesheet redefines
  (`.sidebar { --text: … }`).

## What trips a copy

- **Specificity and order.** `cascade.mts` has done it for you: copy the winners, not the rules you
  read first. Two rules of equal specificity: the later one wins, even across the file.
- **Palettes.** Most colours are variables and follow for free. Rules under
  `:root[data-palette="…"]`, `[data-theme="dark"]`, `[data-wash]`, `[data-buckets]`, `[data-lanes]` are
  not: grep them (`awk` over `styles.css` for your classes) and carry each, with a comment.
- **Text inside a Pressable on web** is inside a `<button>`, which centres text: `Txt` sets
  `textAlign="left"`; say otherwise where the CSS does.
- **Block layout** is a column, but margins between blocks COLLAPSE in the DOM and add up in a flex
  column; work the collapsed value out and set it.
- **`:last-child`, `+`, `~`**: a copy cannot see its siblings. Pass the fact as a prop (`last`,
  `first`), as `TaskCard` takes `last` from its lane.
- **`::before`/`::after`** with content are real elements in the copy.
- **Grid** is not in React Native: rows and columns of `View`s with the tracks' widths.
- **Colours composited in floating point** (a translucent `color-mix()` ground) come out one level apart
  from the copy's `rgba()`; `pair.mts` calls that "identical to the eye", and it is.
- **Every window WRITES.** Inside Electron both `/` and `/rn` use the window's own bridge, and a phone
  or a browser is a paired device on the engine's transport (decision 0013, amended 2026-09-30): nothing
  is read-only any more, so pressing Cancel on a parked task cancels it. Only in your studio's own world —
  reseed it (`studio.mts --reseed --port …`) if you spoil it.
- **The dev server remembers a missing file.** Import a file before it exists and the shared dev server
  caches the miss; creating the file afterwards does not clear it ("Failed to resolve import"), and it
  breaks `/` and `/rn` for every studio. Rename the IMPORTING file away and back (content unchanged).
- **Line heights on web.** Blink multiplies a unitless line height out in floating point and snaps to
  1/64px; `Txt` gives pixels, which drifts a long run of lines by hundredths of a pixel each. Where a
  column of prose must stay aligned for its whole length, pass the factor the stylesheet uses.
- **Greyscale text.** Chromium draws text greyscale where it paints over a composited scroller; a copy
  over react-native-web's scroller must sit where the DOM's text does to match (see `OVER_SCROLLER` in
  `components/panel/SidePanel.tsx`).
- **Scrolling to the end on web**: `scrollTo` with a very large y; `scrollToEnd` stops a fraction short.
- **Icons** are `components/panel/Icon.tsx` (SVG). On web a real `<svg>`; on a phone `react-native-svg`.
- **A Tamagui `View` is `position: static` on web.** An absolutely placed child needs
  `position="relative"` on its parent, as the DOM's usually says; `PLAIN_SCROLLER` is static too, so a
  scroller that must be absolute goes inside a wrapper `View`.
- **Form controls.** The desktop page sets no `color-scheme`, so a placeholder is #757575 in every look
  (`placeholderColor`). A menulist's text sits on a `normal` line (1.3867), a plain input's on the
  inherited 1.5; `components/logs/Select.tsx` draws Chromium's own select arrow from measurement.
- **`ch` is not a constant in DM Sans**: its `0` widens with the size (`appCh()`).
- **A form measured before its width is known** lays out as wide; wait for the width before drawing it.
- **An `input` with a `list`** (a `<datalist>` with options) keeps 16 at its end for the list's indicator,
  and its text stops short of it even where the indicator is not drawn (the workflow editor's `Box`,
  `listed`).
- **Equal specificity, later wins — even for a rule you did not expect to meet**: `button.sm` (later)
  beats `.link-toggle`'s size and padding and `.reorder button`'s padding. Read the cascade, not the rule.
- **A `select`'s `width: 100%` is its flex basis** (`flex: 1 1 auto`), not its options' width; squeezed it
  stops at its padding and border, and it shrinks by its CONTENT box — so the padding and border must be on
  the flex item itself, not on a box inside it (`workflow/controls.tsx`'s `Pick`).
- **react-native-web's `onLayout` reports a transformed box's size scaled.** Inside a scaled canvas,
  centre things with `transform: [{ translateX: "-50%" }]` rather than by measuring. And a DOM
  `clientWidth` is rounded to whole pixels: read the element's own on web where the desktop's code reads it.
- **Greyscale text from a composited layer, the other way round**: the desktop's graph canvas (and the
  pane holding it) are composited, so their text is greyscale; the copy's are not until given a 3D no-op
  (`translateZ(0)`) — `will-change: transform` composites too, but rasters the scaled text blurred.
- **A CSS gradient's hard stop is sampled at each device pixel's centre**, with no anti-aliasing: a
  swatch drawn as views of a device pixel each matches it (`workflow/StateGraph.tsx`'s `Strip`).
- **Text nodes are shaping boundaries.** `ready — {detail}` in JSX is two text nodes, and Blink shapes each
  apart: a copy that writes it as one string (`` ` — ${detail}` ``) moves the glyphs after the join by a
  fraction. Keep the DOM's nodes as separate children (`{" — "}{detail}`) — it took the Connections page
  from 168 differing pixels to 28.
- **An inherited `letter-spacing` is a length, not an em.** A heading's `-0.005em` reaches a child set at
  another size as the heading's pixels (`.settings-recheck` inside `.set-section-title`): scale it
  (`-0.005 × 1.1 / (11/12.5)`).
- **A `button`'s words do not wrap, and it is at least as wide as they are** (`white-space: nowrap`,
  `min-width: auto`): a `+` box whose sub is longer than its 200 runs past it. `whiteSpace: "nowrap"` on
  the texts and `minWidth: "auto"` on the pressable (`connections/Row.tsx`'s `AddBox`).
- **`.mono` alone is no rule.** Only some parents give `.mono` the data face (`.cfg-row-title.mono`,
  `.cfg-input.mono`); `conn-probe-at mono` is the app face. Read the cascade, not the class name.
- **Inline icons.** A Tamagui `View` inside a `Txt` is not inline on web; use `floats/InlineGlyph`.
- **Style-only props.** `overflowWrap` and `boxDecorationBreak` go in `style`, or they land on the element
  as attributes.
- **Borders snap.** Chromium lays a 1px border out in whole device pixels (0.667px at 1.5×).
- **Flex items keep their children's margins**: they do not collapse out of a flex column
  (`.modal-wide`), and each child of a flex button is its own item with its edge spaces dropped.
- **Portalled floats** (menus, cards, dialogs) are under `<body>`: a rule scoped to where they were
  opened from (`.approval-surface .mono`) does not reach them — nor should the copy's.
- **Floats** are `components/floats/`: `Float` places one as `Popover` does, `Modal` is the backdrop and
  box, `anchor.ts` finds what it hangs from (the element a press handed over, on web).
- **A block's strut.** A `div` holding an inline span is as tall as the line of its OWN font (the body's
  13/12.5 on 1.5 = 19.5), not the span's: a copy draws the span in a box that tall, the text moved down
  by the difference of the two baselines (`RouteCascade`'s divider, the composer's figure).
- **Flex columns do not collapse margins.** A gate in a state's panel (`.st-block`, a flex column) keeps
  the heading's 8 and the chooser's 14 apart; the same gate in an `.inline-gate` (a block) collapses them.
- **`.cx-col { width: 148px }` holds for `.cx-col-last` too**, under its `min-width: 190` — read every
  rule the element matches, not the one named after it.
- **`container-type: inline-size` gives a box no width of its own.** `.cfg-fields` is one, so a gate's
  `.modal` (as wide as what it holds) is as wide as its heading and buttons, and the form inside it stacks
  under 380. The copy's `FieldGrid` says `containerType` on web and lays its list out of flow on a phone.
- **A flex item is a formatting context of its own**: margins do not collapse through it. The same gate
  body collapses its first margin into the heading's in `.inline-gate` (a block) and keeps it in the
  gallery's `.modal-wide` (a flex column) — `GateSurface`'s `flex`, `ChoiceList`'s `flat`.
- **A newline in a markdown paragraph is a space** unless something round it says `pre-wrap`; a native
  `Text` breaks the line. `Markdown`'s (and `ValueView`'s) `softbreak="space"` where the host collapses it.
  The same holds for plain text: a schema's description in a field's hint has newlines, which the DOM's
  `white-space: normal` collapses (`Field` collapses a string hint).
- **A disabled checkbox is Chromium's own colours, not a faded box**: in light, the ring and a checked
  box's ground #767676 at 30% and the tick white at 60% (`form/inputs.tsx`'s `Checkbox`).
- **A roving tab stop** (a rail's tabs, one of them in the Tab order): `Press`'s `focusable` — on web it is
  react-native-web's `tabIndex`; its `focusable` prop does nothing there.
- **react-native-web's text boxes stop a key from bubbling** (`e.stopPropagation()` on every keydown): a
  React `onKeyDown` on a box round one, and a `window` listener on the way up, hear nothing typed in it.
  Listen on the element itself (`SidePanel`'s Alt+←, `useEnterSubmits`) or on the way down (`MenuLayer`'s
  Escape), and let the box's own handler go first — it has prevented the default by the next task if it
  took the key.
- **A native control's keys are not a copy's for nothing**: a closed `<select>` steps with the arrows and
  finds a choice by its letter (`form/selectKeys.ts`), a `<form>` submits on Enter in a single-line box
  (`form/useEnterSubmits.ts`), `type="number"` steps with ↑ and ↓, a link is reached by Tab and named by
  the right-click menu only as a real `<a>` (`render="a"`, and then no press handler: the anchor opens it).
- **A test key must carry its character.** `driver.mts`'s `press()` sends `rawKeyDown`, which a JS key
  handler hears and a form's implicit submission does not: send `keyDown` with `text` to press Enter as a
  keyboard does.
- **Found on the device, not on `/rn`** (the emulator pass, `packages/app/shots/android.mts`):
  - A hand-set `fontFamily: t.v("font-data")` is the whole CSS stack, which Android cannot read and
    draws in the system font. Go through `Txt`, or `faceOf()` for a font set by hand.
  - React Native has no `white-space: nowrap`. Text the desktop keeps on one line and clips must say so:
    `numberOfLines={1}` for an ellipsis, or measure its one-line width and clip, as the project crumb
    does (`Crumbs.tsx`).
  - A `Press` inside a stretched box can grow without bound in Yoga (Connections' rows reached a million
    px): `fill={isWeb}`.
  - Android dashes a border only when it is set on all four sides with a radius; Tamagui splits it into
    sides, so dashed borders draw solid there (not fixed yet).
  - `accessibilityRole` values the web accepts (`separator`) crash Android; use `role`.
  - Metro stubs `react-native-reanimated` for gesture handler (`metro.config.cjs`); a Metro started
    before that change crashes the app at launch until restarted.
- **A box centred by `left: 50%; transform: translateX(-50%)`** (the toast, the crash banner) lands on a
  fraction of a pixel that flex centring does not: on web place the copy the same way. It is as wide as
  its words up to what is left of its containing block at 50% — half the window — before any `max-width`.
- **Something fixed to the window** gets a specimen in a stage that stands in for the window: a DOM box
  with `contain: layout` (the containing block of what is fixed inside it), and a copy that takes
  `staged` to be absolute in its box instead (`shellSpecimens.tsx`).
- **The phone is the final check, not the loop**: `packages/app/shots/android.mts` on the emulator, once
  a region passes in every look. It pairs the phone with the desktop it launches by the code that
  desktop shows (`machines:pairCode`), over `adb reverse` to the engine's loopback port
  (`MachinesView.self.port`): no token is printed or passed anywhere.

- **The studio's dev server is shared.** A file that stops parsing — a half-written edit, a shell heredoc
  that turned `"
"` into a real line break — breaks `/` and `/rn` for every studio at once, and the
  window then keeps One's "Route failed to load" overlay over both pictures until it reloads. Write a
  file whole or with exact edits; rerun a comparison that says "gave up waiting … to draw".
- **Import from `@jaira/universal`, not a path under it.** The client's alias points the package name
  at `src/index.ts` alone, so `@jaira/universal/components/…` does not resolve on the dev server: export
  the piece from the index.
- **`scrollbarProps()` is for a `ScrollView`.** Its `dataSet` becomes `data-scrollbar` on
  react-native-web's element, but a Tamagui `View` hands it on as `dataset="[object Object]"`; a View
  that scrolls itself (`overflow: auto`) takes `viewScrollbarProps()`.
- **A still picture holds only CSS animations.** The shots stop `animation` and `transition`; an
  `Animated` loop keeps turning. What turns on web (a spinner) is a CSS animation (`Turn.web.tsx`), and
  the native driver on a phone.
- **A form field's frame is its host's.** `.modal .field` and `.inline-gate .field` put 12 above a field
  and dim its label; a bare `.field` (a state's panel, a transcript) has neither — `FieldFrame` says
  which.

- **The dev server can miss a quick second edit.** Two saves of one file in a row can leave it serving
  the first: `curl` the module from `127.0.0.1:8081` to see what it serves, and `touch` the file.
- **An inline iframe adds its line's depth.** In `.vv-body` a 360-tall frame makes a 365.5-tall block
  (the frame sits on the baseline of a line of the block's font): the copy stands it in a strut.
- **A space after an inline chip.** A copy's `Txt` that begins a line of its own collapses a leading
  space the DOM keeps mid-line after a chip; write a no-break space after the chip.
- **A 1px border is 0.667 in the studio.** Chromium draws it at device pixels while `devicePixelRatio`
  reads 2 there; where the width is geometry (a picture's frame), measure it on web (`ring.web.ts`).
- **Chromium splits a line's leading** by giving the ascent half of it rounded down and the descent
  the rest — the half pixel a baseline-placed box is off by, when it is off.
- **An island brings the stylesheet, and only an island has it.** The component is half its rules (the
  markdown editor is CodeMirror under sixty `.cm-*` rules and the page's own type), so on web `Island`
  installs `styles.css` inside `@scope ([data-island])` (`islands/islandStyles.ts`): it reaches the island's
  elements and no copy. `:root` there is the island's own box, which carries the look as the root does.
  Before it, the editor stood in the browser's serif, 57px taller than the desktop's, and every stage
  under it on the Components page was that much lower.
- **An island stands without its host's ancestors.** `.markdown pre` and `.review-detail .monaco-host` name
  classes the universal tree does not have. `under={["markdown", "md-block"]}` stands the component under
  boxes of those classes that generate no box (`display: contents`); the diff's ring is still its `frame`.
- **What an editor reads off the root.** Monaco takes its face and size from the ROOT's computed style
  (`--font-data`, `--size-editor`): `islandStyles.ts` lends the root those two where it has none.
- **A sticky box holds under its scroller's padding.** `.gallery-common { top: 0 }` in a scroller padded
  by 12 sticks 12 down; react-native-web puts a `ScrollView`'s padding on its content, so the copy says 12.
- **A `button` keeps the base rule.** `.ft-mode` turns a button into a column and resets nothing else, so
  `align-items: center` and the radius are still the base `button`'s: its content sits mid-tab, and the
  accent under the chosen one turns up at its ends. `.cfg-input` on a `<select>` is `width: 100%` too.
- **A flex row with no `align-items` stretches** its buttons to its tallest child (`.note-reply`: four more
  than their own height) — invisible while the ring is faint, plain in the contrast palette.
- **An inline box does not give way.** `.cx-chip-wrap` shrinks and the `inline-flex` chip in it does not:
  squeezed, the desktop's composer chips keep their words and run over one another.

- **A photograph holds nothing that closes on resize.** `app.shot()` captures beyond the viewport, which
  resizes the page and so closes a `MenuLayer` or a suggestion list; hold those open another way.
- **`<datalist>` is a native window.** No page capture shows Chromium's list; it was photographed from a
  test Electron app, and it follows the OS theme, not the page's look.
- **A hook after an early return.** A component that returns early for "nothing yet" and declares
  state below it crashes when the nothing becomes something ("Rendered more hooks"): state first.

## A leaf, on its own

A component with no place in a scene yet (or one worth checking alone, in every variation) gets a
**specimen**: `packages/client/src/specimens/registry.tsx` names it, with its DOM original and its copy,
each drawn from the same fixture at the width it usually has. Then:

```bash
npx tsx packages/app/shots/pair.mts --specimen markdown --every-look --port 9301
```

draws `/specimen-dom?name=markdown` (the desktop's stylesheet) and `/specimen-rn?name=markdown` (the
native path), compares them, and lists every run of text that moved and by how much — which line is
out, not just that something is. `cascade.mts --path 'specimen-dom?name=markdown&look=light'` reads the
rules on a specimen page.

## The reference pictures (goldens)

`pair.mts` needs the desktop's page to compare against, and that page is what the migration deletes
(decision 0015, the migration's step 2). So its pictures are kept first, one per scene or specimen and
look, with what a comparison needs of the page they came from; from then on `/rn` is held against those.

```bash
npm --workspace @jaira/app run shots:freeze -- --port 9301            # every scene and specimen, every look
npm --workspace @jaira/app run shots:freeze -- --port 9301 --verify   # photograph again: do they reproduce?
npm --workspace @jaira/app run shots:goldens -- --port 9301           # /rn alone, against the kept pictures
npx tsx packages/app/shots/pair.mts --freeze --scene board,task --look dark --port 9301   # a few of them
```

- **Where.** `packages/app/shots/goldens/<scene>/<look>.png` and `…/specimen-<name>/<look>.png`, each with
  a `<look>.json`: the scene's regions (or the specimen's box), every run of text and where it stood,
  the desktop's editors' boxes, what the world keeps changing, the window, and the world it was taken in.
  `manifest.json` lists the set. 1,864 pictures on 2026-09-30 (121 scenes and 112 specimens in eight
  looks), 279 MB; the folder is not in git (`.gitignore`).
- **`--against-goldens`** photographs `/rn` only and grades it as `pair.mts` grades it against `/`: the
  same regions, cropped at the same places, the copy's islands painted out of both. It fails by name on
  a picture that was never frozen, one frozen in another world (the parked task's id is the world's
  name: another seeding draws other ids and times) and one frozen in a window of another size.
- **The world keeps writing its log**, so what the log draws is painted out of a comparison against
  goldens: the counts on the sidebar's Logs and Settings rows, the Logs room's rows and tally, the
  needs-attention card's lines about the log (`VOLATILE` in `pair.mts`). `--mask-volatile` does the same
  to a comparison against `/`, so the two can be held to each other: `--report a.json` on one run,
  `--same-as a.json` on the other.
- **Freeze a world that has seen every scene once.** Some scenes make what they show the first time they
  run (`task-adopted` writes a workflow, and the planning column is called by its id from then on;
  opening a task marks its counts seen), so the first pass over a new world is not the second. Run
  `pair.mts --scene all` once, then freeze.
- **Freeze from the built client**, not the shared dev server: `npm --workspace @jaira/client run build`,
  then `studio.mts --built --port 9301` serves that build to its window as files (`--pages <url>` for a
  server of your own). A freeze is some two thousand page loads over two or three hours; on the shared
  server every other copier's save reloads the page under a scene, and the load is what runs the server
  out of memory. `pair.mts` tries a picture again when the page was reloaded under it, and goes on past
  one it cannot take. Freeze and compare from the SAME build: a golden is of the desktop's page as that
  build drew it.
- **A picture waits for its page to hold still** (`App.settled`): nothing being fetched, no editor still
  to mount, and its boxes, words and token colours unchanged for a second. A fixed pause photographed
  Monaco at "loading the diff editor…" on whichever page asked for it first.
- **What `--verify` tells apart.** A picture reproduces to the pixel; or to the eye (a pixel a level
  off); or but for the log's counts; or but for the inside of an editor — on the dev server Monaco draws
  a diff's deleted lines with the token colours it has when the diff arrives, and which arrives first is
  not the page's to decide (the copy's islands are painted out of every comparison, so no verdict rests
  on it). Anything else does not reproduce, and is a scene that shows what an earlier one left behind: a
  panel still open on the last task, scrolled where that scene scrolled it (`files-graph`,
  `files-plan-children`). `--verify` on a comparison against `/` makes the check in passing.

## Shared copies

- **`Markdown`** (`components/Markdown.tsx`) — `markdown.tsx`'s renderer: the same parse, native views.
  Props for the contexts that change it: `scale` (13/12.5 in a panel, 13.5/12.5 in a transcript message,
  12.5/12.5 in a value view), `lineHeight`, `trimEnd`, `padding`. `registerFenceRenderer` for fenced
  blocks, as the desktop's.
- **`Pill`**, **`Pills`**, **`TaskCard`**, **`ProjectChip`** (the inbox strip's), **`Sidebar`**.
- **Settings** (`components/settings/`) — `settingsLayout.tsx`'s page, section and row
  (`SettingsPage`, `SettingsSection`, `SettingsRow`, with the ↺ and ⓘ), and the controls every page is
  made of: `Switch`, `Segmented`, `SelectInput` (a closed `<select>`, arrow and all), `SizeStep`,
  `TextField` (`.cfg-input`), `Button` (`button` and its `ghost`, `quiet`, `primary`, `danger`),
  `LayerPicker`. A section says it is one to `parts.ts`, which is what the sidebar's accordion lists —
  there is no DOM to query for `data-part`.
- **Connections' rows** (`components/settings/connections/Row.tsx`) — the row every provider, forge
  and MCP server is (`ConnRow`: what it is | its boxes | its switch and chevron, then what goes across),
  its boxes (a login card, a key box, the `+` boxes, a waiting box) and the table under a row
  (`Probe.tsx`, whose `useColumn` is a grid's `auto` column). What they say is `connectionsModel.ts`'s.
- **The usage ring and figures** (`components/usage/`) — `Ring` and `MoneyRing`, shared with the
  composer, and a sign-in card's and a key's figures (`usageFigure.ts`'s words).
- **The transcript** (`components/panel/`) — `SessionTranscript.tsx`'s `Transcript` (messages, the work
  between them, pauses, compactions, an armed cut; `padding` for a host that sets another), its rows
  (`WorkRows.tsx`: a call, a thought, a call being written, a journal fact, `ShellLine`, `OutcomeNote`,
  `AnsweredForYou`), the summary of a stretch of several steps (`WorkSummary.tsx`, its hover cards in a
  `HoverLayer`), the marks between blocks (`TranscriptMarks.tsx`: `GapMark`, `CompactionLine`,
  `DayChip`) and a run's page of panels (`SessionBands.tsx`: bands across, torn edges, `ForkMark`,
  `OriginMark`, the notes). Fixtures for each: `transcript-*` and `session-bands` specimens.
- **The composer's cards** (`components/chat/ComposerCards.tsx`, `ComposerTools.tsx`, `UsageCards.tsx`) —
  `ChipCard` (a chip's `.cx-pop`), `Opt`, `RouteCascade`, `BucketPicker`, `KeepPermissionSet`, the Tools
  card, and the account's and context's cards; `composer-*` scenes open each.
- **The artifact gates** (`components/artifact/`) — `review_artifact`, `edit_artifact` and the changeset
  reviewer (`review_artifacts`); what they decide is `artifactReview.ts`'s and `changesetReviewModel.ts`'s.
  A note is anchored to a selection on web with the desktop's own code (`reviewSelection.ts`, over the
  DOM react-native-web draws); a phone lists notes but cannot select a passage. The diff and the markdown
  editor are islands; an HTML or SVG artifact drawn as a page is the `artifact` island (a WebView on a
  phone — web content by nature). `pair.mts --specimen` paints islands out, as a scene does.
- **`PLAIN_SCROLLER`** (`primitives.tsx`) on a `ScrollView`'s style and content style: without it
  react-native-web's `translateZ(0)` and `z-index: 0` composite the scroller and Chromium draws its
  text greyscale, where the DOM's `overflow: auto` keeps subpixel text. That fixed the sidebar's
  sections list; a Settings page scrolled away from its top still draws greyscale on `/rn` (the DOM's
  stays subpixel), for a reason not found yet — `pair.mts` counts it as anti-aliasing.
