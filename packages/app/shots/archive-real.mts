/**
 * Archived tasks in the real app (the person, 2026-09-27): two finished tasks archived from the card
 * menu's verb, the board with them held at the foot of the Finished lane, shown, and Settings →
 * Machines → Copies of other machines' work.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/archive-real.mts
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "archive-real");
const WORLD = join(import.meta.dirname, ".world-archive-real");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const says = (text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9250 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    await app.resize(1360, 820);
    const ids: Record<string, string> = {};
    for (const title of ["add dark mode", "port the updater to arm", "fix the tray icon", "rename the sync lint"]) {
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "feature/plan", inputs: { issue: `# ${title}` } });
      await app.ipc("task:start", { taskId: made.taskId, fake: happyRules() });
      ids[title] = made.taskId;
    }
    await app.until(`document.querySelectorAll(".card .pill-success").length >= 4`, "four finished tasks");
    await sleep(800);
    await app.shot("before");
    const archived = await app.ipc<{ changed: string[] }>("task:archive", { taskIds: [ids["fix the tray icon"]!, ids["port the updater to arm"]!] });
    if (archived.changed.length !== 2) throw new Error(`archived ${JSON.stringify(archived)}`);
    await app.until(says("2 archived"), "the archived line");
    await sleep(500);
    await app.shot("hidden");
    await app.evaluate(`(() => { document.querySelector(".lane-archived")?.click(); return true; })()`);
    await app.until(`document.querySelectorAll(".card.is-archived").length === 2`, "the archived cards shown");
    await sleep(400);
    await app.shot("shown");
    // The menu of an archived card offers Unarchive.
    await app.evaluate(`(() => {
      const card = document.querySelector(".card.is-archived");
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
      return true;
    })()`);
    await sleep(500);
    await app.shot("menu");
    const menu = await app.evaluate<string>(`[...document.querySelectorAll(".context-menu .menu-item")].map((b) => b.textContent).join(" | ")`);
    console.log("menu:", menu);
    await app.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.clickText("Settings");
    await sleep(500);
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Machines")); li?.click(); return !!li; })()`);
    await app.until(says("Copies of other machines"), "the Copies section");
    await app.evaluate(`document.querySelector('[data-part="copies"]')?.scrollIntoView()`);
    await sleep(500);
    await app.shot("copies");
    await app.evaluate(`(() => { const li = [...document.querySelectorAll(".sections > li")].find((e) => e.textContent.trim().startsWith("Runs")); li?.click(); return !!li; })()`);
    await app.until(says("Finished tasks"), "the archive settings");
    await app.evaluate(`[...document.querySelectorAll(".set-section-title")].find((e) => e.textContent.includes("Finished tasks"))?.scrollIntoView()`);
    await sleep(500);
    await app.shot("rule");
  } finally {
    await app.close();
  }
}

await main();
