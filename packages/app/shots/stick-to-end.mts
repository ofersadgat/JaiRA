/**
 * A conversation's thread stays at its live edge (`liveEdge.ts`, 2026-11-14): a message typed into the
 * composer and sent leaves the thread at its end while the answer streams in; a wheel up lets go; a
 * wheel back down to the end pins it again, and it follows the rest of the answer.
 *
 * A real agent (claude-cli/haiku - this rig spends a little) asked for an answer long enough to stream
 * for a while. Passes when the thread is within 24 px of its end at every sample while pinned, away from
 * it (with the jump) once wheeled up, and at the end again when the answer is done.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/stick-to-end.mts [--pages http://127.0.0.1:8081/]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Stick to the end";
const MODEL = "claude-cli/haiku";
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;
const OUT = join(import.meta.dirname, "out", "stick-to-end");
const WORLD = join(import.meta.dirname, ".world-stick-to-end");

/** The thread's scroller (the tallest that scrolls), how far its end is below what shows, and its box. */
const MEASURE = `(() => {
  const s = [...document.querySelectorAll('div')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!s) return null;
  const b = s.getBoundingClientRect();
  return { below: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), height: s.scrollHeight, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), jump: document.body.innerText.includes('Jump to live'), live: !!document.querySelector('[role="status"]') };
})()`;

interface Measured {
  below: number;
  height: number;
  x: number;
  y: number;
  jump: boolean;
  live: boolean;
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: 9271 });
  const failures: string[] = [];
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 760);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message: "Reply with the single word: ready." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(says("ready"), "the opening answer", 400);
    await settle(1500);

    // Typed into the composer and sent with Enter: the path a person takes.
    const box = await app.evaluate<{ x: number; y: number }>(`(() => { const b = document.querySelector('textarea').getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`);
    await app.clickAt(box.x, box.y);
    await app.type("Without using any tool, write a story of about 1200 words about a lighthouse keeper, in plain paragraphs.");
    await app.press("Enter", 13);

    // Pinned while it streams: sampled until the thread is well past the window.
    const pinned: number[] = [];
    for (let i = 0; i < 400; i++) {
      await settle(150);
      const m = await app.evaluate<Measured | null>(MEASURE);
      if (m === null) continue;
      pinned.push(m.below);
      if (m.height > 2600) break;
    }
    await app.shot("1-pinned-after-send");
    // A sample may land between the content growing and the scroll that follows it; most must be at the end.
    const off = pinned.filter((b) => b > 24);
    if (pinned.length < 5) failures.push(`too few samples while streaming (${pinned.length})`);
    if (off.length > pinned.length / 5) failures.push(`after the send, ${off.length} of ${pinned.length} samples were away from the end: ${off.join(", ")}`);

    // Wheeled up: let go, and stays where the reader put it while the answer grows.
    let m = (await app.evaluate<Measured>(MEASURE))!;
    for (let i = 0; i < 4; i++) await app.wheel({ x: m.x, y: m.y }, -300);
    await settle(1200);
    const up1 = (await app.evaluate<Measured>(MEASURE))!;
    await settle(1200);
    const up2 = (await app.evaluate<Measured>(MEASURE))!;
    await app.shot("2-wheeled-up");
    if (up1.below < 600) failures.push(`wheeled up but only ${up1.below} px from the end`);
    // The jump rides on the live status: only while the answer still streams.
    if (up2.live && !up2.jump) failures.push("no jump once wheeled up");
    if (up2.live && up2.below < up1.below) failures.push(`pulled back toward the end while away (${up1.below} → ${up2.below})`);

    // Wheeled back down to the end: pinned again, and follows the rest.
    m = up2;
    for (let i = 0; i < 12; i++) await app.wheel({ x: m.x, y: m.y }, 400);
    const again: number[] = [];
    for (let i = 0; i < 400; i++) {
      await settle(200);
      const now = await app.evaluate<Measured | null>(MEASURE);
      if (now === null) continue;
      again.push(now.below);
      if (!now.live && i > 10) break;
    }
    await settle(1500);
    const done = (await app.evaluate<Measured>(MEASURE))!;
    await app.shot("3-back-at-the-end");
    const off2 = again.filter((b) => b > 24);
    if (off2.length > again.length / 5) failures.push(`after wheeling back down, ${off2.length} of ${again.length} samples were away from the end: ${off2.join(", ")}`);
    if (done.below > 24) failures.push(`the answer finished ${done.below} px above the end`);
    if (done.jump) failures.push("the jump shows at the end");

    // Sent from above the end, with a message of several lines (the composer grew over the thread): the
    // send's own scroll is reported after the sent message has grown the thread.
    m = done;
    await app.wheel({ x: m.x, y: m.y }, -300);
    await settle(600);
    await app.clickAt(box.x, box.y);
    await app.type("Now, without using any tool, write a sequel of about 600 words.");
    for (const line of ["Keep the same keeper.", "Plain paragraphs again.", "No title."]) {
      await app.press("Enter", 13, { shift: true });
      await app.type(line);
    }
    await settle(300);
    await app.press("Enter", 13);
    const sequel: number[] = [];
    for (let i = 0; i < 400; i++) {
      await settle(200);
      const now = await app.evaluate<Measured | null>(MEASURE);
      if (now === null) continue;
      sequel.push(now.below);
      if (!now.live && i > 10) break;
    }
    await settle(1500);
    const last = (await app.evaluate<Measured>(MEASURE))!;
    await app.shot("4-sequel-sent-from-above");
    const off3 = sequel.filter((b) => b > 24);
    if (off3.length > sequel.length / 5) failures.push(`after sending from above the end, ${off3.length} of ${sequel.length} samples were away from the end: ${off3.join(", ")}`);
    if (last.below > 24) failures.push(`the sequel finished ${last.below} px above the end`);

    console.log(JSON.stringify({ pinned, up1: up1.below, up2: up2.below, again, done: done.below, sequel, last: last.below }));
    if (failures.length > 0) throw new Error(failures.join("; "));
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
