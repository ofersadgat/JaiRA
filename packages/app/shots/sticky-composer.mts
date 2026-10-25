/**
 * A conversation's composer opens on what it was left at (the person, 2026-10-05: "I start a
 * conversation and then change the permission set to chat/smart then I switch to a different
 * conversation where the composer correctly switches to chat/ask and then I switch back to this current
 * conversation the composer should switch back to chat/smart").
 *
 * Two conversations answered by a script (this rig spends nothing). In the first the Permissions chip is
 * set to another permission set and nothing is sent; the second must open on its own; the first, opened
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

  /** What the open conversation's Permissions chip reads. */
  const chip = (app: App): Promise<string> =>
    app.evaluate<string>(`(document.querySelector('[aria-label="Permissions"]')?.innerText ?? "").trim()`);
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
    picked = before.includes("full access") ? "read-only" : "full access";
    await app.evaluate(`document.querySelector('[aria-label="Permissions"]')?.click()`);
    await settle(600);
    await app.clickText(picked);
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
