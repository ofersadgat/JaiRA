/**
 * The bar under the composer as buttons, in the real app (the person, 2026-11-20: "wherever you see
 * the machine/workspace chip … you should be able to click on it to switch machines / workspaces … the
 * branch label … should also allow you to click on it to switch branches"). One repository cloned twice
 * on this machine; a conversation answered in the first, waiting for its next message.
 *
 *   running      the bar: the machine, the workspace and the branch, each with its chevron
 *   workspaces   the workspace's list: this machine's two workspaces, the one it runs in ticked
 *   machines     the machine's list: the machines alone, no Automatic (it runs somewhere already)
 *   branches     the branch's menu: the field, the checkout's own branches, the one it is on ticked
 *   dirty        a branch chosen with a file not committed: what becomes of it, asked
 *   moved        the second workspace chosen: the conversation MOVED there — the bar says its folder
 *                and its branch, and the thread is the same thread
 *
 *   npm --workspace @jaira/app run build:main            the main process
 *   npx tsx packages/app/shots/chat-move.mts [--pages http://127.0.0.1:8081/]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { clickFirst, clickTitled, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "chat-move");
const WORLD = join(import.meta.dirname, ".world-chat-move");
const REMOTE = "git@github.com:ofersadgat/mist-server.git";
const TITLE = "Review merge request 17";
const MESSAGE = "Do a code review of merge request 17";
const ANSWER = "The request changes the session cache and its two callers. I am reading the diff against `main` now.";
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;

function clone(dir: string, branch: string): void {
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "rig@example.com");
  git(dir, "config", "user.name", "Rig");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", REMOTE);
  writeFileSync(join(dir, "cache.ts"), "export const cache = new Map();\nexport const hits = 0;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const second = join(WORLD, "mist-server-3");
  initProject(second, world.home);
  clone(world.project, "main");
  git(world.project, "branch", "release");
  git(world.project, "branch", "feature/review-notes");
  clone(second, "feature/session-cache");
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: 9251 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    await app.ipc("project:open", { dir: second, remember: true });
    const projects = await app.ipc<Array<{ project: string; kind: string; identity?: string }>>("project:list", {});
    const mine = projects.filter((p) => p.kind === "user" && p.identity !== undefined);
    if (mine.length !== 2) throw new Error(`expected two workspaces of one repository, found ${mine.length}`);
    const first = mine.find((p) => !p.project.toLowerCase().includes("mist-server-3"))!;

    // A conversation answered in the first clone, waiting for its next message.
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "session", conversation: true, inputs: { message: MESSAGE }, project: first.project });
    await app.ipc("task:start", { taskId: made.taskId, project: first.project, runOn: { project: first.project }, fake: [{ output: ANSWER }] });
    await app.evaluate("location.reload()");
    await app.until(drawn, "the window to draw again");
    await app.until(says("CHAT") + " || " + says("Chat"), "the project's rooms");
    await settle(1500);
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation to be listed");
    await app.clickText(TITLE);
    await app.until(says("reading the diff"), "the answer");
    await app.until(says("main"), "the bar to say the branch");
    await settle(800);
    await app.shot("running");

    await clickTitled(app, ["Move this conversation to another workspace"]);
    await app.until(says("mist-server-3") + " && " + says("feature/session-cache"), "this machine's workspaces");
    await settle(400);
    await app.shot("workspaces", undefined, false);
    await clickTitled(app, ["Move this conversation to another workspace"]);
    await settle(300);

    await clickTitled(app, ["Move this conversation to another machine"]);
    await app.until(says("this machine") + " && (" + says("CPU") + " || " + says("Memory") + ")", "the machines");
    await settle(400);
    await app.shot("machines", undefined, false);
    await clickTitled(app, ["Move this conversation to another machine"]);
    await settle(300);

    await clickTitled(app, ["Switch branch"]);
    await app.until(says("release") + " && " + says("feature/review-notes"), "the branches");
    await settle(400);
    await app.shot("branches", undefined, false);

    // A file not committed: choosing a branch asks first.
    writeFileSync(join(world.project, "cache.ts"), "export const cache = new Map<string, Session>();\nexport const hits = 0;\n");
    await clickTitled(app, ["Switch branch"]);
    await settle(300);
    await clickTitled(app, ["Switch branch"]);
    await app.until(says("release"), "the branches again");
    await clickFirst(app, "release");
    await app.until(says("not committed") + " && " + says("Bring them to release"), "the question about the uncommitted file");
    await settle(400);
    await app.shot("dirty", undefined, false);
    await clickFirst(app, "Cancel");
    await clickTitled(app, ["Switch branch"]);
    await settle(300);

    // Moved: the second workspace chosen from the workspace's list.
    await clickTitled(app, ["Move this conversation to another workspace"]);
    await app.until(says("mist-server-3"), "the workspaces again");
    await clickFirst(app, "mist-server-3");
    await app.until(says("feature/session-cache") + " && " + says("reading the diff"), "the bar to say the workspace it moved to, under the same thread", 200);
    await settle(1200);
    await app.shot("moved");
    const tasks = await app.ipc<Array<{ taskId: string }>>("task:list", { project: first.project });
    if (tasks.some((t) => t.taskId === made.taskId)) throw new Error("the conversation is still in the first workspace");
    console.log("chat-move: the bar's machine, workspace and branch open their lists, a dirty switch asks, and the conversation moved");
  } finally {
    await app.close();
  }
}

await main();
