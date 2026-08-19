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
 * Extra frames, each taken after one click.
 *
 * Kept as data rather than as a flag on the specimen, because what is being photographed is a
 * TRANSITION — the control before and the control after — and a specimen that opened itself on mount
 * would have no picture of the first half.
 */
const OPENED = [
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

  for (const theme of ["light", "dark"]) {
    say(`app · ${theme}`);
    await win.loadFile(join(here, "..", "dist", "snapshot", "index.html"), { search: `theme=${theme}` });
    await ready(win, `document.documentElement.dataset.ready === "1"`);
    const ids = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("[data-shot]")].map((e) => e.dataset.shot)`,
    );
    await shoot(
      win,
      ids.map((id, i) => ({ name: `${id}.${theme}`, selector: "[data-shot]", index: i })),
      join(out, "app"),
    );

    // The states a specimen only reaches by being used. A popover is half the design of the control
    // it belongs to, and a harness that photographs every surface at rest has no picture of it.
    for (const { name, click, shot } of OPENED) {
      const hit = await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(click)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (hit !== true) {
        say(`  ! nothing at ${click} — skipped ${name}`);
        continue;
      }
      await shoot(win, [{ name: `${name}.${theme}`, selector: shot }], join(out, "app"));
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

  say("done");
  win.destroy();
  app.quit();
}

app.whenReady().then(main, (err) => {
  say(`failed: ${err?.stack ?? err}`);
  app.exit(1);
});
