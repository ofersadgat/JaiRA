/**
 * One run of `pair.mts` held against another, pixel for pixel: the page's own pictures (`<name>.rn.png`)
 * before a change that must not show and after it. `pair.mts --same-as` holds two runs' VERDICTS to each
 * other; this holds their PICTURES, and so says of a scene that was already off its golden whether it is
 * off by the same pixels.
 *
 *   npx tsx packages/app/shots/pair.mts --port 9301 --out packages/app/shots/parity/universal-before     before the change
 *   npx tsx packages/app/shots/pair.mts --port 9301                                                     after it (→ parity/rn-9301)
 *   npx tsx packages/app/shots/before-after.mts --port 9301        parity/universal-before against parity/rn-9301
 *   --before <dir> --after <dir>   the two folders, named
 *   --again <dir>    a SECOND run from before the change: what differs between the two before-runs is the
 *                    noise floor (written to `<before>/noise.json`), and only more than that is a change
 *   --regions        the region crops too (`<name>.<region>.rn.png`), not only the whole pictures
 *
 * Both runs must be of the same world, window and build of everything the change does not touch: same
 * studio (`studio.mts --goldens-world --built` for the scenes). The pictures already have the page's
 * islands and the log's counts painted out, as `pair.mts` writes them.
 *
 * The noise floor is per picture, in pixels: a clock that reads "3 min ago" in one run and "4 min ago" in
 * the next, an editor that coloured a line a frame later. `<before>/noise.json` is
 * `{ "<name>": <pixels> }`; a picture not in it has a floor of 0. Without the file every pixel counts.
 * Exit code 1 if any picture differs by more than its floor, is of another size, or is missing after.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const HERE = import.meta.dirname;
const BEFORE = resolve(arg("--before") ?? join(HERE, "parity", "universal-before"));
const AFTER = resolve(arg("--after") ?? join(HERE, "parity", arg("--port") === undefined ? "rn" : `rn-${arg("--port")}`));
const SUFFIX = ".rn.png";

/** The page's pictures in a folder, by name: whole windows and specimens, and with `--regions` the crops (their names have a dot). */
function pictures(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`no pictures at ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => f.slice(0, -SUFFIX.length))
    .filter((name) => process.argv.includes("--regions") || !name.includes("."))
    .sort();
}

type Held = { px: number; box?: string } | { size: string };

/** How many pixels of two pictures differ at all, and the box that holds them; or their two sizes. */
function hold(a: string, b: string, diffTo?: string): Held {
  const [x, y] = [PNG.sync.read(readFileSync(a)), PNG.sync.read(readFileSync(b))];
  if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}×${x.height} then, ${y.width}×${y.height} now` };
  const diff = new PNG({ width: x.width, height: x.height });
  const px = pixelmatch(x.data, y.data, diff.data, x.width, x.height, { threshold: 0, includeAA: true, alpha: 0.15 });
  if (px === 0) return { px };
  let [x0, y0, x1, y1] = [x.width, x.height, -1, -1];
  for (let j = 0; j < x.height; j++) {
    for (let i = 0; i < x.width; i++) {
      const at = (j * x.width + i) * 4;
      if (x.data[at] === y.data[at] && x.data[at + 1] === y.data[at + 1] && x.data[at + 2] === y.data[at + 2] && x.data[at + 3] === y.data[at + 3]) continue;
      [x0, y0, x1, y1] = [Math.min(x0, i), Math.min(y0, j), Math.max(x1, i), Math.max(y1, j)];
    }
  }
  if (diffTo !== undefined) writeFileSync(diffTo, PNG.sync.write(diff));
  return { px, box: `${x0},${y0} ${x1 - x0 + 1}×${y1 - y0 + 1}` };
}

/** The floor each picture is allowed: what a second run from before the change differed by, kept beside the first. */
function noiseFloor(names: readonly string[]): Record<string, number> {
  const file = join(BEFORE, "noise.json");
  const again = arg("--again");
  if (again !== undefined) {
    const second = new Set(pictures(resolve(again)));
    const floor: Record<string, number> = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number>) : {};
    let noisy = 0;
    for (const name of names) {
      if (!second.has(name)) continue;
      const held = hold(join(BEFORE, name + SUFFIX), join(resolve(again), name + SUFFIX));
      // Another size between two runs of one build is no floor to allow: left out, so it fails if it differs after.
      if ("size" in held) continue;
      // The larger of what was seen: a floor recorded from several repeats only grows.
      if (held.px > (floor[name] ?? 0)) floor[name] = held.px;
      if (held.px > 0) noisy++;
    }
    writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(floor).filter(([, px]) => px > 0).sort()), null, 1));
    console.log(`noise floor from ${resolve(again)}: ${noisy} of ${names.length} pictures differ between two runs of the same build; written to ${file}`);
    return floor;
  }
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number>) : {};
}

function main(): void {
  const before = pictures(BEFORE);
  const after = new Set(pictures(AFTER));
  const floor = noiseFloor(before);
  const out = join(AFTER, "before-after");
  mkdirSync(out, { recursive: true });
  let same = 0;
  const within: string[] = [];
  const changed: string[] = [];
  for (const name of before) {
    if (!after.has(name)) {
      changed.push(`  ${name}: not photographed after`);
      continue;
    }
    const held = hold(join(BEFORE, name + SUFFIX), join(AFTER, name + SUFFIX), join(out, `${name}.diff.png`));
    if ("size" in held) changed.push(`  ${name}: ANOTHER SIZE (${held.size})`);
    else if (held.px === 0) same++;
    else if (held.px <= (floor[name] ?? 0)) within.push(`  ${name}: ${held.px} px in ${held.box} (floor ${floor[name]})`);
    else changed.push(`  ${name}: ${held.px} px differ, in ${held.box}${floor[name] !== undefined ? ` (floor ${floor[name]})` : ""} — ${join(out, `${name}.diff.png`)}`);
  }
  const fresh = [...after].filter((name) => !before.includes(name));
  console.log(`${BEFORE}\n  against ${AFTER}`);
  console.log(`${before.length} pictures: ${same} the same to the pixel, ${within.length} within their noise floor, ${changed.length} changed${fresh.length > 0 ? `; ${fresh.length} only after (${fresh.slice(0, 8).join(", ")}${fresh.length > 8 ? ", …" : ""})` : ""}`);
  if (within.length > 0) console.log(`within the floor:\n${within.join("\n")}`);
  if (changed.length > 0) {
    console.log(`CHANGED:\n${changed.join("\n")}`);
    process.exitCode = 1;
  }
}

main();
