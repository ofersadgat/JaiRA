/**
 * The chips over the box while a conversation's agent waits for an approval (2026-11-04: "Running Read
 * file" and "Waiting for approve powershell -NoProfile" side by side, when there should be just the
 * waiting, with the waiting timer).
 *
 * A real agent (claude-cli/haiku — this rig spends a little), reads allowed and the shell asking, told to
 * make a shell call and a read in one message, so the read is queued behind the shell call's approval.
 * Passes when the row over the box holds one chip, the approval's, and the time on it grows; the
 * conversation's status pill is not drawn beside it.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/approval-chips.mts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Approval chips";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "approval-chips");
const WORLD = join(import.meta.dirname, ".world-approval-chips");
/** Reads go through; a shell line asks. */
const SET = { read_file: "allow", glob: "allow", grep: "allow", shell: "ask", other: "ask" };

/** The chips over the box: the status pill (`role="status"` with a verb) and the wait pills (`go to …`). */
const CHIPS = `(() => {
  const status = [...document.querySelectorAll('[role="status"]')].filter((e) => /^(Thinking|Answering|Writing|Running|Working|Waiting for you|Checking with)/.test(e.innerText.trim()));
  const waits = [...document.querySelectorAll('[title^="go to "]')];
  const words = (e) => e.innerText.replace(/\\s+/g, ' ').trim();
  return { status: status.map(words), waits: waits.map(words) };
})()`;

type Chips = { status: string[]; waits: string[] };

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  writeFileSync(join(world.project, "README.md"), "# A project\n\nNothing to see.\n");
  const app = await App.launch(world, { out: OUT, port: 9267 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`approval-chips: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message: "Reply with the single word: ready." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(says("ready"), "the opening answer", 400);
    await settle(1500);

    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const send = {
      taskId: made.taskId,
      instanceId: thread.instanceId,
      message:
        "In ONE message, make two tool calls together, in this order: first your shell tool running exactly `hostname`, then your read-file tool on README.md. Do not wait for one before making the other. Then reply with both results.",
      overrides: { model: MODEL, permissionSet: SET },
    };
    // Not awaited: the send settles when its turn does, and the turn waits on the approval.
    await app.evaluate(`void window.jaira.invoke("chat:send", ${JSON.stringify(send)}).catch(() => undefined), true`);

    let asked: { requestId: string; command?: string } | undefined;
    for (let i = 0; asked === undefined; i++) {
      [asked] = (await app.ipc<Array<{ requestId: string; taskId?: string; command?: string }>>("approval:pending", undefined)).filter((p) => p.taskId === made.taskId);
      if (i > 240) throw new Error(`no approval asked in two minutes; the page ends: ${JSON.stringify((await app.evaluate<string>("document.body.innerText")).slice(-500))}`);
      if (asked === undefined) await settle(500);
    }
    console.log(`approval-chips: asked ${JSON.stringify(asked.command)}`);
    await settle(2500);
    const first = await app.evaluate<Chips>(CHIPS);
    await app.shot("1-asked");
    await settle(2200);
    const later = await app.evaluate<Chips>(CHIPS);
    await app.shot("2-asked-later");
    console.log(`approval-chips: chips ${JSON.stringify({ first, later })}`);

    check(first.status.length === 0, `no status pill beside the approval (saw ${JSON.stringify(first.status)})`);
    check(first.waits.length === 1 && first.waits[0]!.startsWith("Waiting for approve"), `one chip, the approval's (saw ${JSON.stringify(first.waits)})`);
    const seconds = (words: string | undefined): number | undefined => {
      const m = /(\d+(?:\.\d)?) seconds/.exec(words ?? "");
      return m === null ? undefined : Number(m[1]);
    };
    const a = seconds(first.waits[0]);
    const b = seconds(later.waits[0]);
    check(a !== undefined && b !== undefined && b > a, `its time grows (${a} → ${b})`);

    await app.ipc("approval:submit", { requestId: asked.requestId, decision: "allow", scope: "once" });
    await settle(1500);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`approval-chips: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("approval-chips: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
