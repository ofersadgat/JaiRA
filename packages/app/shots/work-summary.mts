/**
 * The work summary in the real app — Settings → Appearance → Conversation's three rows and the
 * preview under them, which is the real transcript over one request's work.
 *
 *   npx tsx packages/app/shots/work-summary.mts
 *
 * Checks, with real pointer events, that a chip and "Every step" open their hover cards (the preview
 * takes the pointer, unlike the page's other previews), and that the settings redraw it: thinking
 * off merges the neighbouring Explored phases, "None" keeps no rows. Output: `shots/out/work-summary/`.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "work-summary");
const WORLD = join(import.meta.dirname, ".world-work-summary");
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9255, width: 1280, height: 1500 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.clickText("Settings");
    await pause(600);
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim() === "Appearance"); li?.click(); return !!li; })()`);
    await app.until(`!!document.querySelector(".ws-preview")`, "the work preview");
    await app.evaluate(`document.querySelector(".ws-preview").scrollIntoView({ block: "start" })`);
    await pause(800);
    await app.shot("1-settings", `[data-part="conversation"]`);

    const count = (sel: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const centre = (sel: string): Promise<{ x: number; y: number }> =>
      app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

    check((await count(".ws-preview .ws-phase")) === 1 + 4 + 4, "phases: 1 early on, 4 many calls in, 4 finished");

    // A chip's hover card, with a real pointer.
    const chip = await centre(".ws-preview .ws-preview-card:nth-child(3) .ws-chip");
    await app.hover(chip.x, chip.y);
    check(await app.evaluate<boolean>(`!!document.querySelector("body > .float.ws-card .ts-row")`), "a chip opens its rows in a hover card");
    await app.shot("2-chip-card");

    // Every step's hover card.
    const foot = await centre(".ws-preview .ws-preview-card:nth-child(3) .ws-foot");
    await app.hover(foot.x, foot.y);
    const lines = await app.evaluate<string>(`document.querySelector("body > .float.ws-card .ws-card-head")?.textContent ?? ""`);
    check(lines.startsWith("Every step"), `Every step opens a hover card (${lines})`);
    await app.shot("3-every-step-card");
    await app.hover(5, 5);
    await pause(400);

    // Thinking off: the neighbouring Explored phases become one.
    await app.evaluate(`document.querySelector('[aria-label="Show thinking"]').click()`);
    await pause(900);
    check((await count(".ws-preview .ws-think")) === 0, "thinking off: no thinking line");
    check((await count(".ws-preview .ws-preview-card:nth-child(3) .ws-phase")) === 3, "thinking off: Explored + Explored merge");
    await app.evaluate(`document.querySelector('[aria-label="Show thinking"]').click()`);
    await pause(600);

    // Rows: None keeps no rows; 5 keeps the phase in progress's.
    const rows = (): Promise<number> => count(".ws-preview .ws-preview-card:nth-child(2) .ws-run");
    await app.evaluate(`[...document.querySelectorAll('[aria-label="Rows shown while it works"] button')].find((b) => b.textContent === "None").click()`);
    await pause(800);
    check((await rows()) === 0, "None: no rows while it works");
    await app.evaluate(`[...document.querySelectorAll('[aria-label="Rows shown while it works"] button')].find((b) => b.textContent === "5").click()`);
    await pause(800);
    const five = await rows();
    check(five > 0 && five <= 5, `5: the phase in progress keeps its rows (${five})`);
    await app.evaluate(`document.querySelector(".ws-preview").scrollIntoView({ block: "start" })`);
    await pause(400);
    await app.shot("4-rows-5", `[data-part="conversation"]`);

    const complaints = app.complaints.filter((line) => !/Autofill|cache|catalog source/.test(line));
    if (complaints.length > 0) console.log(`complaints:\n${complaints.join("\n")}`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) process.exit(1);
}

await main();
