# Building the UI

How to add or change something the app draws. There is **one implementation of every feature**: the
universal tree in `packages/universal` (Tamagui over react-native, and react-native-web in a browser),
drawn by the desktop's window, by a browser tab and natively by a phone (decision
[0015](../engineering/decisions/0015-one-universal-client.md)). The DOM renderer it was copied from was
deleted on 2026-10-01; the last commit that has it is tagged `dom-renderer-final`.

Two rules decide most of what follows:

- **A component draws; a module decides.** Anything a component would work out — which rows, what a label
  says, whether Save is offered — is a pure function in `packages/app/src/renderer` (`@jaira/ui`), with a
  test. The component calls it.
- **A change to the look is deliberate.** Every scene and specimen has a reference picture. A picture
  that changes because you meant it to is accepted by name, after looking at the diff; one that changes
  for any other reason is a bug.

## The loop

```bash
npm --workspace @jaira/app run build:main                       # once, and after any change to main or the service
npx tsx packages/app/shots/studio.mts --port 9301               # leave running: your own desktop and world
npx tsx packages/app/shots/peek.mts 'document.title' --port 9301            # what its window is showing
npx tsx packages/app/shots/pair.mts --port 9301 --specimen markdown --every-look   # a component against its picture
```

- **The studio** keeps the real app open on a seeded world (`parityWorld.mts`: a task parked at its gate,
  a finished one, a failed one, an archived one). Its window loads One's dev server (port 8081), so a saved
  edit is on the next page load with no build. Studios on different `--port`s have their own worlds
  (`shots/.world-studio-<port>`) and windows and share the one dev server: the first to start runs it.
  `--reseed` starts a studio's world over. Stop yours when you are done: kill its `tsx … studio.mts`
  process and its `electron.exe` (the one with `--remote-debugging-port=<yours>`).
- **`peek.mts`** prints the window's address, whether it drew and the first of its text, and evaluates an
  expression in the page.
- **The page** is `/`, the universal shell, with **no stylesheet of the app's on it**: every colour and
  size comes from the replayed tokens, as on a phone. Nothing on it can be helped by a CSS rule, and
  `pair.mts` refuses the page if `styles.css` is found on it. Only an island brings the stylesheet, scoped
  to itself.
- `npm run start` is the app as it ships: it builds main and the client and opens Electron on the built
  page.

## Where things go

| What | Where |
| --- | --- |
| The shell: its frame and one file per region or room | `packages/universal/src/app/` — `UniversalApp.tsx`, `SidebarRegion.tsx`, `TitleBar.tsx`, `BoardColumn.tsx`, `PanelColumn.tsx`, `FilesView.tsx`, `ChatView.tsx`, `SettingsView.tsx`, `LogsView.tsx`, `DebugView.tsx`, `GalleryView.tsx` |
| A component | `packages/universal/src/components/<Name>.tsx`, or the folder of the room it belongs to: `panel/`, `chat/`, `run/`, `files/`, `workflow/`, `settings/`, `form/`, `floats/`, `artifact/`, `logs/`, `debug/`, `usage/`, `gallery/` |
| Its logic | a pure `.ts` module in `packages/app/src/renderer` (`boardModel.ts`, `composerModel.ts`, `transcriptRows.ts`, `panelStack.ts` are the pattern), imported as `@jaira/ui/<module>`, with a test in `packages/app/test` |
| The store and the bridge | `packages/app/src/renderer/store.ts`: `useApp()` is called once, by `UniversalApp`, and every region reads it through `useShell()` (`app/shell.ts`), which gives `{ state, actions }` |
| A fact two regions share that is not the store's | a small store in `app/viewState.ts` (the run's reading, the board's group) or `components/panel/panelBridge.ts` |
| What only the desktop's window does | `app/windowPage.web.ts` (the focus ring, the page's scrollbar, the window's name) and the web-only constants in `primitives.tsx` |
| A DOM component that cannot be drawn natively | an island (below) |

- A region file builds its component's props from the store; a component takes props and knows nothing of
  the store, so a specimen can draw it from a fixture.
- A piece that a specimen or the client needs is exported from `packages/universal/src/index.ts`. Import
  from `@jaira/universal`, never a path under it: the client's alias points the package name at the index
  alone, so `@jaira/universal/components/…` does not resolve on the dev server.
- A component's header comment says what it draws and the measures it draws it by, as the existing ones do
  (`TaskCard.tsx`, `Sidebar.tsx`, `InboxStrip.tsx`). Where one names a class (`.run-doing`), that is the
  rule of the DOM renderer's stylesheet it was copied from — at the tag, the record of why a number is
  what it is.

## The primitives (`packages/universal/src/primitives.tsx`)

- **`Txt`** — every piece of text. Nothing inherits into a native `Text`, so every `Txt` states its whole
  font. `register="data-title"` is one of the ten registers of [direction.md](direction.md) (`REGISTERS`);
  `spec={{ voice, scale, weight, ls, upper, color, lineHeight, tabular, italic }}` overrides or replaces
  one. `scale` multiplies `--size-app` or `--size-data` (`11 / 12.5` for eleven at the default size).
  Line height is 1.5 × the size unless stated; `lineHeight: { px: 15 }` for a fixed one. `ellip` is one
  line, cut with an ellipsis. `font(t, spec)` is the same font for something that is not a `Txt`, and
  `faceOf(t, voice, weight, size)` the family alone, for a text that sets its own font: a CSS stack is no
  family on Android.
- **`InkContext`** — the colour a `Txt` that names none takes, where a box sets one for everything in it.
- **`Press`** — anything clickable: React Native's `Pressable` around a Tamagui box (Tamagui's `onPress`
  never fires on Android). Props that size and place it go on the `Press`; the box's own go in `box`, which
  may be a function of the press state — `box={({ hovered }) => ({…})}`, and children as a function — for a
  hover (web only: a phone has no pointer). A `role` (`tab`, `switch`, `checkbox`, `menuitem`, `combobox`),
  `aria-expanded`, `aria-selected`, `aria-pressed`, `aria-current`, `aria-haspopup`, `onKeyDown`,
  `onFocus` and `onBlur` go on the `Press` and reach the element that takes the focus. `label` is its
  accessible name, `title` its tooltip, `focusable` its place in the Tab order.
- **`useHover()`** — hover on a box that is not itself pressed (a row).
- **`useHoverFloat()`, `Tap`, `HoverFloatLayer`** (`components/floats/hoverFloat.tsx`) — something that
  shows more of itself in a float (a hover card, a tip with a breakdown in it). How it opens is the
  POINTER's to decide, not the platform's (`useCanHover()`, `canHover.ts`): under a pointer that hovers,
  on hover or the keyboard's focus; under a finger — the phone app, or a phone's browser — on a press, as
  a modal that a press outside it closes. Never write `isWeb ? onMouseEnter : …` for this: a touch screen
  on web has no hover either.
- **`onTouchElsewhere()`** (`touchElsewhere.tsx`) — for what a press opens IN PLACE rather than in a float
  (a message's rail, under a finger): the shell's root hears every touch after the boxes nearer the finger
  have, so a press anywhere else puts it away. A Tamagui box does not hand `onTouchStart` on on a phone:
  `TouchRoot` is a React Native box round the shell there.
- **`edge(t, { bottom: 1 }, "line")`** — a border on some sides. Never `borderStyle="solid"` with only
  some widths: on web Tamagui leaves the other sides at the browser's 3px.
- **`Glyph`** — a symbol in the app voice (▶ ⚙ ⌕), optionally in a fixed width.
- **Scrolling.** A `ScrollView` takes `PLAIN_SCROLLER` on its style and content style and
  `scrollbarProps(t)`; a Tamagui `View` that scrolls itself (`overflow: auto`) takes
  `viewScrollbarProps(t)`. A bare react-native `View` that must stay positioned without becoming a
  stacking context takes `NO_STACK`. Why: "Greyscale text" below.
- **Lengths.** `lengthToken(t, "control-radius", 7)` and `padToken(t, "control-pad", [3, 10])` for a token
  that is a length; `appCh(t, scale, n)` for `n` characters of the app voice (its `0` widens with the
  size); `placeholderColor(scheme)` for a placeholder.
- **The desktop's window, not a component** (web only, nothing on a phone): `DRAG_REGION` / `NO_DRAG` in a
  `style` (where the frameless window is moved by, and the controls and floats that opt out),
  `WINDOW_GUTTER` (the room the OS's window buttons take), `landmark("navigation")` (a region's role),
  `ENTER_KEEPS_FOCUS` on a `TextInput` (react-native-web blurs a single-line box on Enter).

## Tokens and looks

- `const t = useTokens()`; `t.v("line")` a variable, `t.scaled("size-app", 0.8)` a size,
  `t.mix(a, pct, b)` and `t.tint(name, pct)` for a mixed colour. `colorOf(t, "var(--p1)")`
  (`components/Sidebar.tsx`) resolves a colour the host wrote as CSS (a project's hue).
- The tokens are the `:root` blocks of `packages/app/src/renderer/styles.css` — the one place a palette,
  a scheme or a size is defined. `packages/universal/scripts/tokens.mjs` turns them into
  `cssTokens.generated.ts`, and `cssTokens.ts` replays the cascade for where a component stands;
  `npm run typecheck` fails when the generated file is stale (`npm --workspace @jaira/universal run tokens`
  rewrites it). `packages/app/shots/tokens-check.mts` holds the replay to what Chromium computes.
- A new token is a new variable in those blocks. A new palette is a new `:root[data-palette="…"]` block.
- `useLook()` says the palette, scheme, `wash`, `buckets` and `lanes`, for a rule that depends on the
  look itself rather than on a variable (a palette that draws cards as tiles). The component carries such
  a rule by hand, with a comment.
- `<TokenScope scope="sidebar">` for a subtree whose variables the token blocks redefine
  (`.sidebar { --text: … }`).
- Check a change in **all eight looks** (`pair.mts --every-look`): light, dark, and each palette with and
  without its wash.

## Web and native

One file serves both wherever it can. Where it cannot:

- **A pair of files**: `Name.tsx` and `Name.web.tsx` (the plain file is the phone's) or `Name.tsx` and
  `Name.native.tsx` (the plain file is the web's). The bundler picks by platform. Among the existing
  pairs: `MenuLayer`, `Lift`, `Turn`, `Img`, `floats/TipLayer`, `floats/InlineGlyph`, `floats/keyboard`,
  `form/SuggestLayer`, `form/Range`, `panel/Svg`, `panel/HoverLayer`, `chat/Pulse`, `canHover`, `islands/Island`, `tokens`,
  `clipboard`, `app/windowPage`.
- **`isWeb`** (from `@tamagui/core`) for a line or two inside one file.
- **DOM code never reaches a phone.** Anything that touches `document`, a DOM event or a DOM-only package
  goes in a `.web.tsx`. `node packages/client/scripts/nativeGraph.mjs` (part of `npm run typecheck`) walks
  what Metro would bundle and names any DOM-only package it reaches, with the chain of imports that
  reaches it.
- On a phone's width (under 700, `phoneModel.ts`' `PHONE_WIDTH`) the shell lays itself out for the
  phone (decision 0015, amended 2026-10-04): `UniversalApp phone` draws `PhoneFrame.tsx` — the sidebar a
  drawer with an INBOX row, the context panel a sheet (`panel/PanelSheet.tsx`), the run's Steps a rail at
  its conversation's edge (`panel/StepsRail.tsx`), the board one column at a time with All first
  (`Board.tsx`' `PhoneColumns`). A component asks `usePhone()` (`app/phone.ts`); everything it does
  differently is behind that, and the desktop is untouched. What decides the layout is
  `phoneModel.ts`'s, with a test. Wider (a tablet, a phone on its side) the shell is the desktop's,
  fitted to the screen (`DesktopFrame` in `packages/client/src/native`). Either way the root lays out
  strictly (`StrictLayout`), so Yoga behaves as CSS flexbox does.
- `packages/app/shots/phoneLayout.mts` drives the phone's layout in a phone-sized headless Chrome: the
  drawer, the Inbox, the sheet's heights and the main view, the Steps rail, the board. Built client
  first (`npm --workspace @jaira/app run build`).

## Islands

An island is a DOM component the universal tree hosts instead of drawing: `<Island component="…"
props={…} />` (`packages/universal/src/islands`). There are six — `code` and `diff` (Monaco,
`monacoDiff.tsx`), `markdownEditor` (CodeMirror, `markdownEditor.tsx` and `markdownDocument.tsx`),
`schemaText` (`schemaEditor.tsx`), `markdown` (`markdown.tsx`) and `artifact` (`htmlFrame.tsx`,
`interactiveArtifact.tsx`) — and their components are the only `.tsx` files left in
`packages/app/src/renderer`, with `popover.tsx`, which the schema editor's completion list uses.

- On web `Island.tsx` draws the component inline, lazily. On a phone `Island.native.tsx` draws its page
  (`packages/client/island/<name>.tsx`, built by `npm --workspace @jaira/client run build:island`) in a
  WebView, with props, events and commands over a bridge (`island/protocol.ts`).
- **An island brings the stylesheet, and only an island has it.** On web `islandStyles.ts` installs
  `styles.css` inside `@scope ([data-island])`: it reaches the island's elements and nothing else. `:root`
  there is the island's own box, which carries the look as the root does.
- **An island stands without its host's ancestors.** A rule written for it under other classes
  (`.markdown pre`) matches only if those boxes exist: `under={["markdown", "md-block"]}` stands the
  component under boxes of those classes that generate no box (`display: contents`).
- Monaco takes its face and size from the root's computed style; `islandStyles.ts` lends the root
  `--font-data` and `--size-editor` where it has none.
- A rule in `styles.css` is for a token or for an island. A rule for anything else is dead.
- A new island is a ruling, not a convenience (0015: the editors are the one place a phone may differ).
  `pair.mts` paints islands out of every comparison; what is inside one is checked by
  `packages/app/shots/monaco.mts` and `islands.mts`.

## Looking at it

- **In the app**: the studio's window, driven by hand or by `peek.mts`. `studio.mts --goldens-world`
  opens the world the reference pictures were taken in (below).
- **Alone**: a specimen. `/specimen-rn?name=<name>&look=<look>` draws one component from a fixture in a
  box of its usual width (`#specimen`). `look` is `light`, `dark` or `<palette>[-wash]-<theme>`. With no
  `name` the page carries every specimen's name (`#specimens`, in `data-names`), which is where
  `pair.mts --all` reads them.
- **In the Components room** of the app, for a gate or a dialog: every surface a run can park at, a row
  each, from the catalogue in `galleryModel.ts`.
- **On a phone**: the emulator rigs (below).

## A specimen for a leaf

A component with no place in a scene, or one worth seeing in every variation, gets a specimen:

1. Export the component from `packages/universal/src/index.ts`.
2. Add `packages/client/src/specimens/<yours>Specimens.tsx` (or extend one): a name, the box's `width`,
   and `rn`, a function drawing the component from a fixture. `transcriptSpecimens.tsx` and
   `valueSpecimens.tsx` are the pattern.
3. Spread it into `SPECIMENS` in `registry.tsx`.
4. `pair.mts --specimen <name> --every-look`, look at the pictures, then accept them (below).

Something fixed to the window (the toast, a dialog) takes `staged` to be absolute in its specimen's box
instead (`shellSpecimens.tsx`, `floatSpecimens.tsx`).

## A scene for a state of the app

A scene is a state of the whole app reached from a freshly loaded page: `SCENES` in
`packages/app/shots/parityWorld.mts`, each a `name` and a `reach(app)`. Reach things by what the page
**says**, by a role, a title or accessible name, or a `data-testid` — never by a class (`app.clickText`,
`says(…)`, `clickFirst`, `clickTitled`). The inside of an island is the one exception: it is that editor's
own DOM. If the scene needs something the seed does not make, make it in `reach` the first time it runs,
as `conversation` does, rather than changing the seed: another seeding is another world, and every
scene's picture would be of one that is gone.

## How it is checked

**While working**, only what the change reaches, on the dev server (no build between an edit and its
picture):

```bash
npx tsx packages/app/shots/studio.mts --goldens-world --port 9301           # leave running
npx tsx packages/app/shots/pair.mts --port 9301 --changed                   # what the branch reaches, light
npx tsx packages/app/shots/pair.mts --port 9301 --changed HEAD              # what the working tree reaches
```

**Before a merge**, the full sweep, on the built client:

```bash
npm --workspace @jaira/client run build                                     # the client the gate runs on
npx tsx packages/app/shots/studio.mts --goldens-world --built --port 9301   # leave running
npx tsx packages/app/shots/pair.mts --port 9301                             # every scene and specimen, light
npx tsx packages/app/shots/pair.mts --port 9301 --every-look                # all eight looks
npx tsx packages/app/shots/pair.mts --port 9301 --scene task --region panel --texts
npx tsx packages/app/shots/pair.mts --port 9301 --accept --scene <name>     # keep the page's picture as the reference
```

- **The reference pictures** ("goldens", `packages/app/shots/goldens/`, not in git) are one per scene or
  specimen and look, with what a comparison needs beside each: where the regions stood, every run of
  text, what the world keeps changing, the window. Most are of the DOM renderer, taken from the tag
  `dom-renderer-final`; the rest were accepted from the universal page. The manifest says which.
- **`pair.mts`** photographs the page and grades it against the golden of the same name, region by region
  (`sidebar`, `titlebar`, `board`, `panel`, `inbox`, `viewport` for a whole room, and the whole window;
  the regions are the golden's own, read from its manifest). `--scene a,b`, `--scene all`,
  `--specimen a,b`, `--all`, `--look`, `--every-look`, `--region`, `--texts` (which words moved, and by
  how much), `--scroll-to <heading>` for a long page. Pictures land in
  `packages/app/shots/parity/rn-<port>/`: `<name>.rn.png` is the page now, `<name>.golden.png` the
  reference, `<name>.diff.png` where they differ.
- **The grade** is `identical`, `identical to the eye` (pixels that differ only in anti-aliasing or by one
  level: two layouts never agree to a sixty-fourth of a pixel, and a mixed colour computed in floating
  point is a level off its 8-bit one) or a count of differing pixels. With N in the thousands, "to the
  eye" means a region is subpixel text on one side and greyscale on the other: see below.
- **`--changed [<ref>]`** photographs, in the light look, every scene and specimen whose recorded
  coverage holds a file changed since the ref (by default the merge base with main, with the working
  tree and untracked files), a specimen whose own `specimens/*.tsx` changed, and whatever has no
  coverage yet; it says what chose each. The coverage (`goldens/coverage.json`) is the source files
  whose functions ran while a scene was reached or a specimen drawn: `--accept` records it with the
  golden, `--record-coverage` records only it. Both from a studio on the dev server: the built client is
  bundled with no sourcemaps.
- **A foundation is under every picture**: `primitives.tsx`, the tokens, `styles.css`, the fonts. A
  change to one is the full sweep, and `--changed` says so. The specimen registry is under every
  specimen.
- **A file under no picture** is listed by `--changed`: a new component, or one whose only code runs as
  its module loads (a fixture, a table), which coverage does not see. Give it a specimen, or name the
  scenes that draw it. Nor does coverage see the engine: a change to what main or the service answers is
  named scenes or the full sweep. Coverage drifts as scenes start drawing new things; record it again
  (`--record-coverage`) after a merge. (Measured: a change to `Composer.tsx` reaches 45 of 121 scenes
  and 1 of 119 specimens, 6m 40s against the full light sweep's 29m 49s on the same studio.)
- **A scene is compared only in the goldens' world** (`studio.mts --goldens-world`,
  `shots/.world-goldens`): its picture holds that world's task ids, times and project path. That world is
  opened as it is and never seeded again. A specimen has no world and is compared from any studio.
- **The built client, not the dev server**, for a sweep (`--built`): nothing anyone saves reaches it, and
  the pictures are of what ships. The dev server is for the loop, and for recording coverage.
- **A new scene or specimen** has no golden. Once its picture is right, `pair.mts --accept --scene <name>`
  (in the goldens' world) or `--accept --specimen <name>` keeps the page's own picture, in every look.
  `--accept` with nothing named takes everything that has no golden and leaves the rest.
- **An intended change to the look** means the affected goldens are wrong now. Run the gate, **open each
  `.diff.png`** and its two pictures, and satisfy yourself that every difference is the one you meant —
  in every look, and in every scene the component appears in, not only the one you were looking at. Then
  name them: `pair.mts --accept --scene a,b --specimen c`. Naming one that has a golden REPLACES it; a
  sweep (`all`) never does. Say in the commit which pictures were re-accepted and why. A golden replaced
  without looking is the gate switched off.
- **A change that must not show** (a refactor, a moved module): run the gate before it with
  `--out packages/app/shots/parity/universal-before` (twice, the second into another folder, for the
  noise floor), run it after, and `before-after.mts --port 9301 [--again <second before folder>]` holds
  the page's pictures to each other pixel for pixel. `pair.mts --report a.json` / `--same-as a.json` does
  the same for verdicts.
- **A world's first session is not its steady state.** In the first launch after seeding the parked task
  is `running`; in every later one it is `interrupted` and its card says **stopped**. A world is
  photographed for keeps only from its second launch on.
- **A picture waits for its page to hold still**: nothing being fetched, no editor still to mount, its
  boxes and words unchanged for a second. The clock is held and CSS animations are off while a studio
  runs; an `Animated` loop keeps turning, so what turns on web is a CSS animation (`Turn.web.tsx`).
- **Every window writes.** A studio's window is the real app on its own bridge: pressing Cancel on a
  parked task cancels it. In your own world, `--reseed` if you spoil it. In the goldens' world, do not.
- **A photograph holds nothing that closes on resize.** A capture beyond the viewport resizes the page,
  which closes a `MenuLayer` or a suggestion list; hold those open another way.
- **A test key must carry its character.** `driver.mts`'s `press()` sends `rawKeyDown`, which a key handler
  hears and a form's implicit submission does not: send `keyDown` with `text` to press Enter as a keyboard
  does.
- **Logic**: `npx vitest run packages/app/test/<name>.test.ts`. **Types**: `npx tsc --noEmit -p
  packages/universal`, `-p packages/client`, `-p packages/app`, or `npm run typecheck` for everything.
- `packages/app/shots/README.md` lists every rig and what each proves.

## The phone

The emulator is the last check, once a change passes on web in every look.

```bash
npm --workspace @jaira/client run build:island && (cd packages/client && npx one prebuild --platform android)
(cd packages/client/android && ./gradlew assembleDebug)
npx tsx packages/app/shots/android.mts [--serial emulator-5554] [--metro 8082] [--hold]   # end to end
npx tsx packages/app/shots/android-check.mts up            # leave running: a desktop, Metro and the paired emulator
npx tsx packages/app/shots/android-check.mts screen [filter] | tap "<text>" | shot <name> [x,y,w,h] | reload | tall
```

- **`android.mts`** pairs the phone with the desktop it launches by the code that desktop shows, over
  `adb reverse` to the engine's loopback port, reaches each room, writes a setting, answers a gate, and
  reconnects by the token it kept.
- **`android-check.mts`** keeps the same rig up on the gate's world, to drive one state at a time:
  `screen` prints what the phone says and where, `tap` presses what reads so, `shot` photographs it (or a
  part, enlarged), `reload` opens it again on the sources as saved, `tall` lists any view taller than
  twenty screens, `desk click|shot` does the same on the desktop it is paired with.
- **What the build needs** (0015, "On the Android emulator"): JDK 17 (Android Studio's bundled 25 fails
  the build), `plugins/withWorkspaceReactNative.cjs` first in `app.json`'s plugins, and a Metro started
  after any change to `metro.config.cjs`.
- `uiautomator dump` waits for a second in which nothing changes: the rigs' link says `&still=1`
  (`packages/client/src/native/still.ts`), and everything that moves on its own asks `isStill()`
  (`packages/universal/src/motion.ts`). `reload moving` opens the app without it.
- Fast Refresh is off in the rig's builds: the sources are shared, and another person's save reloaded the
  app under a state just reached.
- A long press is `input swipe x y x y 800`; a lift and a drag is `input motionevent DOWN x y`, a pause,
  `MOVE`s, `UP` in one `adb shell`; a selection in Monaco is `input mouse swipe`. `settings put system
  user_rotation 1` turns the emulator on its side, where the shell is twice the size and can be read.
- `packages/app/shots/phone.mts` is the phone app in a phone-sized headless Chrome (`/native`), and
  `remote.mts` the client in an ordinary browser as a paired device: neither needs an emulator.
- What a phone still lacks is in `TODO.md`, "Open inside the universal client, on a phone only".

## What trips a component

**The dev server**

- **It is shared.** A file that stops parsing — a half-written edit, a shell heredoc that turned `"\n"`
  into a real line break — breaks the page for every studio at once, and a window then keeps One's
  "Route failed to load" overlay until it reloads. Write a file whole or with exact edits; rerun a
  comparison that says "gave up waiting … to draw".
- **It remembers a missing file.** Import a file before it exists and the server caches the miss;
  creating the file afterwards does not clear it ("Failed to resolve import"). Rename the IMPORTING file
  away and back.
- **It can miss a quick second edit.** Two saves of one file in a row can leave it serving the first:
  `curl` the module from `127.0.0.1:8081` to see what it serves, and `touch` the file.

**React**

- **A hook after an early return.** A component that returns early for "nothing yet" and declares state
  below it crashes when the nothing becomes something ("Rendered more hooks"): state first.
- **A development build mounts every effect twice.** A frame or timer cancelled in a cleanup must be
  forgotten too, or what waits on "none pending" waits for ever.

**Layout and text on web (react-native-web, Tamagui, Chromium)**

- **A component cannot see its siblings.** There is no `:last-child`: pass the fact as a prop (`last`,
  `first`), as `TaskCard` takes `last` from its lane.
- **There is no grid** in React Native: rows and columns of `View`s with the tracks' widths.
- **Text inside a `Press` on web is inside a `<button>`**, which centres text: `Txt` sets
  `textAlign="left"`; say otherwise where it should not be.
- **A Tamagui `View` is `position: static` on web.** An absolutely placed child needs
  `position="relative"` on its parent. `PLAIN_SCROLLER` is static too, so a scroller that must be absolute
  goes inside a wrapper `View`.
- **Line heights.** Blink multiplies a unitless line height out in floating point and snaps the product
  DOWN to 1/64 of a device pixel; a length it snaps to the nearest. So `Txt` writes a factor as the factor
  on web (a phone is told the product). A fixed line is `lineHeight: { px }`; a `Txt` given a `fontSize`
  apart from its spec keeps the spec's size times the factor.
- **Borders snap.** Chromium lays a 1px border out in whole device pixels: 0.667px at 1.5×, which is the
  studio's scale. Where the width is geometry (a picture's frame), measure it on web
  (`artifact/ring.web.ts`).
- **Text nodes are shaping boundaries.** `ready — {detail}` in JSX is two text nodes, and Blink shapes each
  apart; written as one string the glyphs after the join move by a fraction. Changing which it is moves
  pixels.
- **Inline icons.** A Tamagui `View` inside a `Txt` is not inline on web; use `floats/InlineGlyph`.
- **Style-only props.** `overflowWrap` and `boxDecorationBreak` go in `style`, or they land on the element
  as attributes.
- **`onLayout` reports a transformed box's size scaled.** Inside a scaled canvas, centre things with
  `transform: [{ translateX: "-50%" }]` rather than by measuring. A DOM `clientWidth` is rounded to whole
  pixels.
- **A form measured before its width is known** lays out as wide; wait for the width before drawing it.
- **A sticky box holds under its scroller's padding**, and react-native-web puts a `ScrollView`'s padding
  on its content: a header that sticks at the top of a scroller padded by 12 says `top: 12`.
- **Scrolling to the end**: `scrollTo` with a very large y; `scrollToEnd` stops a fraction short.
- **A newline in a markdown paragraph is a space** on web unless something says `pre-wrap`; a native `Text`
  breaks the line. `Markdown`'s (and `ValueView`'s) `softbreak="space"` where the host collapses it.
- **A table is the browser's.** Markdown's tables are `display: table` on web; a phone has no table layout
  yet.

**Greyscale text is the order a page is painted in**

Chromium layers a page by paint order: a scroller is a layer, what is painted after it and touches it (its
scrollbar first) is squashed into a layer over it, and later boxes nearby join that layer — whose text is
greyscale unless all of it stands on one opaque box in the same layer. The reference pictures have
subpixel text where the DOM renderer had it, so:

- react-native-web's `View` is `position: relative; z-index: 0`: a stacking context, painted after
  everything static. A `ScrollView` takes `PLAIN_SCROLLER`; a `Press` is static by itself (say
  `position="relative"` where something is placed against it); a bare react-native `View` takes
  `PLAIN_SCROLLER` (static) or `NO_STACK` (positioned, no stacking context).
- Nothing asks for a layer by hand (`z-index: 1`, `will-change`, `translateZ(0)`), with one exception: the
  state graph's canvas, whose text is greyscale on purpose (`workflow/StateGraph.tsx`).
- A list item's number is hung in the flow on web (`Markdown`'s `Marker`), not placed absolutely in a
  positioned item: that alone turned a track of cards greyscale.
- A hidden probe placed absolutely (a table's columns measured, a crumb's width) needs a positioned box
  round it. The shell's root is positioned on web as the box of last resort, and clips: without one the
  probe is the page's, the page grows a scrollbar, and the window is laid out ten pixels narrower.
- The window's ground is the page's (`body`, `windowPage.web.ts`), not a box of the shell's.

**Keys and controls**

- **react-native-web's text boxes stop a key from bubbling** (`stopPropagation()` on every keydown): a
  React `onKeyDown` on a box round one, and a `window` listener on the way up, hear nothing typed in it.
  Listen on the element itself (`SidePanel`'s Alt+←, `form/useEnterSubmits.ts`) or on the way down
  (`MenuLayer`'s Escape), and let the box's own handler go first.
- **A native control's keys are not free.** A closed select steps with the arrows and finds a choice by
  its letter (`form/selectKeys.ts`), a form submits on Enter in a single-line box
  (`form/useEnterSubmits.ts`), a number box steps with ↑ and ↓, and a link is reached by Tab and named by
  the right-click menu only as a real `<a>` (`render="a"`, and then no press handler: the anchor opens it).
- **A roving tab stop** (a rail's tabs, one of them in the Tab order) is `Press`'s `focusable`.
- **A select** is `components/logs/Select.tsx` or `settings/fields.tsx`'s `SelectInput`: each draws
  Chromium's own arrow and measures its own width. A box with suggestions is `form/inputs.tsx`'s
  `FormInput` with `form/Suggest.tsx`.
- **A form field's frame is its host's.** A field in a dialog or an inline gate has 12 above it and a dim
  label; a bare one (a state's panel, a transcript) has neither. `FieldFrame` (`floats/Choices.tsx`) says
  which.

**Floats**

- Anything that floats — a menu, a card, a dialog, a tip — is drawn in a layer over the window, never
  inside its opener: `MenuLayer` (portalled into `<body>` on web, a `Modal` on a phone), with
  `floats/Float.tsx` placing it against its anchor by `floatPlace.ts`'s arithmetic, `floats/Modal.tsx` the
  backdrop and box, and `floats/anchor.ts` finding what it hangs from. Escape closes the layer on top and
  no other. This is the standard *Nothing floats in place*
  ([standards.md](../engineering/standards.md)).

**On a device (React Native, Yoga, Android)**

- **Yoga is not CSS flexbox until it is told to be.** React Native keeps its old layout errata: a child
  that may grow takes the height its box was OFFERED — and every `Press` holds such a child. A badge in a
  transcript stood 27,000 tall. The phone's root is wrapped in `StrictLayout`
  (`experimental_LayoutConformance`), which turns the errata off.
- A hand-set `fontFamily: t.v("font-data")` is the whole CSS stack, which Android cannot read and draws
  in the system font. Go through `Txt`, or `faceOf()`.
- React Native has no `white-space: nowrap`. Text kept on one line says `numberOfLines={1}` for an
  ellipsis, or measures its one-line width and clips (`Crumbs.tsx`).
- `flex: 1` is a basis of 0: in a box as wide as what it holds, text given it is 0 wide and wraps a letter
  a line. Say `flexShrink: 1` where the text should shrink from its own width.
- A `Press` inside a stretched box can grow without bound in Yoga: `fill={isWeb}`.
- A `View` that draws nothing is flattened out of the native tree. Give it a `zIndex` later and Android
  makes it then, moving its children into it — a `TextInput` among them loses the focus.
  `collapsable={false}` from the start.
- A child drawn outside its parent's bounds is seen and cannot be pressed, and a scroller clips it. What
  floats is drawn in a layer over the frame and placed by `measureInWindow` (`form/SuggestLayer.tsx`), or
  in `MenuLayer`. A `Modal` is outside the fitted frame: what is in it is drawn at the window's scale,
  three times the shell's.
- `measureInWindow` answers in the window's units and the shell is drawn scaled: a point from inside it is
  scaled by the view's measured width over its laid-out width before it is used in the window, and back
  again to place something inside the frame (`Island.native.tsx`, `liftTargets.ts`).
- A float with a box in it stands in what the keyboard leaves (`floats/keyboard.native.ts`).
- Android dashes a border only when it is set on all four sides with a radius; `edge()` splits it into
  sides, so dashed borders draw solid there.
- `accessibilityRole` values the web accepts (`separator`) crash Android; use `role`.
- React Native's `Image` draws bitmaps only: an SVG is drawn by `react-native-svg` and sized from its root
  (`components/Img.native.tsx`).
- A span inside a `Text` takes no opacity, and `color: "transparent"` reads as no colour at all: hide it
  with an ink of `rgba(0, 0, 0, 0.01)`.
- Tamagui's `onPress` never fires on Android: everything pressable is `Press`.
- Metro stubs `react-native-reanimated` for gesture handler (`metro.config.cjs`); a Metro started before
  that change crashes the app at launch until restarted.

## What exists already

Look here before writing a control. The catalogue of what each looks like is
[index.md](index.md); each component's doc names its files in `implemented_by`.

- **Text and marks**: `Markdown` (`components/Markdown.tsx`; `scale`, `lineHeight`, `trimEnd`, `padding`,
  and `registerFenceRenderer` for fenced blocks), `Pill` and `Pills`, `panel/Icon.tsx` (a real `<svg>` on
  web, `react-native-svg` on a phone), `Turn` (the turning ring), `usage/Ring.tsx`.
- **Settings** (`components/settings/`): `SettingsPage`, `SettingsSection`, `SettingsRow` (with the ↺ and
  ⓘ), `Switch`, `Segmented`, `SelectInput`, `SizeStep`, `TextField`, `Button` (and its `ghost`, `quiet`,
  `primary`, `danger`), `LayerPicker`. A section says it is one to `parts.ts`, which is what the sidebar's
  accordion lists. Connections' rows are `connections/Row.tsx` and `Probe.tsx`.
- **Forms** (`components/form/`): `SchemaForm` (and `registerWidget`), `Field`, `FieldGrid`, `FormInput`,
  `NumInput`, `TextArea`, `Checkbox`, `Chip` and `PickWell`, `Range`, `LlmConfigForm`.
- **Floats** (`components/floats/`, `MenuLayer`, `Menu.tsx`): `Float`, `ModalBox`, `ContextMenu`,
  `TipLayer`, `Toast`, the dialogs, `ChoiceList` and `ChoiceSteps`.
- **The transcript** (`components/panel/`): `Transcript` (`SessionTranscript.tsx`), its rows
  (`WorkRows.tsx`), the summary of a stretch of steps (`WorkSummary.tsx`), the marks between blocks
  (`TranscriptMarks.tsx`), a run's page of panels (`SessionBands.tsx`), the rail (`Rail.tsx`).
- **Values**: `ValueView` (`panel/ValueView.tsx`) and its readings (`ValueReadings.tsx`), `DataView`.
- **The composer** (`components/chat/`): `Composer`, its chips' cards (`ComposerCards.tsx`,
  `ComposerTools.tsx`), the account's and context's cards (`UsageCards.tsx`).
- **Gates** (`floats/GateBodies.tsx`, `panel/Gate.tsx`, `components/artifact/`): the five built-in
  gates, the changeset reviewer, review notes (anchored to a selection on web by `reviewSelection.ts`; a
  phone lists notes and selects in the diff island only).
- **Dragging**: `Lift` (a long press and pan on a phone, DOM drag events on web) and `liftTargets.ts`.
