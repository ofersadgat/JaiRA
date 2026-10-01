---
id: engineering/decisions/0015-one-universal-client
type: decision
status: accepted
updated: 2026-10-01
decides_for: [engineering/units/app-shell, engineering/units/ipc-bridge, engineering/units/renderer-store]
---

# 0015. One client for desktop and mobile, reached by a spike that migrates component by component

The person, 2026-09-27: "I want to create a mobile app which shares as much code as possible with the
jaira app … use the One framework … an electron build which will build the desktop apps that we have
today and then … mobile apps which will mirror the ui and allow you to interact with other remote jaira
servers … The UI should look identical … a spike which acts as a proof of concept and allows us to
gradually migrate from copies of the ui to being able to reuse the same components across both."

**Where this stands (2026-10-01).** The migration is over, and not component by component: every
surface was copied, the desktop switched to the copies whole, and the DOM renderer was deleted
([below](#the-dom-renderer-is-deleted-2026-10-01)). There is one implementation of every feature, in
`packages/universal`. This record keeps what was planned and found on the way; a passage the deletion
made false is marked where it stands.

## Context

### The renderer today (read 2026-09-27)

| | |
|---|---|
| Size | 99 `.tsx` (56k lines), 73 `.ts` (24k lines), **one `styles.css` of 18.7k lines** |
| Styling | Plain global class names (~3,080 `className=`, 51 inline styles). Palettes are CSS custom properties under `:root[data-palette=…]`, written by `applyAppearance`. Fonts are bundled woff2. |
| UI libraries | None. React 19, Vite 6, `markdown-it`, Monaco 0.56 (+ Shiki on Oniguruma WASM), CodeMirror 6. |
| Navigation | No router. The address is state: `AppState.at`, `view`, `doc` (`store.ts:786`). |
| State | One hook, `useApp()` in `store.ts` (4.7k lines), called once in `App.tsx`, plus small module stores. |
| Transport | **One seam.** `bridge()` at `store.ts:158` returns `window.jaira`, a `JairaBridge` (`shared/src/ipc.ts:2762`): `invoke(channel, request)` and `subscribe(listener)`. 137 channels, 19 push types. The renderer imports no Node or Electron. |
| DOM-only | Monaco (`monacoDiff.tsx`), CodeMirror (`markdownEditor.tsx`), iframes (`valueView.tsx`, `jaira-artifact:`), HTML5 drag and drop (7 files), the state graph (HTML boxes over SVG with its own camera), portals, Selection/Range, `getBoundingClientRect` (13 files), `ResizeObserver` (7 files), `dangerouslySetInnerHTML` for markdown. |
| Tests | Vitest in Node mode; ~101 tests import renderer model modules, ~32 use `renderToStaticMarkup`; `shots/*.mts` drive the real app over CDP for screenshots. |

Two facts carry this plan. First, the transport seam is already one function, so a remote client needs a
new `JairaBridge`, not a new UI. Second, the look is **CSS on DOM**, and React Native has neither. Every
component that becomes truly shared must be rewritten from `div` + class to Tamagui/React Native
primitives. That is the real cost, and it is paid per component.

### One (read 2026-09-27)

- "Web is stable, and native is stable in Metro mode." **Development on Windows is rated "early"**, and
  this repo is developed on Windows. There is one npm maintainer, Nate Wienert (Tamagui).
- Web and native come from one route tree. `.web.tsx` / `.native.tsx` / `.ios.tsx` / `.android.tsx` pick
  per platform, for pages, layouts and ordinary modules. **A web route may render an existing DOM tree
  unchanged**, with `.css` imports.
- On web, `react-native` is aliased to react-native-web, so a Tamagui/React Native tree **also renders in
  a browser**. That is what makes the fidelity gate below automatic.
- Native builds through Expo: `one prebuild`, `one run:ios|android`, EAS Build/Submit, Expo Go for
  development.
- Web output can be a pure SPA (`web.defaultRenderMode: 'spa'`, no loaders), statically served from
  `dist/client`.
- **Electron: no guide or example.** The maintainer says it "should work as is." There is no hash
  history, so `file://` will not route; `dist/client` must be served from a custom protocol with an
  `index.html` fallback.
- **No `'use dom'`.** Expo Router has DOM components and One does not. A DOM-only component on native
  must be hosted in `react-native-webview`, bridged by hand.
- Monorepos work. Symlinked workspace packages have produced duplicate React on Android (issue #752).
  Metro needs `watchFolders` covering `../declarative-ai`.

## Rulings (2026-09-27)

1. **Mobile shows exactly the desktop UI.** "What I want now is to generate the exact same ui on mobile
   as there is on desktop. This is meant as a migration step, not as a final step (which will do a
   mobile ui/ux pass)." No drawer, no sheets, no phone layout in this work.
2. **Styling: Tamagui.**
3. **Transport: throwaway.** (It landed as [0013, machines](0013-machines.md).) "There is another session building out the remote properly … just do the
   quickest thing to get it working and expect to throw it away."
4. **One 1.27.1, Tamagui 2.7, Metro for native, and the native side thin** ([Version](#version)). The
   person: "your recommendations sound fine."
7. **Electron is the first desktop target; native desktop comes later.** The person: "there are react
   native builds for windows and mac … we should also support an electron build which will be the first
   target and we'll think of true native desktop solutions after that." See
   [Native desktop, later](#native-desktop-later).
5. **Read-only first.** "We can do read only as a v1 and interactive as v2." And: test whether a browser
   view can encapsulate the components that are hard to migrate, such as Monaco and CodeMirror.
6. **Fidelity is tested in a browser for now.** "Using one to render the browser version should be a
   good approximation until we're ready for a more faithful test." Device testing comes later.

## Options considered

**How the UI is shared:**

| Option | For | Against |
|---|---|---|
| A. Rewrite everything in Tamagui now | One codebase, finally | Months before anything ships. 18.7k lines of CSS at once. The desktop regresses while it happens. |
| B. Mobile is one WebView around today's renderer | Identical for free, in days | Not One. Nothing is ever shared as native components. |
| C. **Strangler.** Two trees during the migration: today's DOM tree, and a **universal tree** of Tamagui copies that renders on native *and* in the browser. Hard components are **islands**: the DOM component itself, inline on web and in a WebView on native. The desktop switches a component from DOM to universal once the two are pixel-identical. | The desktop is untouched on day one. Fidelity is a pixel diff in a browser, not an opinion. Islands give mobile the whole UI before every component is ported. | Two implementations of each not-yet-shared component, which can drift until the desktop switches. |

C is taken. B survives as the fallback if the spike fails (see *Revisit when*).

## Decision

### Shape

```text
packages/
  shared/      unchanged: the contract (ipc.ts), browser.ts
  ui/          NEW @jaira/ui: today's src/renderer, moved as-is by `git mv`
                 (DOM components, styles.css, store.ts, fonts)
  universal/   NEW @jaira/universal: the Tamagui tree
                 tamagui.config.ts    generated from styles.css (below)
                 primitives/          Row, Column, AppText, DataText … the defaults encoded once
                 components/          copies of ui components, same names and props
                 islands/             Island.web.tsx (renders the DOM component inline)
                                      Island.native.tsx (renders it in react-native-webview)
                 App.tsx              the universal shell: same layout as ui's App.tsx
  client/      NEW @jaira/client: the One app
                 app/_layout.tsx
                 app/index.web.tsx      the DOM tree (what Electron shows)
                 app/universal+spa.tsx  the universal tree in a browser (the fidelity gate)
                 app/index.native.tsx   the universal tree on a phone
                 bridges/               electronBridge (window.jaira), socketBridge (throwaway)
                 island/                the page an island's WebView loads
  app/         Electron main, preload, packaging; its renderer is now client's dist/client
```

**As it stands (2026-10-01).** The tree above was the plan; this is what there is:
- `packages/app/src/renderer` was never moved (`@jaira/ui` is an alias for it). It holds the store and
  the bridge seam, the pure modules, the eight DOM components the islands are, `styles.css` and the fonts.
- `packages/universal/src` holds `app/` (the shell and its regions), `components/`, `islands/`
  (`Island.tsx` inline on web, `Island.native.tsx` in a WebView), `primitives.tsx` and the tokens.
- `packages/client` has one page, `/`: `src/routes/index.web.tsx` in Electron and a browser, `index.tsx`
  on a phone. Beside it are `/native` (the phone app in a browser) and `/specimen-rn`. Its bridge for a
  window that is not Electron's is `bridges/engineBridge.ts`.
- There is one tree: a component is drawn by the universal tree or is an island. What the notes below
  say of two trees, of four states and of a region with no copy yet describes the migration, which is over.

The plan's own notes on it:

- **The bridge becomes injectable.** `bridge()` returns whatever `setBridge()` installed, defaulting to
  `window.jaira`. Nothing else in `store.ts` changes. **Both trees run the same `useApp()`**, so the
  universal tree is a second *view* of the same state, not a second app.
- **The universal shell is the desktop layout.** Sidebar, address bar, main pane and side panel, at the
  same widths and sizes, on the phone too (ruling 1). On a phone it is shown at desktop width in a
  horizontally scrolling, pinch-zoomable frame; the mobile pass replaces that later.
- **A component is in one of four states:** `dom` (only the DOM version), `copy` (a universal copy
  exists; the desktop still uses DOM), `shared` (the desktop uses the universal one; DOM version and its
  CSS deleted), `island` (DOM forever, a WebView on native).
- **Where a region has no copy yet, the universal tree shows it as an island.** So mobile shows the
  whole UI from early on, and the islands shrink as copies land.
- **Electron keeps its main process.** `app:build` runs `one build` (SPA, no loaders) instead of
  `vite build`, and main serves `dist/client` from an `app://` protocol with an `index.html` fallback.
  The CSP moves from the `<meta>` to a response header on that protocol, and keeps its directives.

### Tamagui, generated from the CSS

**As built** (see [What the spike found](#what-the-spike-found)): Tamagui carries no themes and no
tokens. `packages/universal/scripts/tokens.mjs` generates `cssTokens.generated.ts` from the `:root`
blocks of `styles.css`, `useTokens()` reads it, and `typecheck` fails when it is stale. Since
2026-10-01 those blocks are the one thing every surface still takes from the stylesheet.

- `tamagui.config.ts` is **generated** from `styles.css` by a script (like `schemas:sync`), never
  hand-copied:
  - every `:root[data-palette=…]` block becomes a Tamagui theme (light and dark per palette);
  - `--font-app` and `--font-data` become the two font families, with `--size-app` scaling;
  - spacing, radii and sizes that the ported components use become tokens as they are ported.
- A check in `typecheck` fails when `styles.css` and the generated config disagree, so a palette edit
  reaches the universal tree at the next build.
- The primitives encode what React Native does differently from today's CSS once:
  - flex-direction column by default,
  - `border-box`,
  - no margin collapse,
  - no inherited text style.
  `AppText` and `DataText` encode the two type voices (`docs/ui/direction.md`), including "data never
  takes `text-transform`".
- Fonts: the woff2 files are converted to TTF for native (expo-font) and used as-is on web.
- **To verify in the spike:** that Tamagui's theme CSS variables on web do not collide with the same
  names in `styles.css`, since both trees may share a page once the desktop starts switching
  components. *They do.* Tamagui names a theme's variables after its keys (`--accent`), so the spike
  built it differently; see [What the spike found](#what-the-spike-found).

### The fidelity gate (ruling 6)

**Superseded (2026-10-01).** There is no DOM tree to render beside the universal one. The gate grades
the one page against reference pictures of the DOM tree, taken from the tag `dom-renderer-final`
([below](#the-dom-renderer-is-deleted-2026-10-01)), and no component is waiting to become `shared`. What
follows is the gate as it was planned.

- The `shots` driver gains a mode that renders the **same seeded state** twice: the DOM tree at `/` and
  the universal tree at `/universal`, in the same browser at the same size, and pixel-diffs them per
  region.
- A copy is done when its region diffs to zero, or to a listed and explained difference such as
  antialiasing.
- A component becomes `shared` only when the desktop's existing shots are still identical with it
  swapped in. **The desktop is the reference and never regresses for the sake of the phone.**
- Device screenshots come later (ruling 6). Until then, the browser rendering of the universal tree
  stands in for the phone.

### Islands (ruling 5)

- An island is a DOM component bundled into a small local page (`client/island/`) with `styles.css` and
  the fonts. Props go in and events come out over `postMessage`. The palette follows the host's theme.
- `Island.web.tsx` renders the component inline, so on web there is no WebView and the pixel diff still
  works.
- `Island.native.tsx` renders the page in `react-native-webview`. It sizes the WebView to its content,
  or gives it the region's fixed size for editors.
- Candidates for permanent islands: Monaco (the diff and file views), the CodeMirror markdown editor,
  interactive artifacts, and possibly the state graph.
- **What is known before measuring (research, 2026-09-27):**
  - **CodeMirror 6** uses the platform's own selection and editing on phones. It runs in a WebView in a
    maintained package (`@actualwave/react-native-codeditor`), with known Android fixes:
    - leave out `drawSelection()`, which breaks the IME cursor;
    - set `EditorView.EDIT_CONTEXT = false` to avoid misplaced characters when typing fast;
    - use `adjustResize`.
  - **Monaco says it does not support mobile** (README FAQ: "No"; #246 open since 2016). It has no touch
    selection, and it captures touch-drag scrolling with no option to hand it back (#4108). Read-only
    viewing may work; editing is a research project.
  - **Assets load from `file://`,** the way Expo's own DOM components do: a config plugin copies the
    island folder into the app bundle (`android_asset/`, the iOS bundle), and the WebView gets
    `allowFileAccess`, `allowFileAccessFromFileURLs` and `allowingReadAccessToURL`.
    - Not an `html` string: that gives a null origin and pushes megabytes over the bridge.
    - Not `expo-asset`: it renames files, which breaks relative references.
  - **Workers and WASM are the weak points.** Android refuses `file://` workers and fetches from a null
    origin. Monaco then runs its diff on the main thread, which is slower but still works. An inline
    blob worker is unverified on both platforms. Fetching `.wasm` over `file://` fails in WKWebView, so
    the grammar WASM is inlined as base64. iOS Lockdown Mode disables WASM altogether. **Shiki's
    JavaScript regex engine needs no WASM,** so islands use it.
  - **Cost:** every WKWebView is its own process on iOS; on Android they share one renderer. Keep one to
    three live islands per screen, and show a static rendering until a region is tapped or scrolled
    into view.
  - **Both editors render only the lines in view.** An island stretched to full content height renders
    every line. Editors therefore get their region's fixed size, as on the desktop, and scroll
    inside.
- **The frame conflicts with editors.** The desktop-width frame of ruling 1 pans and zooms, and so does
  an editor island. The rule is that a one-finger drag inside an island belongs to the island, and a
  two-finger drag or a pinch belongs to the frame. S5 tests it.
- **The same island page runs in a browser.** The page posts through `window.ReactNativeWebView` when it
  exists and through `window.parent` otherwise, so a browser harness can host it in an iframe. With
  touch emulation, Playwright's WebKit engine is the closest desktop stand-in for WKWebView. It catches
  layout and loading problems, but not keyboard, IME or gesture problems.

### Read-only v1

- `socketBridge` has an allowlist of read channels. Any other `invoke` is refused in the client with a
  "read-only in this version" notice.
- Controls that would mutate stay visible, because the UI must be identical, but are inert.
- v2 turns the allowlist off and makes the controls live.
- **v2 is here (2026-09-30).** The allowlist is deleted with the socket it guarded (below): a phone and a
  browser are windows that write.

### The throwaway transport (ruling 3)

**Gone (2026-09-30).** `spikeSocket.ts`, `socketBridge.ts`, the allowlist and `JAIRA_SPIKE_WS` are
deleted. A phone and a browser reach an engine over [0013](0013-machines.md)'s transport, paired by its
one-time code as a device (0013, "Amended 2026-09-30"); `bridges/engineBridge.ts` is the `JairaBridge`
they install, and nothing above the bridge noticed. What follows is what it was.

The quickest thing that works:

- The desktop's main opens a WebSocket on `JAIRA_SPIKE_WS=<port>` when that variable is set. It prints a
  random token to the log, and it dispatches `{id, channel, request}` to the existing `handlers` table
  and forwards every push to every socket.
- There is no pairing, no TLS, no Settings row and no per-connection state. The phone connects on the
  LAN with address and token typed once.
- `socketBridge` is about fifty lines behind `JairaBridge`. When the other session's remote transport
  lands, it replaces both ends and nothing above the bridge notices.
- Known and accepted: the spike's clients share the desktop's "current project"; iOS needs a
  local-network cleartext exception; Android needs `usesCleartextTraffic`.

### The spike

Time-boxed, on a branch. Each part has an exit test.

| # | Part | Exit test |
|---|---|---|
| S0 | **Toolchain on this machine.** `packages/client` and `packages/universal` on the chosen One version, Tamagui, npm workspaces, Metro mode, `watchFolders` for `../declarative-ai`, React deduped. Android emulator on Windows; iOS through EAS. | `one dev` serves web; the Android emulator shows a Tamagui screen in the ink palette that imports from `@jaira/shared/browser` and `@declarative-ai/json`. Windows pain is written down, not silently worked around. |
| S1 | **One hosts today's UI in Electron.** `git mv src/renderer packages/ui`. `index.web.tsx` renders `<App/>`. Main loads `app://`. Monaco's worker, the WASM tokenizer, fonts and `jaira-artifact:` frames work under the new CSP. | **Every `shots/*.mts` produces the same pixels** as the Vite build (zero diff, or a listed, explained one). `npm run app:dist` and its package probe pass. |
| S2 | **The throwaway transport** above, plus `setBridge()`. | The **DOM tree in an ordinary browser** on another machine connects and shows the desktop's projects and board. |
| S3 | **The universal shell**, read-only. Copies of the frame: sidebar with project rows, the address bar, the side panel frame. The Tasks room: board, columns, `task-card`, `status-pill`, `task-metrics`. Everything else in the frame is an island. Runs at `/universal` in the browser and on the Android emulator against S2. | The fidelity gate passes for the copied regions against the DOM tree, in two palettes and both schemes. The emulator shows the same screen, live: a task that moves on the desktop moves on the phone. |
| S4 | **The first shared components.** The desktop switches `status-pill` and `task-card` to their universal versions and deletes their DOM versions and CSS blocks. | S1's shots are still pixel-identical on desktop. The measured hours per component become the migration's estimate. |
| S5 | **The island test** (ruling 5). Three islands on the emulator and on iOS via EAS: the markdown view (static, auto-height), the Monaco diff editor read-only (worker and WASM loaded from the bundled page), and the CodeMirror markdown editor, read-only and then editable (to answer v2's question early). | See [Island test](#island-test). |

The spike ends with this record updated with what it measured: hours per copied component, bundle sizes,
cold start on a mid-range Android, the gate's results, the island findings, and how bad Windows was.
Then a go/no-go for the migration.

### Island test

**What is built:**

- One island folder, built with Vite by `client/island/`, holding four pages:
  - the markdown view (`markdown.tsx`);
  - today's Monaco diff (`monacoDiff.tsx`), read-only, with its worker created from an inline blob;
  - the same diff in CodeMirror's `@codemirror/merge`, as the fallback candidate;
  - today's CodeMirror markdown editor (`markdownEditor.tsx`).
- The config plugin that copies the folder into both native bundles.
- A typed bridge that carries props, the theme's CSS variables, content height, a `ready` event, and
  links routed back out.
- A test screen inside the desktop-width frame. It shows native rows and one, three, then six islands,
  over files of 200, 2,000 and 20,000 lines.
- The same pages in the browser harness, driven by the same script.

**What is measured**, on a low-end Android emulator image and on iOS through an EAS simulator build
(real devices when they are available):

| Measure | Pass |
|---|---|
| Time to `ready` for a 2,000-line diff | under 1.5 s |
| Worker started, or the main-thread fallback acceptable | either, stated which |
| Grammar highlighting | Shiki's JS engine highlights identically to the desktop's WASM engine |
| The frame scrolls and zooms past islands | no stuck gestures; one finger inside an editor scrolls the editor |
| Memory for three islands | under about 150 MB added |
| Auto-height (markdown) | settles without a resize loop |
| Palette switch | islands follow the host's palette without a reload |
| Long-press select and copy (v1) | works in all four |
| Typing with Gboard and a Japanese IME in the CodeMirror editor (v2's question) | no misplaced characters, and the keyboard does not cover the caret |
| Pixel diff of each island page in the browser harness against the desktop | zero, or explained |

**If it fails:**

- Monaco cannot give up touch scrolling, or cannot get under the time limit: diffs on native use
  CodeMirror's merge view. They stay Monaco on desktop, and the difference is listed in the ledger as a
  known departure from "identical".
- Islands at 20,000 lines stall: cap what is loaded and page the rest.
- Blob workers fail on iOS: the diff runs on the main thread or on the React Native side.
- WebViews fail altogether on a platform: that component needs a native read-only equivalent before v1
  can show it.

### After the spike: the migration

**Ended (2026-10-01).** Steps 1 to 6 were done as copies (every room, float and dialog, by 2026-09-30),
and step 7 stands: the editors are islands. The desktop did not switch a component at a time: it
switched whole, and the DOM tree was then deleted whole. Of the rules below:
- **the ledger was never built.** No component doc gained `platforms:`, and `docs/ui/index.md` never
  counted lines of `styles.css`. With one tree there is nothing to count: each component doc's
  `implemented_by` names the universal files that draw it, or the DOM component and the island that
  hosts it;
- **drift** and **short-lived copies** have nothing left to govern.

What follows is the plan as it was.

**The order is the frame first, then leaves, then rooms.** Mobile needs the frame to be native to feel
like anything, and leaves are cheap to prove.

1. The frame and the Tasks room (done in the spike).
2. Leaves: `icon`, `switch`, `segmented-control`, `chip-box`, `sidebar-row`, `project-row`,
   `conversation-row`, `work-row`.
3. Read surfaces: `transcript`, `message`, `value-view`, `waiting-on-sheet`, `inbox-strip`, and the
   run views.
4. The Chat and Files rooms, then the side panel's views (`panelStack.ts` is already pure and carries
   over).
5. Interactive v2: `composer`, gates, `agent-question`, `command-approval`, and drag and drop (Gesture
   Handler on native, the HTML5 path kept in a `.web.tsx` beside the shared file where it must be).
6. Settings pages, one at a time.
7. Never: Monaco, CodeMirror, interactive artifacts. These stay islands.

**Rules:**

- **The ledger.** Each `docs/ui/components/*.md` gains `platforms: dom | copy | shared | island`, and
  `docs/ui/index.md` counts them with the lines of `styles.css` left.
- **Drift.** A `copy` whose DOM half changes without its universal half is a CI failure through the
  fidelity gate, not a warning. That is what keeps the copies honest while they exist.
- **Copies are short-lived.** A copy that passes the gate is switched on the desktop within the same
  piece of work, where the desktop shots allow it, so the time spent with two versions stays short.

## Version

Read 2026-09-27 from npm, the `v2-beta` branch, and the draft post `version-two.mdx` (2026-09-17, not
published). There is no changelog, no git tag and no upgrade guide for 2.0.

- **Stable:** `one@1.27.1` (2026-09-14). `main` says v2-beta "is where One work goes; main stays as it
  was", so 1.x looks frozen. That is an inference; no maintenance policy is stated.
- **Beta:** `2.0.0-beta.N.M`, published several times a day, on a branch 901 commits ahead of `main`
  and about 2,300 commits in the last week. Pin it exactly. **`one@^2` resolves to an unrelated 2013
  package** of the same name, and no version scheme has been announced for a stable 2.
- **No date for 2.0 stable** anywhere.

**What 2.0 breaks, measured against what this plan uses:**

| Change in 2.0 | Hits this plan? |
|---|---|
| **Expo removed from the toolchain.** Config moves from `app.json` to `one({ native: { app } })`. `prebuild`/`run` use the RN community CLI. No Expo Go. `one/expo-plugin` → `vxrn/expo-plugin`, `one/react-native-commands` → `one/react-native-config`. | **Yes.** Native setup, EAS, and the islands' config plugin |
| React Native 0.86 → 0.87. **New Architecture required** (One now ships native code and Nitro modules). **iOS 17 minimum.** | Yes. The native build, and react-native-webview must be New Architecture ready |
| React Navigation 7 → **8.0.0-alpha**, pinned exactly. `Presentations` replaces `NavigationRender`. | Barely. The app has no router and uses a single route per tree. |
| Metro config: `expo/metro-config` → `require('one/metro-config').withOne(__dirname)`. The docs contradict themselves on whether `babel-preset-expo` is needed. | Yes, small |
| Rolldown becomes the default native bundler. | No. This plan pins `bundler: 'metro'` |
| `SafeAreaView` → `One.UI.SafeArea.View`. `EXPO_OS` gone on web (use `ONE_PLATFORM`). `ONE_PUBLIC_` env prefix. Peer floors: gesture-handler ≥3, screens ≥4.25, worklets ≥0.12.2. | Small |
| New: SwiftUI/Compose components (`One.UI`), Rolldown native HMR, web navigators that keep `react-native` out of the web bundle. | Not needed for the spike |

**The web side is the same in both.** Both use React ^19.2.3, Vite ^8.2 and Rolldown, and both pair
with **Tamagui 2.x** (2.7.7 is current; the docs pin 2.6.2). Starting on Tamagui 2 means its own v1→v2
breaks (`space` → `gap`, no `Stack`, `animation` → `transition`, `aria-*`) never apply to us.

**Windows is unsupported on both.** `installation.mdx` says "One currently doesn't support Windows… for
development", and `status.mdx` rates it "early". S0 must find out whether that means rough edges or a
wall. If it is a wall, the fallback is to develop the client inside WSL, with the Android emulator on the Windows side reached through `adb` over TCP.

**Also:** One brings Vite 8, and the app is on Vite 6. S1 moves the renderer build to One, so `packages/app`
drops its own Vite. Until then, the two must not be hoisted into one copy.

**Ruled: 1.27.1 with Tamagui 2.7, Metro for native, and the native side kept thin.** The reasons:

- The part of the spike most at risk (S1, S3, the gate) is web, and it is identical in both.
- Keeping native thin means configuring through `vite.config.ts` where 1.27 allows it, importing
  nothing from `@react-navigation/*`, and keeping `app.json` minimal. A later move to 2 is then mostly
  the Expo-to-community-CLI swap, which is known.
- The islands' config plugin is written against the Expo plugin API. It is the one piece that 2.0
  moves to `vxrn/expo-plugin`.

**Move to 2 when** it has a published release or a non-draft announcement, or when 1.x stops building
against a Tamagui or react-native-webview release we need.

## What the spike found

Built on `spike/one-client`, 2026-09-27, on this Windows machine. Everything short of a device is
done, as the person asked ("make as much as possible work without native tooling").

| Part | State | Evidence |
|---|---|---|
| S0 toolchain (web) | done | `packages/client`, One 1.27.1, SPA; `one build` on Windows after the workarounds below |
| S0 toolchain (native) | runs on Android | Metro, through `one dev`, builds the Android bundle (1,611 modules) and the iOS one (1,610); `nativeGraph.mjs` (in `typecheck`) proves no DOM-only package reaches them. `one prebuild` and Gradle build a debug APK that runs on the emulator (below); iOS needs a Mac |
| S1 One hosts the renderer | done | `shots/parity.mts`: board, task, settings and the Monaco file-types preview pixel-identical to the Vite build; `app:dist` builds the installer and its probe and smoke test pass |
| S2 throwaway transport | done | `shots/remote.mts`: a headless Chrome loads the client from the desktop's port, draws its board, sees a task the desktop starts appear by push |
| S3 copies (web) | done: pill, task card, next-move chips | `parity.mts universal`: `/` against `/universal` identical in ink light and dark, classic, classic with the wash, contrast, pastel, blueprint, ink with the wash (18 of 18, one transient column-heading band once); each page reports what it drew, and `/universal` draws no DOM card or pill |
| S4 desktop switched | done: pill, task card | `/` draws the Tamagui pill and card; the S1 gate (Vite's DOM ones against them) is identical |
| Native colours | done | `shots/tokens-check.mts`: all 1,616 colour variables of 8 palettes × 2 schemes × {root, sidebar}, replayed for native, equal what Chromium computes |
| S5 islands (browser) | done | `shots/islands.mts`, a 390×844 Chrome loading the island pages from file:// under strict rules: markdown ready in 58 ms, auto-height; the Monaco diff ready in ~265 ms and drawn in 34–73 ms at 200 / 2,000 / 20,000 lines, grammar-coloured, worker started; palette switch without a reload; typed text back over the bridge from the editable CodeMirror |
| Phone app (browser) | done | `shots/phone.mts`: `/native` (`NativeApp` through react-native-web) connects, shows the desktop's own UI in its frame, and draws the live boards from the universal cards |
| On a device | Android emulator: done | `shots/android.mts` (below): connects by deep link, the Desktop UI in its WebView, the native copies drawing the live board, the three islands on the device, typing into CodeMirror back over the bridge, no errors in logcat. Not yet: a physical phone, iOS |

(Of the evidence above, `shots/parity.mts`, the Vite build it compared with and the `/universal` route
went with the DOM page on 2026-10-01; `shots/pair.mts` is the gate, and `tokens-check.mts`,
`islands.mts`, `remote.mts`, `phone.mts` and `android.mts` run against the universal page.)

**The phone, as built (ruling 1).** `NativeApp` is a Connect screen, then two views of one connection:
- **Desktop UI** is the desktop's own UI in a WebView — the whole app as one island, identical by
  construction, read only. It is what a person uses until the frame is copied.
- **Native copies** draws the copies that exist from live data through the same store. Its column
  headings are placeholders until the board's frame is copied.

**What a copy costs.** The pill took under an hour. The task card, with its chips, took most of a
working session. The time went on rules that a copy has to re-derive by hand: the palette's tile beats
`:last-child`, the status wash beats hover and selection, and block layout collapses the chips' margin
into the meta line's. Two things generalise:
- **Structural CSS becomes props.** `Lanes` now passes `last`, because a copy cannot see its
  siblings.
- **Every copy needs the gate's render census.** The first "identical" compared the DOM card with
  itself: every card in the test world was draggable, which the copy fell back on.

**Windows and One, found on the way** (each worked around; the starred ones are worth upstream fixes):

- `fast-flow-transform` 0.0.3's win32 binary panics on every input and aborts the process;
  `packages/fast-flow-transform` stands in for it on Babel and the Hermes parser.
- ★ One's client tree-shake parses `.json` as JavaScript (an unanchored extension regex); the client's
  `vite.config.ts` wraps it.
- ★ One's Metro preset turns tsconfig `paths` into aliases against the project folder, ignoring
  `baseUrl`; the client's tsconfig is written relative to itself.
- One names a `.web.tsx` page as its own route, and Metro bundles every route file for native: routes
  stay plain and re-export from `src/routes/<name>(.web).tsx`.
- `metro.config.cjs` must extend One's Metro config (a function of it); starting from Expo's defaults
  replaces One's transformer and resolver. `@vxrn/vite-plugin-metro` and `@expo/cli` must be direct
  dependencies, because One resolves them from the project.
- `one build --platform android` uses One's Rolldown pipeline even in Metro mode, and `one build`
  empties `dist/` (so the island pages build into `dist-island/`).
- `@vxrn/color-scheme` pins React to exactly 19.2.3, so the workspace is pinned to it.

**Tamagui, found on the way:**
- **Its theme variables are named after their keys** (`--accent`), so a copy reads the CSS variable
  itself on web and the replayed cascade on native (`useTokens`, `cssTokens.ts`). Tamagui carries no
  themes.
- **A `group` is a size-contained container** (`container-type: inline-size`), which sized each chip as
  if it had no text.
- **`onPress` does not fire from a synthetic click bubbling up from a child;** controls carry
  `role="button"`.

**Islands are classic pages.** As ES modules on file://, nothing loads without file access for file URLs
(deprecated on Android). One IIFE per component, a deferred plain script, no `crossorigin`, fonts
inlined, and Monaco's workers as blobs load under the strict rules. One page per component keeps the
markdown island at 732 KB; only the diff carries Monaco (27 MB).

**Deviations from the plan above:**
- **The renderer was not moved.** `@jaira/ui` is an alias for `packages/app/src/renderer`. It moves
  at go.
- **Palettes override components by selector, not only through variables.** Variables scoped to a
  subtree are extracted; rule-level overrides are carried by each copy (the card's header lists its own).
- **The DOM pill and card stay,** because the Vite renderer, the S1 gate's baseline, still draws them.
  Both go when it is retired.
- **The board's pure half moved to `boardModel.ts`,** so the copies and the phone use it without
  `react-dom`.

**Rebased on main (2026-09-27).** The spike was first numbered 0013; main had meanwhile accepted its own
[0013 (machines)](0013-machines.md) and [0014](0014-archived-tasks.md), so this is 0015. What the rebase met:
- **The engine moved** into `@jaira/service` and the window's code into `desktop.ts` (0012 steps 1–4). The
  `app://` protocol and the spike socket moved with it; the socket dispatches exactly as the window's IPC
  does (host-only verbs here, the rest through the link to wherever the engine runs) and fans out through
  `pushToWindow`.
- **The real remote transport has landed** as 0013: machines paired over Tailscale, the engine reachable
  from other machines on loopback. The spike's socket and `socketBridge` are now the thing to delete: the
  phone should reach an engine the way 0013's other machines do.
- **UI to catch up on.** Archived tasks sit at the foot of the Finished lane, faded, wearing the pill of how
  they finished and saying when they were archived; a card in a project of several workspaces carries a
  machine chip. The card copy draws both (`MachineChip` is a copy of its own). `Lanes` now also tells a
  card when the archived foot follows it, since that makes the last live card not `:last-child`. The gate
  world gained an archived task and an "archived" scene; the machine chip needs a paired machine to appear,
  so it is not in the world yet.
- **Dependencies.** React is one 19.2.3 everywhere (the client had drifted to 19.3.0, which npm let win
  over the override); `react-native-webview` is one 13.16.1, Expo 57's own choice, where npm had installed
  a second copy as Expo's peer — two copies of a native module fail at run time on a device.
- **Metro ignores this repository's build output.** Watching the root to see the workspace packages also
  watched `packages/app/release/`, and an `app:dist` rewriting it crashed the dev server.
- **Verified after the rebase:** typecheck (with the native graph) and 5,665 tests; the S1 gate 28/28 and
  the universal gate 26/26, both across every look; native colours 1,616/1,616; the remote browser; the
  phone app in the browser; the islands under strict file:// rules; Metro bundles for Android (1,614
  modules) and iOS (1,613); the installer, its probe, CLI and smoke test; Monaco on all four surfaces in the
  development build and the installer.

**On the Android emulator (2026-09-27).** A Pixel-sized emulator (`medium_phone`, Android 16 / API 36,
WebView 133) running the debug APK against Metro, both reaching the desktop through `adb reverse`.
`shots/android.mts` does the whole thing in one command and passes:
1. **Connect.** The deep link `jaira:///?address=…&token=…` connects in 50–70 s, most of it the first
   bundle from Metro.
2. **Desktop UI.** The desktop's own UI draws in its WebView.
3. **Native copies.** The live board draws from the Tamagui cards, including both tasks the desktop ran.
4. **Islands on the device**, in one WebView renderer (heap 141 MB across the three), with no warnings:

   | Island | Ready | Drawn |
   |---|---|---|
   | Markdown | 100–117 ms | 11–39 ms |
   | Monaco diff, 2,000 lines, grammar-coloured | 50–66 ms | 143–171 ms |
   | CodeMirror editor | 13–16 ms | 27–41 ms |

   The readout's "inks" is counted 250 ms after the first paint, so it undercounts: the screenshot shows
   the diff fully coloured.
5. **Typing (v2).** Keys typed into the editable CodeMirror island land in the editor, and each change
   comes back over the bridge. That is 22 events for 22 characters, the last carrying the whole document.
   The first time Gboard appears, it opens a "Try out your stylus" tutorial that takes the keys; the rig
   dismisses it.

What it took:
- **JDK 17.** Android Studio's bundled JBR 25 fails React Native's `configureCMake` task on a
  "restricted method" warning. Temurin 17 builds.
- **React Native where npm hoists it.** The prebuild template's `react { … }` block points at
  `packages/client/node_modules/react-native`. `plugins/withWorkspaceReactNative.cjs` asks `node` for
  the real paths. It must be **first** in `app.json`'s plugins: Expo runs `build.gradle` mods in reverse,
  and One's plugin replaces the whole block.
- **jsonc-parser's ES-module entry.** Its UMD `main` hides its requires from Metro, and on the device it
  threw `Unknown named module: "./impl/format"`. `metro.config.cjs` maps it to `lib/esm/main.js`.
- **Tamagui's `onPress` never fired on Android.** The tabs and the Connect button are React Native
  `Pressable`s wrapping Tamagui views.
- **Safe areas.** Without `react-native-safe-area-context`, the tabs sat under the status bar.
- **The copies' columns wrap,** as the desktop board's do. A sideways scroll hid every column past the
  second.

What the device showed:
- **The gesture conflict is real.** A swipe that starts on the Monaco island scrolls Monaco, not the page;
  over the markdown island it scrolls the page. An island with its own scroll needs a way out (a grab
  strip, or scrolling only after a tap to focus) before it goes in a scrolling screen.
- **The copies draw in the system font.** The app fonts are not loaded natively yet (`expo-font`).
- **Development only:** the Fast Refresh banner and `ONE_SERVER_URL` warnings, which come from running
  against Metro.

**Still open:**
- ~~The Monaco preview sometimes never draws its lines.~~ Not an app bug: Windows marks a covered window
  hidden and Chromium draws no frames for it. The rigs launch with `CalculateNativeWinOcclusion` off.
- **A physical phone and iOS.** The same rig takes `--serial`. iOS needs a Mac.
- **The islands' scroll gesture** inside a scrolling screen (above), and fonts on native.
- **The Desktop UI view's viewport:** desktop width and zoomable, as a WebView gives a page without a
  viewport tag.
- **A release build.** The bundle is embedded, not served by Metro; not built yet.

## The whole UI, copied (from 2026-09-27)

The person, after the emulator run: "the goal is to replicate the desktop ui, but not in a webview … you
should keep going". The Desktop UI tab — the whole app in a WebView — is gone. The phone connects and
draws `UniversalApp`: `App.tsx`'s frame built from universal copies, running on the same store
(`useApp()`, once, shared by context). Asked whether to keep copying into Tamagui or to write a CSS
engine for native that would run the DOM components as they are, the person chose copying.

**How a copy is checked.** Also the person's: "test the migrated components using react-native-web and
once everything passes there do the final check with the android emulator". (Since 2026-10-01 `/rn` is
`/`, `pair.mts` holds it to reference pictures rather than to a second page, and `cascade.mts` is
retired: [below](#the-dom-renderer-is-deleted-2026-10-01). The list is the method as it was.)
- **`/rn`** draws the universal shell in a browser, on the native token path (`Replayed`), with no
  `styles.css` on the page — what it matches, it matches the way a phone draws it.
- **`studio.mts`** keeps a desktop open on a seeded world and on One's dev server, so an edit is on the
  next load. Several run side by side (`--port`), one per copier.
- **`pair.mts`** photographs `/` and `/rn` in one window, one state and one look, and compares them region
  by region (sidebar, title bar, board, panel, inbox strip, a whole room). `--specimen` does the same for
  a single component drawn from a fixture.
- **`cascade.mts`** prints, for any element, the declarations Chromium chose and the rules they came from,
  per look — the specificity and palette arithmetic a copy used to do by hand.
- **The grade** is pixelmatch's perceptual test, with anti-aliased pixels forgiven: the two layouts never
  agree to a sixty-fourth of a pixel, and a stylesheet's floating-point `color-mix()` never matches a
  copy's 8-bit `rgba()` exactly. Exact counts are reported beside it.

`docs/ui/copying.md` was the method, the primitives (`Txt` with the ten registers, `Press`, `useHover`,
`edge`) and what trips a copy. Since 2026-10-01 it is [`docs/ui/building.md`](../../ui/building.md): how
to add or change UI now that there is no original to copy, with what tripped a copy kept where it still
trips a component.

**What sharing means here.** A copy's LOGIC is never copied. What `App.tsx` or a DOM component derives
moves unchanged into a pure module both import:
- `shellModel.ts`: the sidebar's rows and counts;
- `boardModel.ts`, `markdown.tsx`'s parse and URL rules;
- the panel's host logic.
Only the drawing is written twice, until the desktop switches to the copy (S4). (It switched whole on
2026-10-01, and the drawing is written once.)

**Fonts on native.** DM Sans has an optical-size axis, which Chromium sets to the font size, and
Android can pick neither a weight nor an optical size out of one variable file.
- `packages/universal/scripts/fonts.py` cuts 96 static instances (3.6 MB): JetBrains Mono at eight
  weights, DM Sans at eight weights on eleven optical sizes.
- `expo-font`'s config plugin embeds them.
- `primitives.tsx` names the nearest instance, e.g. `DMSans_600_12`.

**Found on the way:**
- Tamagui on web leaves unstated border sides at the browser's 3px once a style is set, so every
  one-sided border is `edge()`.
- React Native Web's `Pressable` is a `<button>`, which centres text.
- Tamagui's `onPress` never fired on Android; everything pressable is React Native's `Pressable`.
- A shorthand holding a `var()` leaves CDP's longhands empty, and they still win.

**The editors (the person, 2026-09-28):** "the editor is the one place that I'll allow a divergence on
mobile to have for now. That being said, the desktop version should be able to use monaco/codeview as
normal components since desktop is using electron (for now). I want to complete the process of building
a pixel perfect ui match before tackling the editor." So:
- on a phone the code editors are islands and may differ from the desktop's. That covers Monaco
  (`code`, `diff`), CodeMirror (`markdownEditor`) and the JSON editor's text (`schemaText`);
- on the desktop they stay the DOM components, drawn inline by the web `Island`;
- editor work waits until every other surface matches.

**Progress (2026-09-30).** Every room, float and dialog is copied, and a scene or specimen for each is
identical, or identical to the eye, in all eight looks; the Android emulator run passed on 2026-09-28. A
completeness audit on 2026-09-30 compared every DOM component and `styles.css` rule with its copy and
found mostly interactions not yet wired rather than pixels. The cheap ones are done: the toast, the crash
screen and the loose-error banner, the offline and disconnected banners, answered and settled gates,
the run's composer, the message rail and cuts in run transcripts, a subagent's conversation, the value
view's patch, table, form, image, changes and coloured code, JSON hints, markdown images, the Files
room's rendered, patch and JSON-form views, the Debug journal, file drop on the composer, and the right-click
menu on content. The rest, also 2026-09-30:
- the changeset reviewer's settled mode, picture comparison, and notes and line reverts on a selection
  inside the diff island, with its compiler checks (the island's bridge carries commands and calls);
- interactive artifacts on web and in Electron (the page runs, its prompt fills the composer);
- adopted history, a task the store is not holding, bookmark focus and "where am I", and the rail's
  hover, name tip, fan, fold and lane menu;
- drag and drop on the board and the run board (the DOM's drag events on web; a long press and pan on a
  phone), and reordering automations;
- `<datalist>` suggestions (a list drawn as Chromium draws its own), the Files room's delimited,
  patch-file, leaf and workflow-sync surfaces, and the Debug session panel.

What a phone still lacks is in TODO.md ("Open inside the universal client, on a phone only"), deferred
by the person on 2026-09-30.

**The transport switch (2026-09-30).** The person, about the phone's read-only socket: "this should work
the same way that all of the remote stuff should work, no? it shouldnt be phone specific...right?" — and
then "do … the transport switch". Done, as 0013's amendment of the same day records it:
- **One transport.** The phone and a browser pair with a machine by the code its Settings → Machines
  shows, and connect to its engine's listener with the frames another machine speaks. The spike's socket,
  its token in the log and its port are gone; the engine's loopback listener serves the built client to a
  browser, by the rules and with the content policy of the desktop's `app://` protocol.
- **A device is a window.** It gets what the desktop's window gets over the pipe, with a current project
  of its own — the spike's clients shared the desktop's — and every push.
- **It writes.** Every control is live. A browser answered a gate the desktop's run had parked at, and
  the desktop's engine no longer held it. On the emulator the phone's Dark switch — a settings write —
  turned the desktop's own window dark, and back.
- **The Connect screen** (`screens/Connect.tsx`, the same on a phone and in a browser) takes an address
  and a code; `Remote.tsx` pairs, keeps the token (the phone's keystore, a browser's `localStorage`) and
  connects, and at the next launch connects by itself. `jaira:///?address=…&code=…` pairs at once.
- **It stays connected.** A drop is retried with growing waits and a fresh `hello`; the shell's line says
  "Disconnected … Reconnecting…" meanwhile and goes when it is back, and the store reads again without a
  reload. A device forgotten on the machine returns to the Connect screen saying so.
- **Checked:** `shots/remote.mts` (a browser), `shots/phone.mts` (`/native` in a browser) and
  `shots/android.mts` (the emulator), each pairing by code against the engine's own port.
- **Left:**
  - a phone cannot open or make a project: the folder dialog is the machine's, and the folder browser of
    0013 §8 is drawn only for another machine;
  - ~~on the emulator a task's conversation does not draw its transcript, so a gate cannot be answered
    from the phone's panel yet (the strip offers it, by a push); the browser's does;~~ Fixed 2026-10-01:
    Yoga's legacy layout gave a child that may grow the height its box was offered (a badge stood
    27,000 px tall), so the phone's root lays out strictly (`StrictLayout`), and `android.mts` answers
    the gate from the phone's own panel;
  - the `/native` browser preview has never had the phone's tokens, so it draws unstyled;
  - on an emulator React Native asks the host's port 8081 for its JavaScript whatever `adb reverse`
    says; `android.mts` now tells the debug build to ask its own localhost, so `--metro` is honoured.

**Performance (2026-09-30), production build, 220 cards and a 120-step conversation.** Typing in a long
conversation on `/rn` fell from 90 ms a key to 5 ms (the transcript is memoised, so the draft above it
does not redraw it); selecting a card from ~40 ms to ~22 ms on `/rn` and ~28 ms to ~6 ms on `/` (cards
memoised); the service's placement timer no longer pushes "tasks changed" every 10 s with nothing queued,
which redrew every window. Room switches, boot (~600-1000 ms, mostly waiting on IPC) and scrolling were
already fine; no leak across 150 room switches. Left: any store change still redraws the whole universal
shell (the context carries the whole model), and `/rn` Settings and Logs take ~50 ms to switch to.

**The desktop opens the universal shell (2026-10-01).** The person, after the gaps were filled: "do 1, 2,
and the transport switch" — 2 being the switch. `npm run start` and a packaged app open `/rn`; `--ui=dom`
(or `JAIRA_UI=dom`, `npm run start:dom`) opens the page it replaced, which stays while both exist, and
the shots that drive that page by its classes launch it so. Switched whole rather than a component at a
time (S4's plan): the universal shell already runs on the same store, and slotting copies into `App.tsx`
one by one would have been a third arrangement to keep. Before it: what a desktop does outside its
components was checked on `/rn` and brought over (window drag regions, the focus ring, keys, the
window's name, roles), and an island on web was given `styles.css` scoped to itself, without which the
built page's code editor stood 5 px tall. The DOM components, `slots.tsx`, the Vite build and most of
`styles.css` are not deleted yet: 33 of the 60 shots scripts find things on that page by class, 33 of
the 169 app tests render its components, and 51 of its 111 component files are still imported by the
universal tree (the editors, and exports of logic) — that is its own piece of work, and the person's to
start. (Started and done the same day: the next section. `/rn`, `--ui=dom`, `JAIRA_UI` and `start:dom`
are gone with it.)

## The DOM renderer is deleted (2026-10-01)

The person, the same day the desktop switched: "delete it, i dont want to implement every new feature
twice". So there is **one page, `/`, and it is the universal shell; one implementation of every
feature.** The last commit that has the DOM page is tagged `dom-renderer-final`
(`git worktree add ../JaiRA-2-dom dom-renderer-final` checks it out beside this tree).

**What went.**
- 103 of the renderer's 111 component files: `App.tsx` and every pane, panel, view and form.
- `index.html` and the Vite build that served them (`build:renderer`, `vite.config.ts`,
  `JAIRA_RENDERER`). The window's page is One's build alone, and its content policy is the header
  `clientPolicy` writes (`packages/service/src/clientFiles.ts`), for the window and for a browser alike.
- The `--ui=dom` flag, `JAIRA_UI` and `npm run start:dom`. `npm run start` is the app.
- S4's arrangement for switching a component at a time: the slot mechanism (`slots.tsx`, `COPIES`,
  `SHARED`) and the universal card's fallback to the DOM card.
- The client's `Shell.tsx` and its `/rn`, `/universal` and `/specimen-dom` routes, and the `dom` half of
  every specimen.
- 44 of the 61 shots scripts, each of which drew or drove a DOM component
  (`packages/app/shots/README.md` names every one and what has its coverage now).

**What stays, and why.**
- **The logic.** What the deleted files held that was not drawing — types, constants, functions, hooks —
  moved unchanged into 22 new pure modules beside seven existing models. `packages/app/src/renderer`
  (`@jaira/ui`) is now the store, the bridge seam and those modules, and the universal tree imports them.
- **Eight DOM component files**, the islands and what they need: `monacoDiff.tsx`, `markdownEditor.tsx`,
  `markdownDocument.tsx`, `markdown.tsx`, `schemaEditor.tsx` (its text field alone: the bar, the picker
  and the reference are the universal `SchemaEdit.tsx`'s), `htmlFrame.tsx`, `interactiveArtifact.tsx`,
  and `popover.tsx` for the schema editor's completion list. They stay because the editors are the one
  place the person allows a phone to differ (2026-09-28, above), and on the desktop they are still the
  DOM components, drawn inline by `Island.tsx`.
- **`styles.css`**, for two readers: `tokens.mjs`, which takes the `:root` blocks every surface's colours
  and sizes come from, and the islands, which bring the stylesheet scoped to themselves. It was whole at
  the commit; every rule that serves neither is dead, and cutting it down to the two is the next step.

**The tests.** Of the app's 171 test files, 33 rendered a DOM component. Four were deleted with their
subject (`fenceRender`, `forkMark`, `tableView`, `valueViewToggle`); the rest stand on the pure modules
now, a case kept where a module computes the fact and dropped where the component itself decided it (a
class, an element, a sentence written in JSX). 4,741 cases pass. What no test reaches is logic the
universal components carry inline — the state face's rules in `panel/faces.tsx`, `standingOf` and the
fork's index in `SessionBands.tsx`, the transcript's doomed count, the inbox strip's item list, the
table's 500-row cut, decisions inside hooks (`useWorkflowEditor`, `useRunIndexModel`, `useTypedStep`).
Moving each into a model brings its test back.

**The reference pictures.** The fidelity gate compared two pages, and one is gone, so its pictures were
kept first:
- `pair.mts --freeze`, run from a checkout of the tag, photographed the DOM page into
  `packages/app/shots/goldens/` — one picture per scene or specimen and look, with a manifest of what a
  comparison needs of the page it came from (its regions, every run of text, what the world keeps
  changing, the window, the world). The folder is not in git.
- `pair.mts` now has one mode: the page against those pictures, graded as it was graded against the live
  page. `--freeze` says where the pictures come from and does nothing.
- A scene's picture holds its world's task ids, times and project path, so the world they were taken in
  is kept too (`packages/app/shots/.world-goldens`, opened by `studio.mts --goldens-world`, never seeded
  again), and a scene is compared only there. A specimen has no world.
- A scene or specimen that is new has no DOM original: `pair.mts --accept` keeps the universal page's
  own picture, and the manifest records that it was accepted and when. A change to the look that is
  meant is accepted the same way, by name, after the diff has been looked at
  ([`docs/ui/building.md`](../../ui/building.md)).
- `before-after.mts` holds two runs of the page to each other pixel for pixel, over a recorded noise
  floor, for a change that must not show. The deletion was made under that rule: nothing the universal
  page draws or does was to change.

**What the deletion took with it.**
- **Coverage** (`packages/app/shots/README.md`, "Retired"):
  - event notices end to end in the window — the newest shown with "+1", × reading it, a click opening
    the events task at the firing. It was found by fourteen classes; a port needs test ids on the strip
    and the events conversation first;
  - schema detection by file name, seen in the window, for a Compose file, GitLab CI and a GitHub
    workflow;
  - pictures of Settings → Tools → Events over a real repository with an `origin`, of a project's ⚙
    opening its layer, of a theme picked on Shared showing through a stronger layer, of an archived
    card's menu and the Copies section, and of the Changes tab over a real project's history;
  - a way to look at a component with no Electron at all.
- **The catalog mockups** under `docs/ui/assets/` can no longer be regenerated: they are frozen pictures
  of the look as of the tag, and they draw as captured only against that tag's `styles.css`, which they
  link.
- **`cascade.mts`**, the reading of the cascade a copy was written from. `styles.css` at the tag is the
  record of why a number in a component is what it is.
- **The project's compiler in the Files room's code editor.** The DOM page handed Monaco the project's
  own compiler there (`file:check` and its neighbours: underlines from the real `tsconfig`, definitions,
  references, hover). The universal `CodeEdit.tsx` gives the island no `intel` (its header says so), and
  the page that did is gone; the changeset reviewer's diff still has it. Monaco's own TypeScript
  validation is off (`monacoDiff.tsx`), so a file opened there is underlined by nothing.
  `shots/verifyTypeCheck.mts` and step 2 of `monaco.mts` look for the underline in the Files room. Found
  by reading the code while re-pointing the docs; no rig was run.

**Not yet done at the commit:** the before-and-after comparison of the universal page run to its end,
the stylesheet's pruning, and the comments that name deleted files. The docs were re-pointed the same
day: each component's `implemented_by` and `verified_by`, the units and contracts, and
`docs/ui/copying.md`, which became `docs/ui/building.md`.

**What remains of this decision.**
- **The editors.** Monaco, CodeMirror and the schema text are DOM islands on every platform, and on a
  phone they may differ from the desktop's (the person, 2026-09-28: "the editor is the one place that
  I'll allow a divergence on mobile to have for now … I want to complete the process of building a pixel
  perfect ui match before tackling the editor"). What is left of that match on 2026-10-01 is small —
  checkbox and select-arrow snapping in six Files scenes, a sticky heading's hairline in three looks, a
  few scenes under 180 px — and when the editors are taken up is the person's to say.
- **The mobile UI/UX pass** (ruling 1: "a migration step, not a final step"). A phone still draws the
  desktop's layout at the desktop's width, fitted to its screen.
- **What a phone lacks**: `TODO.md`, "Open inside the universal client, on a phone only", deferred by the
  person on 2026-09-30. A physical phone, iOS and a release build are still untried.
- **Native desktop**: [below](#native-desktop-later).

## Native desktop, later

The desktop ships as Electron first, from the DOM tree and then from shared components as they are
switched (ruling 7). (From the universal tree alone since 2026-10-01.) Microsoft's `react-native-windows` and `react-native-macos` are the candidates for
a true native desktop after that. This plan leaves the door open to them without building for them:

- The universal tree is plain React Native plus Tamagui, so it is the tree those targets would run.
  Every component the migration makes `shared` is one they get for free. (Since 2026-10-01 that is
  every component but the islands.)
- Islands are `react-native-webview` pages, which that library also supports on Windows (WebView2)
  and macOS (WKWebView). The islands' asset-copy plugin is the part that would need a desktop variant.
- One's environments are web, iOS and Android only, as read on 2026-09-27. A native-desktop build would
  therefore run the universal tree through the platform's own Metro setup, beside One rather than
  through it. **This was not checked against those projects' current versions,** and it is the
  first question when that work starts.
- Nothing in the spike depends on this.

## Consequences

**Easier:**

- The desktop is untouched in look from the first day.
- A browser client comes for free from S2.
- Fidelity is a number from a pixel diff, not a judgement.
- `store.ts`, `panelStack.ts`, `transcript.ts`, `stateGraph.ts` layout and the other pure modules are
  shared from the start, along with their ~100 tests.

**Harder:**

- Two implementations of each copied component until it is switched. (Ended 2026-10-01: one.)
- Two styling systems during the migration, both generated from the same `:root` blocks. (Ended
  2026-10-01: the universal tree's, with `styles.css` kept for the token blocks and the islands' rules.)
- The toolchain grows by Expo, Metro, EAS, react-native-web and Tamagui, on a framework with one
  maintainer and "early" Windows support.

**Deferred:** a native desktop build ([above](#native-desktop-later)).

**Foreclosed for now:** any mobile-specific layout. That is the later mobile UI/UX pass, which starts
from a universal tree it can rearrange.

## Revisit when

- ~~**S0 or S1 fails.** One cannot host the DOM tree in Electron identically, or Windows development is
  not workable. Then fall back to B for mobile, and keep the migration on plain react-native-web inside
  the existing Vite build.~~ Neither failed, and there is no DOM tree or Vite build to fall back to
  (2026-10-01).
- ~~**Copying costs more than about a day per leaf component.** Then mobile leans on islands for longer,
  and copies are reserved for the frame and the read surfaces.~~ Every surface was copied by 2026-09-30.
- **Islands fail S5 on iOS or Android.** Then the components concerned need native equivalents (a
  read-only diff view first) before v1 can show them.
- **One publishes a stable 2.** Then move before migration step 3, not during it (see [Version](#version)).
- ~~**Now (0013 has landed).** `socketBridge` and the spike's WebSocket are deleted, and the phone reaches an
  engine as 0013's other machines do.~~ Done 2026-09-30.
- **One gains `'use dom'`.** Then the islands move to it.
