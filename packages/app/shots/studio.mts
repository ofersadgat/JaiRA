/**
 * The desktop, kept open for iterating on universal copies (decision 0015).
 *
 *   npm --workspace @jaira/app run build:main          once, for the main process
 *   npx tsx packages/app/shots/studio.mts [--reseed] [--port 9301]   leave it running
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

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
/**
 * Several studios can run side by side — one per person or agent copying a region — each with its own
 * world and window (`--port`), all sharing one dev server: the first to start runs it, the rest use it.
 */
const PORT = Number(arg("--port") ?? STUDIO_PORT);
const DIR = join(import.meta.dirname, PORT === STUDIO_PORT ? ".world-studio" : `.world-studio-${PORT}`);
const OUT = join(import.meta.dirname, "parity", PORT === STUDIO_PORT ? "rn" : `rn-${PORT}`);
const CLIENT = join(import.meta.dirname, "..", "..", "client");
const DEV = "http://127.0.0.1:8081/";

async function main(): Promise<void> {
  let world: World;
  if (process.argv.includes("--reseed") || !existsSync(join(DIR, "home"))) {
    console.log("seeding the world (a minute or two)…");
    world = buildWorld(DIR);
    await seed(world, OUT, PORT + 1000);
  } else {
    world = { home: join(DIR, "home"), project: join(DIR, "project"), userData: join(DIR, "user-data") };
  }

  // One's dev server: the web pages the window loads, and Metro for a phone on the same port. Started
  // here unless another studio already has it running — with a big heap, since several studios' edits
  // rebuild it all day (it ran out of the default once, and every studio lost its pages).
  const answering = async (): Promise<boolean> => {
    try {
      return (await fetch(DEV)).status < 500;
    } catch {
      return false;
    }
  };
  const running = await answering();
  let one: ChildProcess | undefined;
  let said = "";
  const serve = (): void => {
    one = spawn(process.execPath, ["--max-old-space-size=8192", join(CLIENT, "..", "..", "node_modules", "one", "run.mjs"), "dev", "--port", "8081"], {
      cwd: CLIENT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    one.stdout?.on("data", (d: Buffer) => (said = (said + String(d)).slice(-20_000)));
    one.stderr?.on("data", (d: Buffer) => (said = (said + String(d)).slice(-20_000)));
    // A server that stops is started again rather than taking this studio with it: the other studios
    // share it. Unless another studio got there first.
    one.on("exit", (code) => {
      console.log(`the dev server stopped (${code}); starting it again:\n${said.slice(-2000)}`);
      one = undefined;
      void answering().then((up) => (up ? undefined : serve()));
    });
  };
  if (!running) serve();
  for (let i = 0; i < 120; i++) {
    if (await answering()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  process.env["JAIRA_RENDERER"] = "one";
  process.env["JAIRA_CLIENT_DEV"] = DEV;
  const app = await App.launch(world, { out: OUT, port: PORT });
  // Let the window's own first load finish: navigating over it aborts it, and main reports the abort.
  await app.until("document.readyState === 'complete'", "the first load", 400);
  await app.holdStill(Date.UTC(2026, 8, 27, 21, 0, 0));
  await app.navigate(DEV);
  await app.until(drawn, "the desktop to draw from the dev server", 400);
  console.log(`studio ready: the desktop on CDP port ${PORT}, pages from ${DEV}${running ? " (a dev server another studio started)" : ""}`);

  const stop = async (): Promise<void> => {
    await app.close();
    one?.removeAllListeners("exit");
    one?.kill();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // Stay up. The app process holds the window; this holds the session that keeps the clock held.
  await new Promise(() => undefined);
}

await main();
