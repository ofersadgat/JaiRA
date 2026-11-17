/**
 * Settings that follow the person (decision 0026), in the real app with a real second machine: another
 * base root on this computer running `jaira serve` (the npm CLI), both published on loopback
 * (`JAIRA_REACH=loopback`) in place of a tailnet, and paired the way a person pairs them.
 *
 *   npm --workspace @jaira/app run build && (cd packages/cli && node build.mjs)
 *   npx tsx packages/app/shots/settings-sync.mts
 *
 * The window saves a forge connection and a remote MCP server in Shared, and a look in Just you; the
 * other machine's files must then hold them — with its own command-started MCP server and WSL setting
 * untouched, and the window's loopback server not sent. Then the other machine changes a setting and the
 * window must show it. Settings → Machines is photographed with its new section. Fails on any of it.
 * Pictures land in `shots/out/settings-sync/`.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigView, MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { pairWithServer, serverOnTailnet } from "./pairLoopback.mjs";
import { clickFirst, drawn, says } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "settings-sync");
const WORLD = join(import.meta.dirname, ".world-settings-sync");
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "cli.mjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed += 1;
};

async function until(test: () => boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (test()) return true;
  return test();
}

const readJson = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

async function main(): Promise<void> {
  process.env["JAIRA_REACH"] = "loopback";
  const world = buildWorld(WORLD);
  const other = join(WORLD, "other-home");
  rmSync(other, { recursive: true, force: true });
  mkdirSync(other, { recursive: true });
  // The other machine's own, before it ever meets the window: a server it starts, and WSL.
  writeFileSync(join(other, "settings.json"), JSON.stringify({ execEnvironment: { wsl: "Ubuntu" }, mcp: { servers: { files: { command: "npx", args: ["files"] } } } }, null, 2));
  const jaira = (...args: string[]): string => execFileSync(process.execPath, [CLI, "--home", other, ...args], { encoding: "utf8", env: process.env });
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
    serverOnTailnet(jaira);

    const app = await App.launch(world, { out: OUT, port: 9247 });
    try {
      await app.until(drawn, "the window to draw");
      await app.resize(1360, 900);
      await app.ipc("machines:rename", { label: "desk" });
      await pairWithServer(app, jaira);
      for (let i = 0; i < 60; i += 1) {
        const view = await app.ipc<MachinesView>("machines:view", undefined);
        if (view.machines.some((m) => m.label === "mac-mini" && m.state === "online")) break;
        await sleep(250);
      }

      // The window sets things up once.
      const config = await app.ipc<ConfigView>("config:read", undefined);
      await app.ipc("config:write", {
        layer: "base",
        config: {
          ...((config.base ?? {}) as object),
          integrations: { forges: { work: { provider: "gitlab", host: "gitlab.work.example", credential: "WORK_TOKEN" } } },
          mcp: { servers: { linear: { url: "https://mcp.linear.app/sse" }, mine: { url: "http://localhost:3000/mcp" } } },
        },
      });
      await app.ipc("config:write", { layer: "you", config: { ...((config.you ?? {}) as object), appearance: { mode: "dark", palette: "ink" } } });

      const theirs = (): Record<string, unknown> => readJson(join(other, "settings.json"));
      check(
        await until(() => (theirs()["integrations"] as { forges?: Record<string, unknown> } | undefined)?.forges?.["work"] !== undefined),
        "the forge connection reached the other machine's Shared settings",
      );
      const servers = ((theirs()["mcp"] as { servers?: Record<string, unknown> } | undefined)?.servers ?? {}) as Record<string, unknown>;
      check(servers["linear"] !== undefined, "the remote MCP server reached it");
      check(servers["mine"] === undefined, "the window's loopback MCP server did not");
      check(JSON.stringify(servers["files"]) === JSON.stringify({ command: "npx", args: ["files"] }), "its own command-started MCP server is untouched");
      check(JSON.stringify(theirs()["execEnvironment"]) === JSON.stringify({ wsl: "Ubuntu" }), "its WSL setting is untouched");
      check(
        await until(() => (readJson(join(other, "personal-settings.json"))["appearance"] as { mode?: string } | undefined)?.mode === "dark"),
        "the look reached the other machine's Just you settings",
      );

      // The other machine changes a setting; the window shows it.
      const otherTheirs = theirs();
      writeFileSync(join(other, "settings.json"), JSON.stringify({ ...otherTheirs, autopilot: { askBelow: 0.45 } }, null, 2));
      // Its next look is within a minute; asking it to pair-refresh is not a thing, so the window asks it.
      await app.ipc("machines:syncSettings", { on: false });
      await app.ipc("machines:syncSettings", { on: true });
      let got: unknown;
      for (let i = 0; i < 80 && got === undefined; i += 1) {
        got = ((await app.ipc<ConfigView>("config:read", undefined)).base as { autopilot?: { askBelow?: number } } | null)?.autopilot?.askBelow;
        if (got === undefined) await sleep(250);
      }
      check(got === 0.45, "a change made on the other machine reached the window");
      check(((await app.ipc<ConfigView>("config:read", undefined)).base as { execEnvironment?: unknown }).execEnvironment === undefined, "the other machine's WSL setting did not");

      await app.clickText("Settings");
      await sleep(500);
      await clickFirst(app, "Machines");
      await app.until(says("Settings on every machine"), "the settings section to draw");
      await app.until(says("Last in step"), "the section to say when it was last in step");
      const text = await app.evaluate<string>("document.body.textContent ?? ''");
      check(text.includes("Kept on each machine") && text.includes("MCP servers started as a command, or reached at a loopback address"), "the section lists what is kept on each machine");
      check(text.includes("Agents' sign-ins") && text.includes("Claude Code and Codex follow"), "the section says the agents' sign-ins follow");
      // Tall enough to show the section whole.
      await app.resize(1360, 1700);
      await sleep(500);
      await app.shot("machines-settings");
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
  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
}

await main();
