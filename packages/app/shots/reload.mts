/**
 * A reload comes back where the window stood, and a conversation opens whatever was opened before it.
 *
 * The incident of 2026-10-06, replayed: two projects open, the window's connection having OPENED the
 * second one last (mist-server's part) while it stands on the first (JaiRA's), a conversation there.
 *
 *   ours       standing on the first project, its conversation opened from the Chat list: the answer
 *   reload     the window reloaded: still on the first project, the same conversation, the answer
 *   crossed    the second project's conversation opened, then the first's from its own list: the answer
 *              (it used to be read out of the second project and drawn empty)
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/reload.mts
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import type { World } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "reload");
// Outside this checkout, and each project a repository of its own: under it, both read as clones of
// JaiRA and were drawn as one project's two workspaces, whose rows carry their project — not the case.
const WORLD = join(tmpdir(), "jaira-shots-reload");
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });

function repository(dir: string, home: string, remote: string): void {
  initProject(dir, home);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", remote);
}
const OURS = { title: "Fix permission mode switching bug", answer: "The gate reads the permission live now." };
const THEIRS = { title: "Survey the untested handlers", answer: "Eleven handlers have no test." };

async function converse(app: App, project: string, said: { title: string; answer: string }): Promise<string> {
  const made = await app.ipc<{ taskId: string }>("task:create", { title: said.title, workflow: "chat/session", inputs: { message: said.title }, project });
  await app.ipc("task:start", { taskId: made.taskId, project, fake: [{ output: said.answer }] });
  return made.taskId;
}

/** Stand on a project by its sidebar row, as a person does. */
async function standOn(app: App, label: string): Promise<void> {
  await app.clickText(label);
  await settle(800);
}

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world: World = { home: join(WORLD, "home"), project: join(WORLD, "jaira-app"), userData: join(WORLD, "user-data") };
  const second = join(WORLD, "mist-server");
  repository(world.project, world.home, "git@gitlab.com:example/jaira-app.git");
  repository(second, world.home, "git@gitlab.com:example/mist-server.git");
  const app = await App.launch(world, { out: OUT, port: 9251 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    const projects = await app.ipc<Array<{ project: string; kind: string; label: string }>>("project:list", {});
    const first = projects.find((p) => p.kind === "user")!;
    await converse(app, first.project, OURS);
    // The window OPENS the second project, as it had mist-server: what a reload used to land on.
    await app.ipc("project:open", { dir: second, remember: true });
    const theirs = (await app.ipc<Array<{ project: string; kind: string; label: string }>>("project:list", {})).find((p) => p.kind === "user" && p.project !== first.project)!;
    await converse(app, theirs.project, THEIRS);
    await app.evaluate("location.reload()");
    await app.until(drawn, "the window to draw again");
    await settle(1500);

    await standOn(app, first.label);
    await app.clickText("Chat");
    await app.until(says(OURS.title), "the first project's conversation in its list");
    await app.clickText(OURS.title);
    await app.until(says(OURS.answer), "the conversation's answer");
    await app.shot("ours");

    await app.evaluate("location.reload()");
    await app.until(drawn, "the window to draw after the reload");
    await app.until(says(OURS.answer), "the same conversation, after the reload");
    // …and says it is in its own project, not wherever the window stands.
    await app.until(`document.body.innerText.includes("this machine / ${first.label}")`, "the thread's header naming its own project");
    await app.shot("reload");

    await standOn(app, theirs.label);
    await app.clickText("Chat");
    await app.until(says(THEIRS.title), "the second project's conversation in its list");
    await app.clickText(THEIRS.title);
    await app.until(says(THEIRS.answer), "the second project's answer");
    await standOn(app, first.label);
    await app.clickText("Chat");
    await app.until(says(OURS.title), "the first project's list again");
    await app.clickText(OURS.title);
    await app.until(says(OURS.answer), "the first project's conversation, opened after the second's");
    await app.shot("crossed");
    if (app.complaints.length > 0) throw new Error(`the window complained:\n${app.complaints.join("\n")}`);
    console.log("reload: the window came back where it stood, and each conversation opened from its own list");
  } catch (e) {
    // What was on screen when it gave up, beside the pictures that were taken.
    await app.shot("failed").catch(() => undefined);
    throw e;
  } finally {
    await app.close();
  }
}

await main();
