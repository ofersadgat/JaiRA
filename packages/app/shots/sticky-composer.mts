/**
 * A conversation's composer opens on what it was left at (the person, 2026-10-05: "I start a
 * conversation and then change the permission set to chat/smart then I switch to a different
 * conversation where the composer correctly switches to chat/ask and then I switch back to this current
 * conversation the composer should switch back to chat/smart").
 *
 * Two conversations answered by a script (this rig spends nothing). In the first the permission stack's
 * bottom layer is swapped for another set by its crumb (decision 0023 §4.1) and nothing is sent; the second must open on its own; the first, opened
 * again — and again after the app restarts — must read what it was left at.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/sticky-composer.mts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "sticky-composer");
const WORLD = join(import.meta.dirname, ".world-sticky-composer");
const FIRST = "First conversation";
const SECOND = "Second conversation";

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });

  /** What the open conversation's permission stack reads — the bar, not the ruler's copies of it. */
  const STACK = '[role="group"][aria-label="Permissions"]';
  const chip = (app: App): Promise<string> => app.evaluate<string>(`(document.querySelector(${JSON.stringify(STACK)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`);
  const open = async (app: App, title: string): Promise<void> => {
    await app.clickText(title);
    await settle(1500);
  };

  let app = await App.launch(world, { out: OUT, port: 9263 });
  let first: string;
  let picked: string;
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 860);
    const made: string[] = [];
    for (const title of [FIRST, SECOND]) {
      const { taskId } = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: `Say hello (${title}).` } });
      await app.ipc("task:start", { taskId, fake: [{ output: "hello" }] });
      made.push(taskId);
    }
    first = made[0]!;
    await app.until(says(SECOND), "the conversations to be listed", 200);
    await app.clickText("Chat");
    await settle(1500);
    await open(app, FIRST);
    const before = await chip(app);
    // Whatever it opened on, a different one: the rig is about the change, not about a default.
    const current = /chat\/([a-z-]+)/.exec(before)?.[1];
    if (current === undefined) throw new Error(`the stack names no chat set at its bottom: "${before}"`);
    picked = current === "full" ? "chat/read-only" : "chat/full";
    // The bottom segment, its set's crumb, the sibling: two presses after the segment.
    await app.evaluate(`document.querySelector(${JSON.stringify(`${STACK} [aria-label="chat/${current}"]`)})?.click()`);
    await settle(800);
    await app.shot("first-segment");
    await app.clickText(`${current}.json`);
    await settle(400);
    await app.shot("first-crumb");
    await app.clickText(`${picked.slice("chat/".length)}.json`);
    await settle(1200);
    await app.press("Escape", 27);
    await app.shot("first-picked");
    if (!(await chip(app)).includes(picked)) throw new Error(`the chip did not take "${picked}": it reads "${await chip(app)}"`);

    await open(app, SECOND);
    await app.shot("second-opened");
    const second = await chip(app);
    if (second.includes(picked)) throw new Error(`the second conversation opened on the first one's "${picked}"`);
    console.log(`sticky-composer: the second conversation opens on its own: "${second}"`);

    await open(app, FIRST);
    await app.shot("first-again");
    const again = await chip(app);
    if (!again.includes(picked)) throw new Error(`back in the first conversation the chip reads "${again}", not "${picked}"`);
    console.log(`sticky-composer: back in the first conversation the chip reads "${again}" (it opened on "${before}")`);
  } finally {
    await app.close();
  }

  // And after the app is closed and opened again.
  app = await App.launch(world, { out: OUT, port: 9263 });
  try {
    await app.until(drawn, "the window to draw again");
    await app.resize(1180, 860);
    await app.clickText("Chat");
    await settle(1500);
    await open(app, FIRST);
    await app.shot("first-after-restart");
    const restarted = await chip(app);
    if (!restarted.includes(picked)) throw new Error(`after a restart the first conversation's chip reads "${restarted}", not "${picked}"`);
    const kept = await app.ipc<{ chatSettings?: object }>("task:detail", { taskId: first });
    console.log(`sticky-composer: after a restart it still reads "${restarted}"; the task keeps ${JSON.stringify(Object.keys(kept.chatSettings ?? {}))}`);
  } finally {
    await app.close();
  }
}

await main();
