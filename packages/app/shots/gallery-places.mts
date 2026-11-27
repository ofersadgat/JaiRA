/**
 * A gallery's place buttons (2026-11-27): one `show_artifact` call's three pictures carry the set's own
 * three place buttons on the caption's line, and each picture its own over its top right — drawn while
 * the tile is hovered or the picture is open somewhere, that place lit.
 *
 * The set to a split opens it there on its first picture with the others beside it as tabs, the set's
 * Split lit; a tab steps sideways, not a step in the pane's history. The set to the side panel moves it
 * there. A picture's own Main view opens it alone, and its tile keeps its buttons, Main lit.
 *
 * A real agent (claude-cli/haiku — this rig spends a little), in a world of its own.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/gallery-places.mts
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Gallery places";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "gallery-places");
const WORLD = join(import.meta.dirname, ".world-gallery-places");
const REPO = join(import.meta.dirname, "..", "..", "..");
const SET = { read_file: "allow", glob: "allow", grep: "allow", show_artifact: "allow", shell: "ask", other: "ask" };

const OPENING = [
  "Do exactly this, then reply with one line.",
  "Call show_artifact once with `artifacts` set to the three pictures shots/before.png, shots/after.png and shots/menu.png, and `caption` set to \"Icons before and after, and the When menu open\".",
].join("\n");

const TILE = `[title$="with the others beside it"]`;
/** The place groups in the conversation (the first pane, which holds it): the set's first, then a tile's. */
const GROUPS = `[...document.querySelectorAll('[data-pane="0"] [aria-label="Where to show it"]')]`;
/** The groups drawn over a tile: those inside the gallery's tiles' boxes. */
const TILE_GROUPS = `${GROUPS}.filter((g) => g.parentElement?.previousElementSibling?.querySelector('${TILE}') != null)`;
/** The set's group: the one on the caption's line. */
const SET_GROUP = `${GROUPS}.find((g) => (g.parentElement?.textContent ?? '').includes('Icons before and after'))`;
const litOf = (group: string): string => `[...(${group})?.querySelectorAll('[aria-pressed=true]') ?? []].map((b) => b.getAttribute('aria-label'))`;
const pressIn = (group: string, label: string): string => `(${group})?.querySelector('[aria-label="${label}"]')?.click()`;
/** The tab strip's tabs that name a picture, wherever drawn. */
const TABS = `[...document.querySelectorAll('[role=tablist] [role=tab]')].map((t) => ({ name: (t.textContent ?? '').trim().replace(/^\\d+/, ''), on: t.getAttribute('aria-selected') === 'true', left: Math.round(t.getBoundingClientRect().left) })).filter((t) => /\\.png$/.test(t.name))`;
/** The second pane's ‹ (Back): disabled while its history has one step. */
const SPLIT_BACK = `document.querySelector('[data-pane="1"] [aria-label="Back"]')`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(join(world.project, "shots"), { recursive: true });
  copyFileSync(join(REPO, ".tmp-mockups", "when-icons", "before-1-crop.png"), join(world.project, "shots", "before.png"));
  copyFileSync(join(REPO, ".tmp-mockups", "when-icons", "after-1-crop.png"), join(world.project, "shots", "after.png"));
  copyFileSync(join(import.meta.dirname, "out", "sidebar-scope", "1b-when-menu.png"), join(world.project, "shots", "menu.png"));

  const app = await App.launch(world, { out: OUT, port: 9277 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`gallery-places: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1600, 1000);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "session", conversation: true, inputs: { message: OPENING } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(`document.querySelectorAll('${TILE}').length >= 3`, "the gallery's three tiles", 600);
    // The turn ended (no "Stop this turn" in the box): the conversation is not redrawn under the pointer.
    await app.until(`document.querySelector('[title="Stop this turn"]') === null`, "the turn to end", 600);
    // The run settling may take the window to the Tasks room: back to the conversation, once it is still.
    await settle(4000);
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(`document.querySelectorAll('${TILE}').length >= 3`, "the gallery's three tiles again", 200);
    // The title may be the pane head's crumb by now, whose press opens the pane's history: closed again.
    await app.press("Escape", 27);
    await settle(2000);

    // At rest: the set's group on the caption's line, nothing lit; no tile's group.
    check(await app.evaluate<boolean>(`(${SET_GROUP}) !== undefined`), "the set's place buttons stand on the caption's line");
    check((await app.evaluate<string[]>(litOf(SET_GROUP))).length === 0, "the set's buttons light nothing while it is nowhere");
    check((await app.evaluate<number>(`${TILE_GROUPS}.length`)) === 0, "no tile draws its buttons at rest");
    await app.shot("1-rest", undefined, false);

    // Hovering the second tile draws its buttons, and only its.
    const at = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelectorAll('${TILE}')[1].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await app.hover(at.x - 20, at.y - 20);
    await app.hover(at.x, at.y);
    await settle(400);
    check((await app.evaluate<number>(`${TILE_GROUPS}.length`)) === 1, "hovering a tile draws its buttons");
    await app.shot("2-hover", undefined, false);
    await app.hover(5, 500);
    await settle(300);
    check((await app.evaluate<number>(`${TILE_GROUPS}.length`)) === 0, "leaving it takes them away");

    // The set to a split: its first picture, the others as tabs; the set's Split lit.
    await app.evaluate(pressIn(SET_GROUP, "Open in a split"));
    await app.until(`document.querySelector('[data-pane="1"]') !== null`, "the split", 40);
    await settle(1200);
    let tabs = await app.evaluate<Array<{ name: string; on: boolean; left: number }>>(TABS);
    console.log(`gallery-places: split tabs ${JSON.stringify(tabs)}`);
    check(tabs.length === 3 && tabs.find((t) => t.on)?.name === "before.png", "the split shows before.png with the others as tabs");
    check(JSON.stringify(await app.evaluate<string[]>(litOf(SET_GROUP))) === JSON.stringify(["Open in a split"]), "the set's Split is lit");
    const tileLit = await app.evaluate<number>(`${TILE_GROUPS}.length`);
    check(tileLit === 1, "the picture the split shows keeps its tile's buttons, Split lit");
    const crumbs = await app.evaluate<string>(`(() => { const n = document.querySelector('[data-pane="1"] [aria-label="Where this pane is"]'); return JSON.stringify({ text: n?.innerText, w: n?.getBoundingClientRect().width }); })()`);
    console.log(`gallery-places: split crumbs ${crumbs}`);
    check(/Gallery places/.test(crumbs) && /before\.png/.test(crumbs), "the split's crumbs say the conversation › before.png");
    await app.shot("3-set-in-split", undefined, false);

    // A tab in the split: sideways, not a step in its history.
    await app.evaluate(`[...document.querySelectorAll('[data-pane="1"] [role=tab]')].find((t) => (t.textContent ?? '').includes('menu.png'))?.click()`);
    await settle(800);
    tabs = await app.evaluate(TABS);
    check(tabs.find((t) => t.on)?.name === "menu.png", "a tab in the split steps to menu.png");
    check(await app.evaluate<boolean>(`(() => { const b = ${SPLIT_BACK}; return b !== null && (b.getAttribute('aria-disabled') === 'true' || b.disabled === true); })()`), "the step was sideways: the split's ‹ has nowhere to go");
    check(JSON.stringify(await app.evaluate<string[]>(litOf(SET_GROUP))) === JSON.stringify(["Open in a split"]), "the set's Split stays lit on another picture");
    await app.shot("4-split-stepped", undefined, false);

    // The set to the side panel: moved there, on menu.png, the split closed.
    await app.evaluate(pressIn(SET_GROUP, "Open in the side panel"));
    await settle(1200);
    check(await app.evaluate<boolean>(`document.querySelector('[data-pane="1"]') === null`), "the set moved: the split it was in closed");
    check(JSON.stringify(await app.evaluate<string[]>(litOf(SET_GROUP))) === JSON.stringify(["Open in the side panel"]), "the set's Side panel is lit");
    tabs = await app.evaluate(TABS);
    check(tabs.find((t) => t.on)?.name === "menu.png", "the side panel opens it on the picture it was showing");
    await app.shot("5-set-in-panel", undefined, false);
    // Pressed again where it is lit: the panel closes on it.
    await app.evaluate(pressIn(SET_GROUP, "Open in the side panel"));
    await settle(800);
    check((await app.evaluate<string[]>(litOf(SET_GROUP))).length === 0, "Side panel pressed where lit takes the set away");

    // One picture alone to a split, from its own buttons: drawn while hovered, then kept, Split lit.
    const third = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelectorAll('${TILE}')[2].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await app.hover(third.x - 20, third.y - 20);
    await app.hover(third.x, third.y);
    await settle(400);
    await app.evaluate(pressIn(`${TILE_GROUPS}[0]`, "Open in a split"));
    await app.until(`document.querySelector('[data-pane="1"]') !== null`, "the picture's split", 40);
    await app.hover(5, 500);
    await settle(1200);
    check((await app.evaluate<number>(`${TILE_GROUPS}.length`)) === 1, "the picture open in the split keeps its buttons unhovered");
    check(JSON.stringify(await app.evaluate<string[]>(litOf(`${TILE_GROUPS}[0]`))) === JSON.stringify(["Open in a split"]), "its Split is lit");
    check((await app.evaluate<string[]>(litOf(SET_GROUP))).length === 0, "a picture alone is not the set: the set's buttons light nothing");
    check((await app.evaluate<Array<{ name: string }>>(TABS)).length === 0, "the picture alone has no tabs beside it");
    await app.shot("6-picture-in-split", undefined, false);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`gallery-places: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("gallery-places: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
