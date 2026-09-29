/**
 * The desktop's page against the universal one (decision 0015): `/` and `/rn`, in the same window, the
 * same state and the same look, photographed back to back and compared region by region.
 *
 *   npx tsx packages/app/shots/pair.mts [--scene board|task|gate|archived|settings|files|chat|logs] [--look light|dark|<palette>[-wash]-<theme>]
 *                                       [--every-look] [--region sidebar] [--port 9301]
 *   npx tsx packages/app/shots/pair.mts --specimen markdown [--look …] [--every-look]   one component, from a fixture
 *   --scroll-to <heading>   both pages scrolled so that heading tops its scroller, for a long page
 *   --texts   with a region: list the words that moved, and by how much (a specimen always does)
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

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
/** A studio of its own (`studio.mts --port`) writes its pictures apart, so two copiers never share a folder. */
const OUT = join(import.meta.dirname, "parity", arg("--port") === undefined ? "rn" : `rn-${arg("--port")}`);

/** The shell's regions, as the desktop's page names them. A region absent from a scene is skipped. */
const REGIONS: Record<string, string> = {
  sidebar: ".sidebar",
  titlebar: ".title-bar",
  board: ".tasks-view > .col.mid",
  panel: "aside.ctx-panel",
  inbox: "footer.strip",
  /** The whole room under the title bar — for the rooms that are one region (Files, Chat, Settings, Logs, …). */
  viewport: ".viewport",
  /** The workflow editor (`stateEditor.tsx`'s `.pane.editor`): the first on the page — the Files room's, or the panel's. */
  editor: ".pane.editor",
  /** What floats over the window: a menu, the needs-attention card, a dialog (the scenes that open one). */
  float: ".context-menu, .prob-card, .modal, .cx-submenu",
};

type Rect = { x: number; y: number; width: number; height: number };

/** Paint a box out of a picture, the same on both pages, so it cannot count either way. */
function mask(png: PNG, r: Rect, scale: number): void {
  const x0 = Math.max(0, Math.floor(r.x * scale));
  const y0 = Math.max(0, Math.floor(r.y * scale));
  const x1 = Math.min(png.width, Math.ceil((r.x + r.width) * scale));
  const y1 = Math.min(png.height, Math.ceil((r.y + r.height) * scale));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = 255;
      png.data[i + 1] = 0;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
  }
}

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
 * Pixels that differ TO THE EYE, and beside them pixels that differ at all.
 *
 * "To the eye" is pixelmatch's own perceptual test (YIQ distance over 0.1), with anti-aliased pixels
 * told apart and forgiven — a glyph edge half a pixel over is not a difference anyone can see, and the
 * two layouts never agree to the sixty-fourth of a pixel (Chromium's layout units against React Native
 * Web's), nor does the stylesheet's floating-point `color-mix()` against a copy's 8-bit `rgba()`. What
 * is left after that is something drawn differently: a line out of place, a wrong colour, a missing box.
 */
function differ(a: PNG, b: PNG, diffTo?: string): { differing: number; exact: number; total: number } {
  const diff = new PNG({ width: a.width, height: a.height });
  const exact = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0, includeAA: true });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false, alpha: 0.15, aaColor: [255, 210, 0] });
  if (exact > 0 && diffTo !== undefined) writeFileSync(diffTo, PNG.sync.write(diff));
  return { differing, exact, total: a.width * a.height };
}

/** `--scroll-to <heading>`: the page scrolled so that heading sits at the top of its scroller, on both pages. */
async function scrollTo(app: App): Promise<void> {
  const heading = arg("--scroll-to");
  if (heading === undefined) return;
  const find = `[...document.querySelectorAll("*")].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === ${JSON.stringify(heading)}) && e.getBoundingClientRect().left > 250)`;
  try { await app.until(`${find} !== undefined`, `the ${heading} heading`, 8); } catch { console.log(`  (no ${heading} heading here)`); return; }
  await app.evaluate(`(() => {
    const el = ${find};
    let box = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const at = el.closest('[role="heading"]') ?? el;
    box.scrollTop = Math.round((at.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) * devicePixelRatio) / devicePixelRatio;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
}

async function capture(app: App): Promise<PNG> {
  // As `App.shot` does: a page in the background draws no frame, and a capture waits for one forever.
  // With several studios on one machine a capture sometimes waits anyway, so it is asked again after 20s.
  for (let attempt = 1; ; attempt++) {
    await app.cdp("Page.bringToFront");
    const shot = await Promise.race([
      app.cdp<{ data: string }>("Page.captureScreenshot", { format: "png" }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000)),
    ]);
    if (shot !== undefined) return PNG.sync.read(Buffer.from(shot.data, "base64"));
    if (attempt === 3) throw new Error("the window drew no frame to capture in a minute");
  }
}

/**
 * A specimen (`--specimen markdown`): one component drawn from a fixture on `/specimen-dom` and its copy
 * on `/specimen-rn` (`packages/client/src/specimens/registry.tsx`), photographed and compared — the gate
 * for a leaf, with no world to seed and no scene to reach.
 */
/**
 * Every run of text under `#specimen`, where it is drawn: its words and its box, relative to the specimen.
 * Compared between the two pages, this says WHICH line moved and by how much — what a diff picture
 * cannot say.
 */
const texts = (root: string): string => `(() => {
  const root = ${root};
  const o = root === document.body ? { x: 0, y: 0 } : root.getBoundingClientRect();
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent.replace(/\\s+/g, " ").trim();
    if (text === "") continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    out.push({ text: text.slice(0, 40), x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height });
  }
  return out;
})()`;
type Run = { text: string; x: number; y: number; w: number; h: number };

function compareTexts(dom: readonly Run[], rn: readonly Run[]): string[] {
  const left = [...rn];
  const out: string[] = [];
  for (const d of dom) {
    const i = left.findIndex((r) => r.text === d.text);
    if (i < 0) {
      out.push(`  missing on rn: "${d.text}"`);
      continue;
    }
    const r = left.splice(i, 1)[0]!;
    const f = (n: number): string => (Math.round(n * 100) / 100).toString();
    const moved = [["x", r.x - d.x], ["y", r.y - d.y], ["w", r.w - d.w], ["h", r.h - d.h]].filter(([, v]) => Math.abs(v as number) > 0.05);
    if (moved.length > 0) out.push(`  "${d.text}" at ${f(d.x)},${f(d.y)} ${f(d.w)}×${f(d.h)}: ${moved.map(([k, v]) => `${k} ${(v as number) > 0 ? "+" : ""}${f(v as number)}`).join(" ")}`);
  }
  for (const r of left) out.push(`  only on rn: "${r.text}"`);
  return out;
}

async function specimen(app: App, name: string, looks: readonly Look[]): Promise<boolean> {
  let failed = false;
  const origin = await app.evaluate<string>("location.protocol + '//' + location.host");
  for (const look of looks) {
    const shots: PNG[] = [];
    const sizes: string[] = [];
    const runs: Run[][] = [];
    /** The copy's islands, where they stand in the specimen: painted out of both pictures, as a scene's are. */
    let islands: (Rect & { name: string })[] = [];
    for (const side of ["dom", "rn"]) {
      await app.navigate(`${origin}/specimen-${side}?name=${encodeURIComponent(name)}&look=${lookName(look)}`);
      // Patiently: the shared dev server rebuilds a page's graph after an edit anywhere in it.
      await app.until("document.getElementById('specimen') !== null", `the ${side} specimen to draw`, 400);
      await app.evaluate("document.fonts.ready.then(() => true)");
      await new Promise((r) => setTimeout(r, 400));
      const r = await app.evaluate<Rect>(`(() => { const r = document.getElementById("specimen").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      sizes.push(`${Math.round(r.width * 100) / 100}×${Math.round(r.height * 100) / 100}`);
      if (side === "rn") {
        islands = await app.evaluate<(Rect & { name: string })[]>(
          `[...document.querySelectorAll("#specimen [data-island]")].map((e) => { const b = e.getBoundingClientRect(); return { name: e.getAttribute("data-island"), x: b.x - ${r.x}, y: b.y - ${r.y}, width: b.width, height: b.height }; })`,
        );
      }
      runs.push(await app.evaluate<Run[]>(texts(`document.getElementById("specimen")`)));
      // As `capture` does: a frame asked for first, and the capture asked again if it waits (a studio
      // among several sometimes never answers the first).
      let shot: { data: string } | undefined;
      for (let attempt = 1; shot === undefined; attempt++) {
        await app.cdp("Page.bringToFront");
        await app.evaluate("new Promise((r) => requestAnimationFrame(() => r(true)))");
        shot = await Promise.race([
          app.cdp<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } }),
          new Promise<undefined>((done) => setTimeout(() => done(undefined), 20_000)),
        ]);
        if (shot === undefined && attempt === 3) throw new Error(`the ${side} specimen drew no frame to capture in a minute`);
      }
      shots.push(PNG.sync.read(Buffer.from(shot.data, "base64")));
    }
    const [dom, rn] = shots as [PNG, PNG];
    for (const island of islands) for (const png of [dom, rn]) mask(png, island, rn.width / Number(sizes[1]!.split("×")[0]));
    const base = `specimen-${name}-${lookName(look)}`;
    const moved = compareTexts(runs[0]!, runs[1]!);
    writeFileSync(join(OUT, `${base}.dom.png`), PNG.sync.write(dom));
    writeFileSync(join(OUT, `${base}.rn.png`), PNG.sync.write(rn));
    if (dom.width !== rn.width || dom.height !== rn.height) {
      failed = true;
      const w = Math.min(dom.width, rn.width);
      const h = Math.min(dom.height, rn.height);
      const d = differ(crop(dom, { x: 0, y: 0, width: w, height: h }, 1), crop(rn, { x: 0, y: 0, width: w, height: h }, 1), join(OUT, `${base}.diff.png`));
      console.log(`${base}: DIFFERENT SIZE (dom ${sizes[0]}, rn ${sizes[1]}); over the common part ${verdict(d)}${islands.length > 0 ? `  (islands left out: ${islands.map((i) => i.name).join(", ")})` : ""}`);
      if (moved.length > 0) console.log(`  text that moved (rn − dom):\n${moved.join("\n")}`);
      continue;
    }
    const d = differ(dom, rn, join(OUT, `${base}.diff.png`));
    if (d.differing !== 0) failed = true;
    console.log(`${base}: ${verdict(d)}  (${sizes[0]})${islands.length > 0 ? `  (islands left out: ${islands.map((i) => i.name).join(", ")})` : ""}`);
    if (moved.length > 0) console.log(`  text that moved (rn − dom):\n${moved.join("\n")}`);
  }
  return failed;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const app = await App.connect(Number(arg("--port") ?? STUDIO_PORT), { out: OUT });
  const named = arg("--specimen");
  if (named !== undefined) {
    try {
      const failed = await specimen(app, named, process.argv.includes("--every-look") ? LOOKS : [parseLook(arg("--look") ?? "light")]);
      console.log(`wrote ${OUT}`);
      if (failed) process.exitCode = 1;
    } finally {
      await app.close();
    }
    return;
  }
  const scenes = SCENES.filter((s) => s.name === (arg("--scene") ?? "board"));
  if (scenes.length === 0) throw new Error(`no scene ${arg("--scene")}: ${SCENES.map((s) => s.name).join(", ")}`);
  const looks: readonly Look[] = process.argv.includes("--every-look") ? LOOKS : [parseLook(arg("--look") ?? "light")];
  const only = arg("--region");
  let failed = false;
  try {
    for (const look of looks) {
      for (const scene of scenes) {
        const name = `${scene.name}${arg("--scroll-to") !== undefined ? `@${arg("--scroll-to")!.replace(/[^a-z0-9]+/gi, "_")}` : ""}-${lookName(look)}`;
        await goTo(app, "/", { look, scene });
        await scrollTo(app);
        const regions: Record<string, Rect> = {};
        for (const [region, selector] of Object.entries(REGIONS)) {
          if (only !== undefined && region !== only) continue;
          const r = await app.evaluate<Rect | null>(
            // A float is the last of its kind on the page: floats are appended to <body>, after everything.
            `(() => { const e = ${region === "float" ? `[...document.querySelectorAll(${JSON.stringify(selector)})].pop()` : `document.querySelector(${JSON.stringify(selector)})`}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
          );
          if (r !== null && r.width > 0 && r.height > 0) regions[region] = r;
        }
        const domRuns = process.argv.includes("--texts") ? await app.evaluate<Run[]>(texts("document.body")) : [];
        const dom = await capture(app);
        // A scene is reached by what the page draws ("Awaiting you", a card's title), so on `/rn` it can
        // only be reached once the copies draw those. Until then the picture is of wherever it stopped.
        let unreached: string | undefined;
        try {
          await goTo(app, "/rn", { scene });
          await scrollTo(app);
        } catch (e) {
          unreached = (e as Error).message;
        }
        // The native path must not have been helped: no rule of `styles.css` on the page.
        const helped = await app.evaluate<boolean>(
          `[...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === ".sidebar" || r.selectorText === ".card"); } catch { return false; } })`,
        );
        if (helped) throw new Error("styles.css is on the /rn page: it would draw what the copies should");
        // Islands (Monaco, CodeMirror) are the desktop's own components by construction, and on `/rn`
        // they stand without the stylesheet the phone's island page brings: painted out of both pictures.
        const islands = await app.evaluate<(Rect & { name: string })[]>(
          `[...document.querySelectorAll("[data-island]")].map((e) => { const r = e.getBoundingClientRect(); return { name: e.getAttribute("data-island"), x: r.x, y: r.y, width: r.width, height: r.height }; })`,
        );
        const uncopied = await app.evaluate<string[]>(`[...document.querySelectorAll("[data-testid^=uncopied-]")].map((e) => e.getAttribute("data-testid").slice(9))`);
        const rnRuns = process.argv.includes("--texts") ? await app.evaluate<Run[]>(texts("document.body")) : [];
        const rn = await capture(app);
        const ratio = dom.width / (await app.evaluate<number>("innerWidth"));
        for (const r of islands) for (const png of [dom, rn]) mask(png, r, ratio);
        writeFileSync(join(OUT, `${name}.dom.png`), PNG.sync.write(dom));
        writeFileSync(join(OUT, `${name}.rn.png`), PNG.sync.write(rn));
        const scale = dom.width / (await app.evaluate<number>("innerWidth"));
        console.log(`${name}${uncopied.length > 0 ? `  (not copied yet: ${uncopied.join(", ")})` : ""}${islands.length > 0 ? `  (islands left out: ${islands.map((i) => i.name).join(", ")})` : ""}`);
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
          if (process.argv.includes("--texts") && d.differing !== 0) {
            // Which words moved, of those the desktop draws inside this region (page coordinates).
            const inside = (t: Run): boolean => t.x + t.w > r.x && t.x < r.x + r.width && t.y + t.h > r.y && t.y < r.y + r.height;
            const moved = compareTexts(domRuns.filter(inside), rnRuns.filter(inside));
            if (moved.length > 0) console.log(`    text that moved (rn − dom):\n${moved.map((m) => `  ${m}`).join("\n")}`);
          }
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
  if (d.differing === 0) return `identical to the eye (${d.exact} px differ only in anti-aliasing or by a level)`;
  return `${d.differing} px differ (${((100 * d.differing) / d.total).toFixed(2)}%)`;
}

await main();
