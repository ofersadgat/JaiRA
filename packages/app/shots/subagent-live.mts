/**
 * A subagent's subagent asking for an approval while it runs, drawn the way a run's wait is
 * (`subagentModel.ts`): a pill over the box naming the subagents it is in, the outer subagent's line
 * saying it waits, a press on the pill walking into the one that asks, with its approval drawn there and
 * the title a breadcrumb.
 *
 * A real agent (claude-cli/haiku — this rig spends a little): the conversation starts a BACKGROUND agent,
 * which starts a foreground one that runs `hostname`; the shell asks. That one streams no turn, so all
 * of this is read off its own file as it runs (`UnstreamedChains`).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/subagent-live.mts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Subagents live";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "subagent-live");
const WORLD = join(import.meta.dirname, ".world-subagent-live");
/** Reads and the agent's own tools go through; a shell line asks. */
const SET = { read_file: "allow", glob: "allow", grep: "allow", shell: "ask", other: "ask" };
const OUTER = "outer helper";
const INNER = "inner helper";

const WAITS = `[...document.querySelectorAll('[title^="go to "]')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  writeFileSync(join(world.project, "README.md"), "# A project\n\nNothing to see.\n");
  const app = await App.launch(world, { out: OUT, port: 9271 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`subagent-live: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1400, 950);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message: "Reply with the single word: ready." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    await app.until(says("ready"), "the opening answer", 400);
    // The opening run settles before the next message: one sent while it finishes runs on a branch the
    // thread does not draw (seen 2026-11-13, "diverged at 1"; not what this rig checks).
    for (let i = 0; i < 120; i++) {
      const task = (await app.ipc<Array<{ taskId: string; status: string }>>("task:list", {})).find((t) => t.taskId === made.taskId);
      if (task !== undefined && task.status !== "running") break;
      await settle(500);
    }
    await settle(1500);

    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const send = {
      taskId: made.taskId,
      instanceId: thread.instanceId,
      message:
        `Call the Agent tool ONCE with run_in_background: true, subagent_type "general-purpose", description "${OUTER}", and this prompt: ` +
        `"Call the Agent tool ONCE (run_in_background false) with subagent_type general-purpose, description ${INNER}, prompt: Run exactly \`New-Item -ItemType File -Path probe.txt\` with your shell tool (the mcp__dai__shell tool; load it with ToolSearch first if you must) and reply with its output." ` +
        `Then reply with the single word: started.`,
      overrides: { model: MODEL, permissionSet: SET },
    };
    await app.evaluate(`void window.jaira.invoke("chat:send", ${JSON.stringify(send)}).catch((e) => { window.__sendError = String(e && e.message || e); }), true`);
    await settle(4000);
    console.log(`subagent-live: send error ${JSON.stringify(await app.evaluate<unknown>("window.__sendError ?? null"))}`);

    // The Agent calls ask too (the set asks for anything it does not name): each is allowed as it comes,
    // until the shell asks — from inside the inner subagent.
    let asked: { requestId: string; tool?: string; command?: string } | undefined;
    for (let i = 0; asked === undefined; i++) {
      const pending = (await app.ipc<Array<{ requestId: string; taskId?: string; tool?: string; command?: string }>>("approval:pending", undefined)).filter((p) => p.taskId === made.taskId);
      for (const one of pending) {
        if (one.tool === "shell") asked = one;
        else {
          console.log(`subagent-live: allowing ${one.tool} ${JSON.stringify(one.command ?? "")}`);
          await app.ipc("approval:submit", { requestId: one.requestId, decision: "allow", scope: "once" });
        }
      }
      if (i > 480) throw new Error(`no shell approval asked in four minutes; the page ends: ${JSON.stringify((await app.evaluate<string>("document.body.innerText")).slice(-800))}`);
      if (asked === undefined) await settle(500);
    }
    console.log(`subagent-live: asked ${JSON.stringify(asked.command)}`);
    await settle(3000);
    await app.shot("1-asked", undefined, false);
    const waits = await app.evaluate<string[]>(WAITS);
    const page = await app.evaluate<string>("document.body.innerText");
    console.log(`subagent-live: pills ${JSON.stringify(waits)}`);
    check(waits.length === 1 && waits[0]!.startsWith("Waiting for approve") && waits[0]!.includes(OUTER) && waits[0]!.includes(INNER), "one pill, the approval's, in outer helper › inner helper");
    check(page.includes(OUTER) && page.includes("waiting for"), "the outer subagent's line says it waits");

    // A press on the pill walks into the subagent that asks.
    await app.evaluate(`(() => { const el = document.querySelector('[title^="go to "]'); el && el.click(); return true; })()`);
    await settle(2500);
    await app.shot("2-walked-in", undefined, false);
    // The breadcrumb's crumbs (`ChatTitle`): the conversation's goes back, the outer one goes back to it,
    // the last is where you stand. The page is the subagent's: the opening's "ready" is not on it.
    const crumbs = await app.evaluate<{ back: boolean; outer: boolean; here: string }>(`(() => ({
      back: document.querySelector('[title="back to the conversation"]') !== null,
      outer: document.querySelector('[title="back to ${OUTER}"]') !== null,
      here: document.querySelector('[title="the subagent this conversation\\'s agent started"]')?.innerText ?? "",
    }))()`);
    console.log(`subagent-live: crumbs ${JSON.stringify(crumbs)}`);
    check(crumbs.back && crumbs.outer && crumbs.here.includes(INNER), "walked in: the breadcrumb is conversation › outer helper › inner helper");
    const inside = await app.evaluate<string>("document.body.innerText");
    check(/New-Item/.test(inside) && !/\bready\b/.test(inside), "walked in: the page is the inner subagent's, its call that asks on it");
    const allow = await app.evaluate<boolean>(`[...document.querySelectorAll('button, [role="button"]')].some((b) => /^(Allow|Approve|Run)/.test(b.innerText.trim()))`);
    check(allow, "walked in: the approval is drawn where it can be answered");

    await app.ipc("approval:submit", { requestId: asked.requestId, decision: "allow", scope: "once" });
    await app.until(`document.body.innerText.includes("approve")`, "the approval answered", 20).catch(() => undefined);
    await settle(8000);
    await app.shot("3-answered", undefined, false);
    // Back out by the conversation's crumb.
    await app.evaluate(`(() => { const el = [...document.querySelectorAll('[title="back to the conversation"]')][0]; el && el.click(); return true; })()`);
    await settle(2000);
    await app.shot("4-back-out", undefined, false);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`subagent-live: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("subagent-live: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
