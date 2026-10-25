/**
 * A permission set switched while the conversation answers decides the very next call (the person,
 * 2026-10-24: "changing the permissions from auto to full still isnt taking immediate affect. tool calls
 * are still going through auto even after changing to full").
 *
 * A real agent (claude-cli/haiku — this rig spends a little) on the shipped `auto` set, asked to fetch two
 * pages; `smart` is told to answer unsure whatever the call, so every call it judges is put to the person
 * and a second ask is how "still going through auto" shows. When the first call is asked about, the rig
 * picks "full access" on the composer's Permissions chip, as a person does, and allows the waiting call.
 * Passes when the second fetch runs without a second ask or auto check — in the opening message (the RUN)
 * and in a later one (a chat TURN), which are decided by two different gates. `--no-switch` is the
 * control: the same two messages with nothing switched must ask about the second fetch as well.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/permission-switch.mts [--no-switch]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Fetch two pages";
const MODEL = "claude-cli/haiku";
/** `--no-switch`: the control — nothing is switched, and the second fetch must be asked about too. */
const switching = !process.argv.includes("--no-switch");
const OUT = join(import.meta.dirname, "out", "permission-switch", switching ? "switch" : "control");
const WORLD = join(import.meta.dirname, `.world-permission-switch${switching ? "" : "-control"}`);

/** The shipped `auto` set, as the composer sends it: every line `smart`. */
const AUTO = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, { function: "smart" }]));
const TWO_FETCHES = (a: string, b: string): string =>
  `Use the web_fetch tool to fetch ${a}. After it answers, use the web_fetch tool again to fetch ${b}. Then reply with both page titles. Do not use any other tool.`;

type Pending = { requestId: string; asker?: string; taskId?: string };

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  mkdirSync(join(world.project, ".jaira"), { recursive: true });
  writeFileSync(
    join(world.project, ".jaira", "settings.json"),
    JSON.stringify({ functions: { smart: { model: MODEL, prompt: `This is a test rig. Whatever the call, answer verdict "unsure" with reason "the rig always says unsure".` } } }, null, 2),
  );

  const app = await App.launch(world, { out: OUT, port: switching ? 9261 : 9262 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 860);
    const pending = (taskId: string): Promise<Pending[]> => app.ipc<Pending[]>("approval:pending", undefined).then((all) => all.filter((p) => p.taskId === taskId));

    /** Pick a permission set on the open conversation's composer, the way a person does. */
    const pick = async (label: string): Promise<void> => {
      const opened = await app.evaluate<boolean>(`(() => { const chip = document.querySelector('[aria-label="Permissions"]'); if (!chip) return false; chip.click(); return true; })()`);
      if (!opened) throw new Error("the composer has no Permissions chip");
      await settle(600);
      await app.clickText(label);
      await settle(600);
    };

    /**
     * Wait for the first ask, switch to Full, allow it, and watch the rest of the answer: no second ask.
     * `done` says the answer is over.
     */
    const switchAndWatch = async (what: string, taskId: string, sentence: string, done: () => Promise<boolean>): Promise<void> => {
      let first: Pending | undefined;
      for (let i = 0; first === undefined; i++) {
        first = (await pending(taskId)).find((p) => p.asker === "smart");
        if (i > 240) throw new Error(`${what}: no ask was parked in two minutes`);
        if (first === undefined) await settle(500);
      }
      await settle(1500);
      await app.shot(`${what}-asked`);
      if (switching) {
        await pick("full access");
        await app.shot(`${what}-switched`);
      }
      await app.ipc("approval:submit", { requestId: first.requestId, decision: "allow", scope: "once" });
      const later: string[] = [];
      for (let i = 0; !(await done()); i++) {
        for (const p of await pending(taskId)) {
          if (p.requestId === first.requestId || later.includes(p.requestId)) continue;
          later.push(p.requestId);
          // An ask after the switch is the bug; answered, so the agent can finish and the shot says what it was.
          await app.ipc("approval:submit", { requestId: p.requestId, decision: "allow", scope: "once" }).catch(() => undefined);
        }
        if (i > 360) throw new Error(`${what}: the answer did not finish in three minutes`);
        await settle(500);
      }
      await settle(1500);
      await app.shot(`${what}-answered`);
      // What the answer's phase counts, as the person reads it: both pages fetched, and how many auto checked.
      const phase = await app.evaluate<string>(`(() => { const text = document.body.innerText; return text.slice(text.lastIndexOf(${JSON.stringify(sentence)})); })()`);
      if (!/\b2 pages\b/.test(phase)) throw new Error(`${what}: the agent did not fetch both pages, so the switch was not exercised: ${JSON.stringify(phase.slice(0, 400))}`);
      const checks = Number(/\b(\d+) auto checks?\b/.exec(phase)?.[1] ?? "0");
      if (switching) {
        if (later.length > 0 || checks !== 1) throw new Error(`${what}: after switching to full access, ${later.length} more ask(s) and ${checks} auto check(s)`);
        console.log(`permission-switch: ${what} — after switching to full access, the second fetch ran without an ask or an auto check`);
      } else {
        // The control: with no switch the second fetch is checked and asked about too — what the rig catches.
        if (later.length === 0 || checks < 2) throw new Error(`${what}: the control saw no second ask (${checks} auto check(s)), so the rig could not tell the bug from the fix`);
        console.log(`permission-switch: ${what} — the control, without a switch, asked about the second fetch too`);
      }
    };

    // The OPENING message: the run's own gate, built by the engine.
    const opening = TWO_FETCHES("https://example.com", "https://example.org");
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", inputs: { message: opening } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: AUTO } });
    await app.until(says(TITLE), "the conversation to be listed", 200);
    await app.clickText("Chat");
    await settle(1500);
    await app.clickText(TITLE);
    await settle(1500);
    const finished = async (): Promise<boolean> => (await app.ipc<{ status: string }>("task:detail", { taskId: made.taskId }))?.status !== "running";
    await switchAndWatch("opening-message", made.taskId, opening, finished);

    // A LATER message: a chat turn, gated by the service's own `gateTools`. Sent on Auto again.
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const send = { taskId: made.taskId, instanceId: thread.instanceId, message: TWO_FETCHES("https://example.org", "https://example.com"), overrides: { model: MODEL, permissionSet: AUTO } };
    // Not awaited: a send settles when its turn does, and this turn waits on the ask. The page notes when.
    await app.evaluate(`(window.__turnOver = false, void window.jaira.invoke("chat:send", ${JSON.stringify(send)}).catch(() => undefined).finally(() => { window.__turnOver = true; }), true)`);
    await switchAndWatch("later-message", made.taskId, send.message, () => app.evaluate<boolean>("window.__turnOver === true"));
  } finally {
    await app.close();
  }
}

await main();
