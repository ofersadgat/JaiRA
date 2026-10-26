/**
 * Settings → Machines in the real app, with a real second machine: another base root on this computer
 * running `jaira serve` (the npm CLI), both published on loopback (`JAIRA_REACH=loopback`) in place of a
 * tailnet. The window signs in, finds it among the tailnet's devices, presses Pair and types the code it
 * shows (decision 0022 §5); then the page is photographed with the peer connected, and again with a code
 * another machine asked this one to show.
 *
 *   npm --workspace @jaira/app run build && (cd packages/cli && node build.mjs)
 *   npx tsx packages/app/shots/machines-real.mts
 *
 * It fails if the peer never shows online: the pairing is real (two engines, the one-time code), and
 * what it proves is that the page a person sees says so. Pictures land in `shots/out/machines-real/`.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { askOnce } from "@jaira/service/engineClient";
import type { MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { pairWithServer, serverOnTailnet } from "./pairLoopback.mjs";
import { clickFirst, drawn, says } from "./parityWorld.mjs";
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
    const otherUrl = serverOnTailnet(jaira);
    console.log(`the other machine: ${otherUrl}`);

    const app = await App.launch(world, { out: OUT, port: 9245 });
    try {
      await app.until(drawn, "the window to draw");
      await app.resize(1360, 900);
      await app.ipc("machines:rename", { label: "desk" });
      await pairWithServer(app, jaira);
      await app.clickText("Settings");
      await sleep(500);
      await clickFirst(app, "Machines");
      await app.until(says("mac-mini"), "the other machine to be listed");
      await app.until(`document.body.textContent.includes("paired · connected")`, "the other machine to show connected");
      await sleep(400);
      await app.shot("machines");
      // Another machine asks this one to pair: the code shows over the page (decision 0022 §5).
      const port = (await app.ipc<MachinesView>("machines:view", undefined)).self.port!;
      await askOnce({ url: `ws://127.0.0.1:${port}/engine` }, { t: "pair-ask", machine: { id: "m-studio-0000", label: "studio", os: "linux", form: "server", tags: [] } });
      await app.until(says("studio wants to pair with this machine"), "the code to show");
      await sleep(400);
      await app.shot("machines-code");
      await app.ipc("machines:refuse", undefined);
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
