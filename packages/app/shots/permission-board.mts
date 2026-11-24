/**
 * The permission board (decision 0034): the shield opens it built up from the root set, the Result
 * frozen on the right; a resource opens into its accesses and an access into its tools; a chip moved on
 * the Result lands in the conversation's own layer; the Tools card's Board opens it from the Result,
 * with the source permission sets a press away; and Settings → Tools has the Tool mapping. No agent
 * runs: the conversation is created and its permissions are edited through the board itself.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/permission-board.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "permission-board");
const WORLD = join(import.meta.dirname, ".world-permission-board");
const BAR = '[role="group"][aria-label="Permissions"]';
const FLOAT = "[data-stackmorph]";

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9273 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`permission-board: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1500, 950);
    const at = async (js: string): Promise<{ x: number; y: number } | null> => app.evaluate(`(() => { const el = ${js}; if (!el) return null; el.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const click = async (js: string, what: string, wait = 700): Promise<void> => {
      const p = await at(js);
      if (p === null) throw new Error(`nothing to press: ${what}`);
      await app.pointer(p.x, p.y);
      await settle(120);
      await app.clickAt(p.x, p.y);
      await settle(wait);
    };
    const byText = (text: string, within = "document.body"): string => `[...${within}.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText || "").trim() === ${JSON.stringify(text)})).at(-1)`;
    const inFloat = `document.querySelector(${JSON.stringify(FLOAT)})`;
    const floatText = (): Promise<string> => app.evaluate<string>(`document.querySelector(${JSON.stringify(FLOAT)})?.innerText ?? ""`);

    await app.clickText("Chat");
    await settle(800);
    await click(byText("New"), "New", 1500);

    // 1. The shield: the board, built up from the root set, the Result last.
    await click(`document.querySelector('${BAR} [aria-label="Permissions"]')`, "the shield", 1500);
    await app.shot("1-shield", undefined, false);
    const board = await floatText();
    check(/the root set, each layer on top of it/.test(board) && /Result/.test(board) && /This conversation/.test(board), "1. the shield opens the board, root first");
    check(/Files/.test(board) && /Read/.test(board) && /Programs/.test(board) && /Other/.test(board), "1. rows by resource, Files open on its accesses");

    // 2. An access opened into its tools.
    await click(byText("Search", inFloat), "Files · Search", 900);
    await app.shot("2-search-open", undefined, false);
    check(/glob/.test(await floatText()) && /grep/.test(await floatText()), "2. Search opens into its tools");

    // 2b. One scroll area: scrolled down, the heads stay at its top; scrolled right, the labels stay left.
    const scroller = `[...document.querySelectorAll("[data-cell]")][0]?.parentElement?.closest("*") && (() => { let e = document.querySelector("[data-cell]"); while (e && getComputedStyle(e).overflow !== "auto") e = e.parentElement; return e; })()`;
    const scrolled = await app.evaluate<{ can: boolean; headStays: boolean; labelStays: boolean }>(`(() => {
      const box = ${scroller};
      if (!box) return { can: false, headStays: false, labelStays: false };
      const head = [...box.querySelectorAll("*")].find((e) => (e.innerText || "").trim() === "Resource");
      const label = [...box.querySelectorAll("*")].find((e) => (e.innerText || "").trim().startsWith("Files"));
      box.scrollTop = 300; box.scrollLeft = 400;
      const top = box.getBoundingClientRect().top, left = box.getBoundingClientRect().left;
      const can = box.scrollTop > 0 || box.scrollHeight <= box.clientHeight;
      const headStays = head ? Math.abs(head.getBoundingClientRect().top - top) < 80 : false;
      const labelStays = label ? Math.abs(label.getBoundingClientRect().left - left) < 260 : true;
      return { can, headStays, labelStays };
    })()`);
    await settle(300);
    await app.shot("2b-scrolled", undefined, false);
    console.log(`scrolled: ${JSON.stringify(scrolled)}`);
    check(scrolled.can && scrolled.headStays && scrolled.labelStays, "2b. the grid scrolls, its heads and labels staying");
    await app.evaluate(`(() => { const box = ${scroller}; if (box) { box.scrollTop = 0; box.scrollLeft = 0; } return true; })()`);
    await settle(300);

    // 2c. An open section's row stays under the heads while the section scrolls past, then is pushed away.
    const stuck = await app.evaluate<{ inside: number; past: number; head: number }>(`(() => {
      const box = ${scroller};
      const row = box?.querySelector('[data-stuck="files"]');
      const section = row?.parentElement;
      if (!box || !row || !section) return { inside: -1, past: -1, head: -1 };
      const head = [...box.querySelectorAll("*")].find((e) => (e.innerText || "").trim() === "Resource").getBoundingClientRect().bottom - box.getBoundingClientRect().top;
      box.scrollTop = Math.min(section.offsetHeight / 2, section.offsetHeight - row.offsetHeight - 10);
      const inside = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop = section.offsetTop + section.offsetHeight + 40;
      const past = row.getBoundingClientRect().bottom - box.getBoundingClientRect().top;
      box.scrollTop = 0;
      return { inside: Math.round(inside), past: Math.round(past), head: Math.round(head) };
    })()`);
    console.log(`sticky: ${JSON.stringify(stuck)}`);
    check(stuck.inside >= stuck.head - 4 && stuck.inside <= stuck.head + 12, "2c. an open section's row stays under the heads while its rows scroll past");
    check(stuck.past <= stuck.head + 2, "2c. and is pushed away once the section has gone");
    await settle(300);

    // 3. What every row under an open row says alike is drawn once, on that row, and a place set as one
    //    chip: the machine key's deny is every Files tool's, so it is on the Files row alone.
    const keyRows = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-cell^="files"][data-cell*="|result|"] [data-chip]')].filter((e) => (e.innerText || "").includes("machine key")).map((e) => e.closest("[data-cell]").getAttribute("data-cell"))`);
    console.log(`machine key on the Result: ${JSON.stringify(keyRows)}`);
    check(keyRows.length === 1 && keyRows[0]!.startsWith("files|"), "3. a place every Files tool denies is drawn once, on the Files row");
    check(/credentials 8/.test(await floatText()), "3. the credentials are one chip");
    // A Result column no chip is in is not drawn.
    const empty = await app.evaluate<string[]>(`(() => { const answers = new Set([...document.querySelectorAll('[data-cell*="|result|"]')].map((e) => e.getAttribute("data-cell").split("|")[2])); return [...answers].filter((answer) => ![...document.querySelectorAll('[data-cell$="|result|' + answer + '"] [data-chip]')].length); })()`);
    check(empty.length === 0, `3. every Result column drawn has a chip in it (empty: ${JSON.stringify(empty)})`);

    // 4. A chip pressed opens the inspector; its Deny moves it, kept with this conversation.
    const row = await app.evaluate<string>(`(() => { const e = [...document.querySelectorAll('[data-cell^="files"][data-cell*="|result|"] [data-chip]')].find((each) => (each.innerText || "").includes("project files")); return e ? e.closest("[data-cell]").getAttribute("data-cell").split("|")[0] : ""; })()`);
    console.log(`project files is on: ${row}`);
    await click(`[...document.querySelectorAll('[data-cell^="${row}|result|"] [data-chip]')].find((e) => (e.innerText || "").includes("project files"))`, "project files on the Result", 800);
    await app.shot("4a-inspector", undefined, false);
    const inspector = await app.evaluate<string>(`document.querySelector("[data-inspector]")?.innerText ?? ""`);
    // The section heads are drawn in capitals, and innerText reads them so.
    check(/project files/i.test(inspector) && /answer, for this conversation/i.test(inspector) && /sets \d+ tool/i.test(inspector), "4. a chip pressed opens the inspector");
    await click(`document.querySelector('[data-inspector] [aria-label="Deny"]')`, "the inspector's Deny", 2500);
    await app.shot("4b-moved", undefined, false);
    const landed = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-cell^="files"][data-cell$="|deny"]')].filter((e) => (e.innerText || "").includes("project files")).map((e) => e.getAttribute("data-cell"))`);
    console.log(`project files in Deny: ${JSON.stringify(landed)}`);
    check(landed.some((cell) => cell.includes("|result|")) && landed.some((cell) => cell.includes(":tools|")), "4. the move is in the Result and in This conversation");

    // 4c. The layer heads. Hovering This conversation's head shows its +: a new, empty layer before it.
    const heads = (): Promise<string[]> => app.evaluate<string[]>(`[...document.querySelectorAll("[data-layer-head]")].map((e) => e.getAttribute("data-layer-head"))`);
    console.log(`heads: ${JSON.stringify(await heads())}`);
    const conversationHead = `document.querySelector('[data-layer-head="This conversation"]')`;
    const at4 = await app.evaluate<{ x: number; y: number } | null>(`(() => { const e = ${conversationHead}; if (!e) return null; e.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (at4 !== null) await app.pointer(at4.x, at4.y);
    await settle(400);
    await click(`document.querySelector('[aria-label="Add a layer before This conversation"]')`, "the + before This conversation", 800);
    // The stack is written and read again before the head is drawn.
    for (let tries = 0; tries < 20 && !(await heads()).includes("Layer 1"); tries += 1) await settle(250);
    await app.shot("4c-added", undefined, false);
    check((await heads()).includes("Layer 1"), `4c. the + adds an unsaved layer, Layer 1, before This conversation (${JSON.stringify(await heads())})`);

    // A chip moved into it from the inspector: Layer 1 now holds a line.
    await click(`[...document.querySelectorAll('[data-cell*="|result|"] [data-chip]')][0]`, "a Result chip", 800);
    await click(`[...document.querySelectorAll('[data-inspector] [role="button"], [data-inspector] *')].find((e) => (e.getAttribute("aria-label") || "") === "to Layer 1")`, "keep it in Layer 1", 2500);
    const layerChips = await app.evaluate<number>(`[...document.querySelectorAll('[data-cell*=":unsaved:1|"] [data-chip]')].length`);
    check(layerChips > 0, `4c. a chip kept in Layer 1 is drawn in its columns (${layerChips})`);

    // Its name swaps it: for ask-all, which asks Replace or Merge — it has lines. Merge.
    await click(`document.querySelector('[aria-label="Swap Layer 1"]')`, "Layer 1's name", 900);
    await app.shot("4d-swap-menu", undefined, false);
    check(/deny-all/.test(await app.evaluate<string>("document.body.innerText")) && /ask-all/.test(await app.evaluate<string>("document.body.innerText")), "4d. the swap menu lists the sets, deny-all and ask-all among them");
    await click(`document.querySelector('[aria-label^="base/ask-all,"]')`, "ask-all", 1200);
    await app.shot("4e-replace-or-merge", undefined, false);
    check((await floatText()).includes("Replace them with base/ask-all, or merge base/ask-all"), "4e. swapping a layer with lines asks Replace or Merge");
    await click(`document.querySelector('[data-layer-ask="swap"] [aria-label="Merge"]')`, "Merge", 2500);
    const afterMerge = await heads();
    check(afterMerge.includes("Layer 1") && (await app.evaluate<number>(`[...document.querySelectorAll('[data-cell*=":unsaved:1|"] [data-chip]')].length`)) > layerChips, "4e. Merge keeps Layer 1, base/ask-all's lines copied in");

    // Its ⋯: Save as a set… — named, in this project — and it is that set from then on.
    await click(`document.querySelector('[aria-label="More for Layer 1"]')`, "Layer 1's ⋯", 900);
    await click(`document.querySelector('[aria-label="Save as a set…"]')`, "Save as a set…", 900);
    await app.shot("4f-save", undefined, false);
    await app.evaluate(`(() => { const input = document.querySelector('[data-layer-ask="save"] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "rig-kept"); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await settle(300);
    await click(`document.querySelector('[data-layer-ask="save"] [aria-label="Save"]')`, "Save", 3500);
    await app.shot("4g-saved", undefined, false);
    check((await heads()).includes("rig-kept"), `4g. Save as a set makes Layer 1 the set rig-kept (${JSON.stringify(await heads())})`);

    // The root's swatch dragged onto rig-kept's head: the root moves after it.
    // A drag is picked up, then (the heads drawn again as drop targets) dropped.
    const started = await app.evaluate<boolean>(`(() => {
      const handle = document.querySelector('[data-layer-handle^="Root"]');
      if (!handle) return false;
      window.__dt = new DataTransfer();
      handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__dt }));
      return true;
    })()`);
    await settle(300);
    await app.evaluate(`(() => {
      const target = document.querySelector('[data-layer-head="This conversation"]');
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
      return true;
    })()`);
    for (let tries = 0; tries < 20 && !/rig-kept/.test((await heads())[0] ?? ""); tries += 1) await settle(250);
    const order = await heads();
    console.log(`heads after the drag: ${JSON.stringify(order)}`);
    check(started && /^Root · rig-kept/.test(order[0] ?? "") && order.some((each) => each === "ask-first"), "4h. the root dragged onto This conversation's head goes last of the conversation's layers; rig-kept is the root now");
    await app.shot("4h-dragged", undefined, false);

    // 5. The tools segment: the board from the Result, the sources a press away, the list another.
    await app.press("Escape", 27);
    await settle(500);
    await click(`[...document.querySelectorAll('${BAR} *')].find((e) => /^tools/.test((e.innerText || "").trim()))`, "the tools segment", 1500);
    await app.shot("5a-tools-board", undefined, false);
    const tools = await floatText();
    check(/what this conversation may do/.test(tools) && /Show the source permission sets/.test(tools), "5. the tools segment opens the board from the Result");
    check(!/every layer, merged/.test(tools), "5. the Result alone has no head of its own");
    const narrow = await app.evaluate<number>(`Math.round(document.querySelector(${JSON.stringify(FLOAT)})?.getBoundingClientRect().width ?? 0)`);
    console.log(`tools board width: ${narrow}`);
    check(narrow > 0 && narrow < 1000, "5. the tools board is as wide as its columns, not the window");
    await click(`document.querySelector('${FLOAT} [aria-label="By tool"]')`, "Tools (by tool)", 1200);
    await app.shot("5a2-by-tool", undefined, false);
    check(/File permissions/.test(await floatText()) && /Tasks & workflows/.test(await floatText()), "5. the switch lays the rows out by tool");
    await click(`document.querySelector('${FLOAT} [aria-label="By resource"]')`, "Resources", 900);
    await click(byText("Show the source permission sets", inFloat), "Show the source permission sets", 1200);
    await app.shot("5b-tools-sources", undefined, false);
    check(/Hide the source permission sets/.test(await floatText()) && /This conversation/.test(await floatText()), "5. the sources open beside the Result");
    await click(byText("Tool list…", inFloat), "Tool list…", 1200);
    await app.shot("5c-tool-list", undefined, false);
    check(/Everything/.test(await app.evaluate<string>("document.body.innerText")), "5. Tool list… opens the Tools card");
    await app.press("Escape", 27);
    await settle(500);

    // 6. Settings → Tools → Tool mapping.
    await app.clickText("Settings");
    await settle(1200);
    await app.clickText("Tools");
    await settle(1500);
    await click(byText("Tool mapping"), "Tool mapping", 1500);
    await app.shot("6-tool-mapping", undefined, false);
    const page = await app.evaluate<string>("document.body.innerText");
    check(/Tool mapping/.test(page) && /open_app/.test(page) && /Programs · Open/.test(page), "6. Settings → Tools has the Tool mapping");
    check(/Place sets/.test(page) && /credentials/.test(page) && /project files/.test(page), "6. and the Place sets");
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`permission-board: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("permission-board: all passed");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
