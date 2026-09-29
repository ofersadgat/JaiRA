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
  picks a state and `--look light|dark|<palette>[-wash]-<theme>` a look (`--every-look` for all eight).
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
  children as a function give the `:hover` state (web only — a phone has no pointer).
- **`useHover()`** — `:hover` on a box that is not itself pressed (a row).
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
- **The studio's window WRITES.** The read-only bridge is the socket's (phone, browser); inside Electron
  both `/` and `/rn` use the window's own bridge, so pressing Cancel on a parked task cancels it. Only
  in your studio's own world — reseed it (`studio.mts --reseed --port …`) if you spoil it.
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
- **The phone is the final check, not the loop**: `packages/app/shots/android.mts` on the emulator, once
  a region passes in every look.

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
- **`PLAIN_SCROLLER`** (`primitives.tsx`) on a `ScrollView`'s style and content style: without it
  react-native-web's `translateZ(0)` and `z-index: 0` composite the scroller and Chromium draws its
  text greyscale, where the DOM's `overflow: auto` keeps subpixel text. That fixed the sidebar's
  sections list; a Settings page scrolled away from its top still draws greyscale on `/rn` (the DOM's
  stays subpixel), for a reason not found yet — `pair.mts` counts it as anti-aliasing.
