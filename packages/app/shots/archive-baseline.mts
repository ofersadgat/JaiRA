/**
 * Baselines for the archive mockups: the board with finished tasks, a card's menu open on one, and
 * Settings → Machines — each photographed and its live DOM saved, so the mockups start from real markup.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/archive-baseline.mts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "archive");
const WORLD = join(import.meta.dirname, ".world-archive");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9249 });
  const dump = async (name: string): Promise<void> => {
    const html = await app.evaluate<string>(`(() => {
      const root = document.documentElement;
      const attrs = [...root.attributes].map((a) => a.name + '="' + a.value + '"').join(" ");
      const floats = [...document.querySelectorAll("body > .float")].map((f) => f.outerHTML).join("\\n");
      return "<!-- html " + attrs + " -->\\n" + document.getElementById("root").outerHTML + (floats ? "\\n<!-- floats -->\\n" + floats : "");
    })()`);
    writeFileSync(join(OUT, `${name}.html`), html);
  };
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.resize(1360, 820);
    const start = async (title: string, fake: unknown): Promise<void> => {
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
      await app.ipc("task:start", { taskId: made.taskId, fake });
    };
    for (const title of ["add dark mode", "port the updater to arm", "fix the tray icon", "rename the sync lint"]) await start(title, happyRules());
    await start("rework the sync lint", [happyRules()[0]]);
    await start("tighten the changeset lint", blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park");
    await sleep(1500);
    await app.shot("board");
    await dump("board");
    await app.evaluate(`(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => c.textContent.includes("add dark mode"));
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: card.getBoundingClientRect().left + 40, clientY: card.getBoundingClientRect().top + 20 }));
      return true;
    })()`);
    await sleep(600);
    await app.shot("card-menu");
    await dump("card-menu");
    await app.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.clickText("Settings");
    await sleep(500);
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Machines")); li?.click(); return !!li; })()`);
    await app.until(says("Keep a copy of my other machines"), "the Machines page");
    await sleep(500);
    await app.shot("machines");
    await dump("machines");
  } finally {
    await app.close();
  }
}

await main();
