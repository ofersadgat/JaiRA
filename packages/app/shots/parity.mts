/**
 * The S1 gate of decision 0013: does the One client draw exactly what the Vite renderer drew?
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/parity.mts
 *
 * One world, seeded once. Then, per theme, ONE launch photographs the same scenes twice: first in the
 * Vite renderer (`dist/renderer`, loaded from `file://`), then — the same window reloaded — in the One
 * client (`app://jaira/`). One launch rather than two, because a launch changes the state being
 * photographed: it interrupts the parked run's pending call and re-registers it, which adds lines to
 * the transcript. The clock is held and animations are off (`holdStill`), so the only thing that
 * differs between a pair is the renderer. Pairs are compared pixel by pixel, and every pair that
 * differs gets a diff image in `shots/parity/`.
 *
 * Not `run.mts`: that pass waits for the Appearance preview's Monaco to colour its tokens, which on
 * this machine it never does under either renderer (a separate problem), and a gate that cannot finish
 * on the baseline cannot say anything about the change.
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

type Renderer = "vite" | "one";

const VITE_URL = pathToFileURL(join(import.meta.dirname, "..", "dist", "renderer", "index.html")).href;
const ONE_URL = "app://jaira/";
const drawn = "window.jaira && document.getElementById('root') && document.getElementById('root').children.length > 0";

async function launch(world: World, renderer: Renderer, port: number): Promise<App> {
  process.env.JAIRA_RENDERER = renderer;
  const app = await App.launch(world, { out: OUT, port });
  await app.until(drawn, "the window to draw");
  return app;
}

async function start(app: App, title: string, fake: unknown): Promise<void> {
  const made = await app.ipc<{ taskId: string }>("task:create", {
    title,
    workflow: "feature/plan",
    inputs: { issue: `# ${title}\n\nThe issue this task was raised for.` },
  });
  await app.ipc("task:start", { taskId: made.taskId, fake });
}

async function seed(world: World): Promise<void> {
  const app = await launch(world, "vite", 9239);
  try {
    await start(app, "add dark mode", happyRules());
    await start(app, "rework the sync lint", [happyRules()[0]]);
    await app.until(says("done"), "the completed task");
    await app.until(says("failed"), "the failed task");
    await start(app, PARKED, blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park at its gate");
  } finally {
    await app.close();
  }
}

/** The scenes, in order. Each is reached from the one before, the same way under both renderers. */
async function scenes(app: App, renderer: Renderer, theme: string): Promise<string[]> {
  const names: string[] = [];
  const shot = async (name: string, of?: string): Promise<void> => {
    await settle();
    await app.shot(`${renderer}/${name}-${theme}`, of);
    names.push(`${name}-${theme}`);
  };
  // The pointer where the last pass left it would hover something different at the start of this one.
  await app.hover(2, 2);
  await app.until(says("Awaiting you"), "the gate to still be parked");
  await shot("board");
  await app.clickText(PARKED);
  await shot("task");
  await app.clickText("Settings");
  await shot("settings");
  // A real Monaco drawing a real sample through the TextMate grammars (WASM): the part of the
  // renderer most likely to break under a new origin and a new content policy.
  await app.clickText("Appearance");
  // Scrolled into view, and again on every try: Monaco draws no lines for an editor nobody can see
  // (which is also why `run.mts`'s wait for the same colours can hang), and the page lays out after it
  // mounts, undoing a scroll made before that. Forty seconds, because under either renderer the
  // grammar sometimes takes more than twenty to arrive on this machine.
  await app.until(`document.querySelector(".ft-preview-body") !== null`, "the preview to mount");
  try {
    await app.until(
      `(document.querySelector(".ft-preview-body").scrollIntoView({ block: "center" }),
        [...document.querySelectorAll(".ft-preview-body .view-lines span[class^=mtk]")].some((s) => getComputedStyle(s).color !== "rgb(0, 0, 0)"))`,
      "the preview's editor to colour itself",
      160,
    );
  } catch (e) {
    // What the editor had drawn, for whoever reads the failure.
    console.log(await app.evaluate<string>(`(() => { const v = document.querySelector(".ft-preview-body .view-lines"); const b = document.querySelector(".ft-preview-body"); const r = b.getBoundingClientRect(); return JSON.stringify({ rect: [r.x, r.y, r.width, r.height], inner: innerHeight, lines: v ? v.children.length : null, text: v ? v.innerText.slice(0, 80) : null, mtk: v ? [...v.querySelectorAll("span[class^=mtk]")].slice(0, 5).map((s) => s.className + ":" + getComputedStyle(s).color) : null, host: b.innerHTML.length }); })()`));
    await app.shot(`${renderer}/failed-file-types-${theme}`);
    throw e;
  }
  await shot("file-types", ".ft");
  return names;
}

function compare(name: string): { name: string; differing: number; total: number } {
  const a = PNG.sync.read(readFileSync(join(OUT, "vite", `${name}.png`)));
  const b = PNG.sync.read(readFileSync(join(OUT, "one", `${name}.png`)));
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
  mkdirSync(join(OUT, "vite"), { recursive: true });
  mkdirSync(join(OUT, "one"), { recursive: true });
  const world = buildWorld(WORLD);
  await seed(world);

  const complaints: Record<Renderer, string[]> = { vite: [], one: [] };
  const names = new Set<string>();
  let port = 9240;
  for (const theme of ["light", "dark"] as const) {
    // The theme is read at startup, so it is chosen by a launch of its own before the pair.
    const chooser = await launch(world, "vite", port++);
    await chooser.preferTheme(theme);
    await chooser.close();
    const app = await launch(world, "one", port++);
    try {
      await app.holdStill(Date.UTC(2026, 8, 27, 21, 0, 0));
      for (const [renderer, url] of [["vite", VITE_URL], ["one", ONE_URL]] as const) {
        const before = app.complaints.length;
        await app.navigate(url);
        await app.until(drawn, `the ${renderer} renderer to draw`);
        // Proof the pair is two renderers, not one twice: One's SPA shell sets `__vxrnIsSPA`, Vite's does not.
        const which = await app.evaluate<string>("location.protocol + (globalThis.__vxrnIsSPA === true ? ' one' : ' vite')");
        if (which !== (renderer === "one" ? "app: one" : "file: vite")) throw new Error(`expected the ${renderer} renderer, found ${which}`);
        console.log(`  ${renderer}: ${which}`);
        for (const n of await scenes(app, renderer, theme)) names.add(n);
        complaints[renderer].push(...app.complaints.slice(before));
      }
    } finally {
      await app.close();
    }
  }

  console.log("\nparity:");
  let failed = false;
  for (const name of names) {
    const r = compare(name);
    const verdict = r.differing === 0 ? "identical" : r.differing < 0 ? "DIFFERENT SIZE" : `${r.differing} px differ (${((100 * r.differing) / r.total).toFixed(3)}%)`;
    if (r.differing !== 0) failed = true;
    console.log(`  ${r.name}: ${verdict}`);
  }
  for (const renderer of ["vite", "one"] as const) {
    if (complaints[renderer].length === 0) continue;
    console.log(`\n${renderer} spoke up ${complaints[renderer].length} time(s):`);
    for (const c of complaints[renderer].slice(0, 8)) console.log(`  ${c}`);
  }
  console.log(`\nwrote ${OUT}`);
  if (failed) process.exitCode = 1;
}

await main();
