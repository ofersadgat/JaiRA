/**
 * The app's page against its reference pictures (decision 0015): a scene or a specimen is photographed
 * and graded against the picture of the same name in `shots/goldens` — region by region, at the places
 * the reference page's regions stood.
 *
 *   npx tsx packages/app/shots/pair.mts [--scene board|task|gate|archived|settings|files|chat|logs|…] [--look light|dark|<palette>[-wash]-<theme>]
 *                                       [--every-look] [--region sidebar] [--port 9301]
 *   npx tsx packages/app/shots/pair.mts --specimen markdown [--look …] [--every-look]   one component, from a fixture
 *   --scene a,b | all | main   several scenes, every scene, or the ones photographed in every look
 *   --specimen a,b | all       several specimens, or every one the registry names
 *   --all                      every scene and every specimen
 *   --changed [<git-ref>]      the scenes and specimens a change can reach, light (see "What a change reaches")
 *   --scroll-to <heading>   the page scrolled so that heading tops its scroller, for a long page (a golden of its own: `<scene>@<heading>`)
 *   --texts   with a region: list the words that moved, and by how much (a specimen always does)
 *   --report <file.json>    what each comparison said, for a later run to be held against
 *   --same-as <file>        hold this run against an earlier one: its `--report`, or what it printed, saved as text
 *                           (the tag's `--against-goldens` output reads the same) — every verdict the same, or which are not
 *   --goldens <dir>         where the reference pictures are kept (`shots/goldens`)
 *   --out <dir>             where this run's pictures and diffs land (`shots/parity/rn-<port>`)
 *
 * ## The reference pictures
 *
 * They are of the desktop's DOM renderer, which decision 0015 copied into the universal tree and then
 * deleted: taken from the commit tagged `dom-renderer-final`, in the world kept at `shots/.world-goldens`
 * (a studio on it: `studio.mts --goldens-world`). Each is `<scene>/<look>.png` or
 * `specimen-<name>/<look>.png`, with a `<look>.json` of what a comparison needs of the page it was taken
 * from: where its regions stood, every run of text, what the world keeps changing (the log's counts,
 * painted out of both pictures), the window, and the world. A scene's golden is of ONE world (the parked
 * task's id is the world's name: another seeding draws other ids and times), so scenes are compared in a
 * studio on that world; a specimen has no world and is compared from any studio.
 *
 *   --accept   for what has NO golden — a new scene, a new specimen: photograph the page and keep that
 *              picture as its golden, in every look (or `--look`). With nothing named it takes every
 *              scene and specimen that has none and leaves the rest alone; with `--scene a,b` or
 *              `--specimen a,b` it REPLACES those, golden or not — the page as it is now becomes the
 *              reference, so look at the pictures first. The manifest records that the picture was
 *              accepted from the universal page, and when.
 *   --freeze   is gone from this tree: there is no DOM page here to photograph (see {@link FROZEN_ELSEWHERE}).
 *
 * ## What a change reaches
 *
 * A golden taken (`--accept`) is recorded with the source files whose functions ran while its scene was
 * reached and photographed, or its specimen drawn: `goldens/coverage.json`, beside the manifest.
 * `--record-coverage` records only that, for the scenes and specimens named (all of them by default), with
 * no picture kept or graded. It is V8's own coverage over CDP, a function at a time; a module's top level,
 * and whatever a page runs while its modules load, is no part of it (see {@link Recorder}). Scripts map
 * back to files only as the DEV SERVER serves them, a module per file — the built client is bundled, with
 * no sourcemaps — so coverage is recorded from a studio without `--built`.
 *
 *   --changed [<git-ref>]   the files changed since the ref (by default the merge base with main, with the
 *                           working tree and what is not yet tracked), and every scene and specimen that ran
 *                           one; with them, a specimen whose own file in `specimens/` changed, and whatever
 *                           has no coverage recorded. A shared foundation ({@link FOUNDATIONS}) is under
 *                           every picture: the whole set; the specimen registry, every specimen. Light,
 *                           unless `--look` or `--every-look`. The
 *                           changed UI files that no recorded scene or specimen ran are listed: give one a
 *                           specimen, or name the scenes that draw it.
 *
 * Attaches to the app `studio.mts` keeps running, so a change to a component is in the next run with
 * no build. The page is the universal shell on the native token path, with no stylesheet of the app's
 * on it, so what matches, matches the way a phone would draw it; the emulator is the last check.
 *
 * Pictures and diffs land in `shots/parity/rn-<port>/`: `<name>.rn.png` is the page now,
 * `<name>.golden.png` the reference (both with the same boxes painted out), `<name>.diff.png` where
 * they differ; `shots/before-after.mts` holds one run's `.rn.png`s against another's, pixel for pixel.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { App } from "./driver.mjs";
import { GOLDENS_WORLD, LOOKS, PAGE, PARKED, SCENES, SPECIMEN_PAGE, STUDIO_PORT, goTo, lookName, parseLook, type Look, type Scene } from "./parityWorld.mjs";

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const flag = (name: string): boolean => process.argv.includes(name);
/** A studio of its own (`studio.mts --port`) writes its pictures apart, so two people never share a folder. */
const OUT = arg("--out") !== undefined ? resolve(arg("--out")!) : join(import.meta.dirname, "parity", arg("--port") === undefined ? "rn" : `rn-${arg("--port")}`);
/** The reference pictures: `<scene>/<look>.png` and `specimen-<name>/<look>.png`, each with a `<look>.json` beside it, and `manifest.json` over them all. */
const GOLDENS = arg("--goldens") ?? join(import.meta.dirname, "goldens");
/**
 * What this run does: the page against its goldens, the page's picture kept as the golden of what has
 * none, or (`--record-coverage`) only what each scene and specimen runs.
 */
const MODE: "compare" | "accept" | "record" = flag("--accept") ? "accept" : flag("--record-coverage") ? "record" : "compare";
/** The checkout, and the client the dev server serves its own files from (`/src/…`, `/app/…`, `/bridges/…`). */
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const CLIENT = join(ROOT, "packages", "client");

/** What `--freeze` (and its `--verify`) says now: the page the goldens are of is not in this tree. */
const FROZEN_ELSEWHERE = [
  "pair.mts --freeze cannot be run from this tree: the reference pictures are of the desktop's DOM page, which is not here any more.",
  "The reference pictures are taken from the commit tagged dom-renderer-final (a checkout of it: git worktree add ../JaiRA-2-dom dom-renderer-final), with its own pair.mts --freeze --goldens <this tree's goldens>",
  `  (this tree's goldens: ${GOLDENS}; the world they are taken in: ${GOLDENS_WORLD}, with that checkout's studio.mts --world <that folder> --built).`,
  "For a scene or specimen that is new since then, and so has no DOM original: pair.mts --accept --scene <name> | --specimen <name> keeps the universal page's picture as its golden.",
].join("\n");

/**
 * The shell's regions on the universal page, for a golden ACCEPTED from it: its landmarks and the one
 * test id the board carries. A golden taken from the DOM page has the regions that page's classes named
 * (`editor` and `float` among them, which nothing marks here), kept in its manifest; either way a
 * comparison reads them from the golden, never from the page it is grading.
 */
const REGIONS: Record<string, string> = {
  sidebar: '[role="navigation"]',
  titlebar: '[role="banner"]',
  board: '[data-testid="board-column"]',
  panel: '[role="complementary"]',
  inbox: '[role="contentinfo"]',
};

/**
 * What the world keeps changing under a kept picture: the log. The runtime writes to it at every page
 * load, so the counts on the sidebar's Logs row and the Settings row's count of things needing attention
 * (an error logged since puts one there) are never what they were when the golden was taken. A golden's
 * manifest holds these boxes as its page drew them, and a comparison paints them out of both pictures.
 *
 * This is how they are found on the universal page, for a golden accepted from it: the two rows by their
 * words in the sidebar, from the end of the word to the end of the row. The Logs room's own rows and the
 * needs-attention card's lines about the log have nothing to be found by here (the DOM page's goldens of
 * `logs` and `health-card` hold theirs); a new scene that draws them names them itself (`Scene.volatile`).
 */
const VOLATILE = `(() => {
  const out = [];
  const nav = document.querySelector('[role="navigation"]');
  if (nav === null) return out;
  const walk = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!["Logs", "Settings"].includes(n.textContent)) continue;
    const hit = n.parentElement.closest('button, a, [role="button"], [role="link"]');
    if (hit === null) continue;
    // The row is the box round the row's button, as tall as it and wider: the pills stand beside the button.
    const around = hit.parentElement;
    const row = around !== null && around !== nav && Math.abs(around.getBoundingClientRect().height - hit.getBoundingClientRect().height) < 1 ? around : hit;
    const range = document.createRange();
    range.selectNodeContents(n);
    const a = range.getBoundingClientRect(), b = row.getBoundingClientRect();
    if (b.right - a.right - 4 > 0 && b.height > 0) out.push({ name: n.textContent + " row", x: a.right + 4, y: b.y, width: b.right - a.right - 4, height: b.height });
  }
  return out;
})()`;

/** The dev server reloaded the page under a scene: somebody saved a file. The picture would be of the board. */
class Disturbed extends Error {}

type Rect = { x: number; y: number; width: number; height: number };
type Island = Rect & { name: string };

/** Paint a box out of a picture, the same on both, so it cannot count either way. */
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
 * which is longer than the window where something scrolls: the Components room's last dialog stands
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
 * two layouts never agreed to the sixty-fourth of a pixel (Chromium's layout units against React Native
 * Web's), nor did the stylesheet's floating-point `color-mix()` against a copy's 8-bit `rgba()`. What
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

/** What one comparison said, kept for `--report` and `--same-as`: two runs must say the same thing of every part. */
interface Result {
  /** `<scene>-<look>` or `specimen-<name>-<look>`, as the pictures are named. */
  readonly of: string;
  /** `window`, a region, or `specimen`. */
  readonly part: string;
  /** `identical`, `eye`, `differ`, `size` (a specimen of another size than its golden), `unreached`, `no golden`. */
  readonly grade: string;
  readonly differing?: number;
  readonly exact?: number;
  /** For `size`: the two sizes. */
  readonly note?: string;
}
const results: Result[] = [];
const gradeOf = (d: Graded): string => (d.exact === 0 ? "identical" : d.differing === 0 ? "eye" : "differ");
const noted = (of: string, part: string, d: Graded): void => void results.push({ of, part, grade: gradeOf(d), differing: d.differing, exact: d.exact });

/** `--scroll-to <heading>`: the page scrolled so that heading sits at the top of its scroller. */
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
 * Compared with the golden's, this says WHICH line moved and by how much — what a diff picture cannot say.
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

/** The page's runs of text against the golden's: each line is one that moved, went, or came, as `now − golden`. */
function compareTexts(golden: readonly Run[], now: readonly Run[]): string[] {
  const left = [...now];
  const out: string[] = [];
  for (const d of golden) {
    const i = left.findIndex((r) => r.text === d.text);
    if (i < 0) {
      out.push(`  missing now: "${d.text}"`);
      continue;
    }
    const r = left.splice(i, 1)[0]!;
    const f = (n: number): string => (Math.round(n * 100) / 100).toString();
    const moved = [["x", r.x - d.x], ["y", r.y - d.y], ["w", r.w - d.w], ["h", r.h - d.h]].filter(([, v]) => Math.abs(v as number) > 0.05);
    if (moved.length > 0) out.push(`  "${d.text}" at ${f(d.x)},${f(d.y)} ${f(d.w)}×${f(d.h)}: ${moved.map(([k, v]) => `${k} ${(v as number) > 0 ? "+" : ""}${f(v as number)}`).join(" ")}`);
  }
  for (const r of left) out.push(`  only now: "${r.text}"`);
  return out;
}

/** The page's islands (Monaco, CodeMirror, a frame — `[data-island]`), each named by what it is. */
const islandsOf = (selector: string, origin = "{ x: 0, y: 0 }"): string =>
  `(() => { const o = ${origin}; return [...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => { const b = e.getBoundingClientRect(); return { name: e.getAttribute("data-island"), x: b.x - o.x, y: b.y - o.y, width: b.width, height: b.height }; }); })()`;

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
 * A reference picture's manifest: what a comparison needs of the page it was taken from, which is not
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
  /**
   * The editors on the page it was taken from: the DOM page's (Monaco's host, CodeMirror's editor, a
   * frame), or an accepted picture's islands. A scene's in page coordinates, a specimen's relative to its
   * box. Kept for the record: a comparison paints out the islands of the page it photographs.
   */
  islands: Island[];
  /** What the world keeps changing ({@link VOLATILE}), in the picture's CSS pixels: painted out of a comparison. */
  volatile: Island[];
  /** Every run of text, as `--texts` reports them. */
  texts: Run[];
  takenAt: string;
  /** Absent: taken from the desktop's DOM page, at `dom-renderer-final`. `universal`: accepted from the universal page (`--accept`), at `takenAt`. */
  from?: "universal";
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

/** The index over the whole set (`manifest.json`): every picture kept, the world and window each was taken in. */
type Index = { pictures: Record<string, { kind: string; seed: string | null; window: Win; looks: Record<string, { picture: Golden["picture"]; takenAt: string; from?: "universal" }> }> };
const readIndex = (): Index => (existsSync(join(GOLDENS, "manifest.json")) ? (JSON.parse(readFileSync(join(GOLDENS, "manifest.json"), "utf8")) as Index) : { pictures: {} });

/** What was accepted this run, and what was left alone because it has a golden already. */
const accepted: Golden[] = [];
let alreadyKept = 0;

/**
 * The set an accepted picture joins: one window, and for scenes one world. A picture taken in another
 * would fail by name in every later comparison beside the rest, so it is refused here instead.
 */
function fitsTheSet(golden: Golden): void {
  const set = Object.entries(readIndex().pictures).filter(([key]) => key !== (golden.kind === "specimen" ? `specimen-${golden.name}` : golden.name));
  const other = set.find(([, p]) => !sameWindow(p.window, golden.window));
  if (other !== undefined) throw new Error(`the goldens were taken in another window (${JSON.stringify(other[1].window)}; this one is ${JSON.stringify(golden.window)}): accept it from a studio whose window is that size`);
  const world = set.find(([, p]) => p.kind === "scene" && p.seed !== null);
  if (golden.kind === "scene" && world !== undefined && world[1].seed !== golden.seed)
    throw new Error(`the scenes' goldens were taken in another world (its parked task is ${world[1].seed}, this studio's is ${golden.seed}): accept a scene from a studio on the goldens' world — studio.mts --goldens-world`);
}

/** Keep the page's picture as the golden: `--accept`. */
function accept(golden: Golden, png: PNG, replaced: Golden | undefined): void {
  fitsTheSet(golden);
  mkdirSync(dirname(goldenPath(golden.kind, golden.name, golden.look, "png")), { recursive: true });
  writeFileSync(goldenPath(golden.kind, golden.name, golden.look, "png"), AS_CAPTURED.get(png) ?? PNG.sync.write(png));
  writeFileSync(goldenPath(golden.kind, golden.name, golden.look, "json"), JSON.stringify(golden));
  accepted.push(golden);
  const base = `${golden.kind === "specimen" ? "specimen-" : ""}${golden.name}-${golden.look}`;
  const was = replaced === undefined ? "" : replaced.from === "universal" ? `, in place of the one accepted ${replaced.takenAt}` : ", IN PLACE OF THE ONE TAKEN FROM THE DOM PAGE";
  console.log(`${base}: accepted as its golden  (${png.width}×${png.height}${golden.islands.length > 0 ? `, islands: ${golden.islands.map((i) => i.name).join(", ")}` : ""}${was})`);
}

/** The index, with what was accepted merged in: a few accepted leaves the rest. */
function writeManifest(): void {
  if (accepted.length === 0) return;
  const index = readIndex();
  for (const g of accepted) {
    const entry = (index.pictures[g.kind === "specimen" ? `specimen-${g.name}` : g.name] ??= { kind: g.kind, seed: g.seed, window: g.window, looks: {} });
    // A picture accepted in another world or window: its other looks were of the old one, and are no longer said to be there.
    if (entry.seed !== g.seed || !sameWindow(entry.window, g.window)) Object.assign(entry, { seed: g.seed, window: g.window, looks: {} });
    entry.looks[g.look] = { picture: g.picture, takenAt: g.takenAt, from: "universal" };
  }
  writeFileSync(join(GOLDENS, "manifest.json"), JSON.stringify(index, null, 1));
}

/** What a scene or specimen ran (`coverage.json`), keyed as the manifest keys its pictures. */
type Coverage = { pictures: Record<string, { kind: Golden["kind"]; files: string[]; recordedAt: string; commit: string }> };
const COVERAGE = join(GOLDENS, "coverage.json");
const readCoverage = (): Coverage | undefined => (existsSync(COVERAGE) ? (JSON.parse(readFileSync(COVERAGE, "utf8")) as Coverage) : undefined);
const keyOf = (kind: Golden["kind"], name: string): string => (kind === "specimen" ? `specimen-${name}` : name);

type Taken = { result: Array<{ url: string; functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }> }> };

/**
 * The file in this checkout a script the page ran was served from, as the dev server serves them: the
 * client's own under its root (`/src/Remote.tsx`), every other package's by its path (`/@fs/C:/…`).
 * Not the server's own (`/@vite/client`), a pre-bundled dependency, a built file, or Electron's.
 */
function sourceOf(url: string, origin: string): string | undefined {
  if (!url.startsWith(`${origin}/`)) return undefined;
  const path = decodeURIComponent(url.slice(origin.length).replace(/[?#].*$/, ""));
  if (path.startsWith("/@") && !path.startsWith("/@fs/")) return undefined;
  const fs = path.startsWith("/@fs/") ? path.slice("/@fs".length) : undefined;
  const file = fs === undefined ? join(CLIENT, path) : /^\/[A-Za-z]:\//.test(fs) ? fs.slice(1) : fs;
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  return rel.startsWith("..") || /(^|\/)(node_modules|dist)\//.test(rel) || !existsSync(file) ? undefined : rel;
}

/**
 * What each scene and specimen runs, recorded over CDP: V8's precise coverage, binary and a function at
 * a time (`callCount: false, detailed: false`), started before the page is reached and taken after its
 * picture. A file is in a picture's list when one of its functions ran.
 *
 * Not its top level: every module the page imports runs that, so every file would be under every
 * picture. Nor what a page runs while its modules load (a `.map` at a module's top level, React Refresh's
 * registrations), taken once from the specimen page with nothing drawn on it (`?names`) and left out of
 * every list. A file whose only code runs as it loads (a table of constants, the generated tokens) is so
 * under no picture: `--changed` says so of it, and {@link FOUNDATIONS} names the ones under all of them.
 */
class Recorder {
  private readonly ran = new Map<string, { kind: Golden["kind"]; files: Set<string> }>();

  private constructor(
    private readonly app: App,
    private readonly origin: string,
    /** The functions the page runs as its modules load, by script and place: never a picture's own. */
    private readonly loading: ReadonlySet<string>,
  ) {}

  /** A recorder, or nothing when the studio serves the built client (said, for `--accept`; refused, for `--record-coverage`). */
  static async open(app: App, origin: string): Promise<Recorder | undefined> {
    await app.cdp("Profiler.enable");
    const recorder = new Recorder(app, origin, new Set());
    await recorder.start();
    await app.navigate(`${origin}${SPECIMEN_PAGE}?names`);
    await app.until("document.getElementById('specimens') !== null", "the specimen page to load", 400);
    // Not at once: what the modules defer (a room's module fetched after the first draw) runs seconds later.
    await app.settled();
    await new Promise((r) => setTimeout(r, 2000));
    const taken = await recorder.take();
    if (!taken.result.some((s) => sourceOf(s.url, origin) !== undefined)) {
      const why = "the studio serves the built client, whose scripts are bundled with no sourcemaps: coverage is recorded from a studio on the dev server (studio.mts --goldens-world, without --built)";
      if (MODE === "record") throw new Error(why);
      console.log(`  (coverage not recorded: ${why})`);
      return undefined;
    }
    const loading = new Set(taken.result.flatMap((s) => s.functions.filter((f) => f.ranges[0]!.count > 0).map((f) => `${s.url}#${f.ranges[0]!.startOffset}`)));
    return new Recorder(app, origin, loading);
  }

  /** From here: a page about to be reached. Again on a second try, which starts the counts over. */
  async start(): Promise<void> {
    await this.app.cdp("Profiler.stopPreciseCoverage");
    await this.app.cdp("Profiler.startPreciseCoverage", { callCount: false, detailed: false });
  }

  private async take(): Promise<Taken> {
    const taken = await this.app.cdp<Taken>("Profiler.takePreciseCoverage");
    await this.app.cdp("Profiler.stopPreciseCoverage");
    return taken;
  }

  /** What ran since {@link start}, kept as the scene's or specimen's: over every look it is taken in, one list. */
  async took(kind: Golden["kind"], name: string): Promise<number> {
    const files = this.ran.get(keyOf(kind, name))?.files ?? new Set<string>();
    for (const script of (await this.take()).result) {
      const file = sourceOf(script.url, this.origin);
      if (file === undefined) continue;
      // The script's own top level starts at 0.
      if (script.functions.some((f) => f.ranges[0]!.startOffset > 0 && f.ranges[0]!.count > 0 && !this.loading.has(`${script.url}#${f.ranges[0]!.startOffset}`))) files.add(file);
    }
    this.ran.set(keyOf(kind, name), { kind, files });
    return files.size;
  }

  /** Into `coverage.json`: what was recorded this run replaces what was, and the rest stays. */
  write(): void {
    if (this.ran.size === 0) return;
    const index = readCoverage() ?? { pictures: {} };
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    for (const [key, { kind, files }] of this.ran) index.pictures[key] = { kind, files: [...files].sort(), recordedAt: new Date().toISOString(), commit };
    writeFileSync(COVERAGE, JSON.stringify(index, null, 1));
    const counts = [...this.ran.values()].map((r) => r.files.size);
    const everywhere = [...this.ran.values()].map((r) => r.files).reduce((a, b) => new Set([...a].filter((f) => b.has(f))));
    console.log(`coverage recorded for ${this.ran.size} scenes and specimens (${Math.min(...counts)} to ${Math.max(...counts)} files each; ${everywhere.size} under every one of them) in ${COVERAGE}`);
  }
}

/**
 * Under every picture, so a change to one is the full sweep: the primitives, the tokens and the
 * stylesheet they are replayed from, and the fonts. Most run only as they load, which coverage does not
 * see (see {@link Recorder}).
 */
const FOUNDATIONS: readonly RegExp[] = [
  /^packages\/universal\/src\/primitives\.tsx$/,
  /^packages\/universal\/src\/(css)?[tT]okens(?!.*\.native\.)[^/]*\.tsx?$/,
  /^packages\/universal\/src\/tamagui\.config\.ts$/,
  /^packages\/app\/src\/renderer\/styles\.css$/,
  /^packages\/client\/src\/rn\/fonts\.css$/,
];
/**
 * Under every specimen and no scene: the registry every specimen is drawn through, and the page that
 * draws it. A change to one is every specimen, with the scenes coverage chooses — a new specimen is
 * spread into the registry, and the scenes are not on its page.
 */
const SPECIMEN_FOUNDATIONS: readonly RegExp[] = [/^packages\/client\/src\/specimens\/registry\.tsx$/, /^packages\/client\/(app\/specimen-rn|src\/routes\/specimenRn[^/]*)\.tsx$/];
/**
 * A file the page draws from: what a scene or specimen should cover, and is listed when none does. Not
 * the universal tree's index, which only exports, and which every new component is added to.
 */
const UI_FILE = /^packages\/(universal\/src\/(?!index\.ts$)|client\/(src|app|bridges)\/).*\.(tsx?|css)$/;

/** The files changed since `ref`, with the working tree and what git does not track yet; by default since the merge base with main. */
function changedFiles(ref: string | undefined): { since: string; files: string[] } {
  const git = (...args: string[]): string[] => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const base = ref ?? git("merge-base", "HEAD", "main")[0]!;
  const files = new Set([...git("diff", "--name-only", base), ...git("ls-files", "--others", "--exclude-standard")]);
  return { since: ref ?? `the merge base with main (${base.slice(0, 8)})`, files: [...files].sort() };
}

/**
 * `--changed`: the scenes and specimens the change can reach (see "What a change reaches" above), said
 * as they are chosen; `undefined` for the whole set.
 */
function reachedBy(ref: string | undefined, specimens: readonly string[]): { scenes: string[]; specimens: string[] } | undefined {
  const { since, files } = changedFiles(ref);
  const coverage = readCoverage();
  const ui = files.filter((f) => UI_FILE.test(f) && !/\.test\.tsx?$/.test(f));
  console.log(`--changed since ${since}: ${files.length} files changed, ${ui.length} of them the page's`);
  const foundation = files.find((f) => FOUNDATIONS.some((r) => r.test(f)));
  if (foundation !== undefined) {
    console.log(`${foundation} is under every picture: the full sweep`);
    return undefined;
  }
  if (coverage === undefined) {
    console.log(`no coverage is recorded yet (pair.mts --record-coverage, from a studio on the dev server): the full sweep`);
    return undefined;
  }
  const changed = new Set(files);
  const covered = new Set<string>();
  /** What chose each, said once per picture. */
  const why = new Map<string, string>();
  const choose = (key: string, reason: string): void => void (why.has(key) ? undefined : why.set(key, reason));
  const reaches = (key: string): void => {
    const recorded = coverage.pictures[key];
    if (recorded === undefined) return choose(key, "no coverage recorded");
    const hit = recorded.files.filter((f) => changed.has(f));
    for (const f of recorded.files) covered.add(f);
    if (hit.length > 0) choose(key, hit.map((f) => f.replace(/.*\//, "")).join(", "));
  };
  for (const s of SCENES) reaches(s.name);
  for (const s of specimens) reaches(`specimen-${s}`);
  const specimenFoundation = files.find((f) => SPECIMEN_FOUNDATIONS.some((r) => r.test(f)));
  if (specimenFoundation !== undefined) for (const s of specimens) choose(`specimen-${s}`, `${specimenFoundation.replace(/.*\//, "")}, under every specimen`);
  // A specimen whose own file changed: a fixture is the file's top level, which coverage does not see.
  for (const file of files.filter((f) => /^packages\/client\/src\/specimens\/[^/]+\.tsx$/.test(f) && existsSync(join(ROOT, f)))) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const s of specimens) if (new RegExp(`(^|[\\s{,])(["']${s}["']|${/^[A-Za-z_$][\w$]*$/.test(s) ? s : "(?!)"})\\s*:`, "m").test(text)) choose(`specimen-${s}`, file.replace(/.*\//, ""));
  }
  const scenes = SCENES.map((s) => s.name).filter((n) => why.has(n));
  const chosen = specimens.filter((s) => why.has(`specimen-${s}`));
  const reasons = new Map<string, string[]>();
  for (const [key, reason] of why) reasons.set(reason, [...(reasons.get(reason) ?? []), key]);
  for (const [reason, keys] of reasons) console.log(`  ${reason}: ${keys.join(", ")}`);
  console.log(`${scenes.length} of ${SCENES.length} scenes and ${chosen.length} of ${specimens.length} specimens`);
  const uncovered = ui.filter((f) => !covered.has(f) && existsSync(join(ROOT, f)) && !SPECIMEN_FOUNDATIONS.some((r) => r.test(f)));
  if (uncovered.length > 0) console.log(`changed, and under no picture as recorded — add a specimen for it, or name the scenes that draw it (--scene a,b):\n${uncovered.map((f) => `  ${f}`).join("\n")}`);
  return { scenes, specimens: chosen };
}

/**
 * A page reached and photographed undisturbed, or tried again. The dev server is every studio's: a file
 * somebody saves reloads this window's page under whatever scene it was in the middle of, or fails
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
 * A scene reached and held still — on the page it began on: `performance.timeOrigin` is the document's,
 * so one that changed between the scene's first step and its last is a page reloaded.
 */
async function reach(app: App, to: { look: Look; scene: Scene }): Promise<void> {
  let began = 0;
  const marked: Scene = {
    ...to.scene,
    reach: async (a) => {
      began = await a.evaluate<number>("performance.timeOrigin");
      await to.scene.reach(a);
    },
  };
  await goTo(app, PAGE, { ...to, scene: marked });
  await scrollTo(app);
  await app.settled();
  if (began !== (await app.evaluate<number>("performance.timeOrigin"))) throw new Disturbed("the page was reloaded under the scene");
}

/** A specimen's page: its box, its picture, its words and its islands. */
interface SpecimenShot {
  png: PNG;
  box: Rect;
  texts: Run[];
  islands: Island[];
  window: Win;
}

/** Recording what each scene and specimen runs: `--record-coverage`, and `--accept` from a studio on the dev server. */
let recorder: Recorder | undefined;

const specimenShot = (app: App, origin: string, name: string, look: Look): Promise<SpecimenShot> =>
  undisturbed(app, `the ${name} specimen`, async () => {
    await recorder?.start();
    return specimenPage(app, origin, name, look);
  });

async function specimenPage(app: App, origin: string, name: string, look: Look): Promise<SpecimenShot> {
  // Wherever the last scene left the pointer, a specimen under it would be drawn hovered.
  await app.pointer(2, 2);
  await app.navigate(`${origin}${SPECIMEN_PAGE}?name=${encodeURIComponent(name)}&look=${lookName(look)}`);
  // Patiently: the shared dev server rebuilds a page's graph after an edit anywhere in it.
  await app.until("document.getElementById('specimen') !== null || document.getElementById('specimens') !== null", "the specimen to draw", 400);
  if (await app.evaluate<boolean>("document.getElementById('specimen') === null")) throw new Error(`no specimen ${name} in the registry (packages/client/src/specimens/registry.tsx)`);
  const loaded = await app.evaluate<number>("performance.timeOrigin");
  await app.evaluate("document.fonts.ready.then(() => true)");
  // Until it holds still: an editor is a lazy chunk, and a page that asks for one first waits longest for it.
  if (!(await app.settled(`document.getElementById("specimen")`))) console.log("  (the specimen never held still: photographed as it was)");
  if (loaded !== (await app.evaluate<number>("performance.timeOrigin"))) throw new Disturbed("the page was reloaded under the specimen");
  const box = await app.evaluate<Rect>(`(() => { const r = document.getElementById("specimen").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const islands = await app.evaluate<Island[]>(islandsOf("#specimen [data-island]", JSON.stringify(box)));
  const runs = await app.evaluate<Run[]>(texts(`document.getElementById("specimen")`));
  // Beyond the window only where it must be: that capture lays the page out again as tall as it is, and
  // what is sized by the window's height (a dialog capped at 90vh, whose reviewer scrolls) is then drawn
  // otherwise than it was measured — the island's box 10px short of the island in the picture.
  const fits = await app.evaluate<boolean>(`${box.x} >= 0 && ${box.y} >= 0 && ${box.x + box.width} <= innerWidth && ${box.y + box.height} <= innerHeight`);
  const png = await capture(app, box, !fits);
  return { png, box, texts: runs, islands, window: await windowOf(app, png, box.width) };
}

/** A specimen's picture graded against its golden: the page's islands painted out of both, as a scene's are. */
function gradeSpecimen(base: string, golden: Pick<SpecimenShot, "png" | "box" | "texts">, rn: SpecimenShot): boolean {
  const size = (b: Rect): string => `${round(b.width)}×${round(b.height)}`;
  for (const island of rn.islands) for (const png of [golden.png, rn.png]) mask(png, island, rn.png.width / rn.box.width);
  const moved = compareTexts(golden.texts, rn.texts);
  const left = rn.islands.length > 0 ? `  (islands left out: ${rn.islands.map((i) => i.name).join(", ")})` : "";
  writeFileSync(join(OUT, `${base}.golden.png`), PNG.sync.write(golden.png));
  writeFileSync(join(OUT, `${base}.rn.png`), PNG.sync.write(rn.png));
  let failed: boolean;
  if (golden.png.width !== rn.png.width || golden.png.height !== rn.png.height) {
    failed = true;
    const common = { x: 0, y: 0, width: Math.min(golden.png.width, rn.png.width), height: Math.min(golden.png.height, rn.png.height) };
    const d = differ(crop(golden.png, common, 1)!, crop(rn.png, common, 1)!, join(OUT, `${base}.diff.png`));
    // "dom … rn …" as the reports written while there were two pages said it: `--same-as` holds a note to an earlier one's.
    results.push({ of: base, part: "specimen", grade: "size", differing: d.differing, exact: d.exact, note: `dom ${size(golden.box)}, rn ${size(rn.box)}` });
    console.log(`${base}: DIFFERENT SIZE (golden ${size(golden.box)}, now ${size(rn.box)}); over the common part ${verdict(d)}${left}`);
  } else {
    const d = differ(golden.png, rn.png, join(OUT, `${base}.diff.png`));
    failed = d.differing !== 0;
    noted(base, "specimen", d);
    console.log(`${base}: ${verdict(d)}  (${size(golden.box)})${left}`);
  }
  if (moved.length > 0) console.log(`  text that moved (now − golden):\n${moved.join("\n")}`);
  return failed;
}

/**
 * A specimen (`--specimen markdown`): one component drawn from a fixture on the specimen page
 * (`packages/client/src/specimens/registry.tsx`), photographed and graded against its golden — the gate
 * for a leaf, with no world to seed and no scene to reach.
 */
async function specimen(app: App, origin: string, name: string, look: Look, replace: boolean): Promise<boolean> {
  const base = `specimen-${name}-${lookName(look)}`;
  const kept = readGolden("specimen", name, lookName(look));
  if (MODE === "record") {
    await specimenShot(app, origin, name, look);
    console.log(`${base}: ${await recorder!.took("specimen", name)} files`);
    return false;
  }
  if (MODE === "accept") {
    if (kept !== undefined && !replace) {
      alreadyKept++;
      return false;
    }
    const shot = await specimenShot(app, origin, name, look);
    await recorder?.took("specimen", name);
    accept(
      { kind: "specimen", name, look: lookName(look), seed: null, window: shot.window, picture: { width: shot.png.width, height: shot.png.height }, box: roundRect(shot.box), islands: shot.islands.map(roundRect), volatile: [], texts: roundRuns(shot.texts), takenAt: new Date().toISOString(), from: "universal" },
      shot.png,
      kept?.golden,
    );
    return false;
  }
  if (kept === undefined) {
    results.push({ of: base, part: "specimen", grade: "no golden" });
    console.log(`${base}: NO GOLDEN — if the specimen is new and its picture is right, keep it: pair.mts --accept --specimen ${name}`);
    return true;
  }
  const rn = await specimenShot(app, origin, name, look);
  if (!sameWindow(kept.golden.window, rn.window)) throw new Error(`${base}: the golden was taken in another window (${JSON.stringify(kept.golden.window)}; this one is ${JSON.stringify(rn.window)}) — give the studio's window that size`);
  return gradeSpecimen(base, { png: kept.png, box: kept.golden.box!, texts: kept.golden.texts }, rn);
}

/** The world the studio is open on, by the task its seed parked: what tells one seeding from another. */
async function seedOf(app: App): Promise<string> {
  const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
  const project = projects.find((p) => p.kind === "user")?.project;
  const tasks = await app.ipc<Array<{ title: string; taskId: string }>>("task:list", project !== undefined ? { project } : {});
  return tasks.find((t) => t.title === PARKED)?.taskId ?? "no parked task";
}

/** The shell's regions as the universal page marks them ({@link REGIONS}), and the room between its title bar and its strip. */
async function regionsOf(app: App): Promise<Record<string, Rect>> {
  const regions: Record<string, Rect> = {};
  for (const [region, selector] of Object.entries(REGIONS)) {
    const r = await app.evaluate<Rect | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (r !== null && r.width > 0 && r.height > 0) regions[region] = r;
  }
  const bar = regions["titlebar"];
  if (bar !== undefined) {
    const floor = regions["inbox"]?.y ?? (await app.evaluate<number>("innerHeight"));
    regions["viewport"] = { x: bar.x, y: bar.y + bar.height, width: bar.width, height: floor - bar.y - bar.height };
  }
  return regions;
}

async function scene(app: App, scene: Scene, look: Look, seed: string, replace: boolean): Promise<boolean> {
  const only = arg("--region");
  const stem = `${scene.name}${arg("--scroll-to") !== undefined ? `@${arg("--scroll-to")!.replace(/[^a-z0-9]+/gi, "_")}` : ""}`;
  const name = `${stem}-${lookName(look)}`;
  const kept = readGolden("scene", stem, lookName(look));
  const reached = (): Promise<void> =>
    undisturbed(app, name, async () => {
      await recorder?.start();
      await reach(app, { look, scene });
    });
  if (MODE === "record") {
    await reached();
    console.log(`${name}: ${await recorder!.took("scene", stem)} files`);
    return false;
  }
  if (MODE === "accept") {
    if (kept !== undefined && !replace) {
      alreadyKept++;
      return false;
    }
    await reached();
    const regions = await regionsOf(app);
    const runs = await app.evaluate<Run[]>(texts("document.body"));
    const islands = await app.evaluate<Island[]>(islandsOf("[data-island]"));
    const volatile = [...(await app.evaluate<Island[]>(VOLATILE)), ...(scene.volatile !== undefined ? await app.evaluate<Island[]>(scene.volatile) : [])];
    const png = await capture(app);
    await recorder?.took("scene", stem);
    accept(
      {
        kind: "scene",
        name: stem,
        look: lookName(look),
        seed,
        window: await windowOf(app, png),
        picture: { width: png.width, height: png.height },
        regions: Object.fromEntries(Object.entries(regions).map(([k, r]) => [k, roundRect(r)])),
        islands: islands.map(roundRect),
        volatile: volatile.map(roundRect),
        texts: roundRuns(runs),
        takenAt: new Date().toISOString(),
        from: "universal",
      },
      png,
      kept?.golden,
    );
    return false;
  }
  if (kept === undefined) {
    results.push({ of: name, part: "window", grade: "no golden" });
    console.log(`${name}: NO GOLDEN — if the scene is new and its picture is right, keep it: pair.mts --accept --scene ${scene.name}`);
    return true;
  }
  if (kept.golden.seed !== seed) {
    results.push({ of: name, part: "window", grade: "no golden" });
    console.log(`${name}: the golden was taken in another world (its parked task was ${kept.golden.seed}, this studio's is ${seed}) — a scene is compared in the goldens' world: studio.mts --goldens-world`);
    return true;
  }
  const golden = kept.png;
  let failed = false;
  // A scene is reached by what the page draws ("Awaiting you", a card's title): one that cannot be
  // reached is photographed wherever it stopped, and says so.
  let unreached: string | undefined;
  try {
    await undisturbed(app, name, () => reach(app, { look, scene }));
  } catch (e) {
    unreached = (e as Error).message;
  }
  // The native path must not have been helped: no rule of the app's stylesheet on the page (an island's
  // are scoped to it, `@scope ([data-island])`, and are no rule of the page's).
  const helped = await app.evaluate<boolean>(
    `[...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === ".sidebar" || r.selectorText === ".card"); } catch { return false; } })`,
  );
  if (helped) throw new Error("styles.css is on the page: it would draw what the components should");
  const islands = await app.evaluate<Island[]>(islandsOf("[data-island]"));
  const rnRuns = flag("--texts") ? await app.evaluate<Run[]>(texts("document.body")) : [];
  const rn = await capture(app);
  const window = await windowOf(app, rn);
  if (!sameWindow(window, kept.golden.window)) throw new Error(`${name}: the golden was taken in another window (${JSON.stringify(kept.golden.window)}; this one is ${JSON.stringify(window)}) — give the studio's window that size`);
  // Islands (Monaco, CodeMirror) are the desktop's own DOM components by construction, drawn in the
  // page as they are: painted out of both pictures, with what the log keeps changing.
  const scale = golden.width / window.width;
  for (const r of [...islands, ...kept.golden.volatile]) for (const png of [golden, rn]) mask(png, r, scale);
  writeFileSync(join(OUT, `${name}.golden.png`), PNG.sync.write(golden));
  writeFileSync(join(OUT, `${name}.rn.png`), PNG.sync.write(rn));
  console.log(`${name}${islands.length > 0 ? `  (islands left out: ${islands.map((i) => i.name).join(", ")})` : ""}${kept.golden.volatile.length > 0 ? `  (the log's left out: ${[...new Set(kept.golden.volatile.map((v) => v.name))].join(", ")})` : ""}`);
  if (unreached !== undefined) {
    failed = true;
    results.push({ of: name, part: "window", grade: "unreached", note: unreached });
    console.log(`  the scene could not be reached: ${unreached}`);
  }
  const whole = only === undefined && golden.width === rn.width && golden.height === rn.height ? differ(golden, rn, join(OUT, `${name}.diff.png`)) : undefined;
  if (whole !== undefined) {
    noted(name, "window", whole);
    console.log(`  window   ${verdict(whole)}`);
  }
  for (const [region, r] of Object.entries(kept.golden.regions ?? {})) {
    if (only !== undefined && region !== only) continue;
    const [a, b] = [crop(golden, r, scale), crop(rn, r, scale)];
    // Measured on the page, and wholly below the window: there is no picture of it to compare.
    if (a === undefined || b === undefined) continue;
    const d = differ(a, b, join(OUT, `${name}.${region}.diff.png`));
    writeFileSync(join(OUT, `${name}.${region}.golden.png`), PNG.sync.write(a));
    writeFileSync(join(OUT, `${name}.${region}.rn.png`), PNG.sync.write(b));
    noted(name, region, d);
    console.log(`  ${region.padEnd(8)} ${verdict(d)}  (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)})`);
    if (flag("--texts") && d.differing !== 0) {
      // Which words moved, of those the golden's page drew inside this region (page coordinates).
      const inside = (t: Run): boolean => t.x + t.w > r.x && t.x < r.x + r.width && t.y + t.h > r.y && t.y < r.y + r.height;
      const moved = compareTexts(kept.golden.texts.filter(inside), rnRuns.filter(inside));
      if (moved.length > 0) console.log(`    text that moved (now − golden):\n${moved.map((m) => `  ${m}`).join("\n")}`);
    }
    if (d.differing !== 0) failed = true;
  }
  return failed;
}

/**
 * An earlier run's verdicts: its `--report` (JSON), or what it printed, kept as a text file — a run made
 * with the tag's `pair.mts --against-goldens` and saved by redirection reads the same.
 */
function readReport(path: string): Result[] {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as Result[];
  } catch {
    // Not JSON: the printed lines.
  }
  const graded = (said: string): Pick<Result, "grade" | "differing" | "exact"> | undefined => {
    if (said.startsWith("identical to the eye")) return { grade: "eye", differing: 0, exact: Number(/\((\d+) px/.exec(said)?.[1] ?? 0) };
    if (said.startsWith("identical")) return { grade: "identical", differing: 0, exact: 0 };
    const px = /^(\d+) px differ/.exec(said);
    return px !== null ? { grade: "differ", differing: Number(px[1]) } : undefined;
  };
  const out: Result[] = [];
  let scene: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const specimen = /^(specimen-\S+): (.*)$/.exec(line);
    const part = /^ {2}(\w+)\s+(identical.*|\d+ px differ.*)$/.exec(line);
    const head = /^([a-z][\w@-]*-(?:light|dark))(?: {2}\(.*)?$/.exec(line);
    const lost = /^(\S+): (NO GOLDEN|the golden was taken in another world|COULD NOT BE PHOTOGRAPHED)/.exec(line);
    if (lost !== null) out.push({ of: lost[1]!, part: lost[1]!.startsWith("specimen-") && lost[2] === "NO GOLDEN" ? "specimen" : "window", grade: lost[2] === "COULD NOT BE PHOTOGRAPHED" ? "unreached" : "no golden" });
    else if (specimen !== null) {
      const size = /^DIFFERENT SIZE \(\w+ (\S+), \w+ (\S+)\); over the common part (.*)$/.exec(specimen[2]!);
      const g = graded(size !== null ? size[3]! : specimen[2]!);
      if (size !== null) out.push({ of: specimen[1]!, part: "specimen", grade: "size", differing: g?.differing ?? 0, note: `dom ${size[1]}, rn ${size[2]}` });
      else if (g !== undefined) out.push({ of: specimen[1]!, part: "specimen", ...g });
    } else if (head !== null) scene = head[1];
    else if (part !== null && scene !== undefined) {
      const g = graded(part[2]!);
      if (g !== undefined) out.push({ of: scene, part: part[1]!, ...g });
    } else if (scene !== undefined && /^ {2}the scene could not be reached/.test(line)) out.push({ of: scene, part: "window", grade: "unreached" });
  }
  return out;
}

/**
 * `--same-as`: this run's verdicts against an earlier run's, part by part — identical where that was
 * identical, the same pixels differing where it differed. How a change that must not show is shown not to.
 */
function sameAs(path: string): boolean {
  const then = new Map(readReport(path).map((r) => [`${r.of} ${r.part}`, r]));
  const said = (r: Result | undefined): string => (r === undefined ? "—" : r.grade === "differ" || r.grade === "size" ? `${r.grade} ${r.differing}${r.note !== undefined ? ` (${r.note})` : ""}` : r.grade === "eye" ? `eye ${r.exact}` : r.grade);
  let same = 0;
  /** Of those not the same: the same grade, with another count of pixels. */
  let near = 0;
  const rows: string[] = [];
  for (const now of results) {
    const was = then.get(`${now.of} ${now.part}`);
    then.delete(`${now.of} ${now.part}`);
    // The same verdict: the same grade, and where pixels differ to the eye, the same number of them.
    if (was !== undefined && was.grade === now.grade && (now.grade === "identical" || now.grade === "eye" || now.grade === "unreached" || was.differing === now.differing) && (now.grade !== "size" || was.note === now.note)) same++;
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
  if (flag("--freeze") || flag("--verify")) {
    console.error(FROZEN_ELSEWHERE);
    process.exitCode = 2;
    return;
  }
  const began = Date.now();
  if (flag("--changed") && (arg("--scene") !== undefined || arg("--specimen") !== undefined || flag("--all"))) throw new Error("--changed chooses the scenes and specimens itself: leave out --scene, --specimen and --all");
  mkdirSync(OUT, { recursive: true });
  console.log(
    MODE === "accept"
      ? `pair: keeping the page's own picture as the golden of what has none, in ${GOLDENS}`
      : MODE === "record"
        ? `pair: recording what each scene and specimen runs, in ${COVERAGE}`
        : `pair: the page against the reference pictures in ${GOLDENS} — taken from the tag dom-renderer-final in the world ${GOLDENS_WORLD} (scenes are compared in a studio on it: studio.mts --goldens-world)`,
  );
  const app = await App.connect(Number(arg("--port") ?? STUDIO_PORT), { out: OUT });
  let failed = false;
  try {
    // A window that last loaded while the shared dev server was down is on Chromium's error page, and
    // every page after it would be asked of that: back to the server a studio loads from.
    if ((await app.evaluate<string>("location.protocol")) === "chrome-error:") await app.navigate(arg("--pages") ?? "http://127.0.0.1:8081/");
    const origin = await app.evaluate<string>("location.protocol + '//' + location.host");
    const names = (given: string | undefined): string[] | undefined => given?.split(",").map((s) => s.trim()).filter((s) => s !== "");
    // The registry is the page's (it imports the universal tree): the specimen page with no name lists them.
    // (With a query of its own: from a specimen's page, the bare path is not a new document.)
    const registry = async (): Promise<string[]> => {
      await app.navigate(`${origin}${SPECIMEN_PAGE}?names`);
      await app.until("document.getElementById('specimens') !== null", "the specimen page to list its specimens", 400);
      return JSON.parse(await app.evaluate<string>("document.getElementById('specimens').dataset.names")) as string[];
    };
    // `--changed [<ref>]`: what the change reaches, or (a foundation, no coverage yet) the whole set.
    const ref = arg("--changed")?.startsWith("--") === false ? arg("--changed") : undefined;
    const reached = flag("--changed") ? reachedBy(ref, await registry()) : undefined;
    if (reached !== undefined && reached.scenes.length === 0 && reached.specimens.length === 0) {
      console.log("nothing the gate photographs is reached by the change");
      return;
    }
    // Nothing named: the whole set, scenes and specimens.
    const everything = flag("--all") || (reached === undefined && arg("--scene") === undefined && arg("--specimen") === undefined);
    const wanted = reached?.scenes ?? names(arg("--scene")) ?? (everything ? ["all"] : []);
    const scenes = wanted.flatMap((w) => {
      if (w === "all") return SCENES;
      if (w === "main") return SCENES.filter((s) => s.everyLook === true);
      const found = SCENES.find((s) => s.name === w);
      if (found === undefined) throw new Error(`no scene ${w}: ${SCENES.map((s) => s.name).join(", ")}`);
      return [found];
    });
    // What `--accept` may replace: a scene or specimen named itself, never one a sweep (`all`, `main`) came across.
    const named = new Set([...wanted.filter((w) => w !== "all" && w !== "main"), ...(names(arg("--specimen")) ?? []).filter((s) => s !== "all").map((s) => `specimen-${s}`)]);
    let specimens = reached?.specimens ?? names(arg("--specimen")) ?? (everything ? ["all"] : []);
    if (specimens.includes("all")) specimens = [...new Set([...specimens.filter((s) => s !== "all"), ...(await registry())])];
    // The light look, unless more are asked for; every look for what is accepted, unless one is named.
    // What a page runs is the same in every look: coverage is recorded in the light one unless asked.
    const looks: readonly Look[] = flag("--every-look") || (MODE === "accept" && arg("--look") === undefined) ? LOOKS : [parseLook(arg("--look") ?? "light")];
    const seed = scenes.length > 0 ? await seedOf(app) : "";
    if (MODE !== "compare") recorder = await Recorder.open(app, origin);
    // One that cannot be photographed (a scene that will not be reached, a page that throws) is said and
    // counted, and the rest go on: a run of several hundred is not lost to one.
    const each = async (what: string, run: () => Promise<boolean>): Promise<void> => {
      try {
        if (await run()) failed = true;
      } catch (e) {
        failed = true;
        results.push({ of: what, part: "window", grade: "unreached", note: (e as Error).message.slice(0, 200) });
        console.log(`${what}: COULD NOT BE PHOTOGRAPHED — ${(e as Error).message.slice(0, 300)}`);
      }
    };
    for (const look of looks) for (const s of scenes) await each(`${s.name}-${lookName(look)}`, () => scene(app, s, look, seed, named.has(s.name)));
    for (const s of specimens) for (const look of looks) await each(`specimen-${s}-${lookName(look)}`, () => specimen(app, origin, s, look, named.has(`specimen-${s}`)));
  } finally {
    await app.close();
    writeManifest();
    recorder?.write();
  }
  const lost = results.filter((r) => r.grade === "unreached").map((r) => r.of);
  if (MODE === "record") {
    if (lost.length > 0) console.log(`${lost.length} could not be reached, and have no coverage recorded: ${lost.join(", ")}`);
  } else if (MODE === "accept") {
    console.log(`accepted ${accepted.length} pictures as goldens in ${GOLDENS}${alreadyKept > 0 ? `; ${alreadyKept} have one already and were left alone (name a scene or specimen to replace its golden)` : ""}${lost.length > 0 ? `; ${lost.length} could not be photographed: ${lost.join(", ")}` : ""}`);
  } else {
    if (results.length > 3) {
      const count = (grade: string): number => results.filter((r) => r.grade === grade).length;
      console.log(`${results.length} comparisons: ${count("identical")} identical, ${count("eye")} identical to the eye, ${count("differ")} differ, ${count("size")} of another size${count("unreached") > 0 ? `, ${count("unreached")} not reached` : ""}${count("no golden") > 0 ? `, ${count("no golden")} with no golden` : ""}`);
    }
    const report = arg("--report");
    if (report !== undefined) writeFileSync(report, JSON.stringify(results, null, 1));
    const held = arg("--same-as");
    if (held !== undefined && !sameAs(held)) failed = true;
  }
  const took = Math.round((Date.now() - began) / 1000);
  console.log(`wrote ${MODE === "accept" ? GOLDENS : MODE === "record" ? COVERAGE : OUT}, in ${Math.floor(took / 60)}m ${took % 60}s`);
  if (failed) process.exitCode = 1;
}

await main();
