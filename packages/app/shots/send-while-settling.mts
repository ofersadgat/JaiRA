/**
 * A message sent the moment the opening's answer shows — while its run is still settling — is drawn in
 * the conversation like any other (2026-11-13: it ran, on a branch of the conversation's session, and
 * the thread never drew it: "session … diverged at 1").
 *
 * A real agent (claude-cli/haiku — this rig spends a little). Passes when the second message and its
 * answer are on the page and no record of the task sits on a branch.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/send-while-settling.mts
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Send while settling";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "send-while-settling");
const WORLD = join(import.meta.dirname, ".world-send-while-settling");
const SET = { read_file: "allow", glob: "allow", grep: "allow", shell: "ask", other: "ask" };
type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void };
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string, options?: { readonly?: boolean }) => Db;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const app = await App.launch(world, { out: OUT, port: 9273 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`send-while-settling: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 900);
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message: "Reply with one word: pine and apple joined together, lowercase." } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);
    // Sent the moment the answer shows: the opening's run has not settled yet.
    await app.until("document.body.innerText.includes('pineapple')", "the opening answer", 400);
    const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
    const sentAt = Date.now();
    const send = { taskId: made.taskId, instanceId: thread.instanceId, message: "Reply with the single word: zebra.", overrides: { model: MODEL, permissionSet: SET } };
    await app.evaluate(`void window.jaira.invoke("chat:send", ${JSON.stringify(send)}).then((r) => { window.__sent = r; }, (e) => { window.__sendError = String(e && e.message || e); }), true`);
    await app.until("document.body.innerText.toLowerCase().includes('zebra.') || window.__sendError !== undefined", "the second answer", 400).catch(() => undefined);
    await settle(4000);
    await app.shot("1-after", undefined, false);
    console.log(`send-while-settling: send ${JSON.stringify(await app.evaluate<unknown>("({ sent: window.__sent ?? null, error: window.__sendError ?? null })"))}`);

    const db = new Database(join(world.home, "system", "jaira.db"), { readonly: true });
    const rows = db.prepare("SELECT status, started_at, ended_at, session_id, session_seq, landed_session_id, landed_seq FROM operation_records WHERE task_id = ? ORDER BY started_at").all(made.taskId) as Array<Record<string, unknown>>;
    db.close();
    for (const r of rows) console.log(`send-while-settling: record ${JSON.stringify({ ...r, started_at: Number(r["started_at"]) - sentAt, ended_at: r["ended_at"] === null ? null : Number(r["ended_at"]) - sentAt })}`);
    const logs = join(world.home, "system", "logs");
    const diverged = readdirSync(logs).flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n")).filter((l) => l.includes("diverged"));
    for (const l of diverged) console.log(`send-while-settling: log ${l.slice(0, 300)}`);

    const page = await app.evaluate<string>("document.body.innerText");
    check(/zebra/.test(page) && page.includes("Reply with the single word: zebra."), "the second message and its answer are on the page");
    check(rows.every((r) => r["landed_session_id"] === null), "no record of the conversation sits on a branch");
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`send-while-settling: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("send-while-settling: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
