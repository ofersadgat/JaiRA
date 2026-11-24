/**
 * The stack panel (2026-11-14, round 3 of the mockups): what each part of the composer's permission
 * bar opens, and that it MORPHS — one float whose width eases as a set's contents unfold to the right
 * of the list — rather than one card swapped for another. No agent runs: the conversation is created
 * and opened, and its stack is edited through the panel itself.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/stack-panel.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "stack-panel");
const WORLD = join(import.meta.dirname, ".world-stack-panel");
const BAR = '[role="group"][aria-label="Permissions"]';
const FLOAT = "[data-stackmorph]";

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9271 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`stack-panel: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 900);
    const at = async (js: string): Promise<{ x: number; y: number } | null> => app.evaluate(`(() => { const el = ${js}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const click = async (js: string, what: string, wait = 700): Promise<void> => {
      const p = await at(js);
      if (p === null) throw new Error(`nothing to press: ${what}`);
      await app.pointer(p.x, p.y);
      await settle(150);
      await app.clickAt(p.x, p.y);
      await settle(wait);
    };
    const byText = (text: string, within = "document.body"): string => `[...${within}.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText || "").trim() === ${JSON.stringify(text)})).at(-1)`;
    const inFloat = `document.querySelector(${JSON.stringify(FLOAT)})`;
    const barText = (): Promise<string> => app.evaluate<string>(`document.querySelector(${JSON.stringify(BAR)})?.innerText ?? ""`);
    const floatText = (): Promise<string> => app.evaluate<string>(`document.querySelector(${JSON.stringify(FLOAT)})?.innerText ?? ""`);
    const floatBox = (): Promise<{ width: number; height: number; left: number; top: number } | null> =>
      app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(FLOAT)}); if (!el) return null; const r = el.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top) }; })()`);
    // The float's width, sampled every frame from now for `ms`, and whether it is still the same element.
    const sample = (ms: number): Promise<void> =>
      app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(FLOAT)}); window.__float = el; window.__widths = []; const until = performance.now() + ${ms}; const tick = () => { const now = document.querySelector(${JSON.stringify(FLOAT)}); window.__widths.push([Math.round(performance.now()), now ? Math.round(now.getBoundingClientRect().width) : -1, now === window.__float]); if (performance.now() < until) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
    const samples = (): Promise<Array<[number, number, boolean]>> => app.evaluate("window.__widths");

    // The new-chat screen: its composer keeps what it is set to until the first message (a created,
    // never-started conversation is queued, and takes no settings).
    await app.clickText("Chat");
    await settle(800);
    await click(byText("New"), "New", 1500);
    console.log(`bar: ${JSON.stringify(await barText())}`);
    await app.shot("0-bar", undefined, false);

    // 0. A conversation with no layer yet: + lays ask-first, its row pressed.
    await click(`document.querySelector('${BAR} [aria-label="add"]')`, "+", 900);
    await app.shot("0b-add-first", undefined, false);
    check(/LAY ON TOP/i.test(await floatText()), "0. + opens the list to lay a set on top");
    await app.evaluate(`(() => { window.__calls = []; const real = window.jaira.invoke.bind(window.jaira); window.jaira.invoke = (ch, req) => { window.__calls.push(ch + " " + JSON.stringify(req ?? null).slice(0, 200)); return real(ch, req); }; return true; })()`);
    await click(byText("ask-first", inFloat), "ask-first's row", 1500);
    console.log(`  bar: ${JSON.stringify(await barText())}; float still open: ${(await floatBox()) !== null}`);
    console.log(`  calls: ${JSON.stringify(await app.evaluate("window.__calls"))}`);
    check(/ask-first/.test(await barText()), "0. pressing ask-first's row lays it");

    // 1. A layer: the sets beside it, a find box, its actions under them.
    const bottom = `document.querySelector('${BAR}').querySelectorAll('[aria-expanded]')[1]`;
    await click(bottom, "the bottom layer's segment", 900);
    await app.shot("1-layer-list", undefined, false);
    const list = await floatText();
    check(/SWAP/i.test(list) && /BESIDE IT/i.test(list), "1. a layer opens `Swap … for`, its own group first as `Beside it`");
    check(/read-only/.test(list) && /full/.test(list) && /auto/.test(list), "1. the presets are listed");
    check(/stop and ask before every call|reading goes ahead|anything, without asking/.test(list), "1. each set says what it is for");
    check(/remove/.test(list) || /later/.test(list) || /pin to this project/.test(list), "1. the layer's actions are under the list");
    const folded = await floatBox();
    console.log(`  folded: ${JSON.stringify(folded)}`);
    check(folded !== null && Math.abs(folded.width - 302) <= 2, "1. the list is 300 wide");

    // 2. A row's › unfolds the contents to the RIGHT: the same element, easing wider.
    await app.evaluate(`(() => { window.__marked = document.querySelector(${JSON.stringify(FLOAT)}); return true; })()`);
    const chevron = `[...${inFloat}.querySelectorAll('[aria-label="What auto writes"]')].at(0)`;
    const cp = await at(chevron);
    if (cp === null) throw new Error("no › on auto's row");
    await app.pointer(cp.x, cp.y);
    await settle(200);
    await sample(700);
    await app.clickAt(cp.x, cp.y);
    await settle(900);
    const widths = await samples();
    const distinct = [...new Set(widths.map(([, w]) => w))];
    console.log(`  widths while unfolding: ${distinct.join(" → ")}`);
    check(widths.every(([, , same]) => same), "2. the float is never swapped for another while it unfolds");
    check(distinct.some((w) => w > 310 && w < 795), "2. its width passes through the widths between: it eases, it does not jump");
    const open = await floatBox();
    console.log(`  unfolded: ${JSON.stringify(open)}`);
    check(open !== null && Math.abs(open.width - 802) <= 2, "2. unfolded, it is the list and the contents beside it: 300 + 500");
    const view = await app.evaluate<number>("innerWidth");
    check(folded !== null && open !== null && (open.left === folded.left || (open.left < folded.left && Math.abs(open.left + open.width - (view - 4)) <= 2)), "2. the float grows to the right — sliding left only as far as the window's edge makes it");
    check(await app.evaluate<boolean>(`window.__marked === document.querySelector(${JSON.stringify(FLOAT)})`), "2. still the same element after");
    await app.shot("2-unfolded-auto", undefined, false);
    const unfoldedText = await floatText();
    check(/Previewing/.test(unfoldedText) && /for this/.test(unfoldedText), "2. another set's contents end in `Swap … for this`");

    // 3. ↓ moves the keys' row, and the contents follow it.
    await app.press("ArrowDown", 40);
    await settle(500);
    await app.shot("3-arrow-down", undefined, false);

    // 4. ⤡ folds them away again.
    await click(`[...${inFloat}.querySelectorAll('[aria-label="Fold the contents away"]')].at(-1)`, "⤡", 900);
    const refolded = await floatBox();
    check(refolded !== null && Math.abs(refolded.width - 302) <= 2, "4. ⤡ folds the contents away: 300 again");
    await app.shot("4-folded-again", undefined, false);

    // 5. Pressing a row swaps the layer, and closes.
    await click(byText("read-only", inFloat), "read-only's row", 1200);
    const afterSwap = await barText();
    console.log(`  bar after the swap: ${JSON.stringify(afterSwap)}`);
    check(/read-only/.test(afterSwap), "5. pressing a row swaps the layer for it");
    check((await floatBox()) === null, "5. and the panel closes");

    // 6. +: the same list, `Lay on top`; a row pressed lays it on top.
    await click(`document.querySelector('${BAR} [aria-label="add"]')`, "+", 900);
    await app.shot("6-add-list", undefined, false);
    check(/LAY ON TOP/i.test(await floatText()), "6. + opens the list to lay a set on top");
    // Another segment pressed while it is open carries the same float there.
    await app.evaluate(`(() => { window.__marked = document.querySelector(${JSON.stringify(FLOAT)}); return true; })()`);
    await click(bottom, "the bottom layer's segment, while + is open", 900);
    check(await app.evaluate<boolean>(`window.__marked === document.querySelector(${JSON.stringify(FLOAT)})`), "6. pressing a layer while + is open moves the same float");
    check(/SWAP/i.test(await floatText()), "6. …and it is now the layer's list");
    await click(`document.querySelector('${BAR} [aria-label="add"]')`, "+ again", 900);
    await click(byText("full", inFloat), "full's row", 1200);
    await click(`document.querySelector('${BAR} [aria-label="add"]')`, "+ again", 900);
    await click(byText("auto", inFloat), "auto's row", 1200);
    console.log(`  bar with three layers: ${JSON.stringify(await barText())}`);

    // 7. ⋯ n: narrow the window until the middle folds; its panel is a row per layer.
    let fold: string | null = null;
    for (const width of [1100, 1000, 900, 820, 760]) {
      await app.resize(width, 900);
      await settle(700);
      if (/⋯/.test(await barText())) {
        fold = `[...document.querySelector('${BAR}').querySelectorAll('[aria-expanded]')].find((e) => /⋯/.test(e.innerText))`;
        console.log(`  folded at ${width}: ${JSON.stringify(await barText())}`);
        break;
      }
    }
    check(fold !== null, "7. the bar folds its middle into ⋯ n when narrow");
    if (fold !== null) {
      await click(fold, "⋯", 900);
      await app.shot("7-rows", undefined, false);
      const rows = await floatText();
      check(/NEWEST ON TOP/i.test(rows) && /folded/.test(rows) && /bottom/.test(rows), "7. ⋯ opens a row per layer, newest on top, the folded ones said");
      const before = await floatBox();
      await click(`[...${inFloat}.querySelectorAll('[aria-label^="What "][aria-label$=" writes"]')].at(0)`, "a row's ›", 1000);
      const after = await floatBox();
      console.log(`  rows ${JSON.stringify(before)} → unfolded ${JSON.stringify(after)}`);
      check(before !== null && after !== null && after.width > before.width + 200, "7. a row's › unfolds that layer's contents beside the rows");
      await app.shot("7b-rows-unfolded", undefined, false);
      await click(`[...${inFloat}.querySelectorAll('[title^="Swap "][title$=" for another set"]')].at(0)`, "a row's name", 1000);
      check(/SWAP/i.test(await floatText()) && /Back to the layers/.test(await app.evaluate<string>(`[...${inFloat}.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join('|')`)), "7. a row's name narrows the panel to that layer's list, with ‹ back");
      await app.shot("7c-row-swap-list", undefined, false);
      await click(`${inFloat}.querySelector('[aria-label="Back to the layers"]')`, "‹", 900);
      check(/NEWEST ON TOP/i.test(await floatText()), "7. ‹ goes back to the rows");
      await click(byText("Whole picture ⤢", inFloat), "Whole picture", 1200);
      await app.shot("7d-whole-from-rows", undefined, false);
      check(/what the whole stack comes to/.test(await floatText()), "7. Whole picture ⤢ widens the same panel to the whole picture");
      await app.press("Escape", 27);
      await settle(500);
    }

    // 8. The shield: the permission board (decision 0034), and from it the whole picture, as it was.
    await app.resize(1400, 900);
    await settle(800);
    await click(`document.querySelector('${BAR} [aria-label="Permissions"]')`, "the shield", 1200);
    check(/Layers and sets/.test(await floatText()) && /Result/.test(await floatText()), "8. the shield opens the permission board");
    await click(byText("Layers and sets…", inFloat), "Layers and sets…", 1200);
    await app.shot("8-whole", undefined, false);
    const whole = await floatText();
    check(/This conversation/.test(whole) && /what the whole stack comes to/.test(whole) && /Done/.test(whole), "8. its Layers and sets… opens the whole picture");
    await app.press("Escape", 27);
    await settle(400);
    check((await floatBox()) === null, "8. Escape closes the panel");
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`stack-panel: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("stack-panel: all passed");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
