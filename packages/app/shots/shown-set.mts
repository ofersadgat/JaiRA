/**
 * A shown set in the side panel (2026-11-22): a picture pressed in a call's gallery opens on the path
 * conversation › 3 pictures › it, with the others beside it — as tabs (the default), as thumbnails down
 * the side with their names, or as a stepper in the head, chosen from the view menu — and ← → End and
 * Escape move through it.
 *
 * A real agent (claude-cli/haiku — this rig spends a little), in a world of its own, with the pictures
 * `show-any-file.mts` uses.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/shown-set.mts
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Shown set";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "shown-set");
const WORLD = join(import.meta.dirname, ".world-shown-set");
const REPO = join(import.meta.dirname, "..", "..", "..");
const SET = { read_file: "allow", glob: "allow", grep: "allow", show_artifact: "allow", shell: "ask", other: "ask" };

const OPENING = [
  "Do exactly these two things, in order, then reply with one line.",
  "1. Call show_artifact once with `artifacts` set to the three pictures shots/before.png, shots/after.png and shots/menu.png, and `caption` set to \"Icons before and after, and the When menu open\".",
  "2. Call show_artifact once with `artifacts` set to [\"src/scope.ts\", {\"data\": \"# Notes\\n\\nThe scope falls back to the project.\\n\", \"name\": \"notes.md\"}, {\"data\": \"route,first draw ms\\nchat list,212\\ntasks tab,188\\n\", \"name\": \"timings.csv\"}], and `caption` set to \"The scope, a note on it, and the timings\".",
].join("\n");

/** The panel's head and what the set's views say, read off the page. */
const READ = `(() => {
  const tabs = [...document.querySelectorAll('[role=tablist] [role=tab]')].map((t) => ({ name: (t.textContent ?? '').trim(), on: t.getAttribute('aria-selected') === 'true' }));
  return { tabs, text: document.body.innerText };
})()`;

/** The code card's "Open in the side panel": the place buttons of the card whose bar names scope.ts and no other item. */
const OPEN_SCOPE_CARD = `(() => {
  const groups = [...document.querySelectorAll('[aria-label="Where to show it"]')];
  const mine = groups.find((g) => {
    let el = g;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      const text = el?.textContent ?? "";
      if (text.includes("scope.ts") && !text.includes("timings.csv")) return true;
    }
    return false;
  });
  mine?.querySelector('[aria-label="Open in the side panel"]')?.click();
  return mine !== undefined;
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(join(world.project, "shots"), { recursive: true });
  copyFileSync(join(REPO, ".tmp-mockups", "when-icons", "before-1-crop.png"), join(world.project, "shots", "before.png"));
  copyFileSync(join(REPO, ".tmp-mockups", "when-icons", "after-1-crop.png"), join(world.project, "shots", "after.png"));
  copyFileSync(join(import.meta.dirname, "out", "sidebar-scope", "1b-when-menu.png"), join(world.project, "shots", "menu.png"));
  mkdirSync(join(world.project, "src"), { recursive: true });
  writeFileSync(join(world.project, "src", "scope.ts"), 'export function scopeOf(at: { workspace?: string }): string {\n  return at.workspace ?? "project";\n}\n', "utf8");

  const app = await App.launch(world, { out: OUT, port: 9276 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`shown-set: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const read = (): Promise<{ tabs: Array<{ name: string; on: boolean }>; text: string }> => app.evaluate(READ);
  const shownTab = async (): Promise<string | undefined> => (await read()).tabs.find((t) => t.on && /\.png$/.test(t.name.replace(/^\d+/, "")))?.name.replace(/^\d+/, "");
  const pick = async (view: string): Promise<void> => {
    await app.evaluate(`document.querySelector('[aria-label="Change how the set is shown"]')?.click()`);
    await settle(400);
    await app.clickText(view);
    await settle(600);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 1000);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "session", conversation: true, inputs: { message: OPENING } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(`document.querySelectorAll('[title$="with the others beside it"]').length >= 3 && document.body.innerText.includes("timings.csv")`, "the gallery's three tiles and the second call", 600);
    await settle(2000);

    // Press the first tile: the panel opens on conversation › 3 pictures › before.png, as tabs.
    await app.evaluate(`document.querySelector('[title$="with the others beside it"]')?.click()`);
    await app.until(says("3 pictures"), "the set's crumb");
    await settle(800);
    let now = await read();
    console.log(`shown-set: tabs ${JSON.stringify(now.tabs)}`);
    check(/3 pictures/.test(now.text) && /before\.png/.test(now.text), "the panel stands on 3 pictures › before.png");
    check(now.tabs.filter((t) => /\.png$/.test(t.name)).length === 3, "the set's three pictures are tabs over it");
    check((await shownTab()) === "before.png", "the tab of the picture pressed is the one open");
    await app.shot("1-tabs", undefined, false);

    // → steps to the next, from where the focus was left (the conversation).
    await app.press("ArrowRight", 39);
    check((await shownTab()) === "after.png", "→ steps to after.png");
    await app.shot("2-tabs-next", undefined, false);
    await app.press("End", 35);
    check((await shownTab()) === "menu.png", "End goes to the last");
    await app.press("ArrowRight", 39);
    check((await shownTab()) === "menu.png", "→ at the last stays there: the set does not wrap");

    // The view menu: thumbnails beside it, with their names under them.
    await pick("Thumbnails beside it");
    now = await read();
    check(now.tabs.filter((t) => /\.png$/.test(t.name)).length === 0, "no tabs in the thumbnails view");
    check(["before.png", "after.png", "menu.png"].every((n) => now.text.includes(n)), "each thumbnail's name is under it");
    await app.shot("3-rail", undefined, false);

    // …and a stepper in the head.
    await pick("A stepper");
    check((await read()).text.includes("3 / 3"), "the stepper says 3 / 3");
    await app.press("ArrowLeft", 37);
    check((await read()).text.includes("2 / 3"), "← steps back: 2 / 3");
    await app.shot("4-stepper", undefined, false);

    // Escape: up to the set, the call's gallery in the panel.
    await app.press("Escape", 27);
    now = await read();
    check(/shown together/.test(now.text), "Escape goes up to the set");
    await app.shot("5-set", undefined, false);

    // Any kind (2026-11-22): the second call's code file, note and table are a set too. The code card's
    // "Open in the side panel" opens it on conversation › 3 artifacts › scope.ts, in place of the pictures.
    await app.evaluate(OPEN_SCOPE_CARD);
    await app.until(says("3 artifacts"), "the mixed set's crumb");
    await settle(800);
    await pick("Tabs");
    const openOf = (tabs: Array<{ name: string; on: boolean }>): string | undefined => tabs.find((t) => t.on && /\.(ts|md|csv)$/.test(t.name))?.name;
    now = await read();
    console.log(`shown-set: mixed tabs ${JSON.stringify(now.tabs)}`);
    check(!/3 pictures/.test(now.text), "the mixed set replaces the pictures' set, not nested under it");
    check(["scope.ts", "notes.md", "timings.csv"].every((n) => now.tabs.some((t) => t.name.endsWith(n))), "the code file, the note and the table are its tabs");
    check(openOf(now.tabs)?.endsWith("scope.ts") === true, "the code file is the one open");
    await app.shot("6-mixed-tabs", undefined, false);
    await app.press("ArrowRight", 39);
    check(openOf((await read()).tabs)?.endsWith("notes.md") === true, "→ steps to the note");
    await app.shot("7-mixed-note", undefined, false);
    await pick("Thumbnails beside it");
    now = await read();
    check(/DOCUMENT/i.test(now.text) && /TABLE/i.test(now.text) && /CODE/i.test(now.text), "the thumbnails name each kind");
    await app.shot("8-mixed-rail", undefined, false);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`shown-set: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("shown-set: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
