/**
 * Baselines for the decision 0013 mockups (machines): the board with three tasks and the Settings
 * sheet on About, each photographed and its live DOM saved, so the mockups start from real markup.
 *
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/machines-baseline.mts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "machines");
const WORLD = join(import.meta.dirname, ".world-machines");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9241 });
  const dump = async (name: string): Promise<void> => {
    const html = await app.evaluate<string>(`(() => {
      const root = document.documentElement;
      const attrs = [...root.attributes].map((a) => a.name + '="' + a.value + '"').join(" ");
      return "<!-- html " + attrs + " -->\\n" + document.getElementById("root").outerHTML;
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
    await start("add dark mode", happyRules());
    await start("rework the sync lint", [happyRules()[0]]);
    await app.until(says("done"), "the completed task");
    await start("tighten the changeset lint", blockedAtTheGate());
    await app.until(says("Awaiting you"), "the run to park");
    await sleep(800);
    await app.shot("board");
    await dump("board");

    // The parked task's conversation, where a gate is answered and the composer sits.
    await app.evaluate(`(() => { const c = [...document.querySelectorAll(".card")].find((e) => e.textContent.includes("tighten the changeset")); c?.click(); return !!c; })()`);
    await sleep(1500);
    await app.shot("task");
    await dump("task");
    await app.press("Escape", 27);
    await sleep(400);

    await app.clickText("Settings");
    await sleep(600);
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("About")); li?.click(); return !!li; })()`);
    await sleep(900);
    await app.evaluate(`(() => { document.querySelector('[data-part="engine"]')?.scrollIntoView({ block: "start" }); return true; })()`);
    await sleep(300);
    await app.shot("about-engine");
    await dump("about");
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Connections")); li?.click(); return !!li; })()`);
    await sleep(900);
    await app.shot("connections");
    await dump("connections");
  } finally {
    await app.close();
  }
}

await main();
