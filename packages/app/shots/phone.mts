/**
 * The phone app, run in a browser standing in for the phone (decision 0015, ruling 6).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/phone.mts
 *
 * A desktop with the spike socket, a couple of finished tasks on its board, and a phone-sized headless
 * Chrome on `/native` — `NativeApp` through react-native-web, the same component tree Metro bundles
 * for Android and iOS. It connects with the address and token (as the Connect screen would be filled),
 * then photographs both views: the desktop's own UI in its frame (the whole-app island), and the
 * native copies drawing the desktop's live board through the store.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "parity", "phone");
const PORT = 8766;
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function main(): Promise<void> {
  if (CHROME === undefined) throw new Error("no Chrome to stand in for the phone");
  mkdirSync(OUT, { recursive: true });
  const world = buildWorld(join(import.meta.dirname, ".world-phone"));
  process.env.JAIRA_SPIKE_WS = String(PORT);
  process.env.JAIRA_RENDERER = "one";
  const desktop = await App.launch(world, { out: OUT, port: 9280 });
  let phone: App | undefined;
  try {
    await desktop.until("document.getElementById('root')?.children.length > 0", "the desktop to draw");
    const token = /token ([0-9a-f]{32})/.exec(desktop.said)?.[1];
    if (token === undefined) throw new Error("the desktop printed no token");
    for (const title of ["add dark mode", "rework the sync lint"]) {
      const made = await desktop.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
      await desktop.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
    }
    await desktop.until(`[...document.querySelectorAll("*")].filter((e) => e.textContent === "done").length >= 2`, "both tasks to finish");

    const url = `http://127.0.0.1:${PORT}/native?address=${encodeURIComponent(`ws://127.0.0.1:${PORT}/`)}&token=${token}`;
    phone = await App.browse(CHROME, url, { out: OUT, port: 9281, phone: { width: 390, height: 844, scale: 3 } });
    await phone.until(says("Connect to a JaiRA desktop"), "the phone's connect screen");
    await phone.shot("connect");
    await phone.clickText("Connect");
    await phone.until(`${says("Desktop UI")} && ${says("Native copies")}`, "the phone to connect");
    console.log("(1) the phone app connected over the socket");

    // The desktop's own UI, in the frame: wait for the board inside it.
    await phone.until(
      `(() => { const f = document.querySelector("iframe"); try { return f && f.contentDocument && f.contentDocument.body.innerText.includes("add dark mode"); } catch { return false; } })()`,
      "the desktop UI to draw in its frame",
    );
    await new Promise((r) => setTimeout(r, 1500));
    await phone.shot("desktop-ui");
    console.log("(2) the Desktop UI view draws the desktop's own board in its frame");

    await phone.clickText("Native copies");
    await phone.until(says("add dark mode"), "the native copies to draw the board");
    await new Promise((r) => setTimeout(r, 1000));
    await phone.shot("native-copies");
    const census = await phone.evaluate<string>(`"Tamagui views " + document.querySelectorAll(".is_View").length + ", DOM cards " + document.querySelectorAll(".card").length`);
    console.log(`(3) the Native copies view draws the live board from universal components (${census})`);
    const complaints = [...phone.complaints].filter((c) => !/disk_cache|gpu_disk|Gpu Cache/.test(c));
    if (complaints.length > 0) console.log(`the phone spoke up:\n  ${complaints.slice(0, 8).join("\n  ")}`);
  } finally {
    await phone?.close();
    await desktop.close();
  }
  console.log(`wrote ${OUT}`);
}

await main();
