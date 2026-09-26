/**
 * The Chat view's chrome in the real app — the conversation's name in the top strip, the composer on
 * the thread's ground, and the context panel beside it: folded, unfolded, and after its ✕ (which
 * folds it, beside a conversation). The notes of 2026-09-25.
 *
 *   npx tsx packages/app/shots/chat-chrome.mts
 *
 * The conversation is a `chat/session` task run by the scripted fake executor, so it has a message
 * and an answer and no agent at all. Output lands in `shots/out/chat-chrome/`.
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "chat-chrome");
const WORLD = join(import.meta.dirname, ".world-chat-chrome");
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const click = (app: App, selector: string): Promise<boolean> =>
  app.evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

const ANSWER = [
  "The side panel folds to a rail beside a conversation, so closing it there should fold it too.",
  "",
  "- `sidePanel.tsx` draws the frame and its three controls.",
  "- `App.tsx` decides which room the panel belongs to.",
  "",
  "I would change the ✕ beside a conversation to fold the panel, and leave the Tasks room as it is.",
].join("\n");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9251, width: 1440, height: 900 });
  try {
    await app.until("window.jaira && document.getElementById('root').children.length > 0", "the window to draw");
    for (let i = 0; i < 3; i++) {
      const title = ["Why does the context panel vanish when I close it?", "Tidy the composer", "Scrollbars"][i]!;
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: title } });
      await app.ipc("task:start", { taskId: made.taskId, fake: [{ output: ANSWER }] });
      console.log(`started ${made.taskId}`);
    }
    await pause(2500);
    await app.clickText("Chat");
    await pause(1200);
    console.log(`list: ${await app.evaluate<string>(`[...document.querySelectorAll(".chat-rows li")].map((e) => e.textContent.trim().slice(0, 40)).join(" | ")`)}`);
    await app.clickText("Why does the context panel vanish when I close it?");
    await pause(2000);
    await app.shot("1-chat-folded");
    await app.shot("1b-heading", ".title-bar");
    await app.shot("1c-rail", ".ctx-panel");
    await app.shot("1d-foot", ".chat-thread");

    await click(app, '[title="Unfold the panel"]');
    await pause(700);
    await app.shot("2-chat-unfolded");

    const folded = await click(app, '.sp-controls [title="Collapse the panel to a rail"]');
    console.log(`✕ is the fold: ${folded}`);
    await pause(700);
    const rail = await app.evaluate<boolean>(`!!document.querySelector(".ctx-panel.folded .sp-rail")`);
    console.log(`after ✕, the rail is there: ${rail}`);
    await app.shot("3-after-x");

    // The scrollbar, over a thread long enough to scroll.
    await app.resize(1440, 420);
    await pause(700);
    await app.evaluate(`document.querySelector(".chat-scroll")?.scrollTo(0, 60)`);
    // The gutter the rule asks for: 10px, where the platform draws classic scrollbars at all.
    console.log(`scroller: ${await app.evaluate<string>(`(() => { const el = document.querySelector(".chat-scroll"); return JSON.stringify({ gutter: el.offsetWidth - el.clientWidth, scrolls: el.scrollHeight > el.clientHeight }); })()`)}`);
    const box = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(".chat-scroll").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; })()`);
    await app.hover(box.x, box.y);
    await app.shot("4-scrollbar");

    // The Tasks room's rail, for the width and inset.
    await app.resize(1440, 900);
    await app.clickText("Tasks");
    await pause(900);

    const complaints = app.complaints.filter((line) => !line.includes("Autofill") && !line.includes("cache"));
    if (complaints.length > 0) console.log(`complaints:\n${complaints.join("\n")}`);
  } finally {
    await app.close();
  }
}

await main();
