/**
 * The focused pane is the main view as far as the rest of the app is concerned (decision 0025 §5, the
 * person, 2026-11-24: "whatever panel is focused should be treated as the active/main panel as far as
 * the rest of the app is concerned"). In the Chat room, with two conversations side by side:
 *
 *   1. the sidebar's selected row is the focused pane's conversation, either pane;
 *   2. focusing a pane moves no path — each pane keeps what it shows;
 *   3. a sidebar row pressed lands in the focused pane, which goes on to it; the other keeps its own;
 *   4. each pane's ‹ and › walk its own history, and its crumbs say where it stands (a conversation
 *      alone), never where it has been.
 *
 * Two conversations answered by a scripted model: it costs nothing and reaches no network.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/split-focus.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "split-focus");
const WORLD = join(import.meta.dirname, ".world-split-focus");
const PANE = (i: number): string => `[data-pane="${String(i)}"]`;
const HEAD = (i: number): string => `[data-pane-head="${String(i)}"]`;
const TITLES = ["Focus one", "Focus two", "Focus three"];

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9287 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const count = (selector: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const box = (selector: string): Promise<{ x: number; y: number } | null> =>
    app.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((one) => one.getClientRects().length > 0); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
  const press = async (selector: string): Promise<void> => {
    const at = await box(selector);
    if (at === null) {
      await app.shot(`missing-${selector.replace(/\W+/g, "-").slice(0, 30)}`);
      throw new Error(`nothing matches ${selector}`);
    }
    await app.clickAt(at.x, at.y);
    await settle(1500);
  };
  const crumbs = (head: string): Promise<string> =>
    app.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(`${head} [role="navigation"] > *`)})].map((c) => c.textContent.replace(/^›/, "").trim()).filter(Boolean).join(" › ")`);
  /** The sidebar's selected conversation rows: those drawn on the accent's tint, the pointer away. */
  const selectedRows = async (ids: Record<string, string>): Promise<string[]> => {
    await app.hover(700, 960);
    await settle(400);
    const lit = await app.evaluate<string[]>(
      `(() => { const out = []; for (const row of document.querySelectorAll('[data-drag-task]')) { const grounds = [row, ...row.querySelectorAll('*')].map((el) => getComputedStyle(el).backgroundColor).filter((c) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'); if (grounds.length > 0) out.push(row.getAttribute('data-drag-task')); } return out; })()`,
    );
    return lit.map((id) => Object.entries(ids).find(([, one]) => one === id)?.[0] ?? id);
  };

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1600, 980);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const project = projects.find((p) => p.kind === "user")?.project;
    if (project === undefined) throw new Error("the world has no project to talk in");
    const ids: Record<string, string> = {};
    for (const title of TITLES) {
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", conversation: true, inputs: { message: `Say hello from ${title}.` }, project });
      await app.ipc("task:start", {
        taskId: made.taskId,
        project,
        fake: [
          { promptIncludes: "The person's message", output: JSON.stringify({ verdict: "none", lesson: "", quote: "" }) },
          { promptIncludes: `Say hello from ${title}.`, output: `Hello from ${title}.` },
        ],
      });
      ids[title] = made.taskId;
    }
    for (const title of TITLES) await app.until(says(title), `${title} to be listed`, 200);
    await settle(3000);
    const [one, two, three] = TITLES as [string, string, string];

    // The Chat room, on the first conversation.
    const chatTab = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll('button, [role="tab"]')].find((b) => b.textContent.trim() === "Chat" && b.getBoundingClientRect().left < 400); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (chatTab !== null) await app.clickAt(chatTab.x, chatTab.y);
    await settle(1500);
    await press(`[data-drag-task="${ids[one]!}"] button`);
    await settle(2000);
    check((await crumbs(HEAD(0))).endsWith(one), `the pane is on the first conversation (${await crumbs(HEAD(0))})`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([one]), `its row is selected (${(await selectedRows(ids)).join(", ")})`);

    // The second beside it: its row dragged onto the room's Split band.
    const row = await box(`[data-drag-task="${ids[two]!}"]`);
    const main = await app.evaluate<{ left: number; top: number; width: number; height: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(PANE(0))}).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
    );
    if (row === null) throw new Error("no row for the second conversation");
    // The room's bands, left to right: Main view, Split, Side panel (a third each with no panel open, halves with one).
    const panelOpen = (await count('[role="complementary"]')) > 0 && (await count('[aria-label="Unfold the panel"]')) === 0;
    const to = { x: main.left + main.width * (panelOpen ? 0.75 : 0.5), y: main.top + main.height / 2 };
    await app.mouse("mousePressed", row);
    for (let i = 1; i <= 10; i++) await app.mouse("mouseMoved", { x: row.x + ((to.x - row.x) * i) / 10, y: row.y + ((to.y - row.y) * i) / 10 });
    await settle(400);
    await app.mouse("mouseReleased", to);
    await settle(3000);
    await app.shot("split", undefined, false);
    check((await count("[data-pane]")) === 2, "the column split into two panes");
    const left = await crumbs(HEAD(0));
    const right = await crumbs(HEAD(1));
    check(left.endsWith(one) && right.endsWith(two), `the first on one, the second on two (${left} | ${right})`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([two]), `the second pane focused: its conversation's row is selected (${(await selectedRows(ids)).join(", ")})`);

    // The first pane pressed: its row is selected, and no pane moved.
    await press(`${PANE(0)} textarea`);
    await app.shot("focus-first", undefined, false);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([one]), `the first pane focused: its row is selected (${(await selectedRows(ids)).join(", ")})`);
    check((await crumbs(HEAD(0))) === left && (await crumbs(HEAD(1))) === right, `focusing moved no path (${await crumbs(HEAD(0))} | ${await crumbs(HEAD(1))})`);

    // And the second again.
    await press(`${PANE(1)} textarea`);
    await app.shot("focus-second", undefined, false);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([two]), `the second pane focused again: its row is selected (${(await selectedRows(ids)).join(", ")})`);
    check((await crumbs(HEAD(0))) === left && (await crumbs(HEAD(1))) === right, "focusing again moved no path");

    // A sidebar row lands in the focused (second) pane; the first keeps its own.
    await press(`[data-drag-task="${ids[three]!}"] button`);
    await settle(1500);
    await app.shot("row-into-second", undefined, false);
    check((await crumbs(HEAD(0))) === left && (await crumbs(HEAD(1))) === three, `the row went to the focused pane, its crumbs that conversation alone (${await crumbs(HEAD(0))} | ${await crumbs(HEAD(1))})`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([three]), `and its row is selected (${(await selectedRows(ids)).join(", ")})`);

    // The second pane's ‹ and › walk its own history; the room follows it; the first pane stays.
    await press(`${HEAD(1)} [aria-label="Back"]`);
    await app.shot("second-back", undefined, false);
    check((await crumbs(HEAD(1))) === two && (await crumbs(HEAD(0))) === left, `‹ in the second pane went back to two, the first unmoved (${await crumbs(HEAD(0))} | ${await crumbs(HEAD(1))})`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([two]), `and two's row is selected (${(await selectedRows(ids)).join(", ")})`);
    await press(`${HEAD(1)} [aria-label="Forward"]`);
    check((await crumbs(HEAD(1))) === three && (await crumbs(HEAD(0))) === left, `› in the second pane came forward to three (${await crumbs(HEAD(0))} | ${await crumbs(HEAD(1))})`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([three]), `and three's row is selected (${(await selectedRows(ids)).join(", ")})`);

    // Back to the first pane: its conversation selected again, and a row there goes on ITS path.
    await press(`${PANE(0)} textarea`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([one]), `the first pane again: its row is selected (${(await selectedRows(ids)).join(", ")})`);
    check((await crumbs(HEAD(1))) === three, "the second pane kept where it was");
    await press(`[data-drag-task="${ids[two]!}"] button`);
    check((await crumbs(HEAD(0))) === two && (await crumbs(HEAD(1))) === three, `a row in the first pane took it to that conversation (${await crumbs(HEAD(0))} | ${await crumbs(HEAD(1))})`);
    // Its history, newest first, where it stands marked; the other pane's is not in it.
    const back = await box(`${HEAD(0)} [aria-label="Back"]`);
    if (back !== null) {
      await app.mouse("mousePressed", back);
      await settle(900);
      await app.mouse("mouseReleased", back);
      await settle(800);
    }
    const history = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent)`);
    await app.shot("history-menu", undefined, false);
    check(history.length === 2 && history[0]!.includes(two) && history[0]!.includes("here") && history[1]!.includes(one), `holding ‹ lists this pane's history (${history.join(" | ")})`);
    await app.press("Escape", 27);
    await settle(500);
    await press(`${HEAD(0)} [aria-label="Back"]`);
    check((await crumbs(HEAD(0))) === one && (await crumbs(HEAD(1))) === three, `‹ in the first pane went back to one, the second unmoved (${await crumbs(HEAD(0))} | ${await crumbs(HEAD(1))})`);
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([one]), `and one's row is selected (${(await selectedRows(ids)).join(", ")})`);
    await press(`${HEAD(0)} [aria-label="Forward"]`);
    check((await crumbs(HEAD(0))) === two, `› in the first pane came forward to two (${await crumbs(HEAD(0))})`);
    await press(`${HEAD(0)} [aria-label="Back"]`);

    // The second pane closed: the first is the only view, and stays selected.
    await press(`${HEAD(1)} [aria-label="Close this pane"]`);
    check((await count("[data-pane]")) === 1 && (await crumbs(HEAD(0))).endsWith(one), "✕ on the second: the first alone");
    check(JSON.stringify(await selectedRows(ids)) === JSON.stringify([one]), `its row still selected (${(await selectedRows(ids)).join(", ")})`);
  } catch (err) {
    console.error(err);
    failures.push(String(err));
    await app.shot("error").catch(() => undefined);
  } finally {
    await app.close();
  }
  console.log(failures.length === 0 ? "split-focus: every check passed" : `split-focus: ${String(failures.length)} failed`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

void main();
