/**
 * A folder already on a machine joins its project (the person, 2026-11-21: "the add workspace flow
 * should also allow adding an existing workspace … also, if you add a new project and that project has
 * the same git remote as an existing project, it should be added to the existing project"), in the real
 * window:
 *
 *   1-card         Add's card, with `Or · use a folder already on <machine>`
 *   2-folders      the dialog at Project, beside the project's workspace: each clone chipped with its project
 *   3-refused      a clone of another repository chosen: refused, saying why
 *   4-joins        a clone of the project chosen: `Add project-2 to project`
 *   5-grouped      after it: one project of two workspaces
 *   6-open-joins   Open, a third clone: it says it joins, and joins
 *
 * Nothing is cloned or copied: every folder is opened where it is.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/existing-workspace.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ProjectSummary } from "@jaira/shared";
import { App } from "./driver.mjs";
import { clickFirst, clickTitled, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "existing-workspace");
// Not a hidden folder: Open's folder list leaves those out, and step 6 walks to it from the home folder.
const WORLD = join(import.meta.dirname, "out", "existing-workspace-world");
const REMOTE = "git@gitlab.com:acme/project.git";

function clone(dir: string, remote: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
}

/** Click the control labelled `label` in a folder row's `Choose`. */
async function choose(app: App, name: string): Promise<void> {
  const hit = await app.evaluate<boolean>(`(() => {
    const row = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(name)}) + ']');
    const button = row && [...row.parentElement.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === 'Choose');
    if (!button) return false;
    (button.closest('button, [role=button]') ?? button).click();
    return true;
  })()`);
  if (!hit) throw new Error(`no Choose for ${name}`);
  await settle(500);
}

/** In the open dialog, go into the folder named `name`. */
async function goInto(app: App, name: string): Promise<void> {
  const find = `[...document.querySelectorAll('[role=dialog] [aria-label], [aria-modal=true] [aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(name)})`;
  await app.until(`!!${find}`, `${name} in the folder list`, 60);
  await app.evaluate(`${find}.click()`);
  await settle(500);
}

const dialogText = `(() => [...document.querySelectorAll('[role=dialog], [aria-modal=true]')].map((d) => d.innerText).join('\\n---\\n'))()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  execFileSync("git", ["init", "-q"], { cwd: world.project });
  execFileSync("git", ["remote", "add", "origin", REMOTE], { cwd: world.project });
  clone(join(WORLD, "project-2"), REMOTE);
  clone(join(WORLD, "project-3"), "https://gitlab.com/acme/project");
  clone(join(WORLD, "other"), "git@github.com:acme/other.git");
  const app = await App.launch(world, { out: OUT, port: 9283 });
  const workspaces = async (): Promise<ProjectSummary[]> => (await app.ipc<ProjectSummary[]>("project:list")).filter((p) => p.kind === "user");
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 820);
    const self = (await app.ipc<{ self: { label: string } }>("machines:view", undefined)).self.label;

    // Add's card: the workspace half of the pill, Add a workspace…, this machine.
    await clickTitled(app, ["Workspace: all"]);
    await app.until(says("Add a workspace…"), "the workspace menu", 60);
    await clickFirst(app, "Add a workspace…");
    await app.until(says("More options…"), "which machine, asked", 60);
    await app.evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(self)}).click()`);
    await app.until(says(`use a folder already on ${self}`), "Add's card with its Or line", 80);
    await settle(1500);
    await app.shot("1-card", undefined, false);

    await clickFirst(app, `use a folder already on ${self}`);
    await app.until(says("project-2") + " && " + says("other"), "the dialog at Project, beside the project", 80);
    await settle(1500);
    const folders = await app.evaluate<string>(dialogText);
    console.log(folders);
    if (!/project-2\s*project\b/.test(folders)) throw new Error("project-2 is not chipped with its project");
    if (!/project\s*project · open/.test(folders)) throw new Error("the project's own folder is not chipped open");
    await app.shot("2-folders");

    await choose(app, "other");
    await app.until(says("other is github.com/acme/other, not project (gitlab.com/acme/project)."), "Add refusing another repository", 40);
    await app.shot("3-refused");

    await choose(app, "project-2");
    await app.until(says("Add project-2 to project"), "the primary adding it where it is", 40);
    await app.shot("4-joins");
    await clickFirst(app, "Add project-2 to project");
    for (let i = 0; ; i++) {
      const listed = await workspaces();
      if (listed.length === 2 && listed.every((p) => p.identity === "gitlab.com/acme/project")) break;
      if (i > 60) throw new Error(`project-2 did not join: ${JSON.stringify(listed.map((p) => [p.project, p.identity]))}`);
      await settle(250);
    }
    await settle(1500);
    await app.shot("5-grouped");

    // Open, a third clone of the project: from the home folder, walked to.
    await clickTitled(app, ["open another project"]);
    await clickFirst(app, "Open project…");
    await app.until(says("Where it goes"), "the Open dialog", 80);
    await settle(1000);
    const home = homedir();
    if (!WORLD.startsWith(home + sep)) throw new Error(`${WORLD} is not under ${home}`);
    for (const part of relative(home, WORLD).split(sep)) await goInto(app, part);
    await app.until(says("project-3"), "the world's folders", 60);
    await choose(app, "project-3");
    await app.until(says("The same repository as project: it becomes another of its workspaces, where it is. Nothing is copied."), "Open saying it joins", 40);
    await app.shot("6-open-joins");
    await clickFirst(app, "Next: where it goes");
    await app.until(says("Add project-3 to project"), "the primary adding it where it is", 40);
    await clickFirst(app, "Add project-3 to project");
    for (let i = 0; ; i++) {
      const listed = await workspaces();
      if (listed.length === 3 && listed.every((p) => p.identity === "gitlab.com/acme/project")) break;
      if (i > 60) throw new Error(`project-3 did not join: ${JSON.stringify(listed.map((p) => [p.project, p.identity]))}`);
      await settle(250);
    }
    await settle(1500);
    await app.shot("7-grouped-three");
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
