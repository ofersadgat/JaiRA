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
import { LOOKS, PARKED, SCENES, drawn, launch, lookName, seed, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity");
const WORLD = join(import.meta.dirname, ".world-parity");

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

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  for (const page of PAIR) mkdirSync(join(OUT, page.label), { recursive: true });
  const world = buildWorld(WORLD);
  await seed(world, OUT);

  const complaints = new Map<string, string[]>(PAIR.map((p) => [p.label, []]));
  const names = new Set<string>();
  const census: string[] = [];
  let port = 9240;
  for (const [index, look] of LOOKS.entries()) {
    const theme = lookName(look);
    // The theme is read at startup, so the look is chosen by a launch of its own before the pair.
    const chooser = await launch(world, port++, OUT);
    await chooser.preferLook(look);
    await chooser.close();
    const app = await launch(world, port++, OUT);
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
