/**
 * Removing a layer while the opening run works (2026-11-13): the person's report. An opening message
 * whose call asks under ask-first; `full` laid on top answers it; then ask-first is removed while the
 * run is still working. Logs every invoke the window sends, and what the run comes to.
 *
 * `BARE=1` is the person's case: no stack picked at start (the state's ask-first), and the call that
 * asks is a grep INSIDE the project. Before full.json named `$PROJECT`, `$WORKTREE` and
 * `$AGENT_WORKSPACE`, ask-first's own lines for those places spoke through `full` and the grep kept
 * asking until ask-first was removed. A real agent (claude-cli/haiku) — it may pick another tool.
 *
 *   npx tsx packages/app/shots/stack-remove-while-running.mts
 *   BARE=1 npx tsx packages/app/shots/stack-remove-while-running.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "stack-remove-while-running");
const WORLD = join(import.meta.dirname, ".world-stack-remove-while-running");
const BAR = '[role="group"][aria-label="Permissions"]';
type Pending = { requestId: string; taskId?: string; command?: string };

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9266 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`remove-while-running: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 900);
    const at = async (js: string): Promise<{ x: number; y: number } | null> => app.evaluate(`(() => { const el = ${js}; if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const click = async (js: string, what: string): Promise<void> => {
      const p = await at(js);
      if (p === null) throw new Error(`nothing to press: ${what}`);
      await app.pointer(p.x, p.y);
      await settle(200);
      await app.clickAt(p.x, p.y);
      await settle(600);
    };
    const byText = (text: string): string => `[...document.body.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText || "").trim() === ${JSON.stringify(text)})).at(-1)`;
    const pending = async (taskId: string): Promise<Pending[]> => (await app.ipc<Pending[]>("approval:pending", undefined)).filter((p) => p.taskId === taskId);
    const text = (): Promise<string> => app.evaluate<string>("document.body.innerText");

    // Every invoke the window sends, from now on.
    await app.evaluate(`(() => { window.__calls = []; const real = window.jaira.invoke.bind(window.jaira); window.jaira.invoke = (ch, req) => { window.__calls.push({ at: Date.now(), ch, req: JSON.stringify(req ?? null).slice(0, 300) }); return real(ch, req).catch((e) => { window.__calls.push({ at: Date.now(), ch, failed: String(e) }); throw e; }); }; return true; })()`);

    const title = "Remove while running";
    const message = process.env.BARE ? "Use your grep tool once to search for the word wheel in the folder packages. Then use your shell tool to run exactly: ping -n 25 127.0.0.1\nThen reply with the single word: done." :"Use your shell tool to run exactly this line, once: hostname\nThen use your shell tool again to run exactly: ping -n 25 127.0.0.1\nThen reply with the single word: done.";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", inputs: { message }, conversation: true });
    await app.clickText("Chat");
    await app.until(says(title), "the conversation to be listed", 200);
    await app.clickText(title);
    await settle(800);
    await app.ipc("task:start", { taskId: made.taskId, overrides: process.env.BARE ? { model: MODEL } : { model: MODEL, permissionSet: { layers: ["$/permission-sets/ask-first"] } } });
    for (let i = 0; (await pending(made.taskId)).length === 0; i++) {
      if (i > 240) throw new Error("no ask in two minutes");
      await settle(500);
    }
    await settle(2000);
    await app.shot("1-asked", undefined, false);
    console.log(`bar: ${JSON.stringify(await app.evaluate<string>(`document.querySelector(${JSON.stringify(BAR)})?.innerText ?? ""`))}`);

    // full laid on top from the + segment's list: its row, pressed (2026-11-14).
    await click(`document.querySelector('${BAR} [aria-label="add"]')`, "the + segment");
    await app.shot("2-add-open", undefined, false);
    await click(byText("full"), "full in the list");
    for (let i = 0; (await pending(made.taskId)).length > 0 && i < 40; i++) await settle(250);
    check((await pending(made.taskId)).length === 0, "full on top answered the waiting call");
    await settle(1500);
    await app.shot("3-full-on-top", undefined, false);
    console.log(`bar: ${JSON.stringify(await app.evaluate<string>(`document.querySelector(${JSON.stringify(BAR)})?.innerText ?? ""`))}`);
    console.log(`approval text still on the page: ${/Approve this command\?/.test(await text())}`);

    // ask-first removed while the run works.
    const mark = await app.evaluate<number>("window.__calls.length");
    await click(`document.querySelector('[aria-label="ask-first"]')`, "the ask-first segment");
    await app.shot("4-ask-first-card", undefined, false);
    await click(byText("remove"), "remove");
    await settle(3000);
    await app.shot("5-removed", undefined, false);
    const calls = await app.evaluate<unknown[]>(`window.__calls.slice(${mark})`);
    for (const c of calls) console.log(`call: ${JSON.stringify(c)}`);
    const detail = await app.ipc<{ status: string } | null>("task:detail", { taskId: made.taskId });
    console.log(`status after remove: ${detail?.status}`);
    check(!calls.some((c) => (c as { ch: string }).ch === "task:cancel" || (c as { ch: string }).ch === "approval:submit"), "removing a layer sends no approval answer and no cancel");
    check(detail?.status === "running" || detail?.status === "completed", "the run goes on");
    const page = await text();
    console.log(`page tail: ${JSON.stringify(page.slice(-600))}`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`remove-while-running: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("remove-while-running: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
