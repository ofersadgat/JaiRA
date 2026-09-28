/**
 * The fidelity gates of decision 0015: two pages that must draw the same pixels, photographed in the
 * same states and compared.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/parity.mts              S1: the Vite renderer against the One client
 *   npx tsx packages/app/shots/parity.mts universal    S3: the One client's `/` against `/universal`,
 *                                                      where every universal copy stands in for its DOM
 *                                                      original (`@jaira/universal`'s `COPIES`)
 *
 * One world, seeded once. Then, per theme, ONE launch photographs the same scenes twice: once on the
 * first page, then — the same window navigated — on the second. One launch rather than two, because a
 * launch changes the state being photographed: it interrupts the parked run's pending call and
 * re-registers it, which adds lines to the transcript. The clock starts from the same instant on each
 * page and animations are off (`holdStill`), so the only thing that differs between a pair is the page.
 * Pairs are compared pixel by pixel, and every pair that differs gets a diff image in `shots/parity/`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld, type World } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity");
const WORLD = join(import.meta.dirname, ".world-parity");
const PARKED = "tighten the changeset lint";
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;
const settle = (ms = 1200): Promise<void> => new Promise((r) => setTimeout(r, ms));
const drawn = "window.jaira && document.getElementById('root') && document.getElementById('root').children.length > 0";

interface Page {
  /** Names the output folder. */
  readonly label: string;
  readonly url: string;
  /** What `location.protocol + ' ' + location.pathname + marker` must read: proof the page is the one meant. */
  readonly proof: string;
}

const VITE: Page = {
  label: "vite",
  url: pathToFileURL(join(import.meta.dirname, "..", "dist", "renderer", "index.html")).href,
  proof: "file: vite",
};
const ONE: Page = { label: "one", url: "app://jaira/", proof: "app: / one" };
const UNIVERSAL: Page = { label: "universal", url: "app://jaira/universal", proof: "app: /universal one" };

const PAIR: readonly [Page, Page] = process.argv[2] === "universal" ? [{ ...ONE, label: "dom" }, UNIVERSAL] : [VITE, ONE];
/** The page's own account of itself. One's SPA shell sets `__vxrnIsSPA`; Vite's does not. */
const PROOF =
  "location.protocol + (location.protocol === 'app:' ? ' ' + location.pathname : '') + (globalThis.__vxrnIsSPA === true ? ' one' : ' vite')";

async function launch(world: World, port: number): Promise<App> {
  // The One client is the window's default renderer; the other pages are reached by navigation.
  process.env.JAIRA_RENDERER = "one";
  const app = await App.launch(world, { out: OUT, port });
  await app.until(drawn, "the window to draw");
  return app;
}

async function start(app: App, title: string, fake: unknown): Promise<string> {
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title,
    workflow: "feature/plan",
    inputs: { issue: `# ${title}\n\nThe issue this task was raised for.` },
  });
  await app.ipc("task:start", { taskId: made.taskId, fake });
  return made.taskId;
}

async function seed(world: World): Promise<void> {
  const app = await launch(world, 9239);
  try {
    await start(app, "add dark mode", happyRules());
    await start(app, "rework the sync lint", [happyRules()[0]]);
    await app.until(says("done"), "the completed task");
    await app.until(says("failed"), "the failed task");
    await start(app, PARKED, blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park at its gate");
    // An archived task (main, 2026-09-27): held at the foot of the Finished lane, faded, wearing the
    // pill of how it finished — the card copy has to draw that too.
    const retired = await start(app, "retire the old lint", happyRules());
    await app.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "the task to archive to finish");
    await app.ipc("task:archive", { taskIds: [retired] });
    await app.until(says("1 archived"), "the archived task to be held at the foot");
  } finally {
    await app.close();
  }
}

/**
 * The scenes. Each is reached from a freshly loaded page, and each is photographed on BOTH pages before
 * the next begins: reaching a scene can change what the next one shows (opening a task marks its
 * unseen counts seen), so the two pictures of a pair must be taken from the same state, back to back.
 */
interface Scene {
  readonly name: string;
  /** Photographed in every look, not only the two base ones. */
  readonly everyLook?: boolean;
  /** Selector to frame, or the whole window. */
  readonly of?: string;
  reach(app: App): Promise<void>;
}

const SCENES: readonly Scene[] = [
  { name: "board", everyLook: true, reach: async (app) => void (await app.until(says("Awaiting you"), "the gate to still be parked")) },
  { name: "task", everyLook: true, reach: (app) => app.clickText(PARKED) },
  {
    // The Finished lane's foot opened: the archived card, faded, "archived … ago", its finishing pill.
    name: "archived",
    everyLook: true,
    reach: async (app) => {
      await app.until(says("1 archived"), "the archived foot");
      await app.evaluate("document.querySelector('.lane-archived').click()");
      await app.until(says("retire the old lint"), "the archived card to show");
    },
  },
  { name: "settings", reach: (app) => app.clickText("Settings") },
  {
    // A real Monaco drawing a real sample through the TextMate grammars (WASM): the part of the
    // renderer most likely to break under a new origin and a new content policy.
    name: "file-types",
    of: ".ft",
    reach: async (app) => {
      await app.clickText("Settings");
      await app.clickText("Appearance");
      // Scrolled into view, and again on every try, for the picture rather than for Monaco: `.ft` sits
      // in the settings pane's own scroll container, which a capture paints only where it is scrolled
      // to, and the page lays out after the preview mounts, undoing a scroll made before that. Monaco
      // draws an editor below the fold perfectly well; what it cannot draw in is a hidden window,
      // which is what used to leave this editor empty (see `launch` in the driver).
      await app.until(`document.querySelector(".ft-preview-body") !== null`, "the preview to mount");
      await app.until(
        `(document.querySelector(".ft-preview-body").scrollIntoView({ block: "center" }),
          [...document.querySelectorAll(".ft-preview-body .view-lines span[class^=mtk]")].some((s) => getComputedStyle(s).color !== "rgb(0, 0, 0)"))`,
        "the preview's editor to colour itself",
      );
      // Then the section's top, which is what the picture frames: centred on the preview, `.ft` is
      // about as tall as the window and its upper half lay above the fold, unpainted on both pages.
      await app.evaluate(`document.querySelector(".ft").scrollIntoView({ block: "start" })`);
      await app.until(
        `(() => { const top = document.querySelector(".ft").getBoundingClientRect().top; return top >= 0 && top < innerHeight / 2; })()`,
        "File types to scroll into view",
      );
    },
  },
];

function compare(name: string): { name: string; differing: number; total: number } {
  const a = PNG.sync.read(readFileSync(join(OUT, PAIR[0].label, `${name}.png`)));
  const b = PNG.sync.read(readFileSync(join(OUT, PAIR[1].label, `${name}.png`)));
  if (a.width !== b.width || a.height !== b.height) {
    return { name: `${name} (size ${a.width}x${a.height} vs ${b.width}x${b.height})`, differing: -1, total: a.width * a.height };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0 });
  if (differing > 0) writeFileSync(join(OUT, `${name}.diff.png`), PNG.sync.write(diff));
  return { name, differing, total: a.width * a.height };
}

/**
 * The looks each gate runs in. The first two (the default palette, both modes) take every scene; the
 * rest take the scenes that draw the components copied so far, in the palettes whose rules those
 * components carry by hand (`--quick` skips them).
 */
interface Look {
  theme: "light" | "dark";
  palette: string;
  wash: boolean;
}
const LOOKS: readonly Look[] = [
  { theme: "light", palette: "ink", wash: false },
  { theme: "dark", palette: "ink", wash: false },
  ...(process.argv.includes("--quick")
    ? []
    : ([
        { theme: "light", palette: "classic", wash: false },
        { theme: "dark", palette: "classic", wash: true },
        { theme: "light", palette: "contrast", wash: false },
        { theme: "dark", palette: "pastel", wash: false },
        { theme: "light", palette: "blueprint", wash: false },
        { theme: "light", palette: "ink", wash: true },
      ] as const)),
];
const lookName = (l: Look): string => (l.palette === "ink" && !l.wash ? l.theme : `${l.palette}${l.wash ? "-wash" : ""}-${l.theme}`);

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  for (const page of PAIR) mkdirSync(join(OUT, page.label), { recursive: true });
  const world = buildWorld(WORLD);
  await seed(world);

  const complaints = new Map<string, string[]>(PAIR.map((p) => [p.label, []]));
  const names = new Set<string>();
  const census: string[] = [];
  let port = 9240;
  for (const [index, look] of LOOKS.entries()) {
    const theme = lookName(look);
    // The theme is read at startup, so the look is chosen by a launch of its own before the pair.
    const chooser = await launch(world, port++);
    await chooser.preferLook(look);
    await chooser.close();
    const app = await launch(world, port++);
    try {
      // A launch recovers the parked run (interrupts its pending call, re-registers it) a moment after
      // the window draws. Photographed before that settles, the two pages see two different runs.
      await settle(5000);
      await app.holdStill(Date.UTC(2026, 8, 27, 21, 0, 0));
      // The Monaco scene answers S1's question (does Monaco work under the new origin and policy) and
      // draws nothing a copy replaces, so the universal gate skips it.
      const relevant = SCENES.filter((s) => (index < 2 || s.everyLook === true) && (PAIR[0] === VITE || s.name !== "file-types"));
      for (const scene of relevant) {
        for (const page of PAIR) {
          const before = app.complaints.length;
          await app.navigate(page.url);
          await app.until(drawn, `${page.label} to draw`);
          const which = await app.evaluate<string>(PROOF);
          if (which !== page.proof) throw new Error(`expected ${page.label} (${page.proof}), found ${which}`);
          // The pointer where the last scene left it would hover something different on this load.
          await app.hover(2, 2);
          try {
            await scene.reach(app);
          } catch (e) {
            // Once, with what the page looked like: a scene that fails is news, and a retry would hide
            // it — the retry that used to be here was hiding a window Windows had marked hidden.
            const state = await app.evaluate<string>(
              `(() => { const b = document.querySelector(".ft-preview-body"); const v = b?.querySelector(".view-lines"); const ed = b?.querySelector(".monaco-editor"); return JSON.stringify({ visibility: document.visibilityState, lines: v ? v.children.length : null, editor: ed ? ed.style.width + "x" + ed.style.height : null, text: b?.innerText.slice(0, 120) }); })()`,
            );
            console.log(`  ${scene.name} on ${page.label}: ${state}`);
            await app.shot(`${page.label}/failed-${scene.name}-${theme}`);
            throw e;
          }
          await settle();
          await app.shot(`${page.label}/${scene.name}-${theme}`, scene.of);
          // What this page actually drew, so an "identical" cannot hide a copy that never rendered.
          if (scene.everyLook === true) {
            census.push(
              `${scene.name}-${theme} ${page.label}: ` +
                (await app.evaluate<string>(
                  `(() => { const r = document.documentElement.dataset; return "palette=" + (r.palette ?? "classic") + " theme=" + r.theme + " wash=" + (r.wash ?? "off") + " | DOM cards " + document.querySelectorAll(".card").length + ", DOM pills " + document.querySelectorAll("span.pill:not(.pill-more)").length + ", Tamagui views " + document.querySelectorAll(".is_View").length; })()`,
                )),
            );
          }
          complaints.get(page.label)!.push(...app.complaints.slice(before));
        }
        names.add(`${scene.name}-${theme}`);
      }
    } finally {
      await app.close();
    }
  }

  console.log("\nwhat each page drew:");
  for (const line of census) console.log(`  ${line}`);
  console.log(`\n${PAIR[0].label} against ${PAIR[1].label}:`);
  let failed = false;
  for (const name of names) {
    const r = compare(name);
    const verdict =
      r.differing === 0
        ? "identical"
        : r.differing < 0
          ? "DIFFERENT SIZE"
          : `${r.differing} px differ (${((100 * r.differing) / r.total).toFixed(3)}%)`;
    if (r.differing !== 0) failed = true;
    console.log(`  ${r.name}: ${verdict}`);
  }
  for (const [label, said] of complaints) {
    const real = said.filter((c) => !/disk_cache|gpu_disk|Gpu Cache/.test(c));
    if (real.length === 0) continue;
    console.log(`\n${label} spoke up ${real.length} time(s):`);
    for (const c of real.slice(0, 8)) console.log(`  ${c}`);
  }
  console.log(`\nwrote ${OUT}`);
  if (failed) process.exitCode = 1;
}

await main();
