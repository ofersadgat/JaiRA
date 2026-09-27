/**
 * One project across two machines, in the real app (decision 0013 §4): this window's clone and a clone
 * of the same repository on "another machine" — a second base root on this computer running the npm
 * `jaira serve`, both published on loopback (`JAIRA_REACH=loopback`). Each runs a task on its own clone;
 * the window shows ONE project, its board merged, every card chipped with where it runs. Then with
 * grouping off, the two workspaces listed apart.
 *
 *   npm --workspace @jaira/app run build && (cd packages/cli && node build.mjs)
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/machines-grouped.mts
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "machines-grouped");
const WORLD = join(import.meta.dirname, ".world-machines-grouped");
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "cli.mjs");
const REMOTE = "git@github.com:ofersadgat/jaira.git";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });

async function main(): Promise<void> {
  process.env["JAIRA_REACH"] = "loopback";
  const world = buildWorld(WORLD);
  git(world.project, "init", "-q");
  git(world.project, "remote", "add", "origin", REMOTE);
  // The other machine: its own base root, and its own clone of the same repository.
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
  // The same planning workflow the window's clone has, so the boards are the same shape.
  execFileSync(process.execPath, ["-e", `require("fs").cpSync(${JSON.stringify(join(world.project, ".jaira", "workflows"))}, ${JSON.stringify(join(clone, ".jaira", "workflows"))}, { recursive: true })`]);
  const server = spawn(process.execPath, [CLI, "--home", other, "serve"], { env: process.env, stdio: "ignore" });
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
    // A task on the other machine's clone, run there.
    const made = JSON.parse(jaira("task", "create", "--title", "port the updater to arm", "--workflow", "feature/plan", "--inputs", '{"issue":"arm"}', "--project", clone)) as { taskId: string };
    jaira("task", "start", made.taskId, "--fake", JSON.stringify(happyRules()), "--interactions", JSON.stringify({ "feature/plan/critique/human_review": [{ decision: "approve" }] }), "--project", clone);

    const app = await App.launch(world, { out: OUT, port: 9247 });
    try {
      await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
      await app.resize(1360, 820);
      await app.ipc("machines:rename", { label: "desk" });
      await app.ipc("machines:reach", { on: true });
      await app.ipc("machines:add", { address: reach.url, code: pair.code });
      const here = await app.ipc<{ taskId: string }>("task:create", { title: "add dark mode", workflow: "feature/plan", inputs: { issue: "dark" } });
      await app.ipc("task:start", { taskId: here.taskId, fake: happyRules(), interactions: { "feature/plan/critique/human_review": [{ decision: "approve" }] } });
      await app.until(`document.body.innerText.includes("port the updater to arm")`, "the other machine's task on the board");
      await app.until(`document.body.innerText.includes("2 workspaces")`, "the project to be one group");
      await sleep(800);
      await app.shot("grouped");
      await app.evaluate(`(() => { const s = document.querySelector('.side-foot .side-hit'); return true; })()`);
      await app.ipc("settings:write", { ui: { groupWorkspaces: false } });
      await app.evaluate("location.reload()");
      await app.until("document.getElementById('root') && document.getElementById('root').children.length > 0", "the window to draw again");
      await sleep(2500);
      await app.shot("separate");
    } finally {
      await app.close();
    }
  } finally {
    try {
      jaira("server", "stop");
    } catch {
      server.kill();
    }
  }
}

await main();
