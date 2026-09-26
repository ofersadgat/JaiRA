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
    const pressed = (label: string): Promise<string> =>
      app.evaluate<string>(`[...document.querySelectorAll('[aria-label="${label}"] button')].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent).join("|")`);
    const notesSelect = `[...document.querySelectorAll(".set-row")].find((r) => r.textContent.includes("Rate limits and system notes")).querySelector("select")`;
    check((await app.evaluate<string>(`${notesSelect}.value`)) === "hide-groups", "the notes control starts on its default");
    check((await pressed("Rows shown while it works")) === "3", `the rows control starts on 3 (${await pressed("Rows shown while it works")})`);

    // A chip's hover card, with a real pointer.
    const chip = await centre(".ws-preview .ws-preview-card:nth-child(3) .ws-chip");
    await app.hover(chip.x, chip.y);
    check(await app.evaluate<boolean>(`!!document.querySelector("body > .float.ws-card .ts-row")`), "a chip opens its rows in a hover card");
    await app.shot("2-chip-card");

    // Every step's hover card.
    const foot = await centre(".ws-preview .ws-preview-card:nth-child(3) .ws-foot");
    await app.hover(foot.x, foot.y);
    // The newest card: the chip's may still be lingering on its way out as this one opens.
    await pause(400);
    const lines = await app.evaluate<string>(`[...document.querySelectorAll("body > .float.ws-card .ws-card-head")].at(-1)?.textContent ?? ""`);
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

    // Rate limits and notes: Show gives the opening notes a phase of their own; Hide drops their chips.
    // A <select> is set as a person sets it: the value through the native setter, then a change event.
    const notes = (value: string): Promise<unknown> =>
      app.evaluate(`(() => { const el = ${notesSelect}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    const finished = (): Promise<number> => count(".ws-preview .ws-preview-card:nth-child(3) .ws-phase");
    await notes("show");
    await pause(800);
    check((await finished()) === 5, "Show: the opening notes are a phase of their own");
    await notes("hide");
    await pause(800);
    check((await finished()) === 4 && (await count(".ws-preview .ws-k-wait, .ws-preview .ws-k-note")) === 0, "Hide: no rate-limit or note chips");
    await notes("hide-groups");
    await pause(600);

    // Photographed last: a clipped capture of a section taller than the window is the one step that has
    // stalled on an idle screen, and nothing after it should depend on it.
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
