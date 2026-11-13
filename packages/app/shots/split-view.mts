/**
 * The three places and the split (decision 0025): an artifact moved between the main view, a split and
 * the side panel by its place buttons, the split's own path (Back, Forward, the path menu), its ⋯ menu,
 * focus taking a sidebar row onto the right pane's path, the narrow window's tabs, and a drag of the
 * artifact's title bar onto the drop zones.
 *
 * A real agent (claude-cli/haiku by default) publishes one small page; everything after is the window.
 * Passes when:
 *   - the card's Split opens the page in the right pane, its Split lit there;
 *   - the pane's Side panel moves it to the panel (the split closes) and the card's Split moves it back;
 *   - with the right pane focused, the conversation's row in the sidebar goes on the right pane's path,
 *     and the side panel follows it (the task's context);
 *   - Back and Forward walk the right pane's path, and holding Back lists it;
 *   - the ⋯ menu offers its four verbs, and Close this pane closes the split;
 *   - too narrow for two panes, they are two tabs;
 *   - dragging the card's title bar shows three drop zones, and a drop on Split opens it there.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/split-view.mts [--model claude-cli/haiku] [--task <id>]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Split view check";
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const MODEL = arg("--model") ?? "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "split-view");
const WORLD = join(import.meta.dirname, ".world-split-view");
const kept = arg("--task");
const FULL = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, "allow"]));

const SPLIT = '[aria-label="Split pane"]';

async function main(): Promise<void> {
  const world = kept !== undefined ? { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") } : buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  const app = await App.launch(world, { out: OUT, port: 9281 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const count = (selector: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const centre = (selector: string, which: "first" | "last" = "first"): Promise<{ x: number; y: number } | null> =>
    app.evaluate<{ x: number; y: number } | null>(
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = all[${which === "first" ? "0" : "all.length - 1"}]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
  const press = async (selector: string, which: "first" | "last" = "first"): Promise<void> => {
    await centre(selector, which);
    await settle(500);
    const at = await centre(selector, which);
    if (at === null) {
      await app.shot(`missing-${selector.replace(/\W+/g, "-").slice(0, 30)}`);
      throw new Error(`nothing matches ${selector}`);
    }
    await app.clickAt(at.x, at.y);
    await settle(1200);
  };
  /** The name the right pane's head shows. */
  const paneName = (): Promise<string> => app.evaluate<string>(`(() => { const el = document.querySelector('${SPLIT} [aria-label$="this pane\\'s path"]'); return el ? el.getAttribute("aria-label").replace(/: this pane's path$/, "") : ""; })()`);

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1600, 980);
    if (kept !== undefined) await settle(10_000);
    const made =
      kept !== undefined
        ? { taskId: kept }
        : await app.ipc<{ taskId: string }>("task:create", {
            title: TITLE,
            workflow: "chat/session",
            inputs: { message: 'Call show_artifact once with content "<!doctype html><title>Split test</title><h1>Split test</h1><p>One page.</p>" and file_path "split-test.html". Then say "done" and nothing else.' },
          });
    if (kept === undefined) await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: FULL } });
    await app.until(says(TITLE), "the conversation to be listed", 200);
    for (let i = 0; ; i++) {
      const list = await app.ipc<Array<{ kind: string }>>("artifact:published", { taskId: made.taskId });
      if (list.some((a) => a.kind === "page")) break;
      if (i > 480) throw new Error("no page published in four minutes");
      await settle(500);
    }
    await settle(kept === undefined ? 15_000 : 2000);
    await app.clickText(TITLE);
    await settle(3000);
    await app.shot("card");
    check((await count('[aria-label="Open in a split"]')) > 0, "the card offers the three places");
    check((await count('[aria-label="Show this artifact in the main view"]')) === 0, "the old eye is gone");

    // The card's Split: the page in the right pane, lit there.
    await press('[aria-label="Open in a split"]', "last");
    await settle(2000);
    await app.shot("in-split");
    check((await count(SPLIT)) === 1, "the column split");
    check((await count(`${SPLIT} [aria-label="Open in a split"][aria-pressed="true"]`)) === 1, "the right pane lights Split");
    check((await count(`${SPLIT} iframe, ${SPLIT} [data-island="artifact"]`)) > 0, "the right pane draws the page");

    // Moved to the side panel: the split closes, the panel lights its place.
    await press(`${SPLIT} [aria-label="Open in the side panel"]`);
    await settle(1500);
    await app.shot("moved-to-panel");
    check((await count(SPLIT)) === 0, "moving to the side panel closed the split");
    check((await count('[role="complementary"] [aria-label="Open in the side panel"][aria-pressed="true"]')) === 1, "the panel lights Side panel");
    // And back to a split from the card.
    await press('[aria-label="Open in a split"]', "first");
    await settle(1500);
    check((await count(SPLIT)) === 1 && (await count('[role="complementary"] [aria-label="Open in the side panel"][aria-pressed="true"]')) === 0, "the card's Split moved it out of the panel into a split");

    // Focus: the right pane was focused by the move; the sidebar's row goes on its path. The row is in
    // the project panel's Chat tab.
    const chatTab = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll('button, [role="tab"]')].find((b) => b.textContent.trim() === "Chat" && b.getBoundingClientRect().left < 400); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (chatTab !== null) await app.clickAt(chatTab.x, chatTab.y);
    await settle(1500);
    await press(`[data-drag-task="${made.taskId}"] button`);
    await settle(2500);
    await app.shot("row-on-right");
    const name = await paneName();
    check(name.includes(TITLE), `the sidebar row opened on the right pane's path (it shows "${name}")`);
    check(await app.evaluate<boolean>(`document.querySelector('[role="complementary"]')?.textContent.includes("Steps") ?? false`), "the side panel follows the focused pane (the task's context)");

    // The pane's own path: Back, Forward, the path menu.
    await press(`${SPLIT} [aria-label="Back"]`);
    const backTo = await paneName();
    check(backTo.toLowerCase().includes("split test") || backTo.includes("split-test"), `Back went to the page ("${backTo}")`);
    const forwardLabel = await app.evaluate<string>(`document.querySelector('${SPLIT} [aria-label^="Forward"]')?.getAttribute("aria-label") ?? ""`);
    await press(`${SPLIT} [aria-label^="Forward"]`);
    check((await paneName()).includes(TITLE), `Forward came back (${forwardLabel})`);
    // Holding Back lists the path.
    const back = await centre(`${SPLIT} [aria-label="Back"]`);
    if (back !== null) {
      await app.mouse("mousePressed", back);
      await settle(900);
      await app.mouse("mouseReleased", back);
      await settle(800);
    }
    await app.shot("path-menu", undefined, false);
    const pathItems = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.getAttribute("aria-label"))`);
    check(pathItems.length === 2, `holding Back lists the pane's path (${pathItems.join(" | ")})`);
    await app.press("Escape", 27);
    await settle(500);

    // The ⋯ menu.
    await press(`${SPLIT} [aria-label="This pane's menu"]`);
    await app.shot("pane-menu", undefined, false);
    const verbs = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.getAttribute("aria-label"))`);
    check(["Swap the panes", "Only this pane", "Move to the side panel", "Close this pane"].every((v) => verbs.includes(v)), `the ⋯ menu offers its four verbs (${verbs.join(" | ")})`);
    await press('[role="menu"] [aria-label="Close this pane"]');
    check((await count(SPLIT)) === 0, "Close this pane closed the split");

    // Narrow: two tabs over one pane.
    await press('[aria-label="Open in a split"]', "first");
    await app.resize(1000, 900);
    await settle(2000);
    await app.shot("narrow");
    check((await count('[role="tab"][aria-label="Main view"]')) > 0, "too narrow for two panes, they are tabs");
    await press('[role="tab"][aria-label="Main view"]', "last");
    await settle(800);
    await app.shot("narrow-left");
    check((await count(`${SPLIT}`)) === 1 && (await app.evaluate<boolean>(`getComputedStyle(document.querySelector('${SPLIT}')).display === "none"`)), "the Main view tab hides the right pane, kept");
    await app.resize(1600, 980);
    await settle(1500);
    await press(`${SPLIT} [aria-label="Close this pane"]`);

    // Drag: the card's title bar onto the drop zones.
    const bar = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const g = [...document.querySelectorAll('[role="group"][aria-label="Where to show it"]')].pop(); if (!g) return null; g.scrollIntoView({ block: "center" }); const r = g.parentElement.parentElement.getBoundingClientRect(); return { x: r.left + 60, y: r.top + 12 }; })()`,
    );
    if (bar === null) throw new Error("no card title bar to drag");
    await settle(600);
    const mainBox = await app.evaluate<{ left: number; width: number; top: number; height: number }>(`(() => { const r = document.querySelector('[data-place="main"]').getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, height: r.height }; })()`);
    const target = { x: Math.round(mainBox.left + mainBox.width * 0.75), y: Math.round(mainBox.top + mainBox.height / 2) };
    await app.mouse("mousePressed", bar);
    for (let i = 1; i <= 10; i++) await app.mouse("mouseMoved", { x: bar.x + ((target.x - bar.x) * i) / 10, y: bar.y + ((target.y - bar.y) * i) / 10 });
    await settle(400);
    await app.shot("drop-zones", undefined, false);
    const zones = await app.evaluate<number>(`[...document.body.querySelectorAll("*")].filter((d) => /^(Main view|Split|Side panel)$/.test(d.textContent ?? "") && d.children.length === 0).length`);
    check(zones >= 3, `dragging the title bar shows three drop zones (${String(zones)})`);
    await app.mouse("mouseReleased", target);
    await settle(2000);
    await app.shot("dropped");
    check((await count(`${SPLIT} [aria-label="Open in a split"][aria-pressed="true"]`)) === 1, "a drop on Split opened it in the right pane");

    // A sidebar row dragged onto the right pane goes on its path.
    const row = await centre(`[data-drag-task="${made.taskId}"]`);
    const pane = await centre(SPLIT);
    if (row === null || pane === null) throw new Error("no row or no right pane to drag between");
    await app.mouse("mousePressed", row);
    for (let i = 1; i <= 10; i++) await app.mouse("mouseMoved", { x: row.x + ((pane.x - row.x) * i) / 10, y: row.y + ((pane.y - row.y) * i) / 10 });
    await settle(300);
    await app.shot("row-drag", undefined, false);
    await app.mouse("mouseReleased", pane);
    await settle(2000);
    const after = await paneName();
    check(after.includes(TITLE), `a row dropped on the right pane went on its path ("${after}")`);

    // `--send`: the conversation in the right pane takes a message from its own composer (one more turn).
    if (process.argv.includes("--send")) {
      await press(`${SPLIT} textarea`);
      await app.type("Reply with the single word pineapple.");
      await app.press("Enter", 13);
      let heard = false;
      for (let i = 0; i < 240 && !heard; i++) {
        await settle(500);
        heard = await app.evaluate<boolean>(`[...document.querySelectorAll('${SPLIT} *')].some((e) => e.children.length === 0 && /pineapple/i.test(e.textContent ?? "") && !/single word/.test(e.textContent ?? ""))`);
      }
      await app.shot("sent-from-right");
      check(heard, "a message sent from the right pane's composer was answered there");
    }
  } finally {
    await app.close();
  }
  console.log(failures.length === 0 ? "split-view: every check passed" : `split-view: ${String(failures.length)} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
