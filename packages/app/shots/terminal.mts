/**
 * A shell command as a terminal (decision 0028), end to end in the real app: a command run in a
 * conversation's workspace from its Terminals tab, watched as it prints, found waiting at its prompt,
 * answered by the key its prompt offers, and moved between the side panel and a split.
 *
 * Free: the conversation's one answer is scripted (`fake`), and the command is the person's own
 * (`terminal:run`), so no agent runs. An agent's call reaches the same terminal through `shell`
 * (`packages/runtime/test/shellTerminal.test.ts` drives that half with a real process).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/terminal.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "terminal");
const WORLD = join(import.meta.dirname, ".world-terminal");
const TITLE = "Fix the flaky upload test";
const COMMAND = "printf 'checking uploads\\n'; for i in 1 2 3; do printf '\\033[32m✓\\033[0m upload part %s\\n' $i; sleep 0.2; done; printf 'Retry the slow one? (y/N) '; read answer; echo \"you said $answer\"; sleep 0.3; echo done";

/** The centre of the visible element whose accessible name is `label` (or starts with it). */
const centreOf = (label: string, prefix = false): string => `(() => {
  const want = ${JSON.stringify(label)};
  const all = [...document.querySelectorAll('[aria-label]')].filter((e) => ${prefix ? "e.getAttribute('aria-label').startsWith(want)" : "e.getAttribute('aria-label') === want"});
  const e = all.reverse().find((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9274 });
  const press = async (label: string, prefix = false): Promise<void> => {
    const at = await app.evaluate<{ x: number; y: number } | null>(centreOf(label, prefix));
    if (at === null) throw new Error(`nothing labelled "${label}" on the page`);
    await app.clickAt(at.x, at.y);
    await settle(400);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1360, 860);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "session", conversation: true, inputs: { message: "The upload test is flaky. Check it." } });
    await app.ipc("task:start", { taskId: made.taskId, fake: [{ output: "I'll look at the upload test." }] });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat tab", 100);
    await app.clickText(TITLE);
    await app.until(says("I'll look at the upload test."), "the conversation to open", 100);

    // The Terminals tab on the folded panel's rail: it unfolds on it.
    await app.shot("0-conversation");
    await app.clickText("Terminals");
    await app.until(says("Runs as you"), "the Terminals tab", 60);
    await app.shot("1-terminals-empty");

    // A command of the person's own, typed on the tab's run line.
    await press("Run a command in this conversation's workspace");
    await app.type(COMMAND);
    await app.press("Enter", 13);

    // Run, it opens on the panel's stack: the terminal, found waiting, its prompt's answers as keys.
    await app.until(`[...document.querySelectorAll('[aria-label]')].some((e) => e.getAttribute('aria-label') === 'Answer y: yes')`, "the prompt's answers as keys", 60);
    await app.until(says("waiting for input"), "the terminal to say it waits", 40);
    await app.shot("2-in-the-panel-waiting");

    await press("Answer y: yes");
    await app.until(says("you said y"), "the answer to reach the command", 60);
    await app.until(says("exit 0"), "the command to end", 60);
    await app.shot("3-answered");

    // Moved to a split: the panel gives it up (back to its Terminals tab, the command now under Ended),
    // the second pane takes it, Split lit. Wide enough for two panes beside the panel.
    await app.resize(1920, 900);
    await press("Open in a split");
    await app.until(`[...document.querySelectorAll('[aria-label="Open in a split"][aria-pressed="true"]')].length > 0`, "the split button lit", 40);
    await app.until(`document.body.innerText.toLowerCase().includes("ended")`, "the panel back on its Terminals tab, the command ended", 40);
    await settle(500);
    await app.shot("4-in-a-split");

    // The Command reading: the line's requests, as the approval takes it apart.
    await app.clickText("Command");
    await app.until(says("one printf"), "the Command reading", 40);
    await app.shot("5-command-reading");

    const list = await app.ipc<Array<{ by: string; exitCode?: number; input: string[] }>>("terminal:list", { taskId: made.taskId });
    if (list.length !== 1 || list[0]!.by !== "you" || list[0]!.exitCode !== 0 || list[0]!.input.join() !== "y") throw new Error(`the engine's terminal is not what was run: ${JSON.stringify(list)}`);
    console.log("passed");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
