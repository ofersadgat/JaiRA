/**
 * The desktop's page against the universal one (decision 0015): `/` and `/rn`, in the same window, the
 * same state and the same look, photographed back to back and compared region by region.
 *
 *   npx tsx packages/app/shots/pair.mts [--scene board|task|gate|archived|settings|files|chat|logs] [--look light|dark|<palette>[-wash]-<theme>]
 *                                       [--every-look] [--region sidebar] [--port 9301]
 *   npx tsx packages/app/shots/pair.mts --specimen markdown [--look …] [--every-look]   one component, from a fixture
 *   --scene a,b | all | main   several scenes, every scene, or the ones photographed in every look
 *   --specimen a,b | all       several specimens, or every one the registry names
 *   --all                      every scene and every specimen
 *   --scroll-to <heading>   both pages scrolled so that heading tops its scroller, for a long page
 *   --texts   with a region: list the words that moved, and by how much (a specimen always does)
 *   --report <file.json>    what each comparison said, for a later run to be held against
 *   --same-as <file.json>   hold this run against an earlier one's report: every verdict the same, or which are not
 *
 * The reference pictures ("goldens"), for comparing without the desktop's page (0015's migration, step 2):
 *
 *   --freeze            photograph the desktop's page ONLY — every scene and specimen (or the ones named), in
 *                       every look (or `--look`) — and keep each picture with what a comparison needs of the
 *                       page it was taken from: its regions, its text boxes, its editors' boxes, the window
 *   --freeze --verify   photograph it again and say whether each kept picture reproduces
 *   --verify            (without `--freeze`) the same check made in passing, in a comparison against `/`
 *   --against-goldens   photograph `/rn` ONLY and compare it against the kept pictures: the same regions,
 *                       masks and grading as against `/`. A picture that was never frozen, or was frozen in
 *                       another world or window, fails by name.
 *   --goldens <dir>     where they are kept (`shots/goldens`)
 *   --mask-volatile     in a comparison against `/`: leave out what a comparison against goldens must (the
 *                       log's counts and rows), so the two can be held against each other with `--same-as`
 *
 * Attaches to the app `studio.mts` keeps running, so a change to a copy is in the next run with no
 * build. `/rn` draws the universal shell on the native token path with no `styles.css` on the page, so
 * what it matches, it matches the way a phone would draw it; the emulator is the last check, not the loop.
 *
 * Regions are measured on the DESKTOP's page (by its classes; the universal page has none) and cropped
 * out of both pictures at the same place, so a region that is identical is identical where it stands,
 * not merely similar somewhere else. Pictures and diffs land in `shots/parity/rn/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { App } from "./driver.mjs";
import { LOOKS, PARKED, SCENES, STUDIO_PORT, goTo, lookName, parseLook, type Look, type Scene } from "./parityWorld.mjs";

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const flag = (name: string): boolean => process.argv.includes(name);
/** A studio of its own (`studio.mts --port`) writes its pictures apart, so two copiers never share a folder. */
const OUT = join(import.meta.dirname, "parity", arg("--port") === undefined ? "rn" : `rn-${arg("--port")}`);
/** The reference pictures: `<scene>/<look>.png` and `specimen-<name>/<look>.png`, each with a `<look>.json` beside it, and `manifest.json` over them all. */
const GOLDENS = arg("--goldens") ?? join(import.meta.dirname, "goldens");
/** What this run does: the two pages against each other, the desktop's alone kept, or `/rn` against what was kept. */
const MODE: "pair" | "freeze" | "goldens" = flag("--freeze") ? "freeze" : flag("--against-goldens") ? "goldens" : "pair";
/**
 * Whether the desktop's page is held against (or kept as) its golden as it is photographed: a freeze, and
 * a comparison against `/` given `--verify` — one pass that says both what `/rn` is to `/` and whether
 * the kept pictures of `/` still reproduce.
 */
const KEEPING = MODE === "freeze" || (MODE === "pair" && flag("--verify"));

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

/**
 * The editors on the DESKTOP's page, where a golden's manifest says they stood: Monaco's host, CodeMirror's
 * editor, a frame. A comparison masks the copy's islands (`[data-island]`, which only `/rn` marks); these
 * are kept beside a golden so a picture that does not reproduce can say whether it was an editor's doing.
 */
const DOM_ISLANDS = ".monaco-host, .cm-editor, iframe";

/**
 * What the world keeps changing under a kept picture, found on the desktop's page: the log. The runtime
 * writes to it at every page load, so the counts on the sidebar's Logs row, the Settings row's count of
 * things needing attention (an error logged since puts one there), the Logs room's rows and the
 * needs-attention card's "69 warnings were logged" are never what they were when a golden was frozen.
 * Painted out of both pictures in a comparison against goldens (and in one against `/`, with
 * `--mask-volatile`, so the two say the same of the same pixels).
 */
const VOLATILE = `(() => {
  const out = [];
  const add = (name, r) => { if (r.width > 0 && r.height > 0) out.push({ name, x: r.x, y: r.y, width: r.width, height: r.height }); };
  for (const row of document.querySelectorAll(".side-row")) {
    const label = row.querySelector(".side-label");
    if (label === null || !["Logs", "Settings"].includes(label.textContent)) continue;
    // From the end of the row's word to the end of the row: its pills, however many digits they hold.
    const range = document.createRange();
    range.selectNodeContents(label);
    const a = range.getBoundingClientRect(), b = row.getBoundingClientRect();
    add(label.textContent + " row", { x: a.right + 4, y: b.y, width: b.right - a.right - 4, height: b.height });
  }
  for (const e of document.querySelectorAll(".logs-list, .log-unseen-bar, .logs-bar > .sub, .prob-card-tally, .prob-card-say[title^='Log:']")) add("log", e.getBoundingClientRect());
  return out;
})()`;

/** The dev server reloaded the page under a scene: another copier saved a file. The picture would be of the board. */
class Disturbed extends Error {}

type Rect = { x: number; y: number; width: number; height: number };
type Island = Rect & { name: string };

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

/**
 * A region cut out of a picture — the part of it the picture holds. A region is measured on the page,
 * which is longer than the window where something scrolls: the Components room's last `.modal` stands
 * far below the fold, and a box that begins past the picture has no part in it (`undefined`).
 */
function crop(png: PNG, r: Rect, scale: number): PNG | undefined {
  const x = Math.max(0, Math.round(r.x * scale));
  const y = Math.max(0, Math.round(r.y * scale));
  const w = Math.min(png.width, Math.round((r.x + r.width) * scale)) - x;
  const h = Math.min(png.height, Math.round((r.y + r.height) * scale)) - y;
  if (w < 1 || h < 1) return undefined;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return out;
}

type Graded = { differing: number; exact: number; total: number };

/**
 * Pixels that differ TO THE EYE, and beside them pixels that differ at all.
 *
 * "To the eye" is pixelmatch's own perceptual test (YIQ distance over 0.1), with anti-aliased pixels
 * told apart and forgiven — a glyph edge half a pixel over is not a difference anyone can see, and the
 * two layouts never agree to the sixty-fourth of a pixel (Chromium's layout units against React Native
 * Web's), nor does the stylesheet's floating-point `color-mix()` against a copy's 8-bit `rgba()`. What
 * is left after that is something drawn differently: a line out of place, a wrong colour, a missing box.
 */
function differ(a: PNG, b: PNG, diffTo?: string): Graded {
  const diff = new PNG({ width: a.width, height: a.height });
  const exact = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0, includeAA: true });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false, alpha: 0.15, aaColor: [255, 210, 0] });
  if (exact > 0 && diffTo !== undefined) writeFileSync(diffTo, PNG.sync.write(diff));
  return { differing, exact, total: a.width * a.height };
}

function verdict(d: Graded): string {
  if (d.exact === 0) return "identical";
  if (d.differing === 0) return `identical to the eye (${d.exact} px differ only in anti-aliasing or by a level)`;
  return `${d.differing} px differ (${((100 * d.differing) / d.total).toFixed(2)}%)`;
}

/**
 * What one comparison said, kept for `--report` and `--same-as`: the two ways of comparing `/rn` (against
 * the desktop's page, against its frozen pictures) must say the same thing of every part.
 */
interface Result {
  /** `<scene>-<look>` or `specimen-<name>-<look>`, as the pictures are named. */
  readonly of: string;
  /** `window`, a region, or `specimen`. */
  readonly part: string;
  /** `identical`, `eye`, `differ`, `size` (a specimen as tall on one page as not on the other), `unreached`, `no golden`. */
  readonly grade: string;
  readonly differing?: number;
  readonly exact?: number;
  /** For `size`: the two sizes. */
  readonly note?: string;
}
const results: Result[] = [];
const gradeOf = (d: Graded): string => (d.exact === 0 ? "identical" : d.differing === 0 ? "eye" : "differ");
const noted = (of: string, part: string, d: Graded): void => void results.push({ of, part, grade: gradeOf(d), differing: d.differing, exact: d.exact });

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

const AS_CAPTURED = new WeakMap<PNG, Buffer>();

async function capture(app: App, clip?: Rect, beyond = true): Promise<PNG> {
  // As `App.shot` does: a page in the background draws no frame, and a capture waits for one forever.
  // With several studios on one machine a capture sometimes waits anyway, so it is asked again after 20s.
  for (let attempt = 1; ; attempt++) {
    await app.cdp("Page.bringToFront");
    await app.evaluate("new Promise((r) => requestAnimationFrame(() => r(true)))");
    const shot = await Promise.race([
      app.cdp<{ data: string }>("Page.captureScreenshot", { format: "png", ...(clip !== undefined ? { captureBeyondViewport: beyond, clip: { ...clip, scale: 1 } } : {}) }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000)),
    ]);
    if (shot !== undefined) {
      const bytes = Buffer.from(shot.data, "base64");
      const png = PNG.sync.read(bytes);
      // The capture as it came, for a picture that is kept as it is: encoding it again is a second apiece.
      AS_CAPTURED.set(png, bytes);
      return png;
    }
    if (attempt === 3) throw new Error("the window drew no frame to capture in a minute");
  }
}

/**
 * Every run of text under `root`, where it is drawn: its words and its box, relative to the root.
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

const boxes = (selector: string, origin = "{ x: 0, y: 0 }", name = `e.getAttribute("data-island")`): string =>
  `(() => { const o = ${origin}; return [...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => { const b = e.getBoundingClientRect(); return { name: ${name}, x: b.x - o.x, y: b.y - o.y, width: b.width, height: b.height }; }); })()`;
/** The desktop page's editors, each named by what it is. */
const domIslands = (origin?: string): string => boxes(DOM_ISLANDS, origin, `e.tagName === "IFRAME" ? "frame" : e.className.split(" ")[0]`);

/** The window a picture was taken in: its size in CSS pixels, and the picture's pixels to each of them. */
interface Win {
  width: number;
  height: number;
  scale: number;
}
const sameWindow = (a: Win, b: Win): boolean => a.width === b.width && a.height === b.height && a.scale === b.scale;
/** The scale is the picture's own: `devicePixelRatio` reads 2 in a studio whose pictures come out at 1.5. */
const windowOf = async (app: App, picture: PNG, across?: number): Promise<Win> => {
  const size = await app.evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })");
  return { ...size, scale: round(picture.width / (across ?? size.width)) };
};

/**
 * A reference picture's manifest: what a comparison needs of the desktop's page once that page is not
 * there to ask — where its regions were, where its words were, the window and the world it was taken in.
 */
interface Golden {
  kind: "scene" | "specimen";
  name: string;
  look: string;
  /** The world a scene was photographed in (its parked task's id): another world draws other ids and times. A specimen has none. */
  seed: string | null;
  window: Win;
  /** The picture, in its own pixels. */
  picture: { width: number; height: number };
  /** A scene's regions, in CSS pixels of the page. */
  regions?: Record<string, Rect>;
  /** A specimen's box on its page. */
  box?: Rect;
  /** The desktop page's editors ({@link DOM_ISLANDS}): a scene's in page coordinates, a specimen's relative to its box. */
  islands: Island[];
  /** What the world keeps changing ({@link VOLATILE}), in the picture's CSS pixels: painted out of a comparison. */
  volatile: Island[];
  /** Every run of text, as `--texts` reports them. */
  texts: Run[];
  takenAt: string;
}

/** A scene's folder is its name; a specimen's is `specimen-<name>`, as its pictures are named — some share a name with a scene. */
const goldenPath = (kind: Golden["kind"], name: string, look: string, ext: "png" | "json"): string => join(GOLDENS, kind === "specimen" ? `specimen-${name}` : name, `${look}.${ext}`);
const round = (n: number): number => Math.round(n * 100) / 100;
const roundRect = <T extends Rect>(r: T): T => ({ ...r, x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) });
const roundRuns = (runs: readonly Run[]): Run[] => runs.map((r) => ({ text: r.text, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));

function readGolden(kind: Golden["kind"], name: string, look: string): { golden: Golden; png: PNG } | undefined {
  if (!existsSync(goldenPath(kind, name, look, "png")) || !existsSync(goldenPath(kind, name, look, "json"))) return undefined;
  return { golden: JSON.parse(readFileSync(goldenPath(kind, name, look, "json"), "utf8")) as Golden, png: PNG.sync.read(readFileSync(goldenPath(kind, name, look, "png"))) };
}

/** What was frozen this run, for the index over the whole set (`manifest.json`). */
const frozen: Golden[] = [];
/**
 * What a `--verify` found: pictures that came out the same to the pixel, the same but for the log's
 * counts, the same but for the inside of an editor (Monaco draws a deleted line with the token colours it
 * has when the diff arrives, which is a race the page does not decide) — and those that did not.
 */
const reproduced = { same: 0, eye: [] as string[], world: [] as string[], editor: [] as string[], not: [] as string[] };

/**
 * Keep a picture of the desktop's page — or, with `--verify`, hold a fresh one against the one kept and
 * say whether it reproduces: the same pixels, the same boxes, the same words in the same places.
 */
function keep(golden: Golden, png: PNG): void {
  const base = `${golden.kind === "specimen" ? "specimen-" : ""}${golden.name}-${golden.look}`;
  if (!flag("--verify")) {
    mkdirSync(dirname(goldenPath(golden.kind, golden.name, golden.look, "png")), { recursive: true });
    writeFileSync(goldenPath(golden.kind, golden.name, golden.look, "png"), AS_CAPTURED.get(png) ?? PNG.sync.write(png));
    writeFileSync(goldenPath(golden.kind, golden.name, golden.look, "json"), JSON.stringify(golden));
    frozen.push(golden);
    console.log(`${base}: frozen  (${png.width}×${png.height}${golden.islands.length > 0 ? `, editors: ${golden.islands.map((i) => i.name).join(", ")}` : ""})`);
    return;
  }
  const kept = readGolden(golden.kind, golden.name, golden.look);
  if (kept === undefined) {
    reproduced.not.push(base);
    console.log(`${base}: NO GOLDEN to reproduce`);
    return;
  }
  const said: string[] = [];
  /** Differs only where it may: by a level here and there, in the log's counts, or inside an editor. */
  let but: "eye" | "world" | "editor" | undefined;
  let note = "";
  if (kept.golden.seed !== golden.seed) said.push(`another world (${kept.golden.seed} then, ${golden.seed} now)`);
  if (!sameWindow(kept.golden.window, golden.window)) said.push(`another window (${JSON.stringify(kept.golden.window)} then, ${JSON.stringify(golden.window)} now)`);
  const volatile = [...kept.golden.volatile, ...golden.volatile];
  const editors = [...kept.golden.islands, ...golden.islands];
  if (kept.png.width !== png.width || kept.png.height !== png.height) said.push(`the picture is ${png.width}×${png.height}, was ${kept.png.width}×${kept.png.height}`);
  else {
    const px = pixelmatch(kept.png.data, png.data, undefined, png.width, png.height, { threshold: 0, includeAA: true });
    if (px > 0) {
      // Whose doing: with the log's counts painted out of both, then the desktop's editors, what is left is the page's own.
      const [a, b] = [PNG.sync.read(PNG.sync.write(kept.png)), PNG.sync.read(PNG.sync.write(png))];
      for (const v of volatile) for (const p of [a, b]) mask(p, v, golden.window.scale);
      const settled = differ(a, b);
      for (const i of editors) for (const p of [a, b]) mask(p, i, golden.window.scale);
      const outside = differ(a, b);
      if (settled.exact === 0) [but, note] = ["world", `${px} px in the log's counts`];
      else if (outside.exact === 0) [but, note] = ["editor", `${settled.exact} px inside ${[...new Set(editors.map((i) => i.name))].join(", ")}`];
      // Nothing an eye can see: a pixel a level off (the grading's own "identical to the eye").
      else if (outside.differing === 0) [but, note] = ["eye", `${outside.exact} px a level off`];
      else said.push(`${outside.exact} px differ outside its editors and the log's counts (${outside.differing} of them to the eye; ${px} in all)`);
      differ(kept.png, png, join(OUT, `${base}.refreeze.diff.png`));
      writeFileSync(join(OUT, `${base}.refreeze.png`), PNG.sync.write(png));
    }
  }
  const regions = JSON.stringify(kept.golden.regions ?? kept.golden.box) === JSON.stringify(golden.regions ?? golden.box);
  if (!regions) said.push(`its boxes moved (${JSON.stringify(kept.golden.regions ?? kept.golden.box)} then, ${JSON.stringify(golden.regions ?? golden.box)} now)`);
  // Which words moved, where the picture itself did not reproduce: the ones in it, but for those the log
  // or an editor draws (and a line's breadth round each of those boxes). What a picture reproduces by is
  // its pixels — the words under a scroller's edge or off to one side of a track are not in it, and may
  // be a clock ("checked 1 s ago") or the log's older lines.
  if (said.length > 0) {
    const frame = golden.box !== undefined ? { width: golden.box.width, height: golden.box.height } : golden.window;
    const near = 24;
    const apart = (t: Run): boolean =>
      t.x + t.w > 0 &&
      t.y + t.h > 0 &&
      t.x < frame.width &&
      t.y < frame.height &&
      ![...volatile, ...editors].some((r) => t.x + t.w > r.x - near && t.x < r.x + r.width + near && t.y + t.h > r.y - near && t.y < r.y + r.height + near);
    const moved = compareTexts(kept.golden.texts.filter(apart), golden.texts.filter(apart));
    if (moved.length > 0) said.push(`${moved.length} runs of text moved:\n${moved.slice(0, 12).join("\n").replace(/on rn/g, "now")}`);
  }
  if (said.length > 0) {
    reproduced.not.push(base);
    console.log(`${base}: DOES NOT REPRODUCE — ${said.join("; ")}`);
  } else if (but !== undefined) {
    reproduced[but].push(base);
    console.log(`${base}: reproduces, but for ${note}`);
  } else {
    reproduced.same++;
    console.log(`${base}: reproduces`);
  }
}

/** The index over the set: every picture kept, the world and window each was taken in. Merged, so a freeze of a few leaves the rest. */
function writeManifest(): void {
  if (frozen.length === 0) return;
  const path = join(GOLDENS, "manifest.json");
  type Index = { pictures: Record<string, { kind: string; seed: string | null; window: Win; looks: Record<string, { picture: Golden["picture"]; takenAt: string }> }> };
  const index: Index = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Index) : { pictures: {} };
  for (const g of frozen) {
    const entry = (index.pictures[g.kind === "specimen" ? `specimen-${g.name}` : g.name] ??= { kind: g.kind, seed: g.seed, window: g.window, looks: {} });
    // A picture frozen again in another world or window: its other looks were of the old one, and are no longer said to be there.
    if (entry.seed !== g.seed || !sameWindow(entry.window, g.window)) Object.assign(entry, { seed: g.seed, window: g.window, looks: {} });
    entry.looks[g.look] = { picture: g.picture, takenAt: g.takenAt };
  }
  writeFileSync(path, JSON.stringify(index, null, 1));
}

/**
 * A page reached and photographed undisturbed, or tried again. The dev server is every studio's: a file
 * another copier saves reloads this window's page under whatever scene it was in the middle of, or fails
 * to ("[vite] Failed to reload", "Error loading route") and leaves it half drawn — and the picture is
 * then of the board, or of nothing. Three tries, a few seconds apart; then whatever the last one said.
 */
async function undisturbed<T>(app: App, what: string, attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    const before = app.complaints.length;
    let threw: unknown;
    try {
      const result = await attempt();
      if (n === 3 || !app.complaints.slice(before).some((c) => /\[vite\]|Error loading route|dynamically imported module/.test(c))) return result;
    } catch (e) {
      if (n === 3) throw e;
      threw = e;
    }
    console.log(`  (${what}: ${threw instanceof Error ? threw.message : "the dev server failed a module under it"}; again)`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/**
 * A scene reached on `path` and held still — on the page it began on: `performance.timeOrigin` is the
 * document's, so one that changed between the scene's first step and its last is a page reloaded.
 */
async function reach(app: App, path: string, to: { look?: Look; scene: Scene }): Promise<void> {
  let began = 0;
  const marked: Scene = {
    ...to.scene,
    reach: async (a) => {
      began = await a.evaluate<number>("performance.timeOrigin");
      await to.scene.reach(a);
    },
  };
  await goTo(app, path, { ...to, scene: marked });
  await scrollTo(app);
  await app.settled();
  if (began !== (await app.evaluate<number>("performance.timeOrigin"))) throw new Disturbed("the page was reloaded under the scene");
}

/** One page of a specimen: its box, its picture, its words; and on `/specimen-rn` its islands, on `/specimen-dom` its editors. */
interface SpecimenShot {
  png: PNG;
  box: Rect;
  texts: Run[];
  islands: Island[];
  window: Win;
}

const specimenShot = (app: App, origin: string, name: string, look: Look, side: "dom" | "rn"): Promise<SpecimenShot> =>
  undisturbed(app, `${name} on /specimen-${side}`, () => specimenPage(app, origin, name, look, side));

async function specimenPage(app: App, origin: string, name: string, look: Look, side: "dom" | "rn"): Promise<SpecimenShot> {
  // Wherever the last scene left the pointer, a specimen under it would be drawn hovered.
  await app.pointer(2, 2);
  await app.navigate(`${origin}/specimen-${side}?name=${encodeURIComponent(name)}&look=${lookName(look)}`);
  // Patiently: the shared dev server rebuilds a page's graph after an edit anywhere in it.
  await app.until("document.getElementById('specimen') !== null", `the ${side} specimen to draw`, 400);
  const loaded = await app.evaluate<number>("performance.timeOrigin");
  await app.evaluate("document.fonts.ready.then(() => true)");
  // Until it holds still: an editor is a lazy chunk, and the page that asks first waits longest for it.
  if (!(await app.settled(`document.getElementById("specimen")`))) console.log(`  (the ${side} specimen never held still: photographed as it was)`);
  if (loaded !== (await app.evaluate<number>("performance.timeOrigin"))) throw new Disturbed("the page was reloaded under the specimen");
  const box = await app.evaluate<Rect>(`(() => { const r = document.getElementById("specimen").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const islands = await app.evaluate<Island[]>(side === "rn" ? boxes("#specimen [data-island]", JSON.stringify(box)) : domIslands(JSON.stringify(box)));
  const runs = await app.evaluate<Run[]>(texts(`document.getElementById("specimen")`));
  // Beyond the window only where it must be: that capture lays the page out again as tall as it is, and
  // what is sized by the window's height (a dialog capped at 90vh, whose reviewer scrolls) is then drawn
  // otherwise than it was measured — the island's box 10px short of the island in the picture.
  const fits = await app.evaluate<boolean>(`${box.x} >= 0 && ${box.y} >= 0 && ${box.x + box.width} <= innerWidth && ${box.y + box.height} <= innerHeight`);
  const png = await capture(app, box, !fits);
  return { png, box, texts: runs, islands, window: await windowOf(app, png, box.width) };
}

/** A specimen's two pictures graded: the copy's islands painted out of both, as a scene's are. */
function gradeSpecimen(base: string, dom: Pick<SpecimenShot, "png" | "box" | "texts">, rn: SpecimenShot): boolean {
  const size = (b: Rect): string => `${round(b.width)}×${round(b.height)}`;
  for (const island of rn.islands) for (const png of [dom.png, rn.png]) mask(png, island, rn.png.width / rn.box.width);
  const moved = compareTexts(dom.texts, rn.texts);
  const left = rn.islands.length > 0 ? `  (islands left out: ${rn.islands.map((i) => i.name).join(", ")})` : "";
  writeFileSync(join(OUT, `${base}.dom.png`), PNG.sync.write(dom.png));
  writeFileSync(join(OUT, `${base}.rn.png`), PNG.sync.write(rn.png));
  let failed: boolean;
  if (dom.png.width !== rn.png.width || dom.png.height !== rn.png.height) {
    failed = true;
    const common = { x: 0, y: 0, width: Math.min(dom.png.width, rn.png.width), height: Math.min(dom.png.height, rn.png.height) };
    const d = differ(crop(dom.png, common, 1)!, crop(rn.png, common, 1)!, join(OUT, `${base}.diff.png`));
    results.push({ of: base, part: "specimen", grade: "size", differing: d.differing, exact: d.exact, note: `dom ${size(dom.box)}, rn ${size(rn.box)}` });
    console.log(`${base}: DIFFERENT SIZE (dom ${size(dom.box)}, rn ${size(rn.box)}); over the common part ${verdict(d)}${left}`);
  } else {
    const d = differ(dom.png, rn.png, join(OUT, `${base}.diff.png`));
    failed = d.differing !== 0;
    noted(base, "specimen", d);
    console.log(`${base}: ${verdict(d)}  (${size(dom.box)})${left}`);
  }
  if (moved.length > 0) console.log(`  text that moved (rn − dom):\n${moved.join("\n")}`);
  return failed;
}

const specimenGolden = (name: string, look: Look, dom: SpecimenShot): Golden => ({
  kind: "specimen",
  name,
  look: lookName(look),
  seed: null,
  window: dom.window,
  picture: { width: dom.png.width, height: dom.png.height },
  box: roundRect(dom.box),
  islands: dom.islands.map(roundRect),
  volatile: [],
  texts: roundRuns(dom.texts),
  takenAt: new Date().toISOString(),
});

/**
 * A specimen (`--specimen markdown`): one component drawn from a fixture on `/specimen-dom` and its copy
 * on `/specimen-rn` (`packages/client/src/specimens/registry.tsx`), photographed and compared — the gate
 * for a leaf, with no world to seed and no scene to reach.
 */
async function specimen(app: App, origin: string, name: string, looks: readonly Look[]): Promise<boolean> {
  let failed = false;
  for (const look of looks) {
    const base = `specimen-${name}-${lookName(look)}`;
    if (MODE === "freeze") {
      const dom = await specimenShot(app, origin, name, look, "dom");
      keep(specimenGolden(name, look, dom), dom.png);
      continue;
    }
    let dom: Pick<SpecimenShot, "png" | "box" | "texts">;
    if (MODE === "goldens") {
      const kept = readGolden("specimen", name, lookName(look));
      if (kept === undefined) {
        failed = true;
        results.push({ of: base, part: "specimen", grade: "no golden" });
        console.log(`${base}: NO GOLDEN — freeze it: pair.mts --freeze --specimen ${name}`);
        continue;
      }
      dom = { png: kept.png, box: kept.golden.box!, texts: kept.golden.texts };
      const rn = await specimenShot(app, origin, name, look, "rn");
      if (!sameWindow(kept.golden.window, rn.window)) throw new Error(`${base}: the golden was taken in another window (${JSON.stringify(kept.golden.window)}; this one is ${JSON.stringify(rn.window)}) — freeze it again, or give the studio's window that size`);
      if (gradeSpecimen(base, dom, rn)) failed = true;
      continue;
    }
    const shot = await specimenShot(app, origin, name, look, "dom");
    if (KEEPING) keep(specimenGolden(name, look, shot), shot.png);
    dom = shot;
    const rn = await specimenShot(app, origin, name, look, "rn");
    if (gradeSpecimen(base, dom, rn)) failed = true;
  }
  return failed;
}

/** The desktop's page of a scene, or its frozen picture: what the copy's page is held against. */
interface DomScene {
  png: PNG;
  window: Win;
  regions: Record<string, Rect>;
  texts: Run[];
  /** What to paint out of both pictures besides the copy's islands ({@link VOLATILE}); none in a plain comparison against `/`. */
  volatile: Island[];
}

/** The world the studio is open on, by the task its seed parked: what tells one seeding from another. */
async function seedOf(app: App): Promise<string> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const tasks = await app.ipc<Array<{ title: string; taskId: string }>>("task:list", project !== undefined ? { project } : {});
  return tasks.find((t) => t.title === PARKED)?.taskId ?? "no parked task";
}

async function scene(app: App, scene: Scene, look: Look, seed: string): Promise<boolean> {
  const only = arg("--region");
  const stem = `${scene.name}${arg("--scroll-to") !== undefined ? `@${arg("--scroll-to")!.replace(/[^a-z0-9]+/gi, "_")}` : ""}`;
  const name = `${stem}-${lookName(look)}`;
  let failed = false;
  let dom: DomScene;
  if (MODE === "goldens") {
    const kept = readGolden("scene", stem, lookName(look));
    const why = kept === undefined ? "NO GOLDEN" : kept.golden.seed !== seed ? `the golden was taken in another world (its parked task was ${kept.golden.seed}, this studio's is ${seed})` : undefined;
    if (kept === undefined || why !== undefined) {
      results.push({ of: name, part: "window", grade: "no golden" });
      console.log(`${name}: ${why} — freeze it: pair.mts --freeze --scene ${scene.name}`);
      return true;
    }
    dom = { png: kept.png, window: kept.golden.window, regions: kept.golden.regions ?? {}, texts: kept.golden.texts, volatile: kept.golden.volatile };
  } else {
    await undisturbed(app, `${name} on /`, () => reach(app, "/", { look, scene }));
    const regions: Record<string, Rect> = {};
    for (const [region, selector] of Object.entries(REGIONS)) {
      const r = await app.evaluate<Rect | null>(
        // A float is the last of its kind on the page: floats are appended to <body>, after everything.
        `(() => { const e = ${region === "float" ? `[...document.querySelectorAll(${JSON.stringify(selector)})].pop()` : `document.querySelector(${JSON.stringify(selector)})`}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      );
      if (r !== null && r.width > 0 && r.height > 0) regions[region] = r;
    }
    const runs = KEEPING || flag("--texts") ? await app.evaluate<Run[]>(texts("document.body")) : [];
    const islands = KEEPING ? await app.evaluate<Island[]>(domIslands()) : [];
    const volatile = KEEPING || flag("--mask-volatile") ? await app.evaluate<Island[]>(VOLATILE) : [];
    const png = await capture(app);
    const window = await windowOf(app, png);
    dom = { png, window, regions, texts: runs, volatile: MODE === "freeze" || flag("--mask-volatile") ? volatile : [] };
    if (KEEPING) {
      keep(
        {
          kind: "scene",
          name: stem,
          look: lookName(look),
          seed,
          window,
          picture: { width: dom.png.width, height: dom.png.height },
          regions: Object.fromEntries(Object.entries(regions).map(([k, r]) => [k, roundRect(r)])),
          islands: islands.map(roundRect),
          volatile: volatile.map(roundRect),
          texts: roundRuns(runs),
          takenAt: new Date().toISOString(),
        },
        dom.png,
      );
      if (MODE === "freeze") return false;
    }
  }
  // A scene is reached by what the page draws ("Awaiting you", a card's title), so on `/rn` it can
  // only be reached once the copies draw those. Until then the picture is of wherever it stopped.
  let unreached: string | undefined;
  try {
    await undisturbed(app, `${name} on /rn`, () => reach(app, "/rn", MODE === "goldens" ? { look, scene } : { scene }));
  } catch (e) {
    unreached = (e as Error).message;
  }
  // The native path must not have been helped: no rule of `styles.css` on the page.
  const helped = await app.evaluate<boolean>(
    `[...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === ".sidebar" || r.selectorText === ".card"); } catch { return false; } })`,
  );
  if (helped) throw new Error("styles.css is on the /rn page: it would draw what the copies should");
  const islands = await app.evaluate<Island[]>(boxes("[data-island]"));
  const uncopied = await app.evaluate<string[]>(`[...document.querySelectorAll("[data-testid^=uncopied-]")].map((e) => e.getAttribute("data-testid").slice(9))`);
  const rnRuns = flag("--texts") ? await app.evaluate<Run[]>(texts("document.body")) : [];
  const rn = await capture(app);
  const window = await windowOf(app, rn);
  if (!sameWindow(window, dom.window)) throw new Error(`${name}: the golden was taken in another window (${JSON.stringify(dom.window)}; this one is ${JSON.stringify(window)}) — freeze it again, or give the studio's window that size`);
  // Islands (Monaco, CodeMirror) are the desktop's own components by construction, and on `/rn`
  // they stand without the stylesheet the phone's island page brings: painted out of both pictures.
  const scale = dom.png.width / window.width;
  for (const r of [...islands, ...dom.volatile]) for (const png of [dom.png, rn]) mask(png, r, scale);
  writeFileSync(join(OUT, `${name}.dom.png`), PNG.sync.write(dom.png));
  writeFileSync(join(OUT, `${name}.rn.png`), PNG.sync.write(rn));
  console.log(`${name}${uncopied.length > 0 ? `  (not copied yet: ${uncopied.join(", ")})` : ""}${islands.length > 0 ? `  (islands left out: ${islands.map((i) => i.name).join(", ")})` : ""}${dom.volatile.length > 0 ? `  (the log's left out: ${[...new Set(dom.volatile.map((v) => v.name))].join(", ")})` : ""}`);
  if (unreached !== undefined) {
    failed = true;
    results.push({ of: name, part: "window", grade: "unreached", note: unreached });
    console.log(`  the scene could not be reached on /rn: ${unreached}`);
  }
  const whole = only === undefined && dom.png.width === rn.width && dom.png.height === rn.height ? differ(dom.png, rn, join(OUT, `${name}.diff.png`)) : undefined;
  if (whole !== undefined) {
    noted(name, "window", whole);
    console.log(`  window   ${verdict(whole)}`);
  }
  for (const [region, r] of Object.entries(dom.regions)) {
    if (only !== undefined && region !== only) continue;
    const [a, b] = [crop(dom.png, r, scale), crop(rn, r, scale)];
    // Measured on the page, and wholly below the window: there is no picture of it to compare.
    if (a === undefined || b === undefined) continue;
    const d = differ(a, b, join(OUT, `${name}.${region}.diff.png`));
    writeFileSync(join(OUT, `${name}.${region}.dom.png`), PNG.sync.write(a));
    writeFileSync(join(OUT, `${name}.${region}.rn.png`), PNG.sync.write(b));
    noted(name, region, d);
    console.log(`  ${region.padEnd(8)} ${verdict(d)}  (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)})`);
    if (flag("--texts") && d.differing !== 0) {
      // Which words moved, of those the desktop draws inside this region (page coordinates).
      const inside = (t: Run): boolean => t.x + t.w > r.x && t.x < r.x + r.width && t.y + t.h > r.y && t.y < r.y + r.height;
      const moved = compareTexts(dom.texts.filter(inside), rnRuns.filter(inside));
      if (moved.length > 0) console.log(`    text that moved (rn − dom):\n${moved.map((m) => `  ${m}`).join("\n")}`);
    }
    if (d.differing !== 0) failed = true;
  }
  return failed;
}

/**
 * `--same-as`: this run's verdicts against an earlier run's, part by part. The gate for the goldens is
 * that `/rn` against them says what `/rn` against `/` says — identical where that was identical, the
 * same pixels differing where it differed.
 */
function sameAs(path: string): boolean {
  const then = new Map((JSON.parse(readFileSync(path, "utf8")) as Result[]).map((r) => [`${r.of} ${r.part}`, r]));
  const said = (r: Result | undefined): string => (r === undefined ? "—" : r.grade === "differ" || r.grade === "size" ? `${r.grade} ${r.differing}${r.note !== undefined ? ` (${r.note})` : ""}` : r.grade === "eye" ? `eye ${r.exact}` : r.grade);
  let same = 0;
  /** Of those not the same: the same grade, with another count of pixels. */
  let near = 0;
  const rows: string[] = [];
  for (const now of results) {
    const was = then.get(`${now.of} ${now.part}`);
    then.delete(`${now.of} ${now.part}`);
    // The same verdict: the same grade, and where pixels differ to the eye, the same number of them.
    if (was !== undefined && was.grade === now.grade && (now.grade === "identical" || now.grade === "eye" || was.differing === now.differing) && was.note === now.note) same++;
    else {
      if (was?.grade === now.grade) near++;
      rows.push(`  ${`${now.of} ${now.part}`.padEnd(64)} ${said(was).padEnd(34)} ${said(now)}`);
    }
  }
  for (const [key, was] of then) rows.push(`  ${key.padEnd(64)} ${said(was).padEnd(34)} —`);
  console.log(`against ${path}: ${same} of ${results.length} verdicts the same${rows.length > 0 ? `; ${rows.length} not, ${near} of them the same grade with another count (then | now):\n${rows.join("\n")}` : ""}`);
  return rows.length === 0;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const app = await App.connect(Number(arg("--port") ?? STUDIO_PORT), { out: OUT });
  let failed = false;
  try {
    // A window that last loaded while the shared dev server was down is on Chromium's error page, and
    // every page after it would be asked of that: back to the server a studio loads from.
    if ((await app.evaluate<string>("location.protocol")) === "chrome-error:") await app.navigate(arg("--pages") ?? "http://127.0.0.1:8081/");
    const origin = await app.evaluate<string>("location.protocol + '//' + location.host");
    const names = (given: string | undefined): string[] | undefined => given?.split(",").map((s) => s.trim()).filter((s) => s !== "");
    // Nothing named: a comparison is of the board, as it always was; a freeze, or a run against the
    // frozen set, is of everything.
    const everything = flag("--all") || (MODE !== "pair" && arg("--scene") === undefined && arg("--specimen") === undefined);
    const wanted = names(arg("--scene")) ?? (everything ? ["all"] : arg("--specimen") === undefined ? ["board"] : []);
    const scenes = wanted.flatMap((w) => {
      if (w === "all") return SCENES;
      if (w === "main") return SCENES.filter((s) => s.everyLook === true);
      const found = SCENES.find((s) => s.name === w);
      if (found === undefined) throw new Error(`no scene ${w}: ${SCENES.map((s) => s.name).join(", ")}`);
      return [found];
    });
    let specimens = names(arg("--specimen")) ?? (everything ? ["all"] : []);
    if (specimens.includes("all")) {
      // The registry is the page's (it imports the renderer): a specimen page with no name lists them.
      // (With a query of its own: from a specimen's page, the bare path is not a new document.)
      await app.navigate(`${origin}/specimen-dom?names`);
      await app.until("document.getElementById('specimens') !== null", "the specimen page to list its specimens", 400);
      specimens = JSON.parse(await app.evaluate<string>("document.getElementById('specimens').dataset.names")) as string[];
    }
    // Every look for a freeze, unless one is named; the light look for a comparison, unless more are asked for.
    const looks: readonly Look[] = flag("--every-look") || (MODE === "freeze" && arg("--look") === undefined) ? LOOKS : [parseLook(arg("--look") ?? "light")];
    const seed = scenes.length > 0 ? await seedOf(app) : "";
    // One that cannot be photographed (a scene that will not be reached on the desktop's page, a page that
    // throws) is said and counted, and the rest go on: a run of several hundred is not lost to one.
    const each = async (what: string, run: () => Promise<boolean>): Promise<void> => {
      try {
        if (await run()) failed = true;
      } catch (e) {
        failed = true;
        results.push({ of: what, part: "window", grade: "unreached", note: (e as Error).message.slice(0, 200) });
        if (MODE === "freeze") reproduced.not.push(what);
        console.log(`${what}: COULD NOT BE PHOTOGRAPHED — ${(e as Error).message.slice(0, 300)}`);
      }
    };
    for (const look of looks) for (const s of scenes) await each(`${s.name}-${lookName(look)}`, () => scene(app, s, look, seed));
    for (const s of specimens) for (const look of looks) await each(`specimen-${s}-${lookName(look)}`, () => specimen(app, origin, s, [look]));
  } finally {
    await app.close();
    if (MODE === "freeze") writeManifest();
  }
  const verified = (): void => {
    const all = reproduced.same + reproduced.eye.length + reproduced.world.length + reproduced.editor.length + reproduced.not.length;
    console.log(`${all - reproduced.not.length} of ${all} goldens reproduce: ${reproduced.same} to the pixel, ${reproduced.eye.length} to the eye, ${reproduced.world.length} but for the log's counts, ${reproduced.editor.length} but for the inside of an editor${reproduced.editor.length > 0 ? ` (${reproduced.editor.join(", ")})` : ""}${reproduced.not.length > 0 ? `; ${reproduced.not.length} do not: ${reproduced.not.join(", ")}` : ""}`);
    if (reproduced.not.length > 0) failed = true;
  };
  if (MODE === "freeze") {
    if (flag("--verify")) verified();
    else {
      const lost = results.filter((r) => r.grade === "unreached").map((r) => r.of);
      console.log(`froze ${frozen.length} pictures in ${GOLDENS}${lost.length > 0 ? `; ${lost.length} could not be photographed: ${lost.join(", ")}` : ""}`);
    }
  } else {
    if (results.length > 3) {
      const count = (grade: string): number => results.filter((r) => r.grade === grade).length;
      console.log(`${results.length} comparisons: ${count("identical")} identical, ${count("eye")} identical to the eye, ${count("differ")} differ, ${count("size")} of another size${count("unreached") > 0 ? `, ${count("unreached")} not reached` : ""}${count("no golden") > 0 ? `, ${count("no golden")} with no golden` : ""}`);
    }
    const report = arg("--report");
    if (report !== undefined) writeFileSync(report, JSON.stringify(results, null, 1));
    const held = arg("--same-as");
    if (held !== undefined && !sameAs(held)) failed = true;
    if (KEEPING) verified();
  }
  console.log(`wrote ${MODE === "freeze" && !flag("--verify") ? GOLDENS : OUT}`);
  if (failed) process.exitCode = 1;
}

await main();
