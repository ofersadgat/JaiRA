/**
 * The desktop, kept open for iterating on universal copies (decision 0015).
 *
 *   npm --workspace @jaira/app run build:main          once, for the main process
 *   npx tsx packages/app/shots/studio.mts [--reseed] [--port 9301] [--built | --pages http://127.0.0.1:8094/] [--world <dir>]   leave it running
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
import { cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { App } from "./driver.mjs";
import { STUDIO_PORT, drawn, seed } from "./parityWorld.mjs";
import { buildWorld, type World } from "./world.mjs";

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
/**
 * Several studios can run side by side — one per person or agent copying a region — each with its own
 * world and window (`--port`), all sharing one dev server: the first to start runs it, the rest use it.
 */
const PORT = Number(arg("--port") ?? STUDIO_PORT);
/**
 * The world's folder: this studio's own, or (`--world <dir>`) one kept somewhere of its own — the world the
 * reference pictures were taken in, which has to stay where it is: its project's path is in what it draws.
 */
const DIR = arg("--world") !== undefined ? resolve(arg("--world")!) : join(import.meta.dirname, PORT === STUDIO_PORT ? ".world-studio" : `.world-studio-${PORT}`);
const OUT = join(import.meta.dirname, "parity", PORT === STUDIO_PORT ? "rn" : `rn-${PORT}`);
const CLIENT = join(import.meta.dirname, "..", "..", "client");
/**
 * Where the window's pages come from: the shared dev server, or (`--pages http://127.0.0.1:<port>/`) a
 * server of one's own that is already running — a dev server over a private copy of the sources, or the
 * built client served as files, for a long run (a freeze of the goldens) that the shared server's
 * reloads and restarts must not reach. This studio starts nothing in that case, and stops nothing.
 */
const OWN = arg("--pages");
/**
 * `--built`: the client as it was last built (`npm --workspace @jaira/client run build`), served as
 * files by this studio — what a freeze of the goldens and the gate against them run on. Nothing a copier
 * saves reaches it, a page load costs the shared dev server nothing, and the pictures are of what ships.
 * The build is copied beside the world first, so a rebuild part-way through a run changes nothing under it.
 */
const BUILT = process.argv.includes("--built");
const DEV = OWN ?? (BUILT ? `http://127.0.0.1:${PORT + 2000}/` : "http://127.0.0.1:8081/");

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

/** Serve the built client's folder: a route is its own page (`/rn` is `rn.html`), as the app's protocol serves it. */
function serveBuilt(): void {
  const built = join(CLIENT, "dist", "client");
  if (!existsSync(join(built, "index.html"))) throw new Error(`no built client at ${built}: npm --workspace @jaira/client run build`);
  const dir = join(DIR, "client");
  rmSync(dir, { recursive: true, force: true });
  cpSync(built, dir, { recursive: true });
  createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(normalize(dir))) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const page = join(dir, `${path.replace(/^\/|\/$/g, "") || "index"}.html`);
      file = existsSync(page) ? page : join(dir, "index.html");
    }
    // The assets are named by their content, so the window keeps them: a scene is a page load.
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store" });
    res.end(readFileSync(file));
  }).listen(PORT + 2000, "127.0.0.1");
}

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
  if (BUILT && OWN === undefined) serveBuilt();
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
  if (!running && OWN === undefined && !BUILT) serve();
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
  console.log(`studio ready: the desktop on CDP port ${PORT}, pages from ${DEV}${BUILT ? " (the built client)" : running ? " (a dev server another studio started)" : ""}`);

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
