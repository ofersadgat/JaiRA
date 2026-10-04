/**
 * The phone's own layout (decision 0015, amended 2026-10-04: the mobile pass), in a phone-sized headless
 * Chrome standing in for the phone, as `phone.mts` does.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/phoneLayout.mts [--only drawer,inbox,sheet,board,chat]
 *
 * A desktop with two finished tasks and one parked at its gate, and the phone paired with it by the code.
 * Then each part of the layout, photographed into `parity/phone-layout/`:
 *
 * - **drawer**: ▸| opens the sidebar over the room, with the INBOX row at its root;
 * - **inbox**: the Inbox room lists the gate; pressed, it opens the task with the panel as a sheet at half;
 * - **sheet**: dragged up it is full; dragged past the top the conversation is in the main view, the sheet
 *   back at its head; dragged down past its head it closes;
 * - **board**: All tasks — the strip, every column stacked, one column alone after a swipe;
 * - **chat**: a conversation, its composer at the foot;
 * - **open**: a double tap on a card opens its run.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import type { MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "phone-layout");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
// Case aside: the sidebar's rows are upper case by their style, which `innerText` reads.
const says = (text: string): string => `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const only = (() => {
  const at = process.argv.indexOf("--only");
  return at < 0 ? null : new Set(process.argv[at + 1]!.split(","));
})();
const doing = (part: string): boolean => only === null || only.has(part);

/** A finger's drag on the screen, from (x, y0) to (x, y1) — or sideways, with `dx`. */
async function drag(app: App, x: number, y0: number, y1: number, dx = 0, steps = 14): Promise<void> {
  await app.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await app.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
    await sleep(20);
  }
  await app.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(700);
}

/** Press what is named so (its accessible name), as a finger would. */
async function tapLabel(app: App, label: string): Promise<void> {
  const box = await app.evaluate<{ x: number; y: number } | null>(
    `(() => { const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (box === null) throw new Error(`nothing named "${label}" on the phone`);
  await tap(app, box.x, box.y);
}

async function tap(app: App, x: number, y: number): Promise<void> {
  await app.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await sleep(60);
  await app.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(600);
}

/** The top of the sheet, or null when there is none. */
async function sheetTop(app: App): Promise<number | null> {
  return app.evaluate<number | null>(`(() => { const el = document.querySelector('[aria-label="Drag the panel"]'); return el ? Math.round(el.getBoundingClientRect().top) : null; })()`);
}

async function main(): Promise<void> {
  if (CHROME === undefined) throw new Error("no Chrome to stand in for the phone");
  mkdirSync(OUT, { recursive: true });
  rmSync(join(OUT, ".profile-9283"), { recursive: true, force: true });
  const world = buildWorld(join(import.meta.dirname, ".world-phone-layout"));
  const desktop = await App.launch(world, { out: OUT, port: 9282 });
  let phone: App | undefined;
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await desktop.until("document.getElementById('root')?.children.length > 0", "the desktop to draw");
    for (const title of ["add dark mode", "rework the sync lint"]) {
      const made = await desktop.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
      await desktop.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
    }
    const parked = (await desktop.ipc<{ taskId: string }>("task:create", { title: "tighten the changeset lint", workflow: "feature/plan", inputs: { issue: "# tighten the changeset lint" } })).taskId;
    await desktop.ipc("task:start", { taskId: parked, fake: blockedAtTheGate() });
    for (let i = 0; i < 60; i++) {
      const pending = await desktop.ipc<Array<{ taskId: string }>>("interaction:pending", undefined);
      if (pending.some((p) => p.taskId === parked)) break;
      await sleep(500);
    }

    const shown = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    const port = shown.self.port;
    if (port === undefined || shown.pairing === undefined) throw new Error("the desktop's engine is not listening for devices, or showed no code");
    const url = `http://127.0.0.1:${port}/native?address=${encodeURIComponent(`127.0.0.1:${port}`)}`;
    phone = await App.browse(CHROME, url, { out: OUT, port: 9283, phone: { width: 390, height: 844, scale: 3 } });
    // The shell is drawn at once, empty, saying it has no machine; its line opens the Connect screen.
    await phone.until(`!!document.querySelector('[aria-label="Open the sidebar"]') && ${says("No machine connected")}`, "the phone's shell, drawn before any machine answers");
    await phone.shot("00-no-machine");
    check(true, "the shell is drawn before a machine is reached, saying it has none");
    await tapLabel(phone, "No machine connected. Connect");
    await phone.until(says("Connect to a JaiRA machine"), "the Connect screen over the shell");
    await phone.evaluate(`document.querySelector('input[aria-label="Code"]').focus()`);
    await phone.type(shown.pairing.code);
    await phone.clickText("Pair");
    await phone.until(`!!document.querySelector('[aria-label="Open the sidebar"]') && !${says("Connect to a JaiRA machine")} && !${says("No machine connected")}`, "the phone to pair, close the Connect screen and draw the machine's shell");
    await sleep(1500);
    await phone.shot("0-first");
    console.log("  dims", await phone.evaluate<string>(`JSON.stringify({ inner: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, h: innerHeight, meta: document.querySelector('meta[name=viewport]')?.content ?? null })`));
    console.log("  boxes", await phone.evaluate<string>(`JSON.stringify((() => { const out = []; let el = document.querySelector('[data-testid="board-column"]'); while (el && out.length < 14) { const r = el.getBoundingClientRect(); out.push([el.tagName, Math.round(r.top), Math.round(r.height), getComputedStyle(el).display, getComputedStyle(el).flexGrow, getComputedStyle(el).height]); el = el.parentElement; } return out; })())`));
    console.log("  page says:", (await phone.evaluate<string>("document.body.innerText")).slice(0, 400).replace(/\n/g, " | "));
    check((await phone.evaluate<number>(`document.querySelectorAll('[aria-label="Fit to the screen"], [aria-label="Show at full size"]').length`)) === 0, "the phone draws its own layout, not the desktop's fitted");

    if (doing("drawer")) {
      // A swipe from the screen's left edge pulls the drawer out; one back to the left pushes it in.
      await drag(phone, 4, 420, 424, 260);
      check(await phone.evaluate<boolean>(`!!document.querySelector('[aria-label="Close the sidebar"]')`), "a swipe from the left edge opens the drawer");
      await phone.shot("0b-drawer-swiped");
      await drag(phone, 300, 420, 424, -260);
      await sleep(400);
      check(await phone.evaluate<boolean>(`!document.querySelector('[aria-label="Close the sidebar"]')`), "a swipe back to the left closes it");
    }
    if (doing("drawer") || doing("inbox") || doing("sheet")) {
      await tapLabel(phone, "Open the sidebar");
      await phone.until(says("Inbox"), "the drawer to open with its Inbox row");
      await phone.shot("1-drawer");
      check(await phone.evaluate<boolean>(says("All tasks")), "the drawer is the sidebar, with All tasks under Inbox");
    }
    if (doing("inbox") || doing("sheet")) {
      await phone.clickText("Inbox");
      await phone.until(says("Review the critique result."), "the Inbox room to list the gate");
      await phone.shot("2-inbox");
      check(await phone.evaluate<boolean>(`!document.querySelector('[aria-label="Close the sidebar"]')`), "choosing the Inbox closed the drawer");
      await phone.clickText("Review the critique result.");
      await phone.until(`!!document.querySelector('[aria-label="Drag the panel"]')`, "the task's panel to come up as a sheet");
      await sleep(900);
      await phone.shot("3-sheet-half");
      const half = await sheetTop(phone);
      check(half !== null && half > 300 && half < 560, `the sheet stands at half (top ${half})`);
    }
    if (doing("sheet")) {
      let top = (await sheetTop(phone))!;
      await drag(phone, 195, top + 8, 120);
      top = (await sheetTop(phone)) ?? -1;
      await phone.shot("4-sheet-full");
      check(top > 0 && top < 140, `dragged up, the sheet is full (top ${top})`);
      await drag(phone, 195, top + 8, top + 220);
      const lowered = (await sheetTop(phone)) ?? -1;
      check(lowered > 300 && lowered < 560, `dragged down from full, it settles at half (top ${lowered})`);
      await drag(phone, 195, lowered + 8, lowered + 300);
      const peeked = (await sheetTop(phone)) ?? -1;
      await phone.shot("5-sheet-peek");
      check(peeked > 640, `dragged down again, it rests at its head (top ${peeked})`);
      await drag(phone, 195, peeked + 8, 120);
      const full = (await sheetTop(phone)) ?? -1;
      // A flick up from full: the conversation into the main view.
      await drag(phone, 195, full + 8, 0, 0, 3);
      await sleep(1200);
      await phone.shot("6-main-view");
      check(await phone.evaluate<boolean>(`${says("Conversation")} && ${says("Tasks")}`), "flicked up from full, the run is in the main view, its reading toggle in the title bar");
      const rail = await phone.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => { const el = [...document.querySelectorAll('[aria-label="Steps"]')].find((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 60); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      check(rail !== null, `the conversation has its Steps rail at its edge (${JSON.stringify(rail)})`);
      if (rail !== null) {
        await drag(phone, rail.x + rail.w / 2, rail.y + 40, rail.y + 90);
        await phone.shot("7-rail-scrubbed");
        await drag(phone, rail.x + rail.w / 2, rail.y + 120, rail.y + 122, -240);
        await sleep(500);
        await phone.shot("8-rail-out");
        const out = await phone.evaluate<number>(`Math.max(...[...document.querySelectorAll('[aria-label="Steps"]')].map((e) => e.getBoundingClientRect().width))`);
        check(out > 250, `pulled left, the rail is the Steps index (${Math.round(out)} wide)`);
      }
    }
    if (doing("board")) {
      await tapLabel(phone, "Open the sidebar");
      await phone.clickText("All tasks");
      await sleep(1200);
      await phone.shot("9-board-all");
      check(await phone.evaluate<boolean>(`!!document.querySelector('[aria-label="All columns"]')`), "the board has its strip, All first");
      const selectedTabs = (): Promise<string> => phone!.evaluate<string>(`[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((e) => e.getAttribute("aria-label") + "@" + Math.round(e.getBoundingClientRect().top)).join(", ")`);
      console.log("  selected before the swipe:", await selectedTabs());
      // On a column's heading: on web a card is the browser's to drag (HTML drag and drop), which takes the touch.
      await drag(phone, 330, 185, 188, -220);
      console.log("  selected after the swipe:", await selectedTabs());
      check(await phone.evaluate<boolean>(`[...document.querySelectorAll('[aria-selected="true"][role="tab"]')].filter((e) => e.getBoundingClientRect().top < 100).every((e) => e.getAttribute("aria-label") !== "All columns")`), "swiped left, the board shows one column");
      await phone.shot("10-board-one");
      await tapLabel(phone, "All columns");
      await sleep(500);
      await phone.shot("11-board-all-again");
    }
    if (doing("files")) {
      await tapLabel(phone, "Open the sidebar");
      // Standing on the project opens its rows (Files, Tasks, Chat) under it — unless it already stands there.
      try {
        await phone.clickText("Files");
      } catch {
        await phone.clickText(".world-phone-layout");
        await sleep(600);
        await phone.clickText("Files");
      }
      await sleep(1200);
      await tap(phone, 375, 420);
      await phone.shot("13-files");
    }
    if (doing("settings")) {
      await tapLabel(phone, "Open the sidebar");
      await phone.clickText("Settings");
      await sleep(1200);
      await phone.shot("14-settings-drawer");
      await tap(phone, 375, 420);
      await phone.shot("15-settings");
    }
    if (doing("chat")) {
      await tapLabel(phone, "Open the sidebar");
      await phone.clickText("All conversations");
      await sleep(1200);
      await phone.shot("12-chat");
    }
    if (doing("open")) {
      // The drawer may still stand open on All conversations' list.
      if (!(await phone.evaluate<boolean>(`!!document.querySelector('[aria-label="Close the sidebar"]')`))) await tapLabel(phone, "Open the sidebar");
      await phone.clickText("All tasks");
      await sleep(1200);
      // A double tap on a card opens its run.
      const card = await phone.evaluate<{ x: number; y: number } | null>(`(() => { const el = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent === "add dark mode"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (card !== null) {
        await phone.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [card] });
        await phone.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(120);
        await phone.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [card] });
        await phone.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(1500);
        await phone.shot("11b-double-tapped");
        check(await phone.evaluate<boolean>(`${says("Conversation")} && ${says("Tasks")}`), "a double tap on a card opens its run");
      } else check(false, "a card to double-tap");
    }
  } finally {
    const said = [...(phone?.complaints ?? [])].filter((c) => !/disk_cache|gpu_disk|Gpu Cache/.test(c));
    if (said.length > 0) console.log(`the phone spoke up:\n  ${said.slice(0, 20).join("\n  ")}`);
    await phone?.close();
    await desktop.close();
  }
  console.log(`wrote ${OUT}`);
  if (failures.length > 0) {
    console.log(`${failures.length} check(s) failed`);
    process.exitCode = 1;
  }
}

await main();
