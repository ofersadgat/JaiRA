/**
 * Another machine's tasks, read while it is away, in the real app (decision 0013 §6): a second base root
 * on this computer runs the npm `jaira serve` with a clone of the same repository and a task that ran
 * there. The window pairs with it, keeps a copy of its tasks, and then the server stops — its card is
 * still on the board and its conversation still opens, from the copy.
 *
 *   npm --workspace @jaira/app run build && (cd packages/cli && node build.mjs)
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/machines-replica.mts
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "machines-replica");
const WORLD = join(import.meta.dirname, ".world-machines-replica");
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "cli.mjs");
const REMOTE = "git@github.com:ofersadgat/jaira.git";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });

/** The task files of every copy this window keeps. */
function copied(home: string): string[] {
  const root = join(home, "remote");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const machine of readdirSync(root)) {
    for (const workspace of readdirSync(join(root, machine))) {
      const tasks = join(root, machine, workspace, ".jaira", "system", "tasks");
      if (existsSync(tasks)) out.push(...readdirSync(tasks));
    }
  }
  return out;
}

async function main(): Promise<void> {
  process.env["JAIRA_REACH"] = "loopback";
  const world = buildWorld(WORLD);
  git(world.project, "init", "-q");
  git(world.project, "remote", "add", "origin", REMOTE);
  const other = join(WORLD, "other-home");
  const clone = join(WORLD, "other-clone");
  for (const dir of [other, clone]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  git(clone, "init", "-q");
  git(clone, "remote", "add", "origin", REMOTE);
  const jaira = (...args: string[]): string => execFileSync(process.execPath, [CLI, "--home", other, ...args], { encoding: "utf8", env: process.env });
  jaira("init", "--project", clone);
  execFileSync(process.execPath, ["-e", `require("fs").cpSync(${JSON.stringify(join(world.project, ".jaira", "workflows"))}, ${JSON.stringify(join(clone, ".jaira", "workflows"))}, { recursive: true })`]);
  const server = spawn(process.execPath, [CLI, "--home", other, "serve"], { env: process.env, stdio: "ignore" });
  let serving = true;
  const stop = (): void => {
    if (!serving) return;
    serving = false;
    try {
      jaira("server", "stop");
    } catch {
      server.kill();
    }
  };
  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        if (JSON.parse(jaira("server", "status")).running === true) break;
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    jaira("machine", "rename", "mac-mini");
    const reach = JSON.parse(jaira("machine", "reach", "on")) as { url: string };
    const pair = JSON.parse(jaira("machine", "pair")) as { code: string };
    const made = JSON.parse(jaira("task", "create", "--title", "port the updater to arm", "--workflow", "feature/plan", "--inputs", '{"issue":"arm"}', "--project", clone)) as { taskId: string };
    jaira("task", "start", made.taskId, "--fake", JSON.stringify(happyRules()), "--interactions", JSON.stringify({ "feature/plan/critique/human_review": [{ decision: "approve" }] }), "--project", clone);

    const app = await App.launch(world, { out: OUT, port: 9248 });
    try {
      await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
      await app.resize(1360, 820);
      await app.ipc("machines:rename", { label: "desk" });
      await app.ipc("machines:reach", { on: true });
      await app.ipc("machines:add", { address: reach.url, code: pair.code });
      await app.until(`document.body.innerText.includes("port the updater to arm")`, "the other machine's task on the board");
      // The copy: the window's engine keeps one by default.
      for (let i = 0; i < 60 && !copied(world.home).includes(`${made.taskId}.json`); i += 1) await sleep(500);
      if (!copied(world.home).includes(`${made.taskId}.json`)) throw new Error("the other machine's task was never copied here");
      await app.shot("online");

      stop();
      await app.until(`document.body.innerText.includes("port the updater to arm")`, "the card, from the copy");
      for (let i = 0; i < 40; i += 1) {
        const view = await app.ipc<{ machines: Array<{ state: string }> }>("machines:view", undefined);
        if (view.machines[0]?.state === "offline") break;
        await sleep(500);
      }
      await app.evaluate("location.reload()");
      await app.until(`!!document.body && document.body.innerText.includes("port the updater to arm")`, "the card after a reload, with mac-mini away");
      await sleep(800);
      await app.shot("offline-board");
      await app.clickText("port the updater to arm");
      await sleep(1500);
      await app.shot("offline-conversation");
      await app.clickText("Settings");
      await sleep(500);
      await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Machines")); li?.click(); return !!li; })()`);
      await app.until(`document.body.innerText.includes("Keep a copy of my other machines")`, "the copy switch");
      await sleep(500);
      await app.shot("setting");
    } finally {
      await app.close();
    }
  } finally {
    stop();
  }
}

await main();
