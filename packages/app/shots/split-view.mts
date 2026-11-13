/**
 * The three places and the panes (decision 0025, as amended 2026-11-13: boards 07 and 09; "both panels
 * should be fully self contained. I.e. their ui should be identical. You should be able to close either
 * of them."): an artifact moved between the main view, a split and the side panel by its place buttons;
 * two panes drawn by one component — the same head (‹, ›, its path as crumbs, what is on top's own
 * controls, ⋯, ✕), the same body for the same thing on either side, the same menus; the room's own view
 * an entry on whichever pane holds it; closing either pane leaving the other as the unsplit view with its
 * path; the narrow window's tabs; the drags.
 *
 * A real agent (claude-cli/haiku by default) publishes one small page; everything after is the window.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/split-view.mts [--model claude-cli/haiku] [--task <id>] [--send]
 *
 * `--send` sends a message from the second pane's composer and waits for its answer there (one more turn).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Split view check";
const PAGE = "Split test";
const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const MODEL = arg("--model") ?? "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "split-view");
const WORLD = join(import.meta.dirname, ".world-split-view");
const kept = arg("--task");
const FULL = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, "allow"]));

const PANE = (i: number): string => `[data-pane="${String(i)}"]`;
const HEAD = (i: number): string => `[data-pane-head="${String(i)}"]`;
/** The controls every pane head has, whatever it shows. */
const CONTROLS = ["Back", "Forward", "This pane's menu", "Close this pane"];

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
  const text = (selector: string): Promise<string> => app.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
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
  /** A pane's crumbs, in order, as its head says them. */
  const crumbs = (head: string): Promise<string[]> =>
    app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${head} [role="navigation"] > *`)})].map((c) => c.textContent.replace(/^›/, "").replace(/^[▥◫¶]/, "").trim()).filter(Boolean)`);
  /** What a pane stands on: its last crumb. */
  const paneName = async (i: number): Promise<string> => (await crumbs(HEAD(i))).at(-1) ?? "";
  const disabled = (selector: string): Promise<boolean> => app.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-disabled") === "true"`);
  /** A head's own controls, in order: what every pane head has. */
  const controls = (i: number): Promise<string[]> =>
    app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${HEAD(i)} [aria-label]`)})].map((e) => e.getAttribute("aria-label")).filter((l) => ${JSON.stringify(CONTROLS)}.includes(l))`);
  /** How a pane draws an artifact: its head's places, the artifact's own title bars in its body, its frame. */
  const artifactLook = (i: number): Promise<string> =>
    app.evaluate<string>(
      `JSON.stringify({ head: document.querySelectorAll('${HEAD(i)} [role="group"][aria-label="Where to show it"]').length, inBody: document.querySelectorAll('${PANE(i)} [role="group"][aria-label="Where to show it"]').length - document.querySelectorAll('${HEAD(i)} [role="group"][aria-label="Where to show it"]').length, frame: document.querySelectorAll('${PANE(i)} iframe').length > 0, last: [...document.querySelectorAll('${HEAD(i)} [role="navigation"] > *')].pop()?.textContent.replace(/^\\u203a/, "").replace(/^[\\u25a5\\u25eb\\u00b6]/, "").trim() })`,
    );
  const middle = (selector: string): Promise<{ x: number; y: number } | null> =>
    app.evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, shot: string): Promise<string> => {
    await app.mouse("mousePressed", from);
    for (let i = 1; i <= 10; i++) await app.mouse("mouseMoved", { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 });
    await settle(400);
    const said = await app.evaluate<string>(`[...document.body.querySelectorAll("*")].map((d) => d.children.length === 0 ? d.textContent ?? "" : "").filter((s) => s === "Open here" || s.startsWith("This pane goes on to")).join(" | ")`);
    await app.shot(shot, undefined, false);
    await app.mouse("mouseReleased", to);
    await settle(2500);
    return said;
  };
  const splitFromCard = async (which: "first" | "last" = "first"): Promise<void> => {
    await press(`${PANE(0)} [aria-label="Open in a split"]`, which);
    await settle(2000);
  };

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

    // The conversation, in the Chat room: the project panel's Chat tab, its row.
    const chatTab = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll('button, [role="tab"]')].find((b) => b.textContent.trim() === "Chat" && b.getBoundingClientRect().left < 400); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (chatTab !== null) await app.clickAt(chatTab.x, chatTab.y);
    await settle(1500);
    await press(`[data-drag-task="${made.taskId}"] button`);
    await settle(3000);
    await app.shot("card");
    check((await count('[aria-label="Open in a split"]')) > 0, "the card offers the three places");
    check((await count("[data-pane-head]")) === 0 && (await text('[role="banner"]')).includes(TITLE), "one pane on the room: no pane head, the title bar says the room's place");

    // Split from the card: two panes, one head component.
    await splitFromCard("last");
    await app.shot("in-split", undefined, false);
    check((await count("[data-pane]")) === 2, "the column split into two panes");
    const c0 = await controls(0);
    const c1 = await controls(1);
    check(JSON.stringify(c0) === JSON.stringify(CONTROLS) && JSON.stringify(c1) === JSON.stringify(CONTROLS), `both heads have the same controls (${c0.join(", ")} | ${c1.join(", ")})`);
    check((await text(HEAD(0))).includes(TITLE), "the pane holding the room has the room's place in its head");
    check(!(await text('[role="banner"]')).includes(TITLE), "split, the title bar holds nothing of the room");
    const lookRight = await artifactLook(1);
    check(lookRight === JSON.stringify({ head: 1, inBody: 0, frame: true, last: PAGE }), `the artifact in a pane has one head: its places in the pane's head, no title bar under it (${lookRight})`);
    check((await count(`${HEAD(1)} [aria-label="Open in a split"][aria-pressed="true"]`)) === 1, "its head lights Split");

    // Moved to the side panel and back.
    await press(`${HEAD(1)} [aria-label="Open in the side panel"]`);
    await settle(1500);
    check((await count("[data-pane]")) === 1 && (await count('[role="complementary"] [aria-label="Open in the side panel"][aria-pressed="true"]')) === 1, "moving to the side panel closed the split, the panel lights it");
    await splitFromCard();
    check((await count("[data-pane]")) === 2 && (await count('[role="complementary"] [aria-label="Open in the side panel"][aria-pressed="true"]')) === 0, "the card's Split moved it out of the panel into a split");

    // Focus on the second pane: the sidebar's row goes on its path, as the real thread.
    await press(`[data-drag-task="${made.taskId}"] button`);
    await settle(3500);
    await app.shot("row-on-second", undefined, false);
    check((await crumbs(HEAD(1))).join(" › ") === `${PAGE} › ${TITLE}`, `the sidebar row went on the focused pane's path (${(await crumbs(HEAD(1))).join(" › ")})`);
    check((await count(`${PANE(1)} textarea`)) === 1 && /done/i.test(await text(PANE(1))) && !(await text(PANE(1))).includes("beside the conversation"), "the pane draws the conversation's thread with its composer");
    check(await app.evaluate<boolean>(`document.querySelector('[role="complementary"]')?.textContent.includes("Steps") ?? false`), "the side panel follows the focused pane (the task's context)");

    // The pane's path: a crumb, ›, the path menu.
    await press(`${HEAD(1)} [aria-label="Back to ${PAGE}"]`);
    check((await paneName(1)) === PAGE, `the crumb "${PAGE}" walked the pane back to it`);
    await press(`${HEAD(1)} [aria-label="Forward"]`);
    check((await paneName(1)) === TITLE, "› came forward again");
    const back = await centre(`${HEAD(1)} [aria-label="Back"]`);
    if (back !== null) {
      await app.mouse("mousePressed", back);
      await settle(900);
      await app.mouse("mouseReleased", back);
      await settle(800);
    }
    const pathItems = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent)`);
    await app.shot("path-menu", undefined, false);
    check(pathItems.length === 2 && pathItems[0]!.includes(TITLE) && pathItems[0]!.includes("here") && pathItems[1]!.includes(PAGE), `holding ‹ lists "This pane's path", newest first, here marked (${pathItems.join(" | ")})`);
    await app.press("Escape", 27);
    await settle(500);

    // The ⋯ menu: the same on both panes.
    const verbsOf = async (i: number): Promise<string[]> => {
      await press(`${HEAD(i)} [aria-label="This pane's menu"]`);
      const verbs = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.getAttribute("aria-label"))`);
      await app.press("Escape", 27);
      await settle(400);
      return verbs;
    };
    const v0 = await verbsOf(0);
    const v1 = await verbsOf(1);
    check(JSON.stringify(v0) === JSON.stringify(["Swap the panes", "Only this pane", "Move to the side panel", "Close this pane"]) && JSON.stringify(v0) === JSON.stringify(v1), `the ⋯ menu is the same on both panes (${v0.join(", ")})`);

    // Narrow: two tabs over one pane.
    await app.resize(1000, 900);
    await settle(2000);
    await app.shot("narrow");
    check((await count('[role="tab"][aria-label]')) >= 2, "too narrow for two panes, they are tabs");
    await press(`${PANE(1)} [role="tab"]`, "first");
    await settle(800);
    check(await app.evaluate<boolean>(`getComputedStyle(document.querySelector('${PANE(1)}')).display === "none"`), "the first tab hides the second pane, kept");
    await app.resize(1600, 980);
    await settle(1500);

    // Rows dragged onto either pane: "Open here", then on that pane's path.
    const row = await centre(`[data-drag-task="${made.taskId}"]`);
    await press(`${HEAD(1)} [aria-label="Back to ${PAGE}"]`);
    const second = await middle(PANE(1));
    if (row === null || second === null) throw new Error("no row or no second pane to drag between");
    const saidRight = await drag(row, second, "row-drag");
    check(saidRight.includes("Open here") && saidRight.includes(`This pane goes on to ${TITLE}; ‹ Back returns to ${PAGE}`), `a row over a pane says where it goes and what ‹ returns to (${saidRight})`);
    check((await crumbs(HEAD(1))).join(" › ") === `${PAGE} › ${TITLE}`, "dropped, it went on that pane's path");
    const first = await middle(PANE(0));
    const row2 = await centre(`[data-drag-task="${made.taskId}"]`);
    if (first === null || row2 === null) throw new Error("no first pane to drag onto");
    await drag(row2, first, "row-drag-first");
    check((await crumbs(HEAD(0))).at(-1) === TITLE && !(await disabled(`${HEAD(0)} [aria-label="Back"]`)), `dropped on the first pane, it went on the first pane's path (${(await crumbs(HEAD(0))).join(" › ")})`);
    await press(`${HEAD(0)} [aria-label="Back"]`);
    check((await text(HEAD(0))).includes(TITLE) && (await disabled(`${HEAD(0)} [aria-label="Back"]`)), "‹ on the first pane returned to the room");

    // `--send`: the conversation in the second pane takes a message from its own composer.
    if (process.argv.includes("--send")) {
      const word = `mango${String(Date.now() % 100000)}`;
      await press(`${PANE(1)} textarea`);
      await app.type(`Reply with the single word ${word}.`);
      await app.press("Enter", 13);
      let heard = false;
      for (let i = 0; i < 240 && !heard; i++) {
        await settle(500);
        heard = await app.evaluate<boolean>(`[...document.querySelectorAll('${PANE(1)} *')].some((e) => e.children.length === 0 && (e.textContent ?? "").trim().replace(/[.]$/, "") === ${JSON.stringify(word)})`);
      }
      await app.shot("sent-from-second", undefined, false);
      check(heard, `a message sent from the second pane's composer was answered there ("${word}")`);
    }

    // Close the second pane: the first is the only, unsplit view, its path kept (the room).
    await press(`${HEAD(1)} [aria-label="Close this pane"]`);
    await app.shot("close-right", undefined, false);
    check((await count("[data-pane]")) === 1 && (await count("[data-pane-head]")) === 0 && (await text('[role="banner"]')).includes(TITLE), "✕ on the second pane: the first is the unsplit view on the room, the title bar its place again");

    // Split again on the artifact; swap: the artifact looks the same on the other side.
    await splitFromCard();
    const before = await artifactLook(1);
    await press(`${HEAD(1)} [aria-label="This pane's menu"]`);
    await press('[role="menu"] [aria-label="Swap the panes"]');
    const swapped = await artifactLook(0);
    check(swapped === before, `swapped to the first pane, the artifact looks the same (${before} | ${swapped})`);
    check((await text(HEAD(1))).includes(TITLE), "the room went with its pane to the second place");
    await press(`${HEAD(1)} [aria-label="This pane's menu"]`);
    await press('[role="menu"] [aria-label="Swap the panes"]');

    // Close the FIRST pane: the second is the only view, its path kept — the artifact, headed.
    await press(`${HEAD(0)} [aria-label="Close this pane"]`);
    await settle(1500);
    await app.shot("close-left", undefined, false);
    const alone = await artifactLook(0);
    check((await count("[data-pane]")) === 1 && alone === before && (await count(`${HEAD(0)} [aria-label="Close this pane"]`)) === 0, `✕ on the first pane: the second is the only view with its path, the artifact as it was (${alone})`);
    check(!(await text('[role="banner"]')).includes(TITLE), "the room in no pane, the title bar says nothing of it");
  } finally {
    await app.close();
  }
  console.log(failures.length === 0 ? "split-view: every check passed" : `split-view: ${String(failures.length)} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
