/**
 * A later chat turn's approval on the task's own run page.
 *
 * A real agent (claude-cli/haiku — this rig spends a little), under `ask-first`: a task — not a
 * conversation, so it is read on its run page — answers its opening message and its run ends; a later
 * message asks to run a line, and the approval is drawn on the run page under that turn, where it can be
 * answered. Before the fix the page drew it nowhere: it looked for a state whose call was running, and
 * after the run there is none — the turn is a chat turn's, not the run's.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/run-page-approval.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "run-page-approval");
const WORLD = join(import.meta.dirname, ".world-run-page-approval");
const ASK_FIRST = { layers: ["$/permission-sets/ask-first"] };
const run = (line: string): string => `Use your shell tool to run exactly this line, once, and nothing else: ${line}\nDo not pass a cwd. Then reply with its output, or, if it was not run, with the reason you were given, word for word. Do not use any other tool, and do not try again.`;

type Pending = { requestId: string; taskId?: string; command?: string };
type Node = { instanceId: string; stateId?: string; status?: string; operation?: { status?: string }; children: Node[] };

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9266 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`run-page-approval: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 900);
    const text = (): Promise<string> => app.evaluate<string>("document.body.innerText");
    const pending = async (taskId: string): Promise<Pending[]> => (await app.ipc<Pending[]>("approval:pending", undefined)).filter((p) => p.taskId === taskId);

    // A task, read on its own run page.
    const title = "Run page approval";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: "Reply with the single word: ready." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: ASK_FIRST } });
    for (let i = 0; (await app.ipc<{ status: string } | null>("task:detail", { taskId: made.taskId }))?.status === "running"; i++) {
      if (i > 240) throw new Error("the opening run did not end in two minutes");
      await settle(500);
    }
    await app.clickText("Tasks");
    await app.until(says(title), "the task to be listed", 200);
    await app.clickText(title);
    await app.until(says("ready"), "the opening answer on the run page", 400);
    await settle(1500);
    await app.shot("a-run-page", undefined, false);

    // Later messages, sent as the page's composer sends one. The first enters the chat child; the one
    // that asks is the SECOND, which only takes a transition in it — the turn the report was about.
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const send = (message: string): Promise<unknown> =>
      app.evaluate(
        `window.__turnEnded = false; window.__sendFailed = null; void window.jaira.invoke("chat:send", ${JSON.stringify({ taskId: made.taskId, instanceId: thread.instanceId, message, overrides: { model: MODEL, permissionSet: ASK_FIRST } })}).then(() => { window.__turnEnded = true; }, (e) => { window.__sendFailed = String(e); }), true`,
      );
    const untilTurnEnds = async (what: string): Promise<void> => {
      for (let i = 0; !(await app.evaluate<boolean>("window.__turnEnded === true")); i++) {
        const failed = await app.evaluate<string | null>("window.__sendFailed ?? null");
        if (failed !== null) throw new Error(`${what}: the send failed: ${failed}`);
        if (i > 360) throw new Error(`${what}: the turn did not end in three minutes`);
        await settle(500);
      }
      await settle(1500);
    };
    await send("Reply with the single word: again.");
    await untilTurnEnds("the first later turn");
    await send(run("hostname"));
    let asked: Pending | undefined;
    for (let i = 0; asked === undefined; i++) {
      [asked] = await pending(made.taskId);
      if (i > 240) throw new Error(`no ask in two minutes; the page ends: ${JSON.stringify((await text()).slice(-500))}`);
      if (asked === undefined) await settle(500);
    }
    await settle(2500);
    console.log(`run-page-approval: asked ${JSON.stringify(asked.command)}`);
    const tree = (await app.ipc<{ instances: Node[] }>("task:detail", { taskId: made.taskId })).instances;
    const shape = (nodes: Node[], depth = 0): string[] => nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.instanceId} ${n.stateId ?? ""} status=${n.status} op=${n.operation?.status}`, ...shape(n.children, depth + 1)]);
    console.log(`run-page-approval: the tree while it asks:\n${shape(tree).join("\n")}`);
    await app.shot("b-asked", undefined, false);
    const drawnHere = await app.evaluate<number>(`document.querySelectorAll('[data-testid="approval-row-pill"]').length`);
    const page = await text();
    check(drawnHere > 0, "b. the later turn's approval is drawn on the run page");

    // Answered from the page, the turn goes on.
    if (drawnHere > 0) {
      await app.clickText("Allow");
      await settle(800);
      check((await pending(made.taskId)).length === 0, "c. answered from the run page, nothing is left waiting");
    } else {
      await app.ipc("approval:submit", { requestId: asked.requestId, decision: "deny", scope: "once" });
    }
    await untilTurnEnds("the turn that asked");
    await app.shot("c-ran", undefined, false);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`run-page-approval: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("run-page-approval: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
