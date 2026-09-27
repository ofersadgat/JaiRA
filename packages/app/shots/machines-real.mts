/**
 * Settings → Machines in the real app, with a real second machine: another base root on this computer
 * running `jaira serve` (the npm CLI), both published on loopback (`JAIRA_REACH=loopback`) in place of a
 * tailnet. The window pairs with it by the code it shows, then the page is photographed with the peer
 * online, and again with the code showing.
 *
 *   npm --workspace @jaira/app run build && (cd packages/cli && node build.mjs)
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/machines-real.mts
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "machines-real");
const WORLD = join(import.meta.dirname, ".world-machines-real");
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "cli.mjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  process.env["JAIRA_REACH"] = "loopback";
  const world = buildWorld(WORLD);
  const other = join(WORLD, "other-home");
  rmSync(other, { recursive: true, force: true });
  mkdirSync(other, { recursive: true });
  const jaira = (...args: string[]): string => execFileSync(process.execPath, [CLI, "--home", other, ...args], { encoding: "utf8", env: process.env });
  // The other machine: its own engine, named and reachable.
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
    jaira("machine", "tags", "gpu");
    const reach = JSON.parse(jaira("machine", "reach", "on")) as { url: string };
    const pair = JSON.parse(jaira("machine", "pair")) as { code: string };
    console.log(`the other machine: ${reach.url}, code ${pair.code}`);

    const app = await App.launch(world, { out: OUT, port: 9245 });
    try {
      await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
      await app.resize(1360, 900);
      await app.ipc("machines:rename", { label: "desk" });
      await app.ipc("machines:reach", { on: true });
      await app.ipc("machines:add", { address: reach.url, code: pair.code });
      await app.clickText("Settings");
      await sleep(500);
      await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Machines")); li?.click(); return !!li; })()`);
      await app.until(`document.body.innerText.includes("Online")`, "the other machine to show online");
      await sleep(400);
      await app.shot("machines");
      await app.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === "Show a code"); b?.click(); return !!b; })()`);
      await sleep(600);
      await app.shot("machines-code");
      console.log(JSON.stringify(JSON.parse(jaira("machine", "list")).machines));
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
