/**
 * An unseen task's dot (the unseen-tasks mockups, design 1, 2026-11-22): the Tasks list and the board
 * mark a task nobody has looked at since it moved with a dot in the Chat ring's colour for it, and
 * looking at a task — from any list — is looking at it everywhere ("seeing a task is synonymous with
 * seeing the corresponding chat").
 *
 * A planning task run to the end (green), one parked at its gate (yellow) and a conversation that
 * answered. Passes when the two tasks' rows and cards wear dots; opening one from the Tasks list clears
 * its row and its card and leaves the other lit; and reading the conversation in the Chat tab clears
 * its card on the board, which the Chat tab never draws.
 *
 * Scripted answers (`fake`), so nothing is spent.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/unseen-dots.mts
 */
import { join } from "node:path";
import { happyRules } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { blockedAtTheGate, buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "unseen-dots");
const WORLD = join(import.meta.dirname, ".world-unseen-dots");

const DONE = "add dark mode";
const PARKED = "plan the offline mode";
const CHAT = "Check the tide tables";

/** The centre of the visible element labelled `label`, or whose own text is `text`. */
const centreOf = (how: "text" | "label", text: string): string => `(() => {
  const want = ${JSON.stringify(text)};
  const all = ${how === "label" ? `[...document.querySelectorAll('[aria-label]')].filter((e) => e.getAttribute('aria-label') === want)` : `[...document.querySelectorAll('div, span')].filter((e) => e.innerText !== undefined && e.innerText.trim() === want && ![...e.children].some((c) => c.innerText && c.innerText.trim() === want))`};
  const e = all.find((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`;

/** The Tasks list's rows that say they are unseen, by the start of their accessible name. */
const unseenRows = `[...document.querySelectorAll('[aria-label$="not seen yet"]')].map((e) => e.getAttribute('aria-label').split(',')[0])`;
/** The board's cards that wear the dot, by their title. */
const unseenCards = `[...document.querySelectorAll('[title="not seen since it moved"]')].map((e) => e.parentElement.innerText.split('\\n')[0].trim())`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9274 });
  const press = async (how: "text" | "label", what: string): Promise<void> => {
    const at = await app.evaluate<{ x: number; y: number } | null>(centreOf(how, what));
    if (at === null) throw new Error(`nothing ${how === "label" ? "labelled" : "reading"} "${what}" on the page`);
    await app.clickAt(at.x, at.y);
    await settle(700);
  };
  const check = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`failed: ${what}`);
    console.log(`ok — ${what}`);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 800);
    const done = await app.ipc<{ taskId: string }>("task:create", { title: DONE, workflow: "feature/plan", inputs: { issue: `# ${DONE}` } });
    await app.ipc("task:start", { taskId: done.taskId, fake: happyRules() });
    const parked = await app.ipc<{ taskId: string }>("task:create", { title: PARKED, workflow: "feature/plan", inputs: { issue: `# ${PARKED}` } });
    await app.ipc("task:start", { taskId: parked.taskId, fake: blockedAtTheGate() });
    const chat = await app.ipc<{ taskId: string }>("task:create", { title: CHAT, workflow: "session", conversation: true, inputs: { message: CHAT } });
    await app.ipc("task:start", { taskId: chat.taskId, fake: [{ output: "The tables are current." }] });

    await press("text", "Tasks");
    await app.until(`${unseenRows}.length >= 2`, "both tasks' rows to wear a dot", 200);
    await app.until(`${unseenCards}.includes(${JSON.stringify(CHAT)})`, "the conversation's card to wear a dot", 200);
    await settle(1000);
    await app.shot("1-unseen");
    const rows = await app.evaluate<string[]>(unseenRows);
    check(rows.includes(DONE) && rows.includes(PARKED), `the Tasks list marks both tasks unseen (${rows.join(" · ")})`);
    const cards = await app.evaluate<string[]>(unseenCards);
    check([DONE, PARKED, CHAT].every((t) => cards.includes(t)), `the board marks all three unseen (${cards.join(" · ")})`);

    // Opened from the Tasks list: its row and its card clear; the other task stays lit.
    await press("text", DONE);
    await app.until(`!${unseenRows}.includes(${JSON.stringify(DONE)})`, "the opened task's row to clear", 100);
    await settle(800);
    await app.shot("2-opened-from-tasks");
    check(!(await app.evaluate<string[]>(unseenCards)).includes(DONE), "opening it cleared its card on the board too");
    check((await app.evaluate<string[]>(unseenRows)).includes(PARKED), "the task not opened is still marked");

    // Read in the Chat tab: the board's card for the conversation clears — the same look, by one mark.
    await press("text", "Chat");
    await app.until(says(CHAT), "the conversation in the Chat tab", 200);
    await press("text", CHAT);
    await app.until(says("The tables are current."), "the conversation's thread", 200);
    await press("text", "Tasks");
    await app.until(`!${unseenCards}.includes(${JSON.stringify(CHAT)})`, "the conversation's card to clear once read in Chat", 100);
    await settle(800);
    await app.shot("3-read-in-chat");
    check(true, "reading the conversation in Chat cleared its card on the board");
    if (app.complaints.length > 0) console.log(`the window complained:\n${app.complaints.join("\n")}`);
    console.log("passed");
  } catch (e) {
    await app.shot("failed").catch(() => undefined);
    throw e;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
