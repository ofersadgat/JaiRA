/**
 * Where a conversation says what its agent is doing (`appearance.conversation.liveStatus`, 2026-11-01): a
 * pill over the thread's end, or the composer's first line — in a real conversation read from the Chat
 * room, while an answer streams.
 *
 * A real agent (claude-cli/haiku - this rig spends a little) asked for an answer long enough to stream
 * for a while. Photographed at the live edge and scrolled away (where the jump joins); passes when the
 * status is drawn where the setting says, with the jump once away, and nothing stands between the thread
 * and the box: the foot's fade lies over the thread's last pixels, not over the status.
 *
 *   npm --workspace @jaira/app run build:main
 *   npx tsx packages/app/shots/live-status.mts --place pill|composer [--pages http://127.0.0.1:8081/]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Tell a long story";
const MODEL = "claude-cli/haiku";
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;
const place = process.argv.includes("--place") ? process.argv[process.argv.indexOf("--place") + 1]! : "pill";
if (place !== "pill" && place !== "composer") throw new Error(`--place is pill or composer, not ${place}`);
const OUT = join(import.meta.dirname, "out", "live-status", place);
const WORLD = join(import.meta.dirname, `.world-live-status-${place}`);

/** Where the status is, the composer's frame, and the fade, measured on the page. */
const MEASURE = `(() => {
  const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
  const status = [...document.querySelectorAll('[role="status"]')].find((e) => /^(Thinking|Answering|Writing|Running|Working|Waiting for you|Checking with)/.test(e.innerText.trim()));
  const box = document.querySelector('textarea');
  let frame = box; for (let i = 0; i < 6 && frame; i++) { frame = frame.parentElement; if (frame && getComputedStyle(frame).borderTopLeftRadius === '22px') break; }
  const fade = [...document.querySelectorAll('div')].find((e) => (getComputedStyle(e).backgroundImage || '').startsWith('linear-gradient') && Math.round(e.getBoundingClientRect().height) === 18);
  return { status: rect(status), words: status ? status.innerText.replace(/\\s+/g, ' ').trim() : null, inFrame: !!(status && frame && frame.contains(status)), frame: rect(frame), fade: rect(fade), jump: document.body.innerText.includes('Jump to live') };
})()`;

interface Measured {
  status: { top: number; bottom: number; left: number; right: number } | null;
  words: string | null;
  inFrame: boolean;
  frame: { top: number; bottom: number; left: number; right: number } | null;
  fade: { top: number; bottom: number; left: number; right: number } | null;
  jump: boolean;
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  writeFileSync(join(world.home, "settings.json"), JSON.stringify({ appearance: { conversation: { liveStatus: place } } }, null, 2));
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: place === "pill" ? 9263 : 9264 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 760);
    // A conversation as the Chat view starts one (`conversation: true`), so the Chat room lists it.
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message: "Reply with the single word: ready." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(says("ready"), "the opening answer", 400);
    await settle(1500);
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const send = {
      taskId: made.taskId,
      instanceId: thread.instanceId,
      message: "Without using any tool, write a story of about 900 words about a lighthouse keeper, in plain paragraphs.",
      overrides: { model: MODEL },
    };
    await app.evaluate(`void window.jaira.invoke("chat:send", ${JSON.stringify(send)}).catch(() => undefined), true`);

    // Streaming, and long enough to scroll: the status is live and the thread is past the window.
    const live = `(() => { const m = ${MEASURE}; return m.status !== null; })()`;
    await app.until(live, "the live status", 400);
    await app.until(`(() => { const s = document.querySelector('textarea'); return document.body.innerText.length > 2500; })()`, "the story to fill the window", 400);
    const atEdge = await app.evaluate<Measured>(MEASURE);
    await app.shot("1-at-the-live-edge");

    // Scrolled away: up over the story, where the jump joins.
    await app.evaluate(`(() => { const s = [...document.querySelectorAll('div')].filter((e) => e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY !== 'visible').sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; s.scrollTop = Math.max(0, s.scrollTop - 420); s.dispatchEvent(new Event('scroll')); return true; })()`);
    await settle(400);
    const away = await app.evaluate<Measured>(MEASURE);
    await app.shot("2-scrolled-away");

    console.log(JSON.stringify({ place, atEdge, away }, null, 2));
    const failures: string[] = [];
    for (const [when, m] of [["at the edge", atEdge], ["away", away]] as const) {
      if (m.status === null || m.frame === null || m.fade === null) {
        failures.push(`${when}: status, frame or fade not found`);
        continue;
      }
      if (place === "composer" && !m.inFrame) failures.push(`${when}: the status is not inside the composer`);
      if (place === "pill" && (m.inFrame || m.status.bottom > m.frame.top)) failures.push(`${when}: the pill is not over the composer`);
      // The fade lies over the thread: its foot at the top of what stands under the thread, over no status line.
      if (place === "composer" && m.fade.bottom > m.frame.top) failures.push(`${when}: the fade reaches into the composer`);
    }
    if (atEdge.jump) failures.push("the jump shows at the live edge");
    if (!away.jump) failures.push("no jump once scrolled away");
    if (failures.length > 0) throw new Error(failures.join("; "));
    console.log(`passed: ${place}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
