/**
 * The three places and the panes (decision 0025 as the person ruled it on 2026-11-13: "like 09, each
 * panel goes the whole way top to bottom. they both have breadcrumb paths and are identical other than
 * potentially different paths. when you open something in a split view, the only thing different there
 * is that you're opening a different path. if you opened the same path, the two panels should look pixel
 * identical").
 *
 * A real agent (claude-cli/haiku by default) publishes one small page; everything after is the window.
 * What it checks, besides the panes' paths, menus, closing and drags: the SAME path in both panes at the
 * same width is the same picture, pixel for pixel (outside the 2px focus line along the focused pane's
 * top) — a conversation, then an artifact — and the unsplit main view of the conversation at that width
 * draws the same content as the pane.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/split-view.mts [--model claude-cli/haiku] [--task <id>] [--send]
 *
 * `--send` sends a message from the second pane's composer and waits for its answer there (one more turn).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
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
/** The focused pane's line along its top, which is all two panes on one path may differ by. */
const FOCUS_LINE = 2;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

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
  const crumbs = (head: string): Promise<string[]> =>
    app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${head} [role="navigation"] > *`)})].map((c) => c.textContent.replace(/^›/, "").replace(/^[▥◫¶]/, "").trim()).filter(Boolean)`);
  const paneName = async (i: number): Promise<string> => (await crumbs(HEAD(i))).at(-1) ?? "";
  const controls = (i: number): Promise<string[]> =>
    app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${HEAD(i)} [aria-label]`)})].map((e) => e.getAttribute("aria-label")).filter((l) => ${JSON.stringify(CONTROLS)}.includes(l))`);
  const box = (selector: string): Promise<Box | null> =>
    app.evaluate<Box | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const middle = async (selector: string): Promise<{ x: number; y: number } | null> => {
    const b = await box(selector);
    return b === null ? null : { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  };
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, shot?: string): Promise<string> => {
    await app.mouse("mousePressed", from);
    for (let i = 1; i <= 10; i++) await app.mouse("mouseMoved", { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 });
    await settle(400);
    const said = await app.evaluate<string>(`[...document.body.querySelectorAll("*")].map((d) => d.children.length === 0 ? d.textContent ?? "" : "").filter((s) => s === "Open here" || s.startsWith("This pane goes on to")).join(" | ")`);
    if (shot !== undefined) await app.shot(shot, undefined, false);
    await app.mouse("mouseReleased", to);
    await settle(2500);
    return said;
  };
  /** The window's picture as it is, the pointer away and nothing holding the keyboard. */
  const still = async (name: string): Promise<PNG> => {
    await app.evaluate(`document.activeElement?.blur?.()`);
    // Out, three times over: the driver's last move can land late.
    for (const y of [900, 901, 902]) await app.hover(30, y);
    // A scroller's bar keeps the look the pointer over it gave it until its style is worked out again
    // (Chromium paints `:hover::-webkit-scrollbar-thumb` stale): each bar's rule taken off and put back.
    await app.evaluate(`[...document.querySelectorAll('[data-pane] [data-scrollbar]')].forEach((el) => { const id = el.getAttribute('data-scrollbar'); el.removeAttribute('data-scrollbar'); void el.offsetHeight; el.setAttribute('data-scrollbar', id); })`);
    await settle(300);
    await settle(2500);
    await app.shot(name, undefined, false);
    return PNG.sync.read(readFileSync(join(OUT, `${name}.png`)));
  };
  /** How many pixels differ between two boxes of pictures (device pixels), below the top `skip` css px. */
  const differ = async (a: PNG, boxA: Box, b: PNG, boxB: Box, skip: number, name?: string): Promise<{ differ: number; of: number; where: string }> => {
    const scale = await app.evaluate<number>("devicePixelRatio");
    const w = Math.round(Math.min(boxA.width, boxB.width) * scale);
    const h = Math.round(Math.min(boxA.height, boxB.height) * scale);
    const top = Math.round(skip * scale);
    let differs = 0;
    // Where they differ, in css px from the boxes' top left: bands of rows, each with its columns.
    const bands: { from: number; to: number; left: number; right: number }[] = [];
    // The first box's picture, every pixel that differs from the second's painted red.
    const marked = new PNG({ width: w, height: h });
    for (let y = top; y < h; y++) {
      let left = -1;
      let right = -1;
      for (let x = 0; x < w; x++) {
        const ia = ((Math.round(boxA.top * scale) + y) * a.width + Math.round(boxA.left * scale) + x) * 4;
        const ib = ((Math.round(boxB.top * scale) + y) * b.width + Math.round(boxB.left * scale) + x) * 4;
        const im = (y * w + x) * 4;
        marked.data[im] = a.data[ia]!;
        marked.data[im + 1] = a.data[ia + 1]!;
        marked.data[im + 2] = a.data[ia + 2]!;
        marked.data[im + 3] = 255;
        if (a.data[ia] !== b.data[ib] || a.data[ia + 1] !== b.data[ib + 1] || a.data[ia + 2] !== b.data[ib + 2]) {
          marked.data[im] = 255;
          marked.data[im + 1] = 0;
          marked.data[im + 2] = 0;
          differs++;
          if (left < 0) left = x;
          right = x;
        }
      }
      if (left < 0) continue;
      const last = bands.at(-1);
      if (last !== undefined && last.to >= y - 1) {
        last.to = y;
        last.left = Math.min(last.left, left);
        last.right = Math.max(last.right, right);
      } else bands.push({ from: y, to: y, left, right });
    }
    const css = (n: number): string => String(Math.round(n / scale));
    if (name !== undefined && differs > 0) writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(marked));
    return { differ: differs, of: w * (h - top), where: bands.slice(0, 12).map((band) => `y ${css(band.from)}-${css(band.to)} x ${css(band.left)}-${css(band.right)}`).join("; ") };
  };
  /**
   * Both panes on one path compared as neither is focused: the first pane photographed while the second
   * is focused, the second while the first is (a press in the pane's margin focuses it).
   */
  const unfocusedPair = async (name: string): Promise<{ first: PNG; firstBox: Box; second: PNG; secondBox: Box }> => {
    const focusPane = async (i: number): Promise<void> => {
      // At the pane's left margin, half way down: nothing there takes the press (the head's empty row
      // moves the window, and an artifact's frame keeps its presses to itself).
      // (A conversation's margin half way down; an artifact's title bar under the head, its frame below.)
      const at = await box(PANE(i));
      const head = await box(HEAD(i));
      if (at !== null) await app.clickAt(Math.round(at.left + 8), Math.round(at.top + at.height * 0.5));
      if (at !== null && head !== null) await app.clickAt(Math.round(at.left + 6), Math.round(head.top + head.height + 14));
      await settle(600);
    };
    await focusPane(1);
    const first = await still(`${name}-a`);
    const firstBox = (await box(PANE(0)))!;
    await focusPane(0);
    const second = await still(`${name}-b`);
    const secondBox = (await box(PANE(1)))!;
    return { first, firstBox, second, secondBox };
  };
  /** The panes made exactly as wide as each other: the window grown or shrunk by what they differ. */
  const evenPanes = async (): Promise<{ w0: number; w1: number }> => {
    for (let i = 0; i < 4; i++) {
      const p0 = await box(PANE(0));
      const p1 = await box(PANE(1));
      if (p0 === null || p1 === null) throw new Error("not split");
      if (p0.width === p1.width) return { w0: p0.width, w1: p1.width };
      const size = await app.evaluate<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
      await app.resize(Math.round(size.w + (p1.width - p0.width)), size.h);
      await settle(1500);
    }
    const p0 = await box(PANE(0));
    const p1 = await box(PANE(1));
    return { w0: p0?.width ?? 0, w1: p1?.width ?? 0 };
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
            // A conversation is one the Chat view started (decision 0021): without this it is a plain
            // task, listed under Tasks and not under Chat.
            conversation: true,
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
    // The side panel open: the window's buttons are kept clear at its head's end, as the title bar's was.
    if ((await count('[aria-label="Unfold the panel"]')) > 0) await press('[aria-label="Unfold the panel"]');
    await app.shot("card");
    check((await count("[data-pane]")) === 1 && (await count("[data-pane-head]")) === 1 && (await count('[role="banner"]')) === 0, "unsplit is one pane, its head at the window's top; no title bar over it");
    check((await paneName(0)) === TITLE, `the conversation is the pane's path (${(await crumbs(HEAD(0))).join(" › ")})`);

    // Split from the card: two panes, one head component.
    await press(`${PANE(0)} [aria-label="Open in a split"]`, "last");
    await settle(2500);
    await app.shot("in-split", undefined, false);
    check((await count("[data-pane]")) === 2, "the column split into two panes");
    const c0 = await controls(0);
    const c1 = await controls(1);
    check(JSON.stringify(c0) === JSON.stringify(CONTROLS) && JSON.stringify(c1) === JSON.stringify(CONTROLS), `both heads have the same controls (${c0.join(", ")} | ${c1.join(", ")})`);
    const top0 = await box(HEAD(0));
    const top1 = await box(HEAD(1));
    check((top0?.top ?? 99) <= 2 && (top1?.top ?? 99) <= 2, `each pane goes top to bottom: both heads at the window's top (${String(top0?.top)}, ${String(top1?.top)})`);
    check((await paneName(1)) === PAGE && (await count(`${PANE(1)} [aria-label="Open in a split"][aria-pressed="true"]`)) === 1, "the second pane on the page, its Split lit");

    // Moved to the side panel and back.
    await press(`${PANE(1)} [aria-label="Open in the side panel"]`);
    await settle(1500);
    check((await count("[data-pane]")) === 1 && (await count('[role="complementary"] [aria-label="Open in the side panel"][aria-pressed="true"]')) === 1, "moving to the side panel closed the split, the panel lights it");
    await press(`${PANE(0)} [aria-label="Open in a split"]`);
    await settle(2000);
    check((await count("[data-pane]")) === 2, "the card's Split moved it out of the panel into a split");

    // Focus on the second pane: a sidebar press goes on its path. The split stands on the page's own
    // path, its conversation › it (the person, 2026-11-14): the conversation pressed is that path's
    // first step, so the pane walks back to it, the page ahead.
    check(JSON.stringify(await crumbs(HEAD(1))) === JSON.stringify([TITLE, PAGE]), `the split stands on the page's own path (${(await crumbs(HEAD(1))).join(" › ")})`);
    await press(`[data-drag-task="${made.taskId}"] button`);
    await settle(3500);
    check((await crumbs(HEAD(1))).join(" › ") === TITLE, `the sidebar row walked the focused pane back to the conversation (${(await crumbs(HEAD(1))).join(" › ")})`);
    check((await count(`${PANE(1)} textarea`)) === 1, "the pane draws the conversation with its composer");

    // The pane's path: ›, a crumb, the path menu.
    await press(`${HEAD(1)} [aria-label="Forward"]`);
    check((await paneName(1)) === PAGE, "› came forward to the page");
    await press(`${HEAD(1)} [aria-label="Back to ${TITLE}"]`);
    check((await paneName(1)) === TITLE, `the crumb "${TITLE}" walked the pane back to it`);
    await press(`${HEAD(1)} [aria-label="Forward"]`);
    const back = await centre(`${HEAD(1)} [aria-label="Back"]`);
    if (back !== null) {
      await app.mouse("mousePressed", back);
      await settle(900);
      await app.mouse("mouseReleased", back);
      await settle(800);
    }
    const pathItems = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent)`);
    await app.shot("path-menu", undefined, false);
    check(pathItems.length === 2 && pathItems[0]!.includes(PAGE) && pathItems[0]!.includes("here") && pathItems[1]!.includes(TITLE), `holding ‹ lists "This pane's path" (${pathItems.join(" | ")})`);
    await app.press("Escape", 27);
    await settle(500);
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

    // THE SAME PATH IN BOTH PANES — the conversation alone on each: the second closed, then the row
    // dropped on the Split band of the one pane, which opens a second on that path.
    // Both panes opened fresh: the first pane's own view has a history of scrolls, presses and widths
    // the second has not, and what a view keeps of those (the day over its thread, a chip's measured
    // width) is the view's, not the path's.
    const rowOnSplit = async (): Promise<void> => {
      const only = (await box(PANE(0)))!;
      const rowAt = await centre(`[data-drag-task="${made.taskId}"]`);
      if (rowAt === null) throw new Error("no row");
      await drag(rowAt, { x: Math.round(only.left + only.width * 0.85), y: Math.round(only.top + only.height / 2) });
    };
    await press(`${HEAD(1)} [aria-label="Close this pane"]`);
    await rowOnSplit();
    await press(`${HEAD(0)} [aria-label="Close this pane"]`);
    await rowOnSplit();
    check(JSON.stringify(await crumbs(HEAD(0))) === JSON.stringify([TITLE]) && JSON.stringify(await crumbs(HEAD(1))) === JSON.stringify([TITLE]), "both panes on the same path: the conversation alone");
    const widths = await evenPanes();
    check(widths.w0 === widths.w1 && widths.w0 % 2 === 0, `the panes are equally wide, an even width (${String(widths.w0)}, ${String(widths.w1)})`);
    // Each pane's conversation drawn afresh at this width, the same way: the page put on its path and
    // ‹ back off it. (A thread keeps what it measured at the widths it has stood at — a chip's place
    // to the half pixel; the first pane's has stood wider.)
    const afresh = async (i: number, place: string): Promise<void> => {
      await press(`${PANE(i)} [aria-label="${place}"]`, "last");
      await settle(1500);
      await press(`${HEAD(i)} [aria-label="Back"]`);
      await settle(2500);
    };
    await afresh(0, "Open in the main view");
    await afresh(1, "Open in a split");
    check(JSON.stringify(await crumbs(HEAD(0))) === JSON.stringify([TITLE]) && JSON.stringify(await crumbs(HEAD(1))) === JSON.stringify([TITLE]), "both on the conversation again, the page ahead of each");
    // Every scroller in the panes moved the same way, up and back to its end: what a scroll leaves drawn
    // (the day over the thread) is then the same in each.
    const toEnd = async (): Promise<void> => {
      // By the wheel, as a person scrolls: what the thread draws of a scroll is what a scroll makes it.
      // Up to the start, a step down, then to the end: the same way in each.
      for (const i of [0, 1]) {
        const at = await middle(PANE(i));
        if (at === null) continue;
        await app.wheel(at, -20000);
        await settle(400);
        await app.wheel(at, 600);
        await settle(400);
        await app.wheel(at, 20000);
        await settle(400);
      }
    };
    await toEnd();
    const chatShot = await still("same-path-chat");
    const b0 = (await box(PANE(0)))!;
    const b1 = (await box(PANE(1)))!;
    const chatPair = await unfocusedPair("same-path-chat");
    const chatDiff = await differ(chatPair.first, chatPair.firstBox, chatPair.second, chatPair.secondBox, 0, "diff-same-path-chat");
    console.log(`  boxes: ${JSON.stringify(b0)} ${JSON.stringify(b1)}`);
    console.log(`  same-path-chat: ${String(chatDiff.differ)} of ${String(chatDiff.of)} device pixels differ (panes ${String(b0.width)}x${String(b0.height)} css, each photographed unfocused) ${chatDiff.where}`);
    check(chatDiff.differ === 0, `the same conversation in both panes is the same picture (${String(chatDiff.differ)} pixels differ)`);

    // …and an artifact on both: each pane's › walks to the page ahead of it. (Not by its place buttons:
    // a place button MOVES it, closing it wherever else it stood — the person, 2026-11-14.) Both
    // paths: the conversation, then the page.
    await press(`${HEAD(0)} [aria-label="Forward"]`);
    await settle(1500);
    await press(`${HEAD(1)} [aria-label="Forward"]`);
    await settle(1500);
    const p0 = await crumbs(HEAD(0));
    const p1 = await crumbs(HEAD(1));
    check(JSON.stringify(p0) === JSON.stringify([TITLE, PAGE]) && JSON.stringify(p1) === JSON.stringify([TITLE, PAGE]), `both panes on the same path, the conversation then the page (${p0.join(" › ")} | ${p1.join(" › ")})`);
    await evenPanes();
    await still("same-path-artifact");
    const a0 = (await box(PANE(0)))!;
    const artPair = await unfocusedPair("same-path-artifact");
    const artDiff = await differ(artPair.first, artPair.firstBox, artPair.second, artPair.secondBox, 0, "diff-same-path-artifact");
    console.log(`  same-path-artifact: ${String(artDiff.differ)} of ${String(artDiff.of)} device pixels differ (panes ${String(a0.width)}x${String(a0.height)} css, each photographed unfocused) ${artDiff.where}`);
    check(artDiff.differ === 0, `the same artifact in both panes is the same picture (${String(artDiff.differ)} pixels differ)`);

    // The unsplit main view is one pane: the conversation alone at the pane's width draws what a pane did.
    await press(`${HEAD(0)} [aria-label="Back"]`);
    const paneWidth = b1.width;
    const head1 = (await box(HEAD(1)))?.height ?? 40;
    await press(`${HEAD(1)} [aria-label="Close this pane"]`);
    await app.shot("close-right", undefined, false);
    check((await count("[data-pane]")) === 1 && (await paneName(0)) === TITLE, "✕ on the second pane: the first is the unsplit view, its path kept");
    const one = (await box(PANE(0)))!;
    const size = await app.evaluate<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
    await app.resize(Math.round(size.w - (one.width - paneWidth)), size.h);
    await settle(2000);
    await afresh(0, "Open in the main view");
    await toEnd();
    const alone = (await box(PANE(0)))!;
    const unsplit = await still("unsplit-chat");
    const head = (await box(HEAD(0)))?.height ?? 40;
    const content = await differ(unsplit, { ...alone, top: alone.top + head, height: alone.height - head }, chatPair.second, { ...chatPair.secondBox, top: chatPair.secondBox.top + head1, height: chatPair.secondBox.height - head1 }, 0, "diff-unsplit-chat");
    console.log(`  unsplit vs pane, content below the head: ${String(content.differ)} of ${String(content.of)} device pixels differ (unsplit ${String(alone.width)} css wide, pane ${String(b1.width)}) ${content.where}`);
    check(alone.width === b1.width && content.differ === 0, `the unsplit main view of the conversation draws what the pane drew (${String(content.differ)} pixels differ)`);
    await app.resize(1600, 980);
    await settle(1500);
    await press(`${PANE(0)} [aria-label="Open in a split"]`, "last");
    await settle(2000);

    // Close the FIRST pane: the second is the only view, its path kept.
    await press(`${HEAD(0)} [aria-label="Close this pane"]`);
    await settle(1500);
    await app.shot("close-left", undefined, false);
    check((await count("[data-pane]")) === 1 && (await paneName(0)) === PAGE && (await count(`${HEAD(0)} [aria-label="Close this pane"]`)) === 0, "✕ on the first pane: the second is the only view with its path");

    // A row dragged onto a pane of a split: "Open here", then on that pane's path.
    await press(`[data-drag-task="${made.taskId}"] button`);
    await settle(2000);
    await press(`${PANE(0)} [aria-label="Open in a split"]`, "last").catch(() => undefined);
    await settle(2000);
    if ((await count("[data-pane]")) === 2) {
      const row = await centre(`[data-drag-task="${made.taskId}"]`);
      const target = await middle(PANE(1));
      if (row !== null && target !== null) {
        const said = await drag(row, target, "row-drag");
        check(said.includes("Open here") && said.includes(`This pane goes on to ${TITLE}; ‹ Back returns to ${PAGE}`), `a row over a pane says where it goes and what ‹ returns to (${said})`);
        check((await paneName(1)) === TITLE, "dropped, it went on that pane's path");
      }
    } else check(false, "split again for the row drag");

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
      check(heard, `a message sent from the second pane's composer was answered there ("${word}")`);
    }
  } finally {
    await app.close();
  }
  console.log(failures.length === 0 ? "split-view: every check passed" : `split-view: ${String(failures.length)} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
