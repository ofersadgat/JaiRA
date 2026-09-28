/**
 * The desktop's page against the universal one (decision 0015): `/` and `/rn`, in the same window, the
 * same state and the same look, photographed back to back and compared region by region.
 *
 *   npx tsx packages/app/shots/pair.mts [--scene board|task|archived|settings] [--look light|dark|<palette>[-wash]-<theme>]
 *                                       [--every-look] [--region sidebar]
 *
 * Attaches to the app `studio.mts` keeps running, so a change to a copy is in the next run with no
 * build. `/rn` draws the universal shell on the native token path with no `styles.css` on the page, so
 * what it matches, it matches the way a phone would draw it; the emulator is the last check, not the loop.
 *
 * Regions are measured on the DESKTOP's page (by its classes; the universal page has none) and cropped
 * out of both pictures at the same place, so a region that is identical is identical where it stands,
 * not merely similar somewhere else. Pictures and diffs land in `shots/parity/rn/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { App } from "./driver.mjs";
import { LOOKS, SCENES, STUDIO_PORT, goTo, lookName, parseLook, type Look } from "./parityWorld.mjs";

const OUT = join(import.meta.dirname, "parity", "rn");
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

/** The shell's regions, as the desktop's page names them. A region absent from a scene is skipped. */
const REGIONS: Record<string, string> = {
  sidebar: ".sidebar",
  titlebar: ".title-bar",
  board: ".tasks-view > .col.mid",
  panel: "aside.ctx-panel",
  inbox: "footer.strip",
};

type Rect = { x: number; y: number; width: number; height: number };

function crop(png: PNG, r: Rect, scale: number): PNG {
  const x = Math.round(r.x * scale);
  const y = Math.round(r.y * scale);
  const w = Math.max(1, Math.min(png.width - x, Math.round(r.width * scale)));
  const h = Math.max(1, Math.min(png.height - y, Math.round(r.height * scale)));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return out;
}

/**
 * Pixels that differ VISIBLY — a channel off by more than {@link VISIBLE} — and, beside them, pixels that
 * differ at all. The split is there because the stylesheet's `color-mix()` is composited by Chromium in
 * floating point and a copy's colour is 8-bit `rgba()` (a phone's compositor is different again), so a
 * translucent ground comes out one level apart in one channel: identical to any eye, not to `===`.
 */
const VISIBLE = 2;
function differ(a: PNG, b: PNG, diffTo?: string): { differing: number; exact: number; total: number } {
  const diff = new PNG({ width: a.width, height: a.height });
  const exact = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0 });
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const far = Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!)) > VISIBLE;
    if (far) differing++;
    // The diff image: visible differences red, the rest a faint copy of the page.
    const grey = Math.round((a.data[i]! + a.data[i + 1]! + a.data[i + 2]!) / 3 / 4 + 190);
    diff.data[i] = far ? 255 : grey;
    diff.data[i + 1] = far ? 0 : grey;
    diff.data[i + 2] = far ? 0 : grey;
    diff.data[i + 3] = 255;
  }
  if (differing > 0 && diffTo !== undefined) writeFileSync(diffTo, PNG.sync.write(diff));
  return { differing, exact, total: a.width * a.height };
}

async function capture(app: App): Promise<PNG> {
  // As `App.shot` does: a page in the background draws no frame, and a capture waits for one forever.
  await app.cdp("Page.bringToFront");
  const shot = await app.cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
  return PNG.sync.read(Buffer.from(shot.data, "base64"));
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const app = await App.connect(STUDIO_PORT, { out: OUT });
  const scenes = SCENES.filter((s) => s.name === (arg("--scene") ?? "board"));
  if (scenes.length === 0) throw new Error(`no scene ${arg("--scene")}: ${SCENES.map((s) => s.name).join(", ")}`);
  const looks: readonly Look[] = process.argv.includes("--every-look") ? LOOKS : [parseLook(arg("--look") ?? "light")];
  const only = arg("--region");
  let failed = false;
  try {
    for (const look of looks) {
      for (const scene of scenes) {
        const name = `${scene.name}-${lookName(look)}`;
        await goTo(app, "/", { look, scene });
        const regions: Record<string, Rect> = {};
        for (const [region, selector] of Object.entries(REGIONS)) {
          if (only !== undefined && region !== only) continue;
          const r = await app.evaluate<Rect | null>(
            `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
          );
          if (r !== null && r.width > 0 && r.height > 0) regions[region] = r;
        }
        const dom = await capture(app);
        // A scene is reached by what the page draws ("Awaiting you", a card's title), so on `/rn` it can
        // only be reached once the copies draw those. Until then the picture is of wherever it stopped.
        let unreached: string | undefined;
        try {
          await goTo(app, "/rn", { scene });
        } catch (e) {
          unreached = (e as Error).message;
        }
        // The native path must not have been helped: no rule of `styles.css` on the page.
        const helped = await app.evaluate<boolean>(
          `[...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === ".sidebar" || r.selectorText === ".card"); } catch { return false; } })`,
        );
        if (helped) throw new Error("styles.css is on the /rn page: it would draw what the copies should");
        const uncopied = await app.evaluate<string[]>(`[...document.querySelectorAll("[data-testid^=uncopied-]")].map((e) => e.getAttribute("data-testid").slice(9))`);
        const rn = await capture(app);
        writeFileSync(join(OUT, `${name}.dom.png`), PNG.sync.write(dom));
        writeFileSync(join(OUT, `${name}.rn.png`), PNG.sync.write(rn));
        const scale = dom.width / (await app.evaluate<number>("innerWidth"));
        console.log(`${name}${uncopied.length > 0 ? `  (not copied yet: ${uncopied.join(", ")})` : ""}`);
        if (unreached !== undefined) {
          failed = true;
          console.log(`  the scene could not be reached on /rn: ${unreached}`);
        }
        const whole = only === undefined && dom.width === rn.width && dom.height === rn.height ? differ(dom, rn, join(OUT, `${name}.diff.png`)) : undefined;
        if (whole !== undefined) console.log(`  window   ${verdict(whole)}`);
        for (const [region, r] of Object.entries(regions)) {
          const d = differ(crop(dom, r, scale), crop(rn, r, scale), join(OUT, `${name}.${region}.diff.png`));
          writeFileSync(join(OUT, `${name}.${region}.dom.png`), PNG.sync.write(crop(dom, r, scale)));
          writeFileSync(join(OUT, `${name}.${region}.rn.png`), PNG.sync.write(crop(rn, r, scale)));
          console.log(`  ${region.padEnd(8)} ${verdict(d)}  (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)})`);
          if (d.differing !== 0) failed = true;
        }
      }
    }
  } finally {
    await app.close();
  }
  console.log(`wrote ${OUT}`);
  if (failed) process.exitCode = 1;
}

function verdict(d: { differing: number; exact: number; total: number }): string {
  if (d.exact === 0) return "identical";
  if (d.differing === 0) return `identical to the eye (${d.exact} px one or two levels apart)`;
  return `${d.differing} px differ (${((100 * d.differing) / d.total).toFixed(2)}%)`;
}

await main();
