/**
 * A project's own menu, and adding a workspace from the pill, in the real app (the person, 2026-11-20:
 * "if you right click on a project, you should have a menu with project actions. e.g. delete, settings,
 * anything else you can think of … the dropdown for workspace should have an option to add a new
 * workspace. if a machine is selected, it should add a workspace on that machine, otherwise it should
 * ask what machine"). One repository checked out once, and a second project beside it.
 *
 *   menu          the project's tile right-clicked in the rail: its verbs, Delete last
 *   menu-name     the same menu from the project's name at the head of the panel
 *   add-which     the menu's Add a workspace…: which machine, asked
 *   pill          the workspace half of the pill: the workspaces, then Add a workspace…
 *   pill-which    Add a workspace… with no machine chosen: which machine, asked
 *   pill-machine  the pill narrowed to this machine: Add a workspace… says where, and opens Add's card
 *   delete        Delete…: what leaves JaiRA, and that the folders stay
 *   deleted       confirmed: the project's tile gone, the window at the root, the folder still there
 *
 *   npm --workspace @jaira/app run build                 the main process and the client
 *   npx tsx packages/app/shots/project-menu.mts [--pages http://127.0.0.1:8081/]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { clickFirst, clickTitled, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "project-menu");
const WORLD = join(import.meta.dirname, ".world-project-menu");
const REMOTE = "git@github.com:ofersadgat/mist-server.git";
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;
/** A caption drawn in capitals reads so in `innerText`: matched whatever its case. */
const asks = (text: string): string => `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
const menuOpen = "document.querySelector('[role=menu]') !== null";

function checkout(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "rig@example.com");
  git(dir, "config", "user.name", "Rig");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", REMOTE);
  writeFileSync(join(dir, "cache.ts"), "export const cache = new Map();\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
}

/** The middle of the element titled `title` — the `nth` of them, left to right. */
async function centreOf(app: App, title: string, nth = 0): Promise<{ x: number; y: number }> {
  const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
    const els = [...document.querySelectorAll('[title=' + ${JSON.stringify(JSON.stringify(title))} + ']')]
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => a.left - b.left);
    const r = els[${nth}];
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (at === null) throw new Error(`nothing titled ${title}`);
  return at;
}

async function escape(app: App): Promise<void> {
  await app.press("Escape", 27);
  await settle(300);
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  checkout(world.project);
  const other = join(WORLD, "notes");
  mkdirSync(other, { recursive: true });
  initProject(other, world.home);
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: 9253 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    await app.ipc("project:open", { dir: other, remember: true });
    const projects = await app.ipc<Array<{ project: string; label: string; kind: string }>>("project:list", {});
    const mine = projects.find((p) => p.kind === "user" && p.project.toLowerCase() === world.project.toLowerCase());
    if (mine === undefined) throw new Error("the checkout is not open");
    await app.evaluate("location.reload()");
    await app.until(drawn, "the window to draw again");
    await settle(1500);

    // The tile in the rail: stand on the project, then right-click it.
    await app.clickAt(...Object.values(await centreOf(app, mine.project)) as [number, number]);
    await app.until(says("Files") + " && " + says("Chat"), "the project's rooms");
    await settle(600);
    const tile = await centreOf(app, mine.project, 0);
    await app.rightClickAt(tile.x, tile.y);
    await app.until(menuOpen + " && " + says("Delete…") + " && " + says("Copy path"), "the project's menu");
    await settle(300);
    await app.shot("menu", undefined, false);
    await clickFirst(app, "Add a workspace…");
    await app.until(asks("on which machine") + " && " + says("More options…"), "which machine, asked");
    await settle(300);
    await app.shot("add-which", undefined, false);
    await escape(app);

    // The name at the head of the panel: the same menu.
    const name = await centreOf(app, mine.project, 1);
    await app.rightClickAt(name.x, name.y);
    await app.until(menuOpen + " && " + says("Delete…"), "the project's menu from its name");
    await settle(300);
    await app.shot("menu-name", undefined, false);
    await escape(app);

    // The workspace half of the pill: Add a workspace…, and with no machine chosen, which machine.
    await clickTitled(app, ["Workspace: all"]);
    await app.until(menuOpen + " && " + says("All workspaces") + " && " + says("Add a workspace…"), "the workspace menu");
    await settle(300);
    await app.shot("pill", undefined, false);
    await clickFirst(app, "Add a workspace…");
    await app.until(asks("on which machine"), "which machine, asked from the pill");
    await settle(300);
    await app.shot("pill-which", undefined, false);
    await escape(app);

    // Narrowed to this machine: Add a workspace… goes straight to Add's card there.
    await clickTitled(app, ["Machine: all"]);
    await app.until(menuOpen + " && " + says("this machine"), "the machine menu");
    const machineRow = await app.evaluate<string>(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((e) => e.getAttribute('aria-label')).find((l) => l && l !== 'All machines' && l !== 'Add a workspace…' && l !== 'This machine') ?? ''`);
    await clickTitled(app, [machineRow]);
    await settle(400);
    await clickTitled(app, ["Workspace: all"]);
    await app.until(menuOpen + " && " + says("Add a workspace…") + " && " + says(`on ${machineRow}`), "Add a workspace… on the machine chosen");
    await settle(300);
    await app.shot("pill-machine", undefined, false);
    await clickFirst(app, "Add a workspace…");
    await app.until(`!(${asks("on which machine")}) && ${asks("bring")}`, "Add's card on that machine");
    await settle(600);
    await app.shot("pill-card", undefined, false);
    await escape(app);
    await clickTitled(app, ["Show every machine again"]).catch(() => undefined);

    // Delete: asked, then the project is out of JaiRA and its folder is still there.
    const tileAgain = await centreOf(app, mine.project, 0);
    await app.rightClickAt(tileAgain.x, tileAgain.y);
    await app.until(menuOpen + " && " + says("Delete…"), "the project's menu again");
    await clickFirst(app, "Delete…");
    await app.until(says("stay on disk"), "Delete's question");
    await settle(300);
    await app.shot("delete", undefined, false);
    await clickFirst(app, "Delete");
    await app.until(`!document.querySelector('[title=' + ${JSON.stringify(JSON.stringify(mine.project))} + ']')`, "the tile to go");
    await settle(800);
    await app.shot("deleted");
    const after = await app.ipc<Array<{ project: string }>>("project:list", {});
    if (after.some((p) => p.project.toLowerCase() === world.project.toLowerCase())) throw new Error("the project is still open");
    // The window was in it, so it is at the root: All tasks lit, no project's tile.
    const lit = await app.evaluate<string[]>("[...document.querySelectorAll('[aria-current=page]')].map((e) => e.getAttribute('aria-label'))");
    if (!lit.includes("All tasks") || lit.includes("notes")) throw new Error(`the window is not at the root: ${lit.join(", ")}`);
    if (!existsSync(join(world.project, "cache.ts"))) throw new Error("the project's files went");
    if (app.complaints.length > 0) throw new Error(app.complaints.join("\n"));
    console.log("project-menu: the menu from the tile and the name, Add a workspace asked and on the chosen machine, and Delete took the project out and left its files");
  } finally {
    await app.close();
  }
}

await main();
