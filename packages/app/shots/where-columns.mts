/**
 * Add a workspace → Where it goes, in the real window: the folder it goes in browsed in columns (the
 * folder above, it, and the new folder), a folder opened from the middle column, Rename, and the pane
 * narrow enough to be one column.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/where-columns.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { clickFirst, clickTitled, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "where-columns");
const WORLD = join(import.meta.dirname, ".world-where-columns");
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
const asks = (text: string): string => `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
const menuOpen = "document.querySelector('[role=menu]') !== null";

async function centreOf(app: App, title: string): Promise<{ x: number; y: number }> {
  const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
    const r = [...document.querySelectorAll('[title=' + ${JSON.stringify(JSON.stringify(title))} + ']')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => a.left - b.left)[0];
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (at === null) throw new Error(`nothing titled ${title}`);
  return at;
}

/** Press the control labelled exactly `label`. */
async function pressLabel(app: App, label: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => { const el = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); if (!el) return false; el.click(); return true; })()`);
  if (!hit) throw new Error(`nothing labelled ${label}`);
  await settle(1200);
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  git(world.project, "init", "-q", "-b", "main");
  git(world.project, "config", "user.email", "rig@example.com");
  git(world.project, "config", "user.name", "Rig");
  git(world.project, "config", "commit.gpgsign", "false");
  git(world.project, "remote", "add", "origin", "git@github.com:ofersadgat/atlas.git");
  writeFileSync(join(world.project, "index.ts"), "export {};\n");
  git(world.project, "add", "-A");
  git(world.project, "commit", "-q", "-m", "first");
  // Folders beside it, so the columns have something to show.
  const beside = join(world.project, "..");
  for (const name of ["notes", "playground", "sites", "sites/blog", "sites/docs"]) mkdirSync(join(beside, name), { recursive: true });
  git(join(beside, "playground"), "init", "-q");

  const app = await App.launch(world, { out: OUT, port: 9287 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 820);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const mine = projects.find((p) => p.kind === "user" && p.project.toLowerCase() === world.project.toLowerCase());
    if (mine === undefined) throw new Error("the checkout is not open");
    const tile = await centreOf(app, mine.project);
    await app.rightClickAt(tile.x, tile.y);
    await app.until(menuOpen + " && " + says("Add a workspace…"), "the project's menu");
    await clickFirst(app, "Add a workspace…");
    await app.until(asks("on which machine") + " && " + says("More options…"), "which machine, asked");
    await clickFirst(app, "More options…");
    await app.until(says("How it gets there"), "Add a workspace's dialog", 80);
    await settle(1500);
    const self = (await app.ipc<{ self: { label: string } }>("machines:view", undefined)).self.label;
    await clickTitled(app, [self]);
    await app.until(says("made here"), "the columns", 80);
    await settle(1500);
    await app.shot("1-columns");

    await pressLabel(app, "sites");
    await app.until(says("blog"), "sites opened", 40);
    // The folder chosen is planned at Where it goes: Add can be pressed there, and the step says where.
    await app.until(
      `(() => { const b = [...document.querySelectorAll('[role=button], button')].find((e) => (e.textContent ?? '').startsWith('Add ')); return b !== undefined && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })() && ${says("sites/atlas")}`,
      "Add enabled for the folder chosen",
      60,
    );
    await settle(600);
    await app.shot("2-into-a-folder");

    await clickFirst(app, "Rename");
    await settle(500);
    await app.shot("3-renaming");
    await app.press("Enter", 13).catch(() => undefined);

    await app.resize(760, 820);
    await settle(1200);
    await app.shot("4-narrow");
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
