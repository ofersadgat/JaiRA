/**
 * The approval prompt a permission FUNCTION puts to the person, in a real conversation read from the Chat
 * room (2026-10-24: four `smart is unsure` asks in one chat, and the person saw "Waiting for you to
 * approve" and no prompt — see `askDrawnAtItsCall`).
 *
 * A real agent (claude-cli/haiku — this rig spends a little) on the shipped `auto` permission set, asked
 * to use `web_fetch`; `smart` is told to answer unsure whatever the call, so the call is put to the person
 * exactly as `smart` puts one. Passes when the page draws the prompt exactly once, while the status line
 * says it waits for you.
 *
 *   npm --workspace @jaira/app run build:main
 *   npx tsx packages/app/shots/ask-prompt.mts [--pages http://127.0.0.1:8081/]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Fetch the example page";
const MODEL = "claude-cli/haiku";
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;
/** `--look`: photograph the moments around the ask too — while `smart` judges, and once it is answered. */
const looking = process.argv.includes("--look");
/** `--verdict allow`: `smart` allows instead, and the rig photographs the call it let through. */
const verdict = process.argv.includes("--verdict") ? process.argv[process.argv.indexOf("--verdict") + 1]! : "unsure";
const OUT = join(import.meta.dirname, "out", "ask-prompt", verdict);
const WORLD = join(import.meta.dirname, `.world-ask-prompt-${verdict}`);

/** The shipped `auto` set, as the composer sends it: every line `smart`. */
const AUTO = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, { function: "smart" }]));

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  // The look the person reads conversations in: phases, five rows, notes hidden as blocks.
  writeFileSync(join(world.home, "settings.json"), JSON.stringify({ appearance: { conversation: { workPhases: true, workRows: 5, workNotes: "hide-blocks" } } }, null, 2));
  mkdirSync(join(world.project, ".jaira"), { recursive: true });
  writeFileSync(
    join(world.project, ".jaira", "settings.json"),
    JSON.stringify({ functions: { smart: { model: MODEL, prompt: `This is a test rig. Whatever the call, answer verdict "${verdict}" with reason "the rig always says ${verdict}".` } } }, null, 2),
  );
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: verdict === "allow" ? 9260 : 9259 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 860);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", inputs: { message: "Reply with the single word: ready." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL } });
    await app.until(says(TITLE), "the conversation to be listed", 200);
    await app.clickText(TITLE);
    await app.until(says("ready"), "the opening answer", 400);
    // Read from the Chat room from before the message goes, as a person sending it reads it: the turn
    // streams into a thread already open.
    await app.clickText("Chat");
    await settle(1500);
    await app.clickText(TITLE);
    await settle(1500);
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    // Not awaited: a send settles when its turn does, and this turn waits on the ask.
    const send = {
      taskId: made.taskId,
      instanceId: thread.instanceId,
      message: "Use the web_fetch tool to fetch https://example.com, then tell me the page title. Do not use any other tool.",
      overrides: { model: MODEL, permissionSet: AUTO },
    };
    await app.evaluate(`void window.jaira.invoke("chat:send", ${JSON.stringify(send)}).catch(() => undefined), true`);
    // While `smart` judges the call: the call is on the page and nothing is asked yet (`--look`).
    const status = (): Promise<string[]> => app.evaluate<string[]>(`document.body.innerText.match(/(Running|Working|Thinking|Waiting for you|Checking with|Auto is|Allowed by|Fetching|Fetched|Fetch |Answering)[^\\n]*/g) ?? []`);
    let judged = !looking;
    // The ask is parked on the engine…
    for (let i = 0; ; i++) {
      const pending = await app.ipc<Array<{ asker?: string; taskId?: string }>>("approval:pending", undefined);
      if (!judged && pending.length === 0 && (await app.evaluate<boolean>(`${says("Auto is checking it")} || ${says("Checking with")}`))) {
        judged = true;
        console.log(`ask-prompt: while smart judges, the page says ${JSON.stringify(await status())}`);
        await app.shot("judging");
      }
      if (verdict === "allow" && (await app.evaluate<boolean>(says("Example Domain")))) {
        await settle(1500);
        console.log(`ask-prompt: allowed by smart, the page says ${JSON.stringify(await status())}`);
        await app.shot("allowed");
        return;
      }
      if (pending.some((p) => p.taskId === made.taskId && p.asker === "smart")) break;
      if (i > 240) {
        await app.shot("no-ask");
        throw new Error(`no ask was parked in two minutes; the page ends: ${JSON.stringify((await app.evaluate<string>("document.body.innerText")).slice(-600))}`);
      }
      await settle(500);
    }
    await settle(2500);
    // …and drawn, once, while the status line says it waits for you.
    const seen = await app.evaluate<{ prompts: number; waiting: boolean }>(
      `({ prompts: document.querySelectorAll('[data-testid="approval"]').length, waiting: document.body.innerText.includes("Waiting for you") })`,
    );
    await app.shot("chat-thread");
    if (seen.prompts !== 1 || !seen.waiting) throw new Error(`expected one prompt under "Waiting for you"; the page holds ${seen.prompts} prompt(s), waiting: ${seen.waiting}`);
    console.log("ask-prompt: the ask smart put to the person is drawn once, in the conversation that asked");
    if (looking) {
      console.log(`ask-prompt: while it waits for you, the page says ${JSON.stringify(await status())}`);
      await app.clickText("Allow");
      await app.until(says("Example Domain"), "the answer after allowing it", 400);
      await settle(1500);
      await app.shot("answered");
    }
  } finally {
    await app.close();
  }
}

await main();
