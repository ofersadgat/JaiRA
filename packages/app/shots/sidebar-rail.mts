/**
 * The sidebar as a rail beside a project panel (the sidebar mockups, 2026-11-11: "R2 + R3"): the rail
 * holds All tasks, All chats, the projects, Open and Settings; the panel is the open project, its rooms
 * as tabs. Shots of each tab, of All chats chosen on the rail, of the panel hidden, and of Settings.
 *
 * Scripted answers (`fake`), so nothing is spent. Passes when the rail names its items, the tabs switch
 * the panel, and hiding the panel leaves the rail.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/sidebar-rail.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "sidebar-rail");
const WORLD = join(import.meta.dirname, ".world-sidebar-rail");

/** The centre of the visible element labelled `label`, or whose own text is `text`. */
const centreOf = (how: "text" | "label", text: string): string => `(() => {
  const want = ${JSON.stringify(text)};
  const all = ${how === "label" ? `[...document.querySelectorAll('[aria-label]')].filter((e) => e.getAttribute('aria-label') === want)` : `[...document.querySelectorAll('div, span')].filter((e) => e.innerText !== undefined && e.innerText.trim() === want && ![...e.children].some((c) => c.innerText && c.innerText.trim() === want))`};
  const e = all.find((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9273 });
  const press = async (how: "text" | "label", what: string): Promise<void> => {
    const at = await app.evaluate<{ x: number; y: number } | null>(centreOf(how, what));
    if (at === null) throw new Error(`nothing ${how === "label" ? "labelled" : "reading"} "${what}" on the page`);
    await app.clickAt(at.x, at.y);
    await settle(500);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 800);
    for (const [title, answer] of [
      ["Plan the lighthouse rota", "Here is a rota."],
      ["Check the tide tables", "The tables are current."],
    ] as const) {
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", conversation: true, inputs: { message: title } });
      await app.ipc("task:start", { taskId: made.taskId, fake: [{ output: answer }] });
    }
    for (const label of ["All tasks", "All conversations", "Settings", "open another project"]) {
      if ((await app.evaluate(centreOf("label", label))) === null) throw new Error(`the rail has no "${label}"`);
    }
    await press("text", "Chat");
    await app.until(says("Plan the lighthouse rota"), "the conversations in the Chat tab", 200);
    await app.shot("1-chat-tab");
    await press("text", "Tasks");
    await app.shot("2-tasks-tab");
    await press("text", "Files");
    await app.shot("3-files-tab");
    await press("label", "All conversations");
    await app.until(says("All conversations"), "the All conversations panel", 100);
    await app.shot("4-all-chats");
    await press("label", "Settings");
    await app.shot("5-settings");
    await press("label", "Back");
    await press("label", "Hide the sidebar");
    if ((await app.evaluate(centreOf("label", "Show the sidebar"))) === null) throw new Error("hiding the panel took the rail with it");
    await app.shot("6-panel-hidden");
    await press("label", "Show the sidebar");
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
