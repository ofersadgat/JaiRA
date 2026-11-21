/**
 * The folder chooser (`FolderBrowser`) in the real window, from Settings → Machines → Projects folder:
 * the machines down the left with their places, and the folders in columns, as the Open dialog has
 * them (the person, 2026-11-21: "you didnt fix the file picker").
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/folder-chooser.mts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { clickFirst, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "folder-chooser");
const WORLD = join(import.meta.dirname, ".world-folder-chooser");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  for (const name of ["notes", "sites/blog"]) mkdirSync(join(world.project, "..", name), { recursive: true });
  const app = await App.launch(world, { out: OUT, port: 9291 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 820);
    await app.clickText("Settings");
    await settle(1200);
    await app.clickText("Machines");
    await app.until(says("Projects folder"), "Settings → Machines", 60);
    await clickFirst(app, "Change…");
    await app.until(says("Choose a folder") + " && " + says("Home"), "the folder chooser with its places", 60);
    await settle(1500);
    await app.shot("1-chooser");
    await app.evaluate(`[...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === 'notes' && e.nextElementSibling?.getAttribute('aria-label') === 'Open notes')?.click()`);
    await app.until(says("Use notes on"), "notes chosen, named in the foot", 40);
    await settle(600);
    await app.shot("2-chosen");
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
