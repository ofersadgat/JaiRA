/**
 * Where a conversation runs, in the real app (decision 0013 §5, ruled 2026-10-02): one repository cloned
 * twice on this machine, so a conversation is placed.
 *
 *   start      the empty Chat room: the bar under the composer says "automatic", the sentence and the
 *              chip beside the title say the same
 *   list       the list the bar opens: Automatic, this machine with its load, its two workspaces with
 *              their checkouts
 *   chosen     this machine chosen: the bar, the sentence and the chip all say so
 *   waiting    a conversation sent to this machine while neither workspace takes a run (their caps are
 *              0): it WAITS for this machine — the Placing phase in the waiting tone above its message,
 *              the message amber with its pill, the box taking no reply, the list saying it waits
 *   started    room is made on the second clone: the conversation starts THERE, as it was asked to (a
 *              scripted model), and the thread follows it — Placed and Started above the message, the
 *              answer under it, the bar saying the workspace and its branch
 *
 *   npm --workspace @jaira/app run build:main            the main process
 *   npx tsx packages/app/shots/chat-placement.mts [--pages http://127.0.0.1:8081/]
 *
 * With `--pages` the window loads that dev server; without, the client as it was last built.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { App } from "./driver.mjs";
import { clickFirst, clickTitled, drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "chat-placement");
const WORLD = join(import.meta.dirname, ".world-chat-placement");
const REMOTE = "git@github.com:ofersadgat/mist-server.git";
const TITLE = "Review merge request 17";
const MESSAGE = "Do a code review of merge request 17";
const ANSWER = "The request changes the session cache and its two callers. I am reading the diff against `main` now.";
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;

/** A clone with one commit on `branch`, and a line changed since. */
function clone(dir: string, branch: string, changed: boolean): void {
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "rig@example.com");
  git(dir, "config", "user.name", "Rig");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", REMOTE);
  writeFileSync(join(dir, "cache.ts"), "export const cache = new Map();\nexport const hits = 0;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  if (changed) writeFileSync(join(dir, "cache.ts"), "export const cache = new Map<string, Session>();\nexport const hits = 0;\nexport const misses = 0;\n");
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const second = join(WORLD, "mist-server-3");
  initProject(second, world.home);
  clone(world.project, "main", false);
  clone(second, "feature/session-cache", true);
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: 9249 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    await app.ipc("project:open", { dir: second, remember: true });
    const projects = await app.ipc<Array<{ project: string; kind: string; identity?: string; machine?: { id: string } }>>("project:list", {});
    const mine = projects.filter((p) => p.kind === "user" && p.identity !== undefined);
    if (mine.length !== 2) throw new Error(`expected two workspaces of one repository, found ${mine.length}`);
    const first = mine.find((p) => !p.project.toLowerCase().includes("mist-server-3"))!;
    const other = mine.find((p) => p.project.toLowerCase().includes("mist-server-3"))!;
    const self = first.machine!.id;
    const view = await app.ipc<{ workspaces: Array<{ key: string; project: string }> }>("placement:view", { project: first.project });
    const keyOf = (project: string): string => view.workspaces.find((w) => w.project === project)!.key;
    const order = [keyOf(first.project), keyOf(other.project)];

    // The empty Chat room, in the first clone.
    await app.evaluate("location.reload()");
    await app.until(drawn, "the window to draw again");
    await app.until(says("CHAT") + " || " + says("Chat"), "the project's rooms");
    await settle(1500);
    await app.clickText("Chat");
    await app.until(says("What are we doing?"), "the empty Chat room");
    await app.until(says("automatic"), "the bar under the composer");
    await settle(600);
    await app.shot("start");

    await clickTitled(app, ["Where this conversation runs"]);
    await app.until(says("Automatic") + " && " + says("feature/session-cache"), "the list of where it can run");
    await settle(400);
    // As the window stands: a capture past the viewport is a resize, and the list closes on one.
    await app.shot("list", undefined, false);
    await clickFirst(app, "this machine");
    await app.until(says("on this machine, in its first workspace with room"), "the sentence to follow the choice");
    await settle(300);
    await app.shot("chosen");

    // Neither workspace takes a run: a conversation sent to this machine waits for THIS machine.
    await app.ipc("placement:setRules", { project: first.project, order, caps: { [order[0]!]: 0, [order[1]!]: 0 } });
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", inputs: { message: MESSAGE }, project: first.project });
    const started = await app.ipc<{ queued?: true }>("task:start", { taskId: made.taskId, project: first.project, runOn: { machine: self }, fake: [{ output: ANSWER }] });
    if (started.queued !== true) throw new Error("the conversation did not wait");
    await app.until(says(TITLE), "the waiting conversation to be listed");
    await app.clickText(TITLE);
    await app.until(says("queued") + " && " + says("workspaces asked"), "the waiting conversation's summary and message");
    await app.until(says("waiting for room on this machine"), "the bar to say what it waits for");
    await settle(600);
    await app.shot("waiting");

    // Room on the second clone only: it starts there, and the thread follows it.
    await app.ipc("placement:setRules", { project: first.project, order, caps: { [order[0]!]: 0 } });
    await app.until(says("reading the diff"), "the answer, in the workspace that took it", 400);
    await app.until(says("Placed") + " && " + says("Started"), "how it was placed, above its message");
    await app.until(says("feature/session-cache"), "the bar to say the workspace's branch");
    await settle(800);
    await app.shot("started");
    const queue = await app.ipc<unknown[]>("placement:queue", undefined);
    if (queue.length !== 0) throw new Error(`the queue still holds ${queue.length}`);
    console.log("chat-placement: the conversation waited for the machine it was sent to, started when it had room, and the thread followed it");
  } finally {
    await app.close();
  }
}

await main();
