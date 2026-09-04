/**
 * Photographs the specimens, and the figures in the visual reference they answer to.
 *
 * Electron rather than a headless browser bought in for the purpose: this app IS Electron, so a
 * picture taken here is a picture of what ships — same Chromium, same font stack, same rasteriser.
 * A screenshot from a different engine would disagree with the running app about hinting and
 * subpixel positioning, and every one of those disagreements would read as a design difference.
 *
 *   npm run snapshot            # the app's specimens, both themes
 *   npm run snapshot -- --ref   # and the reference's figures, for the side-by-side
 *
 * Output lands in `snapshot/out/`, which is git-ignored: these are evidence for a comparison, not
 * an artifact of the build, and a committed PNG would go stale the first time a hairline moved.
 *
 * Scale is forced to 2 so the pictures can be read at the size the type actually is — at 1x a 10px
 * register is four grey pixels in both the app and the reference, and any two of those look alike.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const wantReference = process.argv.includes("--ref");

/**
 * Progress goes to a FILE as well as stdout.
 *
 * An Electron main process on Windows is a GUI subsystem binary: it has no console attached, so
 * `console.log` from a run started by a script reaches nobody. A harness whose only report is
 * invisible is one you debug by guessing.
 */
mkdirSync(out, { recursive: true });
const logFile = join(out, "shoot.log");
writeFileSync(logFile, "");
const say = (line) => {
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};

app.commandLine.appendSwitch("force-device-scale-factor", "2");
// A window nobody watches still has to be a real one: `capturePage` reads the compositor's output,
// and an offscreen window composites at its own cadence with no vsync to settle against.
app.disableHardwareAcceleration();
// A run that wedges must not leave an invisible window holding the terminal. Ten minutes is far
// past any real capture and far short of a person's patience.
setTimeout(() => {
  say("timed out");
  app.exit(1);
}, 600_000).unref?.();

/**
 * What counts as a figure in the reference.
 *
 * The window mockups and the settings mockup are the obvious ones; the register and pill tables are
 * figures too — they are where the type scale and the pill vocabulary are actually specified, and
 * leaving them out meant the two comparisons with an exact right answer were the two nobody could
 * make.
 */
const REF_FIGURES = ".spec .win, .settings, .tbl";

/**
 * Extra frames, each taken after one gesture.
 *
 * Kept as data rather than as a flag on the specimen, because what is being photographed is a
 * TRANSITION — the control before and the control after — and a specimen that opened itself on mount
 * would have no picture of the first half.
 *
 * `click` names something to press; `run` is an expression evaluated in the page instead, for a
 * surface whose gesture is not a click. The graph's map is the reason the second exists: a wheel
 * listener that is silently passive and a drag that reads a stale camera both LOOK fine in a still,
 * and both were real — found by photographing the map after it had been moved.
 */
/**
 * Put the pointer on something and leave it there.
 *
 * `mouseover` with no `relatedTarget` is what React turns into `onMouseEnter` for the whole chain
 * from the document to the target, which is exactly what a real pointer arriving from outside the
 * window produces. The frames it makes are the only picture there is of the graph's attention model
 * — a still of the resting state says nothing about what hovering answers.
 */
const hover = (selector) =>
  [
    "(() => {",
    "  const el = document.querySelector(" + JSON.stringify(selector) + ");",
    "  if (!el) return false;",
    '  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));',
    "  return true;",
    "})()",
  ].join("\n");

const OPENED = [
  /**
   * A Monaco with the caret actually IN it.
   *
   * The frame that matters for the current-line rule, and the one the resting specimens cannot take:
   * limiting the highlight to a focused editor cleared it from every block nobody was in and left it
   * exactly where this frame looks. First in the list, because the steps below switch this specimen
   * to the code view and there is no editor left to click.
   */
  {
    name: "monaco-focused",
    click: `[data-shot="renderer-menu"] .monaco-editor .view-line`,
    shot: `[data-shot="renderer-menu"]`,
  },

  /**
   * Step one: put a fence at the very bottom of its pane.
   *
   * Separate from the click below because React commits a state change in a later task — a `run`
   * that clicked and then looked for the menu in the same expression found nothing, every time.
   */
  {
    name: "renderer-menu-at-edge-setup",
    shot: `[data-shot="gamut-blocks"]`,
    run: `(() => {
      const sc = document.querySelector('[data-shot="gamut-blocks"] .cm-scroller');
      const arrow = document.querySelector('[data-shot="gamut-blocks"] .cm-fence-block .vv-arrow');
      if (!sc || !arrow) return "nothing to place";
      const pane = sc.getBoundingClientRect();
      sc.scrollTop += arrow.getBoundingClientRect().top - pane.bottom + 40;
      return "placed";
    })()`,
  },
  /**
   * Step two: the menu, opened there.
   *
   * The frame the bespoke popover could never have passed. It was `position: absolute` inside the
   * value's header, and a fence sits inside `.cm-scroller` inside a `.config-half` that is
   * `overflow: hidden` on purpose — so a menu near the bottom edge was cut off by all three. The
   * app's own `ContextMenu` is `position: fixed` and clamps itself to the window instead.
   */
  {
    name: "renderer-menu-at-edge",
    click: `[data-shot="gamut-blocks"] .cm-fence-block .vv-arrow`,
    shot: `.context-menu`,
  },
  {
    name: "renderer-menu-stacking",
    shot: `.context-menu`,
    run: `(() => {
      const menu = document.querySelector(".context-menu");
      if (!menu) return "no menu";
      const traps = [];
      for (let el = menu.parentElement; el; el = el.parentElement) {
        const st = getComputedStyle(el);
        const why = [];
        if (st.zIndex !== "auto" && st.position !== "static") why.push("z-index " + st.zIndex);
        if (st.transform !== "none") why.push("transform");
        if (st.filter !== "none") why.push("filter");
        if (st.contain !== "none") why.push("contain " + st.contain);
        if (st.isolation === "isolate") why.push("isolate");
        if (st.willChange !== "auto") why.push("will-change " + st.willChange);
        if (why.length > 0) traps.push(el.className.slice(0, 40) + " => " + why.join(", "));
      }
      return traps.length === 0 ? "no stacking context above the menu" : traps.join(" | ");
    })()`,
  },


  // The bottom of the block gamut: the quote with a list in it, and the two tables. A frame of the
  // top of a 2000px specimen is a frame of the headings, and the headings were never the problem.
  {
    name: "gamut-blocks-scrolled",
    shot: `[data-shot="gamut-blocks"]`,
    run: `(() => {
      const sc = document.querySelector('[data-shot="gamut-blocks"] .cm-scroller');
      if (!sc) return "no scroller";
      // ASYNC, with a frame between each jump. CodeMirror measures lazily: everything below the
      // viewport is an estimate until it is drawn, so the scroll height grows only after a layout,
      // and twenty assignments in one task all read the same stale number and land in the same
      // place. NB no backticks in here — this whole run is itself a template literal, and one in a
      // comment closes it and takes the harness down with a syntax error.
      return (async () => {
        for (let i = 0; i < 20; i++) {
          sc.scrollTop = sc.scrollHeight;
          await new Promise((r) => requestAnimationFrame(r));
        }
        return "at " + Math.round(sc.scrollTop) + " of " + Math.round(sc.scrollHeight);
      })();
    })()`,
  },

  /**
   * The long document, scrolled well past where the initial parse stopped.
   *
   * The number in the log is the point: it says how far the tree had been built when the fold last
   * ran. A frame of the top of this file proves nothing — the top always worked.
   */
  {
    name: "long-document-scrolled",
    shot: `[data-shot="long-document"]`,
    run: `(() => {
      const sc = document.querySelector('[data-shot="long-document"] .cm-scroller');
      if (!sc) return "no scroller";
      sc.scrollTop = 2600;
      sc.dispatchEvent(new Event("scroll", { bubbles: true }));
      return "scrolled to " + sc.scrollTop + " of " + sc.scrollHeight;
    })()`,
  },

  /**
   * FIRST RENDER, measured rather than photographed.
   *
   * `window.remount` throws the specimen away and builds it again — see `main.tsx` — and this reads
   * the fence widgets' heights in the same task, before the browser has had a chance to paint. That
   * is the only vantage point the defect is visible from: a widget whose DOM React fills
   * asynchronously is zero pixels tall at the moment CodeMirror measures it, so the document below
   * lays out against nothing and then jumps. A screenshot taken 120ms later shows the recovered
   * page, which is why this reports a number instead.
   */
  {
    name: "markdown-first-render",
    shot: `[data-shot="markdown-pane"]`,
    run: `(() => {
      if (!window.remount("markdown-pane")) return "no remount hook";
      const at = document.querySelectorAll('[data-shot="markdown-pane"] .cm-fence-block');
      const heights = [...at].map((el) => Math.round(el.getBoundingClientRect().height));
      const zero = heights.filter((h) => h === 0).length;
      return "fences " + heights.length + " heights [" + heights.join(",") + "] zero-height " + zero;
    })()`,
  },

  // The arrow, pressed. Everything about this control is in the frame after the click.
  {
    name: "renderer-menu-open",
    click: `[data-shot="renderer-menu"] .vv-arrow`,
    shot: `[data-shot="renderer-menu"]`,
  },
  // And the choice taken: the same value, drawn plainly, which is the state a selection can be
  // dragged out of. A picture of the menu alone would not show that the item did anything.
  {
    name: "renderer-menu-plain",
    shot: `[data-shot="renderer-menu"]`,
    run: `(() => {
      const arrow = document.querySelector('[data-shot="renderer-menu"] .vv-arrow');
      if (!arrow) return "no arrow rendered";
      arrow.click();
      // The app's own ContextMenu, portalled into the document body — not a popover inside the
      // value view. It went there because cm-scroller is a stacking context, which trapped the old
      // one under the splitter; this selector followed it. (No backticks: see the note above.)
      const items = [...document.querySelectorAll(".context-menu .menu-item")];
      const plain = items.find((b) => b.textContent.trim().includes("Code view"));
      if (!plain) return "menu items: " + items.map((b) => b.textContent.trim()).join(",");
      plain.click();
      return "picked the code view";
    })()`,
  },

  { name: "appearance-menu", click: `[data-shot="appearance"] .face-add`, shot: `[data-shot="appearance"]` },
  // The row you are ALREADY ON, clicked again. It must still be showing its tree afterwards: a row
  // is a place, nothing folds a drawer, and the only way to put one away is to go somewhere else.
  // Every frame ever taken of this column was taken without clicking anything, which is how a row
  // that hid its own contents on the second click went unnoticed.
  {
    name: "sidebar-clicked",
    click: `[data-shot="sidebar"] .side-views .side-row.on .side-hit`,
    shot: `[data-shot="sidebar"]`,
  },
  // Settings: a full-height panel OVER the column, headed by its own row, holding everything that
  // belongs to no project — the sections, Logs, Debug and the theme.
  {
    name: "sidebar-settings",
    click: `[data-shot="sidebar"] .side-foot .side-row:last-child .side-hit`,
    shot: `[data-shot="sidebar"]`,
  },
  // The rail. Every row in it is drawn by the same function as the expanded column, so a change to
  // what a row IS reaches 46px whether or not anybody looked — which is the reason to look.
  { name: "sidebar-rail", click: `[data-shot="sidebar"] .side-toggle`, shot: `[data-shot="sidebar"]` },
  // The form scrolled to its operation, which is where a linked property — and the preview of what
  // it says — actually is. A still of the top of a form says nothing about the bottom of it.
  {
    name: "state-panel-link",
    shot: `[data-shot="state-panel"]`,
    run: `(() => {
      const at = document.querySelector('[data-shot="state-panel"] .link-preview');
      if (!at) return "no preview rendered";
      at.scrollIntoView({ block: "center", behavior: "instant" });
      return "preview: " + at.textContent.slice(0, 60);
    })()`,
  },
  {
    name: "graph-moved",
    shot: `[data-shot="graph"]`,
    run: `(() => {
      const map = document.querySelector('[data-shot="graph"] .sg-map');
      if (!map) return false;
      const r = map.getBoundingClientRect();
      const at = { clientX: r.left + 300, clientY: r.top + 200, bubbles: true, cancelable: true };
      map.dispatchEvent(new WheelEvent("wheel", { ...at, deltaY: -420 }));
      map.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerId: 1, button: 0, isPrimary: true }));
      const to = { ...at, clientX: at.clientX - 160, clientY: at.clientY + 40, pointerId: 1, isPrimary: true };
      map.dispatchEvent(new PointerEvent("pointermove", to));
      map.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerId: 1, isPrimary: true }));
      return true;
    })()`,
  },
  // Further in, and pushed up: what a reader has when the boxes are readable and most of what they
  // are joined to is not. The frame is here for the two repairs that state needs — a pill at each
  // crossing naming what is off the edge, and a condition slid along its arc to somewhere visible.
  // The two gestures with no picture: click asks for the box's configuration, double-click asks to
  // open it. Both answer in words — see the loop below, and `GraphSpecimen`.
  {
    name: "graph-click",
    run: `(() => {
      const el = document.querySelector('[data-shot="graph"] [data-node="child:goals"]');
      if (!el) return "no such box";
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const html = document.documentElement.dataset;
      return "panel=" + (html.pinned ?? "nothing") + " · opened=" + (html.opened ?? "nothing");
    })()`,
  },
  // Select a passage in a reviewed artifact and check that the note composer STAYS UP.
  //
  // The bug this guards: the composer focuses its own textarea on mount, a textarea owns its
  // selection, so focusing it collapsed the document's — and the listener read that as "the words
  // were clicked away" and closed the composer in the same frame. It appeared and vanished, which
  // reads as a rendering glitch rather than as a logic error, and no unit test in this repo can see
  // it because there is no DOM to select in. This is the only place it can be checked at all.
  {
    name: "note-composer",
    run: `(() => {
      // The single-artifact review, not the changeset one: the changeset detail pane is Monaco now,
      // whose selection lives in its own model rather than in the DOM (see MonacoDiffPane.onSelect).
      // NOTE: no backticks anywhere in here — this whole block is inside a template literal, and one
      // stray backtick ends the string and takes the harness down with a parse error.
      const well = document.querySelector('[data-shot="review-one"] [data-testid="artifact"]');
      if (!well) return "no artifact well";
      const walker = document.createTreeWalker(well, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node || node.data.length < 4) return "nothing to select";
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(20, node.data.length));
      const live = window.getSelection();
      live.removeAllRanges();
      live.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      // The composer opens when the gesture ENDS, not while it is being made, so a drag that never
      // lets go opens nothing. Dispatching the release is what makes this a real selection.
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return new Promise((done) => setTimeout(() => {
        const open = document.querySelector('[data-testid="note-composer"]') !== null;
        done(open ? "composer stayed up" : "COMPOSER VANISHED — the selection was cleared");
      }, 250));
    })()`,
    shot: `[data-shot="review-one"]`,
  },
  {
    name: "graph-deep",
    shot: `[data-shot="graph"]`,
    run: `(() => {
      const map = document.querySelector('[data-shot="graph"] .sg-map');
      if (!map) return false;
      const r = map.getBoundingClientRect();
      const at = { clientX: r.left + 500, clientY: r.top + 120, bubbles: true, cancelable: true };
      map.dispatchEvent(new WheelEvent("wheel", { ...at, deltaY: -300 }));
      map.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerId: 3, button: 0, isPrimary: true }));
      const to = { ...at, clientX: at.clientX - 40, clientY: at.clientY - 260, pointerId: 3, isPrimary: true };
      map.dispatchEvent(new PointerEvent("pointermove", to));
      map.dispatchEvent(new PointerEvent("pointerup", to));
      return true;
    })()`,
  },
  {
    name: "graph-on-node",
    shot: `[data-shot="graph"]`,
    run: hover(`[data-shot="graph"] [data-node="child:critique"]`),
  },
  { name: "graph-on-rule", shot: `[data-shot="graph"]`, run: hover(`[data-shot="graph"] .sg-label`) },
  { name: "graph-on-port", shot: `[data-shot="graph"]`, run: hover(`[data-shot="graph"] .sg-node .sg-port`) },
  { name: "graph-on-term", shot: `[data-shot="graph"]`, run: hover(`[data-shot="graph"] .sg-term`) },
  // The LINE, not its label: two pixels of stroke is not a target, which is why every line carries a
  // fat invisible twin. This is the frame that says the twin is there and asks the right question.
  {
    name: "graph-on-line",
    shot: `[data-shot="graph"]`,
    run: hover(`[data-shot="graph"] [data-line="edge:mount:critique:1"]`),
  },
];

/** Waits for the page to say it has settled — fonts loaded, one frame painted. */
async function ready(win, flag) {
  for (let i = 0; i < 200; i++) {
    const done = await win.webContents.executeJavaScript(flag);
    if (done === true) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`page never became ready: ${flag}`);
}

/**
 * One picture per selector match.
 *
 * The element is scrolled to the top of the viewport before its rectangle is read, because
 * `capturePage` can only see what is on screen — a figure below the fold captures as the background
 * behind it, which is a blank PNG that looks like a rendering bug rather than a missing scroll.
 */
async function shoot(win, targets, dir) {
  mkdirSync(dir, { recursive: true });
  for (const { name, selector, index = 0 } of targets) {
    const rect = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: "start", inline: "start", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)),
               width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()`);
    if (rect === null) {
      say(`  ! no match for ${selector}[${index}] — skipped ${name}`);
      continue;
    }
    // One frame after the scroll, so the picture is of where the page ended up.
    await new Promise((r) => setTimeout(r, 120));
    const image = await win.webContents.capturePage(rect);
    const file = join(dir, `${name}.png`);
    writeFileSync(file, image.toPNG());
    say(`  ${name}.png  ${rect.width}×${rect.height}`);
  }
}

/**
 * Everything after the app is ready.
 *
 * A function rather than top-level `await`, because Electron's main-process bootstrap waits for the
 * entry module to finish evaluating before it emits `ready` — so `await app.whenReady()` at the top
 * level deadlocks, silently, with a live process and an empty log.
 */
async function main() {
  // SHOWN, and parked off the desktop. `capturePage` reads the compositor, and a window with
  // `show: false` never gives it a frame to read — the call does not fail, it simply never returns.
  const win = new BrowserWindow({
    width: 1000,
    height: 900,
    x: -2400,
    y: 0,
    frame: false,
    skipTaskbar: true,
    webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();

  // The page's own console, in the harness's log.
  //
  // A specimen that throws during render reports itself to a console nobody was reading, and the
  // only other evidence was a directory with no PNGs in it — which is indistinguishable from a
  // selector that stopped matching. Forwarded, the first line of a broken run names the file.
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) say(`  [page] ${message}${source ? ` (${source}:${line})` : ""}`);
  });

  /** Set once anything went wrong, so a broken run exits non-zero instead of saying "done". */
  let broken = false;

  for (const theme of ["light", "dark"]) {
    say(`app · ${theme}`);
    await win.loadFile(join(here, "..", "dist", "snapshot", "index.html"), { search: `theme=${theme}` });
    await ready(win, `document.documentElement.dataset.ready === "1"`);
    // What the page says about itself before a single picture is taken. A specimen that threw is
    // still photographable — its boundary drew the message into the frame — but the run has to end
    // badly, because a red panel where a control should be is not a snapshot anybody wants to trust.
    const failures = await win.webContents.executeJavaScript(`globalThis.__specimenFailures ?? []`);
    for (const failure of failures) {
      broken = true;
      say(`  ! specimen threw — ${failure.split("\n")[0]}`);
    }
    const ids = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("[data-shot]")].map((e) => e.dataset.shot)`,
    );
    if (ids.length === 0) {
      broken = true;
      say("  ! no [data-shot] elements — the page rendered nothing");
    }
    await shoot(
      win,
      ids.map((id, i) => ({ name: `${id}.${theme}`, selector: "[data-shot]", index: i })),
      join(out, "app"),
    );

    // The states a specimen only reaches by being used. A popover is half the design of the control
    // it belongs to, and a harness that photographs every surface at rest has no picture of it.
    for (const { name, click, shot, run } of OPENED) {
      const hit = await win.webContents.executeJavaScript(
        run ?? `(() => { const el = document.querySelector(${JSON.stringify(click)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (hit !== true && typeof hit !== "string") {
        say(`  ! nothing at ${click ?? name} — skipped ${name}`);
        continue;
      }
      // A gesture whose whole effect is a CALLBACK leaves no picture — clicking a box asks the shell
      // to fill a panel this page does not have. A step may answer in words instead, and the words
      // are the evidence: see the specimens, which record what the surface asked for.
      if (typeof hit === "string") say(`  ${name}: ${hit}`);
      if (shot !== undefined) await shoot(win, [{ name: `${name}.${theme}`, selector: shot }], join(out, "app"));
    }
  }

  if (wantReference) {
    say("reference");
    await win.loadURL(pathToFileURL(join(here, "reference", "the-shell.html")).href);
    await ready(win, `document.fonts.status === "loaded"`);
    // Every figure in the document, named by the section it sits in — the reference's own numbering,
    // so a picture can be traced back to the paragraph that argues for it.
    const figures = await win.webContents.executeJavaScript(`(() => {
      const out = [];
      for (const el of document.querySelectorAll(${JSON.stringify(REF_FIGURES)})) {
        const section = el.closest("section")?.id ?? "x";
        out.push(section);
      }
      return out;
    })()`);
    const seen = new Map();
    await shoot(
      win,
      figures.map((section, i) => {
        const n = (seen.get(section) ?? 0) + 1;
        seen.set(section, n);
        return { name: `${section}-${n}`, selector: REF_FIGURES, index: i };
      }),
      join(out, "reference"),
    );
  }

  say(broken ? "done, WITH FAILURES — see above" : "done");
  win.destroy();
  // Non-zero on a broken page, so `npm run snapshot` fails rather than finishing quietly on a run
  // that photographed nothing.
  if (broken) app.exit(1);
  app.quit();
}

app.whenReady().then(main, (err) => {
  say(`failed: ${err?.stack ?? err}`);
  app.exit(1);
});
