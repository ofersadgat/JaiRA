/**
 * Rewinding a conversation to before the message it OPENED with (2026-11-05): the opening message's rail
 * offers Rewind and Fork (it offered neither — the thread named no cut before the run's own call), the
 * banner says the whole conversation goes, and confirming deletes it and opens the start page with the
 * message back in its box.
 *
 * Scripted answers (`fake`), so nothing is spent. Passes when the rail shows both buttons on the opening
 * message, the banner says the conversation is deleted, and after Rewind the conversation is gone from
 * the list and the start page's box holds the opening message.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/rewind-opening.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OPENING = "Plan the lighthouse rota for next week.";
const TITLE = "Plan the lighthouse rota";
const OUT = join(import.meta.dirname, "out", "rewind-opening");
const WORLD = join(import.meta.dirname, ".world-rewind-opening");

/** The centre of the element whose own text is exactly `text` (innermost), or of the `[aria-label]` named so. */
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
  const app = await App.launch(world, { out: OUT, port: 9271 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 760);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message: OPENING } });
    await app.ipc("task:start", { taskId: made.taskId, fake: [{ output: "Here is a rota: Monday, Tuesday, Wednesday." }] });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(says("Here is a rota"), "the opening answer", 400);
    await settle(800);

    // Under the pointer, the opening message's rail.
    const message = await app.evaluate<{ x: number; y: number } | null>(centreOf("text", OPENING));
    if (message === null) throw new Error("the opening message is not on the page");
    await app.hover(message.x, message.y);
    await settle(300);
    const rewind = await app.evaluate<{ x: number; y: number } | null>(centreOf("label", "Rewind to before this message"));
    const fork = await app.evaluate<{ x: number; y: number } | null>(centreOf("label", "Fork before this message"));
    await app.shot("1-rail-on-the-opening-message");
    if (rewind === null || fork === null) throw new Error(`the rail offers ${rewind === null ? "no Rewind" : ""}${rewind === null && fork === null ? " and " : ""}${fork === null ? "no Fork" : ""}`);

    await app.clickAt(rewind.x, rewind.y);
    await app.until(says("the whole conversation is deleted"), "the banner", 100);
    await app.shot("2-banner");
    const confirm = await app.evaluate<{ x: number; y: number } | null>(centreOf("text", "Rewind"));
    if (confirm === null) throw new Error("the banner has no Rewind button");
    await app.clickAt(confirm.x, confirm.y);

    // Gone, and the start page holds the words.
    await app.until(`(() => !document.body.innerText.includes(${JSON.stringify(TITLE)}))()`, "the conversation to leave the list", 200);
    await app.until(`(() => [...document.querySelectorAll('textarea')].some((t) => t.value === ${JSON.stringify(OPENING)}))()`, "the start page's box to hold the message", 200);
    await settle(500);
    await app.shot("3-start-page");
    const listed = await app.ipc<Array<{ taskId: string }>>("task:list", {});
    if (listed.some((t) => t.taskId === made.taskId)) throw new Error("the conversation is still a task");
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
