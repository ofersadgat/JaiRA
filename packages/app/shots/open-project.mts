/**
 * Open and Add a workspace (decision 0027), and Settings' path, in the real window: the Open dialog at
 * its first step, Add's card from a machine's row in the project's Workspaces menu, Add a workspace… at
 * Where it goes, and the settings path with its `+` menu.
 *
 * Nothing is spent and nothing is cloned: the world has no forge and no paired machine, so the dialog
 * is seen with this machine's folders, and Add with this machine as the only place.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/open-project.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { clickFirst, clickTitled, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "open-project");
const WORLD = join(import.meta.dirname, ".world-open-project");

/** Click the first control whose accessible name ends with `tail`. */
async function clickLabelEnding(app: App, tail: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('[aria-label]')].find((e) => (e.getAttribute('aria-label') ?? '').endsWith(${JSON.stringify(tail)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!hit) throw new Error(`nothing labelled …${tail}`);
  await settle(400);
}

/** Where the open dialog is drawn, for the log: a dialog drawn off the page is not a dialog seen. */
const dialogBox = `(() => {
  const d = [...document.querySelectorAll('[role=dialog], [aria-modal=true]')].map((e) => { const b = e.getBoundingClientRect(); return [e.getAttribute('aria-label'), Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; });
  return JSON.stringify(d);
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9281 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 820);

    await clickTitled(app, ["open another project"]);
    await clickFirst(app, "Open project…");
    await app.until(says("Where it goes"), "the Open dialog", 80);
    await settle(1500);
    console.log("dialogs:", await app.evaluate<string>(dialogBox));
    await app.shot("1-open-dialog-project");
    await clickFirst(app, "Cancel");

    await clickLabelEnding(app, " — workspaces");
    await app.until(says("Add a workspace…"), "the project's Workspaces menu", 60);
    // A menu goes when the window resizes, so it is captured as the window is (no capture beyond it).
    await app.shot("2-workspaces-menu", undefined, false);
    // Add on a machine's row: its button shows under the pointer, and opens Add's card where the menu stood.
    const row = await app.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = [...document.querySelectorAll('[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]')].find((e) => (e.textContent ?? '').includes('This machine'));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    if (row === null) throw new Error("no This machine row in the Workspaces menu");
    await app.hover(row.x, row.y);
    await settle(300);
    await clickLabelEnding(app, "Add — This machine");
    await app.until(says("More…"), "Add's card", 80);
    await settle(2500);
    console.log("card:", await app.evaluate<string>(dialogBox));
    await app.shot("2b-add-card", undefined, false);
    await clickFirst(app, "Cancel");
    await clickLabelEnding(app, " — workspaces");
    await app.until(says("Add a workspace…"), "the project's Workspaces menu again", 60);
    await clickFirst(app, "Add a workspace…");
    await app.until(says("How it gets there"), "Add a workspace's dialog", 80);
    await settle(2500);
    const self = (await app.ipc<{ self: { label: string } }>("machines:view", undefined)).self.label;
    await clickTitled(app, [self]);
    await settle(3000);
    await app.shot("3-add-a-workspace-where");
    await clickFirst(app, "Next: how it gets there");
    await settle(2500);
    await app.shot("4-add-a-workspace-how");
    await clickFirst(app, "Cancel");

    await clickTitled(app, ["Settings"]);
    await settle(800);
    await app.shot("5-settings-path");
    await clickTitled(app, ["Narrow these settings"]);
    await settle(400);
    await app.shot("6-settings-plus", undefined, false);
    // A part in the path: `Settings › Just you › +` stays on one line, the + beside it.
    await clickFirst(app, "Just you");
    await settle(800);
    const parts = await app.evaluate<string>(`(() => {
      const nav = document.querySelector('[aria-label="Whose settings"]');
      if (!nav) return 'no path';
      const box = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      return JSON.stringify({ nav: box(nav), parent: box(nav.parentElement), children: [...nav.children].map((c) => [c.textContent, ...box(c)]) });
    })()`);
    console.log("path:", parts);
    await app.shot("7-settings-just-you");
    const plus = JSON.parse(parts) as { nav: number[]; children: [string, number, number, number, number][] };
    // One line: every part's middle at the same height (parts of different heights have different tops).
    const rows = new Set(plus.children.map((c) => Math.round((c[2] + c[4] / 2) / 4)));
    if (rows.size > 1) throw new Error(`the settings path wrapped: ${parts}`);
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
