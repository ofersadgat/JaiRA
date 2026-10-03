# The shots

Rigs that launch the real app over the DevTools protocol (`driver.mts`), on a world they seed
(`world.mts`), and either photograph it against reference pictures or prove a behaviour end to end.

There is one page: the universal shell (`packages/universal`). The desktop's DOM renderer it was copied
from is gone, and so is every rig that drove that page by its CSS classes. A rig finds things by what the
page **says**, by a role, a title or accessible name, or a `data-testid` — never by a class
(`parityWorld.mts`'s scenes show how: `app.clickText`, `says(…)`, `clickFirst`, `clickTitled`,
`[data-testid=…]`). The one exception is the inside of an island (Monaco, CodeMirror), which is that
editor's own DOM and is found by that editor's own classes (`.monaco-editor .squiggly-error`).

How to add or change what the page draws, and how a change to its look is accepted: `docs/ui/building.md`.

## The fidelity gate

```bash
npm --workspace @jaira/app run build:main                       # once, for the desktop's main process
npm --workspace @jaira/client run build                         # the client the gate runs on
npx tsx packages/app/shots/studio.mts --goldens-world --built --port 9301   # leave running
npx tsx packages/app/shots/pair.mts --port 9301                  # every scene and specimen, light
npx tsx packages/app/shots/pair.mts --port 9301 --every-look     # in all eight looks
npx tsx packages/app/shots/pair.mts --port 9301 --scene task --region panel --texts
npx tsx packages/app/shots/pair.mts --port 9301 --specimen markdown --every-look
```

While working, a studio on the dev server, and only what the change reaches:

```bash
npx tsx packages/app/shots/studio.mts --goldens-world --port 9301          # the dev server: an edit is in the next page, no build
npx tsx packages/app/shots/pair.mts --port 9301 --changed                  # what this branch changed reaches, light
npx tsx packages/app/shots/pair.mts --port 9301 --changed HEAD             # what the working tree changed reaches
npx tsx packages/app/shots/pair.mts --port 9301 --record-coverage          # what each scene and specimen runs, recorded again
```

- **What a change reaches** is read from `goldens/coverage.json` (not in git), beside the manifest: for
  each scene and specimen, the source files whose functions ran while it was reached and photographed.
  `--accept` records it with the golden; `--record-coverage` records only it, for what is named or for
  everything, with no picture kept or graded. `--changed [<ref>]` takes the files changed since the ref
  (by default the merge base with main, with the working tree and what git does not track yet) and
  photographs, in the light look, every scene and specimen that ran one of them, a specimen whose own
  `specimens/*.tsx` changed, and whatever has no coverage recorded. It says what chose each.
- **A foundation is under every picture.** A change to `primitives.tsx`, the tokens (`tokens*.tsx`,
  `cssTokens*.ts`, `tamagui.config.ts`), `styles.css` or the fonts is the full sweep, said in one line. A
  change to the specimen registry or the specimen page is every specimen, with the scenes coverage
  chooses: the scenes are not on that page.
- **Coverage is recorded from the dev server.** It is V8's, over CDP, a function at a time, and a script
  is a file only as the dev server serves them, a module each; the built client is bundled with no
  sourcemaps, and a studio with `--built` records nothing (`--accept` says so; `--record-coverage`
  refuses). A module's top level is no part of it, nor is what a page runs while its modules load
  (taken once from the specimen page with nothing on it): otherwise every file would be under every
  picture. So a file whose only code is its top level — a table of constants, a fixture — is under no
  picture, and `--changed` lists it, with every other changed UI file no scene or specimen ran: give it
  a specimen, or name the scenes that draw it (`--scene a,b`).
- **What coverage cannot see**: the engine. A scene's picture holds what main and the service answered
  (`environment:view`, a task's journal), and a change there reaches no page file. Name the scenes, or
  run the full sweep.
- **Coverage drifts with the code**: a scene that starts drawing a component is not chosen by a change to
  it until coverage is recorded again. Record it again after a merge, or when `--changed` lists a file
  under no picture that you know a scene draws; it takes about as long as a light sweep.
- **The full sweep stays the gate before a merge**, on the built client. `--changed` is for the loop.
  Measured on the dev server, one studio: a change to `Composer.tsx` reaches 45 scenes (the Chat room's,
  and every task and run scene, whose panel holds a conversation's composer) and one specimen, in 6m
  40s; the full light sweep took 29m 49s, and gave the same verdicts for the same pictures, but for one
  thread's scroll in two `artifact-*` scenes that the full run's order disturbs. A change to the
  renderer's store (`store.ts`, under 151 of the 240) reaches nearly everything; so does the specimen
  registry, for the specimens.

- **The reference pictures** (`goldens/`, not in git) are of the DOM renderer, taken from the commit
  tagged `dom-renderer-final` (a checkout of it: `git worktree add ../JaiRA-2-dom dom-renderer-final`)
  with that tree's `pair.mts --freeze --goldens <this tree's goldens>`. `pair.mts --freeze` here says
  so and does nothing: there is no DOM page in this tree to photograph.
- **The goldens' world** (`.world-goldens/`, not in git) is the world they were taken in. A scene's
  picture holds that world's task ids, times and project path, so a scene is compared only in a studio
  on that world: `studio.mts --goldens-world`. It is opened as it is and never seeded again (`--reseed`
  is refused: another seeding is another world, and every scene's golden would be of one that is gone).
- **A studio of your own** (`studio.mts --port <yours>`, world `.world-studio-<port>`, `--reseed` to
  start it over) is for looking at things (`peek.mts`) and for specimens, which have no world.
- **A world's first session is not its steady state.** The seed parks a task at its gate and its process
  is killed. The first launch after that still has the task `running`; every launch after it finds no
  run behind the row and calls it `interrupted` — the card says **stopped** (its gate is still
  answerable), the pills count it elsewhere, and its next-step chip lights. So a world is photographed
  for keeps only from its second launch on: seed, start the studio, stop it, start it again, then take
  reference pictures or `--accept` a scene. (Measured: `running`, then `interrupted` three launches in a
  row.) A picture taken in the first session differs from every later one wherever the parked task shows.
- **Stopping a studio**: kill its `tsx … studio.mts` process and its `electron.exe` (the one with
  `--remote-debugging-port=<yours>`). The app is gone ten to thirty seconds after its process is
  killed, and until then its port is taken: wait before starting another on the same port. Two studios
  photographing at once slow each other badly (each capture waits for the window to be in front — some
  twenty seconds a picture instead of three); run a sweep while no other is running.
- **The studio's window has to be drawing, on a monitor.** A minimised window's page is hidden, draws
  no frame, and a capture waits for one forever (a run once stood still for 29 minutes). A window moved
  off the desktop is photographed at the override's scale (2) instead of the monitor's (1.5), and every
  golden then fails with "another window". Leave it where it opens, under the other windows; it does
  not need the focus.
- **The real mouse pointer must not rest over the studio's window.** The page hears it: a scroller
  under it draws its thumb in the hover colour (28 board scenes once differed by one 9px column), a
  button under it lights. Park the pointer elsewhere before a sweep; a run whose only differences are
  scrollbar thumbs or one hovered control was taken with it over the window.
- **Compare runs of the same selection.** A scene or specimen photographed on its own can differ from
  the same one photographed in a full run by a few dozen anti-aliasing pixels (text drawn after
  different pages); in sequence it reproduces to the pixel. A before-and-after is two runs of the same
  `--scene`/`--specimen`/`--all`.
- **A new scene or specimen** has no DOM original. Once its picture is right:
  `pair.mts --accept --scene <name>` (in the goldens' world) or `--accept --specimen <name>` keeps the
  page's own picture as its golden, in every look, and the manifest records that it was accepted from
  the universal page and when. `--accept` with nothing named takes everything that has no golden and
  leaves the rest; naming one that has a golden REPLACES it.
- **A change that must not show**: run the gate before it with `--out parity/universal-before` (twice,
  the second into another folder, for the noise floor), run it after, and
  `before-after.mts --port 9301 [--again <second before folder>]` holds the page's pictures to each
  other pixel for pixel. `pair.mts --report a.json` / `--same-as a.json` does the same for verdicts
  (`--same-as` also reads a run's printed output saved as text, the tag's `--against-goldens` included).

## The scripts

**Kept** as they were (they drove the universal page, or no page of the app's, already):

| Script | What it does | Why kept |
| --- | --- | --- |
| `driver.mts` | Launches or attaches to the app over CDP: evaluate, IPC, click, type, photograph, hold still, wait until settled. | What every rig stands on. The `ui` option and `--ui=dom` are gone: the app has one page. |
| `world.mts` | Builds a scratch project and base root, and the scripted replies that park a run at its gate. | The world of every rig. |
| `parityWorld.mts` | The gate's world (its seed) and its 121 scenes; `PAGE`, `SPECIMEN_PAGE`, `GOLDENS_WORLD`. | The scenes. Reached by text, role, title, test id only; the DOM-class branches are removed. |
| `studio.mts` | Keeps the app open on a seeded world, from the dev server or the built client. | The loop. Now `--goldens-world`; refuses to seed that world. |
| `pair.mts` | The page against its reference pictures, graded region by region; `--accept`; `--changed`, only what a change reaches, by the coverage `--record-coverage` keeps. | The gate. Reworked: the goldens are what it compares against; `--freeze` points to the tag. |
| `peek.mts` | What a studio's window shows, and an expression evaluated in it. | Looking at things. |
| `islands.mts` | The island pages (Monaco, CodeMirror, frames) in a browser standing in for a phone's WebView, with their timings. | The phone's islands; drives no page of the app's. |
| `android.mts` | The phone app on the emulator, end to end: pairs by the desktop's code, reaches each room. | The device check. |
| `android-check.mts` | The same rig kept up, to drive a phone state by state (`screen`, `tap`, `shot`). | The device loop. |
| `phone.mts` | The phone app (`/native`) in a phone-sized headless Chrome, paired with a desktop. | The phone's shell without an emulator. |
| `verifyTypeCheck.mts` | `file:check` over the whole wire: squiggles from the real project, go to definition, peek, references, hover, and a review's two programs. | Behaviour nothing else sees. It finds the editor by Monaco's own classes, the rest by text and test id, and the file the window is on by the title bar's crumbs. Its Files scene (and step 2 of `monaco.mts`) looks for the compiler's underline in the Files room's editor, which the universal `CodeEdit.tsx` hands the project's compiler (`fileEditModel.ts`' `codeIntelOf`). Both rigs open the BUILT client (`npm --workspace @jaira/app run build` first), or the dev server with `JAIRA_CLIENT_DEV=http://127.0.0.1:8081/` in the environment. |

**New**:

| Script | What it does |
| --- | --- |
| `before-after.mts` | Two runs of `pair.mts` held to each other pixel for pixel, over a recorded noise floor. |

**Ported** to the universal page (they found things by the DOM page's classes):

| Script | What it does | What changed |
| --- | --- | --- |
| `machines-real.mts` | Two engines pairing: a second base root runs `jaira serve`, the window pairs with it by its code, and Settings → Machines must show it online. | The Settings section and "Show a code" by their words. |
| `machines-replica.mts` | Another machine's task copied here, and still on the board and readable once that machine is away. | The Settings section by its words. |
| `machines-grouped.mts` | One project across two machines: the merged board, a task no machine can take, Where tasks run, the other machine's folders browsed through its engine. | The sidebar's `+` by its title, the menu and dialog by their words; the browser is known to be the other machine's by its listing that machine's clone. |
| `chat-placement.mts` | Where a conversation runs, in one window with two clones of one repository: the bar, the chip and the sentence choosing; the list (photographed as the window stands — `shot(name, of, false)` — since a capture past the viewport resizes the page and a menu closes on that); a conversation sent to this machine waiting while neither clone has room; then starting in the clone that has room, the thread following it there. | The bar's machine and the chip by their name, `Where this conversation runs`; everything else by its words. `--pages http://127.0.0.1:8081/` loads a dev server instead of the built client. |
| `monaco.mts` | Monaco in the development build and the packaged app: the Appearance preview coloured by the TextMate grammars, a file opened and typed into, a type error underlined, a patch in the diff editor, the workers started. | The sidebar by its landmark, the preview by its test id and island. |
| `tokens-check.mts` | The token replay (`resolveAt`) against Chromium's own cascade over `styles.css`, for every palette, scheme and scope. | Asked the DOM page; now puts the stylesheet on an empty page of its own. |
| `remote.mts` | The client in an ordinary browser as a device on a desktop's engine: pairs, hears pushes, answers a gate, reconnects, is forgotten, says when it is disconnected. | The shell's page is `PAGE`, not a second route beside the DOM page. |

**Retired** (deleted). Each drew or drove a DOM component; what it photographed is now a golden, a scene
or a specimen, unless the last column says coverage went with it.

| Script | What it did | What has it now, or what is lost |
| --- | --- | --- |
| `cascade.mts` | Read the DOM page's CSS cascade for an element: the spec a copy was written from. | Nothing to read: there is no cascade on the page. `styles.css` at the tag is the record. |
| `parity.mts` | The first fidelity gates: the Vite renderer against the One client, `/` against `/universal`. | `pair.mts`. |
| `probe.mts`, `probe-fold.mts`, `probe-real.mts` | Throwaway probes of the parity world, a fold's scroll arithmetic, a real run's rail. | `peek.mts`; the rail's scenes (`run-convo`, `run-knot-fold`, `rail-*` specimens). |
| `run.mts` (`npm run shots`) | Photographed the app's main states against `reference/the-shell.html`. | The scenes. |
| `logs.mts` (`npm run shots:logs`) | Photographed the Logs page over a world with a log in it. | The `logs` scene. |
| `panels.mts`, `chat-chrome.mts`, `graph.mts`, `palettes.mts`, `usage.mts`, `work-summary.mts`, `model-levels.mts`, `about.mts`, `settings-tabs.mts`, `settings-fixes.mts`, `project-settings.mts`, `events-settings.mts` | Photographed a room or a page while its DOM component was being built. | The `task-*`, `chat`, `conversation-*`, `composer-*`, `files-graph`, `settings-*` scenes, `--every-look`, the `transcript-*` and `update-row-*` specimens. **Lost**: pictures of Settings → Tools → Events over a real git repository with an `origin` (events-settings), of a project's ⚙ in the sidebar opening its layer (project-settings), and of a theme picked on Shared showing through a stronger layer (settings-fixes) — none had assertions; their logic has unit tests. |
| `floats.mts` | Photographed floats (the composer's Tools card, a mode picker) to see none was cut off by its container. | The `composer-*`, `card-menu*`, `files-menu`, `gallery-approval-menu`, `health-card` scenes. |
| `archive-real.mts`, `archive-baseline.mts` | Archived two tasks and photographed the board, the archived lane, an archived card's menu, Settings → Machines → Copies. | The seed archives a task and the `archived` scene opens the lane. **Lost**: the archived card's menu (Unarchive) and the Copies section, in pictures. |
| `machines-baseline.mts` | Saved the live DOM of the board and About, for the machines mockups to start from. | Mockup scaffolding; nothing to save now. |
| `changes-real.mts`, `changes-mock.mts` | The Changes tab over a copy of a real project (written out as DOM HTML), and with a mockup injected into it. | The `task-changes` scene and the `changes-commands`, `changes-git` specimens. **Lost**: looking at the tab over a real project's history without the app. |
| `event-notices.mts` | A real events run posting notices to the inbox strip: the newest shown with "+1", × reading it, a click opening the events task at the firing, a restart starting without them. | **Lost**: this flow end to end in the window. It was found by fourteen DOM classes and a `data-entered` attribute with no counterpart yet (the strip's notice, its ×, the events conversation's rows); a port needs test ids on the universal strip and conversation first. The service's side (`notices:list`, the events task) has tests. |
| `schemaFiles.mts` | Five files held to their ecosystem's schema by NAME (`package.json`, a commented `tsconfig.json`, a Compose file, GitLab CI, a GitHub workflow): each opened on the schema-aware editor with its schema chosen and its mistake said. | The `files-schema` scene and the `file-json-form*` specimens draw the editor for `tsconfig.json` and `package.json`. **Lost**: detection by name for the three YAML kinds, through main, seen in the window (the detection and the 2020-12 compile have unit tests). It asserted through four DOM classes (`.schema-edit`, `.schema-pick select`, `.schema-bar .chip-bad`, `.violation`). |
| `approval-static.mts`, `builtin-static.mts`, `builtin-mockups.mts`, `composer-cards-static.mts`, `connect-static.mts`, `connect-mockups.mts`, `conversation-tools-static.mts`, `fast-forward-static.mts`, `integrations-static.mts`, `message-source-static.mts`, `move-static.mts`, `permissionSets-static.mts`, `presets-static.mts`, `remote-gate-static.mts`, `settings-header-static.mts`, `tool-summary-static.mts`, `usage-static.mts` | Server-rendered a DOM component over `styles.css` to a static page or a catalog mockup, with no Electron. | The components are deleted, so there is nothing to render. Each state is a specimen or a gallery scene (`gallery-*`, `board-drag-*`, `transcript-*`, `message-source*`, `form-*`, `debug-session*`). **Lost**: regenerating the catalog mockups under `docs/ui/assets/` (`command-approval/`, `file-tree/built-in.html`, `workflow-editor/built-in.html`, `task-board/`, the settings header's) from what ships — they are now frozen HTML of the DOM renderer; and a way to look at a component with no Electron at all (a universal component needs react-native-web's runtime: the specimen page is that). |

`reference/the-shell.html` is the visual reference `run.mts` was compared with by eye; it stays as a
document.
