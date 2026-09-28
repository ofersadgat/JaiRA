/**
 * The desktop, kept open for iterating on universal copies (decision 0015).
 *
 *   npm --workspace @jaira/app run build:main          once, for the main process
 *   npx tsx packages/app/shots/studio.mts [--reseed]   leave it running
 *
 * Then, from another shell, the rigs that attach to it: `cascade.mts` (what the CSS does to an element)
 * and `pair.mts` (the desktop's page against the universal one, photographed and compared).
 *
 * The world is the fidelity gate's own (`parityWorld.mts`), seeded once and kept between runs. The
 * window loads One's DEV SERVER (`JAIRA_CLIENT_DEV`), so an edit to a copy is on the next page load —
 * no build between a change and its picture. The clock is held and animations are off (`holdStill`)
 * for as long as this runs, so two pictures of one state are comparable.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { STUDIO_PORT, drawn, seed } from "./parityWorld.mjs";
import { buildWorld, type World } from "./world.mjs";

const DIR = join(import.meta.dirname, ".world-studio");
const OUT = join(import.meta.dirname, "parity", "rn");
const CLIENT = join(import.meta.dirname, "..", "..", "client");
const DEV = "http://127.0.0.1:8081/";

async function main(): Promise<void> {
  let world: World;
  if (process.argv.includes("--reseed") || !existsSync(join(DIR, "home"))) {
    console.log("seeding the world (a minute or two)…");
    world = buildWorld(DIR);
    await seed(world, OUT);
  } else {
    world = { home: join(DIR, "home"), project: join(DIR, "project"), userData: join(DIR, "user-data") };
  }

  // One's dev server: the web pages the window loads, and Metro for a phone on the same port.
  const one: ChildProcess = spawn(process.execPath, [join(CLIENT, "..", "..", "node_modules", "one", "run.mjs"), "dev", "--port", "8081"], {
    cwd: CLIENT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  one.stdout?.on("data", (d: Buffer) => (said += String(d)));
  one.stderr?.on("data", (d: Buffer) => (said += String(d)));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(DEV)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  process.env["JAIRA_RENDERER"] = "one";
  process.env["JAIRA_CLIENT_DEV"] = DEV;
  const app = await App.launch(world, { out: OUT, port: STUDIO_PORT });
  // Let the window's own first load finish: navigating over it aborts it, and main reports the abort.
  await app.until("document.readyState === 'complete'", "the first load", 400);
  await app.holdStill(Date.UTC(2026, 8, 27, 21, 0, 0));
  await app.navigate(DEV);
  await app.until(drawn, "the desktop to draw from the dev server", 400);
  console.log(`studio ready: the desktop on CDP port ${STUDIO_PORT}, pages from ${DEV}`);

  const stop = async (): Promise<void> => {
    await app.close();
    one.kill();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  one.on("exit", (code) => {
    console.log(`the dev server stopped (${code}):\n${said.slice(-2000)}`);
    void stop();
  });
  // Stay up. The app process holds the window; this holds the session that keeps the clock held.
  await new Promise(() => undefined);
}

await main();
