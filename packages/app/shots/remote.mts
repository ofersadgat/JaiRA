/**
 * The S2 check of decision 0015: the One client, in an ordinary browser, drives a desktop's engine over
 * the throwaway spike socket.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/remote.mts
 *
 * The desktop starts with `JAIRA_SPIKE_WS`, which serves the client over HTTP and prints a token. A
 * headless Chrome loads `http://127.0.0.1:<port>/?token=…`, and must then (1) draw the desktop's
 * board, (2) see a task the DESKTOP starts appear by itself, which only a push can do, and (3) show
 * the same board the desktop shows, compared pixel by pixel.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "remote");
const PORT = 8765;
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;
const drawn = "document.getElementById('root') && document.getElementById('root').children.length > 0";

async function start(app: App, title: string): Promise<void> {
  const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
  await app.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
}

async function main(): Promise<void> {
  if (CHROME === undefined) throw new Error("no Chrome found to act as the remote browser");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const world = buildWorld(join(import.meta.dirname, ".world-remote"));
  process.env.JAIRA_SPIKE_WS = String(PORT);
  process.env.JAIRA_RENDERER = "one";

  const desktop = await App.launch(world, { out: OUT, port: 9250 });
  let browser: App | undefined;
  try {
    await desktop.until(drawn, "the desktop to draw");
    const token = /token ([0-9a-f]{32})/.exec(desktop.said)?.[1];
    if (token === undefined) throw new Error(`the desktop printed no token:\n${desktop.said.slice(0, 800)}`);
    await start(desktop, "add dark mode");
    await desktop.until(says("done"), "the first task to finish on the desktop");

    browser = await App.browse(CHROME, `http://127.0.0.1:${PORT}/?token=${token}`, { out: OUT, port: 9251 });
    await browser.until(drawn, "the browser to connect and draw");
    await browser.until(says("add dark mode"), "the browser to show the desktop's task");
    console.log("(1) the browser draws the desktop's board");

    await start(desktop, "rework the sync lint");
    await browser.until(says("rework the sync lint"), "a task started on the desktop to appear in the browser");
    console.log("(2) a task the desktop started appeared in the browser by push");
    await desktop.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "both tasks to finish");
    await browser.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "the browser to see both finish");

    await new Promise((r) => setTimeout(r, 1500));
    await desktop.hover(2, 2);
    await browser.hover(2, 2);
    await desktop.shot("desktop-board");
    await browser.shot("browser-board");
    const a = PNG.sync.read(readFileSync(join(OUT, "desktop-board.png")));
    const b = PNG.sync.read(readFileSync(join(OUT, "browser-board.png")));
    if (a.width !== b.width || a.height !== b.height) {
      console.log(`(3) sizes differ: desktop ${a.width}x${a.height}, browser ${b.width}x${b.height}`);
    } else {
      const diff = new PNG({ width: a.width, height: a.height });
      const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
      writeFileSync(join(OUT, "board.diff.png"), PNG.sync.write(diff));
      console.log(`(3) desktop vs browser board: ${n} px differ (${((100 * n) / (a.width * a.height)).toFixed(3)}%)`);
    }
    const complaints = [...desktop.complaints, ...browser.complaints].filter((c) => !/disk_cache|gpu_disk|Gpu Cache/.test(c));
    if (complaints.length > 0) console.log(`spoke up:\n  ${complaints.slice(0, 8).join("\n  ")}`);
  } finally {
    await browser?.close();
    await desktop.close();
  }
  console.log(`wrote ${OUT}`);
}

await main();
