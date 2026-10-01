/**
 * The One client in an ordinary browser, as a device on a desktop's engine (decisions 0015 S2, and 0013
 * as amended 2026-09-30): served by the engine's own loopback listener, paired by the one-time code the
 * desktop shows, and connected over the engine's transport — the same frames another machine speaks.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/remote.mts
 *
 * The desktop shows a pairing code (`machines:pairCode`, what Settings → Machines → Pair a machine
 * presses) and says which loopback port its engine listens on. A headless Chrome loads
 * `http://127.0.0.1:<port>/?code=…` from that listener, and must then (1) pair and draw the desktop's
 * board, (2) see a task the DESKTOP starts appear by itself, which only a push can do, (3) show the same
 * board the desktop shows, compared pixel by pixel, (4) WRITE: answer a gate the desktop's run parked
 * at, which the desktop's own store then no longer holds, (5) come back after a reload with no code —
 * the token it kept — (6) be sent back to the Connect screen when the desktop forgets it, (7) pair
 * again from the universal shell's page (`/rn`), with the code typed into that screen, (8) say so when
 * a kept machine does not answer, and forget it when asked, and (9) say "Disconnected … Reconnecting…"
 * across the window when the desktop goes away under it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { happyRules } from "@jaira/runtime";
import type { MachinesView } from "@jaira/shared";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "remote");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;
const drawn = "document.getElementById('root') && document.getElementById('root').children.length > 0";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function start(app: App, title: string, fake: unknown = happyRules()): Promise<string> {
  const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
  await app.ipc("task:start", { taskId: made.taskId, fake });
  return made.taskId;
}

async function main(): Promise<void> {
  if (CHROME === undefined) throw new Error("no Chrome found to act as the remote browser");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const world = buildWorld(join(import.meta.dirname, ".world-remote"));
  process.env.JAIRA_RENDERER = "one";

  const desktop = await App.launch(world, { out: OUT, port: 9250 });
  let browser: App | undefined;
  try {
    await desktop.until(drawn, "the desktop to draw");
    await start(desktop, "add dark mode");
    await desktop.until(says("done"), "the first task to finish on the desktop");

    // What "Pair a machine" shows, and where this engine listens: the browser needs nothing else.
    const shown = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    const port = shown.self.port;
    if (port === undefined || shown.pairing === undefined) throw new Error("the desktop's engine is not listening for devices, or showed no code");
    const page = `http://127.0.0.1:${port}/`;
    browser = await App.browse(CHROME, `${page}?code=${encodeURIComponent(shown.pairing.code)}`, { out: OUT, port: 9251 });
    await browser.until(drawn, "the browser to pair, connect and draw");
    await browser.until(says("add dark mode"), "the browser to show the desktop's task");
    const paired = await desktop.ipc<MachinesView>("machines:view", undefined);
    const device = paired.devices[0];
    if (device === undefined || paired.devices.length !== 1 || !device.connected || device.kind !== "browser") throw new Error(`the desktop does not list the browser as a connected device: ${JSON.stringify(paired.devices)}`);
    if (paired.machines.length !== 0) throw new Error("the browser was remembered as a machine");
    if ((await browser.evaluate<string>("location.search")).includes("code")) throw new Error("the code was left in the address bar");
    console.log(`(1) the browser paired by code as "${device.label}", and draws the desktop's board`);

    await start(desktop, "rework the sync lint");
    await browser.until(says("rework the sync lint"), "a task started on the desktop to appear in the browser");
    console.log("(2) a task the desktop started appeared in the browser by push");
    await desktop.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "both tasks to finish");
    await browser.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "the browser to see both finish");

    await sleep(1500);
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

    // A write from the browser: the desktop's run parks at its gate, and the browser answers it.
    const parked = await start(desktop, "plan the offline mode", blockedAtTheGate());
    const pendingFor = async (): Promise<number> => (await desktop.ipc<Array<{ taskId: string }>>("interaction:pending", undefined)).filter((p) => p.taskId === parked).length;
    for (let i = 0; i < 60 && (await pendingFor()) === 0; i++) await sleep(500);
    if ((await pendingFor()) !== 1) throw new Error("the desktop's run never parked at its gate");
    await browser.until(says("Review the critique result."), "the browser to be offered the gate");
    await browser.clickText("Review the critique result.");
    await browser.until(says("request_changes"), "the gate to open in the browser, with its options");
    await browser.shot("browser-gate");
    await browser.clickText("approve");
    for (let i = 0; i < 60 && (await pendingFor()) !== 0; i++) await sleep(500);
    if ((await pendingFor()) !== 0) throw new Error("the browser's answer did not reach the desktop's engine: the gate is still parked");
    const after = await desktop.ipc<Array<{ taskId: string; status: string }>>("task:list", {});
    console.log(`(4) the browser answered the gate; the desktop's task is now "${after.find((t) => t.taskId === parked)?.status ?? "?"}"`);
    await browser.shot("browser-answered");

    // A reload carries no code: the token it kept connects it.
    await browser.navigate(page);
    await browser.until(drawn, "the browser to reconnect with its kept token");
    await browser.until(says("plan the offline mode"), "the reloaded browser to show the board");
    console.log("(5) reloaded with no code, the browser connected by the token it kept");

    // Forgotten on the desktop, it is dropped, refused, and back at the Connect screen saying why.
    await desktop.ipc("machines:forget", { id: device.id });
    await browser.until(says("Connect to a JaiRA machine"), "the forgotten browser to return to the Connect screen");
    await browser.until(says("forgotten there"), "the Connect screen to say why");
    await browser.shot("browser-forgotten");
    if ((await desktop.ipc<MachinesView>("machines:view", undefined)).devices.length !== 0) throw new Error("the desktop still lists the forgotten browser");
    console.log("(6) forgotten on the desktop, the browser was dropped and is back at the Connect screen");

    // The universal shell's page, as a phone draws it: the same Connect screen, with the code typed.
    await browser.navigate(`${page}rn`);
    await browser.until(says("Connect to a JaiRA machine"), "the universal page's Connect screen");
    const again = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    await browser.evaluate(`document.querySelector('input[aria-label="Code"]').focus()`);
    await browser.type(again.pairing!.code);
    await browser.shot("rn-connect");
    await browser.clickText("Pair");
    await browser.until(drawn, "the universal page to pair and draw");
    await browser.until(says("plan the offline mode"), "the universal shell to show the board");
    await sleep(1000);
    await browser.shot("rn-board");
    console.log("(7) the universal shell's page paired by a typed code and draws the board");

    // A kept machine that cannot be reached at launch: the screen says which and why, keeps trying, and
    // offers to forget it. Stood in for by pointing the kept pairing at a port nothing listens on.
    await browser.evaluate(`(() => { const p = JSON.parse(localStorage.getItem("jaira.pairing")); p.url = "ws://127.0.0.1:9/engine"; p.address = "127.0.0.1:9"; localStorage.setItem("jaira.pairing", JSON.stringify(p)); })()`);
    await browser.navigate(`${page}rn`);
    await browser.until(says("Connecting to"), "the screen for a kept machine being connected to");
    await browser.until(says("Forget this machine"), "the offer to forget it");
    await browser.until(`/nothing answers|did not answer|could not reach/i.test(document.body.innerText)`, "why it is not connected");
    await browser.shot("rn-unreachable");
    await browser.clickText("Forget this machine");
    await browser.until(says("Connect to a JaiRA machine"), "the form, once the machine is forgotten");
    if ((await browser.evaluate<string | null>(`localStorage.getItem("jaira.pairing")`)) !== null) throw new Error("the forgotten machine's token was kept");
    console.log("(8) a kept machine that does not answer is said so, and Forget this machine brings the form back");

    // The engine going away under a connected window: the shell says so across its top and keeps trying.
    const last = await desktop.ipc<MachinesView>("machines:pairCode", undefined);
    await browser.navigate(`${page}rn?code=${encodeURIComponent(last.pairing!.code)}`);
    await browser.until(drawn, "the universal page to pair again");
    await browser.until(says("plan the offline mode"), "the board again");
    await desktop.close();
    await browser.until(says("Reconnecting…"), "the line that says the machine went away");
    await browser.shot("rn-disconnected");
    console.log(`(9) with the desktop gone the window says "${(await browser.evaluate<string>(`[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.textContent ?? "").includes("Disconnected")).map((e) => e.parentElement.textContent).pop() ?? ""`)).slice(0, 120)}"`);

    const complaints = [...desktop.complaints, ...browser.complaints].filter((c) => !/disk_cache|gpu_disk|Gpu Cache/.test(c));
    if (complaints.length > 0) console.log(`spoke up:\n  ${complaints.slice(0, 8).join("\n  ")}`);
  } finally {
    await browser?.close();
    await desktop.close();
  }
  console.log(`wrote ${OUT}`);
}

await main();
