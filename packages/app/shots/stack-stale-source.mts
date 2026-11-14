/**
 * The person, 2026-11-09, in a conversation started before the presets left `chat/`: "it isnt showing
 * any permission layers … I tried to add a layer when it was asking me for permission and the
 * permission ui went away, but its still waiting for permission. the added layer isnt showing up in the
 * permission layers either".
 *
 * That conversation's pinned workflow names its set by the OLD reference (`$/permission-sets/chat/ask-first`,
 * a snapshot is frozen) and its composer kept no stack of its own, so the composer's bottom layer is
 * read from that pin. Here: a conversation pinned to a project workflow that names the set by the old
 * reference, the old file then taken away as the move does. A line asks; `+` lays `full` on top. Passes when the bar shows the
 * layers before and after, the call is answered by the permissions, and the kept stack names no
 * reference that cannot be followed.
 *
 * A real agent (claude-cli/haiku — this rig spends a little).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/stack-stale-source.mts
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "stack-stale-source");
const WORLD = join(import.meta.dirname, ".world-stack-stale-source");
const OLD = ["$/permission-sets/", "ch", "at/ask-first"].join("");
const LINE = "hostname";
const run = (line: string): string => `Use your shell tool to run exactly this line, once, and nothing else: ${line}\nDo not pass a cwd. Then reply with its output, or, if it was not run, with the reason you were given, word for word. Do not use any other tool, and do not try again.`;
const BAR = '[role="group"][aria-label="Permissions"]';

type Pending = { requestId: string; taskId?: string; command?: string };

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9272 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`stack-stale-source: ${ok ? "PASS" : "FAIL"} ${what}`);
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
    const pressText = async (text: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
        const hits = [...document.body.querySelectorAll("*")].filter((e) => (e.innerText || "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText || "").trim() === ${JSON.stringify(text)}));
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
    const bar = (): Promise<string> => app.evaluate<string>(`(document.querySelector(${JSON.stringify(BAR)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`);
    const pending = async (taskId: string): Promise<Pending[]> => (await app.ipc<Pending[]>("approval:pending", undefined)).filter((p) => p.taskId === taskId);
    const approvalDrawn = (): Promise<boolean> => app.evaluate<boolean>(`/\\bAllow\\b/.test(document.body.innerText) && /\\bDeny\\b/.test(document.body.innerText)`);

    // A pin made before the presets left `chat/`: the state names its set by the old reference, and the
    // set is there — planted after the move ran at open, as the files stood before it. A pin is checked
    // against its hash, so it cannot be edited into this afterwards.
    const jaira = join(world.project, ".jaira");
    const oldDir = join(jaira, "permission-sets", ["ch", "at"].join(""));
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "ask-first.json"), JSON.stringify({ $ref: "$SYSTEM/permission-sets/ask-first" }));
    const shipped = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "builtin", "workflows", "chat", "session.json"), "utf8")) as { operation: Record<string, unknown> };
    mkdirSync(join(jaira, "workflows", "chat"), { recursive: true });
    writeFileSync(join(jaira, "workflows", "chat", "session.json"), JSON.stringify({ ...shipped, operation: { ...shipped.operation, tools: OLD } }));
    await settle(1500);

    // A conversation as the Chat view starts one, under the state's own set: nothing kept on the composer.
    const title = "Stale pin";
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: "Reply with the single word: ready." }, conversation: true });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL } });
    await app.clickText("Chat");
    await app.until(says(title), "the conversation to be listed", 200);
    for (let i = 0; (await app.ipc<{ status: string } | null>("task:detail", { taskId: made.taskId }))?.status === "running"; i++) {
      if (i > 240) throw new Error("the opening run did not end in two minutes");
      await settle(500);
    }
    const snapshots = join(jaira, "system", "snapshots");
    const pinned = readdirSync(snapshots, { recursive: true }).filter((file) => String(file).endsWith("session.json") && readFileSync(join(snapshots, String(file)), "utf8").includes(OLD)).length;
    console.log(`stack-stale-source: ${pinned} pinned state(s) name ${OLD}`);
    check(pinned > 0, "0. the conversation is pinned to the old name");
    // The move, done: the old file is gone; the pin keeps the old name.
    rmSync(oldDir, { recursive: true });
    rmSync(join(jaira, "workflows", "chat"), { recursive: true });
    await settle(1500);
    const task0 = await app.ipc<{ chatSettings?: unknown }>("task:detail", { taskId: made.taskId });
    console.log(`stack-stale-source: kept composer settings ${JSON.stringify(task0.chatSettings ?? null)}`);
    await app.clickText(title);
    await app.until(says("ready"), "the opening answer", 400);
    await settle(2000);
    const before = await bar();
    console.log(`stack-stale-source: the bar reads ${JSON.stringify(before)}`);
    await app.shot("1-bar", undefined, false);
    check(/ask-first/.test(before), "1. the bar shows the conversation's bottom layer");

    // A line asks.
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    await app.evaluate(`window.__turnEnded = false; void window.jaira.invoke("chat:send", ${JSON.stringify({ taskId: made.taskId, instanceId: thread.instanceId, message: run(LINE), overrides: { model: MODEL } })}).then(() => { window.__turnEnded = true; }), true`);
    for (let i = 0; (await pending(made.taskId)).length === 0; i++) {
      if (i > 240) throw new Error("no ask in two minutes");
      await settle(500);
    }
    await settle(2500);
    await app.shot("2-asked", undefined, false);
    check(await approvalDrawn(), "2. the ask is drawn");

    // `+` lays full on top.
    await press(`${BAR} [aria-label="add"]`);
    await settle(1000);
    await app.shot("3-add", undefined, false);
    // `+`'s list: pressing a set's row lays it on top (2026-11-14).
    await pressText("full");
    for (let i = 0; (await pending(made.taskId)).length > 0 && i < 40; i++) await settle(250);
    await settle(1500);
    const stillAsks = (await pending(made.taskId)).length > 0;
    const drawnNow = await approvalDrawn();
    const after = await bar();
    const kept = (await app.ipc<{ chatSettings?: { permissionSet?: Record<string, unknown> } }>("task:detail", { taskId: made.taskId })).chatSettings;
    await app.shot("4-after-add", undefined, false);
    console.log(`stack-stale-source: after +full the bar reads ${JSON.stringify(after)}; still asks ${stillAsks}; an ask drawn ${drawnNow}`);
    console.log(`stack-stale-source: kept ${JSON.stringify(kept)}`);
    check(/full/.test(after) && /ask-first/.test(after), "4. the bar shows full over ask-first");
    check(!stillAsks, "4. laying full on top answered the waiting call");
    check(stillAsks === drawnNow, "4. what is drawn agrees with what waits");
    check(!JSON.stringify(kept ?? {}).includes(OLD), "4. the kept stack names no reference that cannot be followed");
    check(Object.keys(kept?.permissionSet ?? {}).filter((key) => key !== "layers").length === 0, "4. adding a layer wrote no lines of the conversation's own");
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`stack-stale-source: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("stack-stale-source: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
