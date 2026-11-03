/**
 * The composer's stack after using it (decision 0023, amended 2026-11-03), in a real conversation.
 *
 * A real agent (claude-cli/haiku — this rig spends a little), under `chat/ask-first`:
 *  a. a line asks; the shield opens the browser with this stack at the top of its tree — the bottom
 *     layer, then `tools` — above the scopes (ruling 13);
 *  b. `chat/full` laid on top from that browser decides the waiting call again: it is answered by the
 *     permissions, and the turn goes on without anybody pressing Allow (ruling 15);
 *  c. the layer taken out again, the same line asks; answered for this run, the bar has no `runtime`
 *     segment and counts the answer on `tools`, and the Tools card marks it (ruling 14);
 *  d. the window narrowed, the stack collapses to the shield, the bottom's icon and `+1`; pressed, it
 *     opens the browser (ruling 16).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/stack-rejudge.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "stack-rejudge");
const WORLD = join(import.meta.dirname, ".world-stack-rejudge");
const ASK_FIRST = { layers: ["$/permission-sets/chat/ask-first"] };
const LINE = "hostname";
const run = (line: string): string => `Use your shell tool to run exactly this line, once, and nothing else: ${line}\nDo not pass a cwd. Then reply with its output, or, if it was not run, with the reason you were given, word for word. Do not use any other tool, and do not try again.`;
const BAR = '[role="group"][aria-label="Permissions"]';

type Pending = { requestId: string; taskId?: string; command?: string };

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9264 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`stack-rejudge: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 900);

    const press = async (selector: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) throw new Error(`nothing to press at ${selector}`);
      await app.pointer(at.x, at.y);
      await settle(200);
      await app.clickAt(at.x, at.y);
      await settle(600);
    };
    /** Press the deepest element whose own text is exactly `text`, within what `within` finds. */
    const pressText = async (text: string, within = "document.body"): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
        const root = ${within};
        const hits = [...root.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText || "").trim() === ${JSON.stringify(text)}));
        const el = hits.at(-1);
        if (!el) return null;
        el.scrollIntoView({ block: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (at === null) throw new Error(`nothing reads "${text}"`);
      await app.pointer(at.x, at.y);
      await settle(200);
      await app.clickAt(at.x, at.y);
      await settle(600);
    };
    const pending = async (taskId: string): Promise<Pending[]> => (await app.ipc<Pending[]>("approval:pending", undefined)).filter((p) => p.taskId === taskId);
    const untilAsked = async (taskId: string, what: string): Promise<Pending> => {
      for (let i = 0; ; i++) {
        const [first] = await pending(taskId);
        if (first !== undefined) {
          await settle(2500);
          return first;
        }
        if (i > 240) {
          await app.shot(`no-ask`, undefined, false);
          throw new Error(`${what}: no ask in two minutes; the page ends: ${JSON.stringify((await text()).slice(-500))}`);
        }
        await settle(500);
      }
    };
    const untilTurnEnds = async (what: string): Promise<void> => {
      for (let i = 0; !(await app.evaluate<boolean>("window.__turnEnded === true")); i++) {
        const failed = await app.evaluate<string | null>("window.__sendFailed ?? null");
        if (failed !== null) throw new Error(`${what}: the send failed: ${failed}`);
        if (i > 360) throw new Error(`${what}: the turn did not end in three minutes`);
        await settle(500);
      }
      await settle(1500);
    };
    const text = (): Promise<string> => app.evaluate<string>("document.body.innerText");

    // A conversation as the Chat view starts one, under ask-first.
    const title = "Stack after using it";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: "Reply with the single word: ready." }, conversation: true });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: ASK_FIRST } });
    await app.clickText("Chat");
    await app.until(says(title), "the conversation to be listed", 200);
    await app.clickText(title);
    await app.until(says("ready"), "the opening answer", 400);
    for (let i = 0; (await app.ipc<{ status: string } | null>("task:detail", { taskId: made.taskId }))?.status === "running"; i++) {
      if (i > 240) throw new Error("the opening run did not end in two minutes");
      await settle(500);
    }
    await settle(1500);
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const send = (message: string): Promise<unknown> =>
      app.evaluate(`window.__turnEnded = false; window.__sendFailed = null; void window.jaira.invoke("chat:send", ${JSON.stringify({ taskId: made.taskId, instanceId: thread.instanceId, message, overrides: { model: MODEL, permissionSet: ASK_FIRST } })}).then(() => { window.__turnEnded = true; }, (e) => { window.__sendFailed = String(e); }), true`);

    // a. A line asks; the shield opens the browser, this stack on top of its tree.
    await send(run(LINE));
    const asked = await untilAsked(made.taskId, "the first line");
    console.log(`stack-rejudge: asked ${JSON.stringify(asked.command)}`);
    await app.shot("a-asked", undefined, false);
    const barText = await app.evaluate<string>(`document.querySelector(${JSON.stringify(BAR)})?.innerText ?? ""`);
    console.log(`stack-rejudge: the bar reads ${JSON.stringify(barText)}`);
    check(/chat\/ask-first/.test(barText) && /tools · \d+/.test(barText) && !/runtime/.test(barText), "a. the bar reads chat/ask-first, tools and +, and no runtime segment");
    await press(`${BAR} [aria-label="Permissions"]`);
    await settle(800);
    await app.shot("a-shield-browser", undefined, false);
    const browser = await text();
    check(/This conversation/.test(browser) && /what the whole stack comes to/.test(browser), "a. the shield opens the browser on tools, This conversation at the top of its tree");
    check(/Built in/.test(browser) && /Done/.test(browser), "a. the scopes are under the stack, and the foot says Done");

    // b. chat/full laid on top, from the browser: the waiting call is decided again.
    await pressText("full.json");
    await app.shot("b-full-picked", undefined, false);
    await pressText("Lay it on top");
    for (let i = 0; (await pending(made.taskId)).length > 0; i++) {
      if (i > 40) break;
      await settle(250);
    }
    check((await pending(made.taskId)).length === 0, "b. laying chat/full on top answered the waiting call without anybody pressing Allow");
    await untilTurnEnds("after laying full on top");
    await app.press("Escape", 27);
    await settle(600);
    // The approval is folded into the turn's summary: its chip unfolds it.
    await pressText("1 approval");
    await settle(600);
    await app.shot("b-ran", undefined, false);
    const ran = await text();
    check(/Approved/.test(ran) && /the permissions changed while it waited/.test(ran), "b. the approval reads Approved — the permissions changed while it waited");
    const bar2 = await app.evaluate<string>(`document.querySelector(${JSON.stringify(BAR)})?.innerText ?? ""`);
    console.log(`stack-rejudge: the bar now reads ${JSON.stringify(bar2)}`);
    check(/chat\/full/.test(bar2), "b. the bar shows chat/full over ask-first");

    // c. The layer taken out again; the line asks again, answered for this run; the Tools card marks it.
    await press('[aria-label="chat/full"]');
    await pressText("remove");
    await settle(800);
    // Another line: asked to run one it has run, an agent answers from memory.
    await send(run("whoami"));
    const again = await untilAsked(made.taskId, "another line");
    await app.ipc("approval:submit", { requestId: again.requestId, decision: "allow", scope: "workflow-run", remember: [] });
    await untilTurnEnds("the line answered for this run");
    await settle(800);
    const bar3 = await app.evaluate<string>(`document.querySelector(${JSON.stringify(BAR)})?.innerText ?? ""`);
    console.log(`stack-rejudge: the bar reads ${JSON.stringify(bar3)}`);
    check(/tools · \d+\s*· 1/.test(bar3) && !/runtime/.test(bar3), "c. the bar counts the answer on tools (· 1) and has no runtime segment");
    await app.shot("c-bar", BAR, false);
    await press('[aria-label="tools"]');
    await settle(800);
    await app.shot("c-tools-card", undefined, false);
    const card = await text();
    check(/One answer from this run is marked/.test(card) && /this run · allow/.test(card) && /whoami/.test(card), "c. the Tools card marks whoami: this run · allow");
    await app.press("Escape", 27);
    await settle(500);

    // d. Narrow: the stack collapses to the shield, the bottom's icon and +1.
    await app.resize(540, 900);
    await settle(1200);
    await app.shot("d-narrow", undefined, false);
    const bar4 = await app.evaluate<{ text: string; segments: number } | null>(`(() => { const all = [...document.querySelectorAll('[aria-label="Permissions"]')]; const el = all.find((e) => e.getAttribute("role") !== "group"); return el ? { text: el.innerText, segments: all.length } : null; })()`);
    console.log(`stack-rejudge: narrow, the stack reads ${JSON.stringify(bar4)}`);
    check(bar4 !== null && /\+1/.test(bar4.text) && (await app.evaluate<number>(`document.querySelectorAll('[aria-label="chat/ask-first"]').length`)) === 0, "d. narrow, the stack is the shield with +1, no segments");
    await press('[aria-label="Permissions"]');
    await settle(800);
    await app.shot("d-collapsed-pressed", undefined, false);
    check(/This conversation/.test(await text()), "d. the collapsed stack opens the browser");
    await app.press("Escape", 27);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`stack-rejudge: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("stack-rejudge: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
